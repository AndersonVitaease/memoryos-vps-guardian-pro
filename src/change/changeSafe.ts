/**
 * engineering.vps.change.safe V2 - PLAN + governed EXECUTE (private Supertool).
 *
 * Two modes over ONE closed input contract:
 * - PLAN (default): turns a logical operator-configured target plus current
 *   read-only evidence into a deterministic, fingerprinted plan
 *   (PLAN_READY | BLOCKED | UNKNOWN) with fixed risk REQUIRES_APPROVAL.
 * - EXECUTE (execute=true): requires approval { approved, proposalFingerprint }.
 *   Before ANY mutation the tool re-resolves the logical target, re-collects
 *   fresh evidence, re-runs the SAME prechecks, recomputes the
 *   proposalFingerprint and compares it with approval.proposalFingerprint
 *   (TOCTOU binding): a mismatch reports SNAPSHOT_CHANGED and missing/not
 *   granted approval reports APPROVAL_REQUIRED - both with ZERO mutation.
 *   Only then is exactly ONE mutation attempt made through the
 *   operator-configured SafeChangeAdapter (single capability
 *   application-redeploy; no retry, no auto-recovery), followed by mandatory
 *   read-only post-validation reported honestly as VERIFIED | FAILED |
 *   PENDING | UNKNOWN_REQUIRES_HUMAN_REVIEW. Backend acceptance is never
 *   treated as success.
 *
 * Security boundary of this file:
 * - Input is a closed schema: action (single literal) + logical target key,
 *   plus the minimal execute/approval surface. No command, shell, script,
 *   SSH, host, IP, URL, path, token, credential, backend, toolName or raw
 *   arguments are ever accepted; unknown fields are rejected.
 * - The logical target key resolves ONLY against the operator-configured
 *   allowlist injected in ProContext (construction time). The agent never
 *   supplies an applicationId, host, URL or credential; the resolved real
 *   applicationId is never exposed in the output (it only feeds the
 *   fingerprint hash and the adapter boundary).
 * - Evidence is collected exclusively through the pinned public read-only
 *   adapters (one collect() per adapter per phase, stateless, no I/O here).
 * - Mutation authority lives ONLY inside the SafeChangeAdapter (see
 *   safeChangeAdapter.ts). Approval does NOT create authority: it only binds
 *   a previously produced plan fingerprint; the allowlist and operator
 *   configuration remain the sole authority.
 * - proposalFingerprint is a public, deterministic anchor and correlation/
 *   action key; backend idempotency is NOT claimed.
 * - Fail-closed precedence: any REQUIRED check UNKNOWN -> UNKNOWN; else any
 *   BLOCK -> BLOCKED; else PLAN_READY. PLAN_READY is NOT approval, NOT a
 *   safety guarantee and NOT execution.
 * - Rollback is NOT implemented: every result reports rollback.available=false
 *   and rollback.performed=false.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { assessVpsHealth } from "memoryos-vps-guardian/src/tools/vpsHealth";
import { assessVpsCapacity } from "memoryos-vps-guardian/src/tools/vpsCapacity";
import { assessApplicationHealth } from "memoryos-vps-guardian/src/tools/applicationDeployment";
import { assessDockerHealth } from "memoryos-vps-guardian/src/tools/dockerHealth";
import type { ApplicationDeploymentEvidence } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { ProContext } from "../proContext";
import type { SafeChangeAdapter, SafeChangeOutcome } from "./safeChangeAdapter";

export const CHANGE_SAFE_ACTION = "application.redeploy" as const;

/** Operator-configured resolved target. Never exposed to the agent. */
export interface ResolvedApplicationTarget {
  readonly applicationId: string;
  readonly applicationName: string;
}

/** Logical key -> resolved target. Operator-configured, construction time. */
export type ChangeTargets = Readonly<Record<string, ResolvedApplicationTarget>>;

export const CHANGE_TARGETS_ENV_VAR = "MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS";

const resolvedTargetSchema = z
  .object({
    applicationId: z.string().min(1).max(200),
    applicationName: z.string().min(1).max(200),
  })
  .strict();

export const changeTargetsSchema = z.record(z.string().min(1).max(200), resolvedTargetSchema);

/**
 * Operator allowlist parsing (construction time). Missing/empty value means
 * an EMPTY allowlist: no logical target can ever be planned (fail-closed).
 * A malformed value throws loudly instead of being silently repaired.
 */
export function parseChangeTargets(raw: string | undefined): ChangeTargets {
  if (raw === undefined || raw === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid change-target allowlist: value is not valid JSON");
  }
  const result = changeTargetsSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid change-target allowlist: ${details}`);
  }
  return result.data;
}

/**
 * Approval binding: the operator-approved proposalFingerprint produced by a
 * previous PLAN_READY output. execute defaults to false (plan-only).
 */
export const vpsChangeSafeApprovalSchema = z
  .object({
    approved: z.boolean(),
    proposalFingerprint: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex SHA-256 fingerprint"),
  })
  .strict();

export const vpsChangeSafeInputSchema = z
  .object({
    action: z.literal(CHANGE_SAFE_ACTION),
    target: z.string().min(1).max(200),
    execute: z.boolean().optional(),
    approval: vpsChangeSafeApprovalSchema.optional(),
  })
  .strict();

export type VpsChangeSafeInput = z.infer<typeof vpsChangeSafeInputSchema>;

/** Fixed check order (deterministic output). */
export const CHANGE_SAFE_CHECKS = [
  "TARGET_CONFIGURED",
  "DEPLOYMENT_EVIDENCE_AVAILABLE",
  "DEPLOYMENT_STATE_KNOWN",
  "NO_DEPLOYMENT_IN_FLIGHT",
  "VPS_HEALTH_ACCEPTABLE",
  "CAPACITY_ACCEPTABLE",
  "APPLICATION_HEALTH",
  "DOCKER_HEALTH",
] as const;

export type ChangeSafeCheck = (typeof CHANGE_SAFE_CHECKS)[number];

/**
 * REQUIRED checks gate the plan AND execution (BLOCK/UNKNOWN never mutate).
 * APPLICATION_HEALTH and DOCKER_HEALTH are OBSERVATIONAL: assessed semantics
 * show no public rule gates redeploy planning on them (application DEGRADED
 * is exactly the condition a redeploy may remediate), so they are reported
 * as INFO/NOT_CONFIGURED and never gate anything.
 */
export const CHANGE_SAFE_REQUIRED_CHECKS: readonly ChangeSafeCheck[] = [
  "TARGET_CONFIGURED",
  "DEPLOYMENT_EVIDENCE_AVAILABLE",
  "DEPLOYMENT_STATE_KNOWN",
  "NO_DEPLOYMENT_IN_FLIGHT",
  "VPS_HEALTH_ACCEPTABLE",
  "CAPACITY_ACCEPTABLE",
];

/**
 * PASS/BLOCK/UNKNOWN follow the doctor conventions. INFO marks an
 * observational check that never gates; NOT_CONFIGURED marks an optional
 * evidence source that is not configured (never read as healthy and never
 * read as authority).
 */
export type ChangeSafeCheckStatus = "PASS" | "BLOCK" | "UNKNOWN" | "NOT_CONFIGURED" | "INFO";

export type ChangeSafePlanStatus = "PLAN_READY" | "BLOCKED" | "UNKNOWN";

/** Mandatory post-validation outcomes after an accepted mutation attempt. */
export const CHANGE_SAFE_POST_VALIDATION_STATUSES = [
  "VERIFIED",
  "FAILED",
  "PENDING",
  "UNKNOWN_REQUIRES_HUMAN_REVIEW",
] as const;

export type ChangeSafePostValidationStatus = (typeof CHANGE_SAFE_POST_VALIDATION_STATUSES)[number];

/** Full EXECUTE outcome set (PLAN uses only PLAN_READY | BLOCKED | UNKNOWN). */
export type ChangeSafeExecuteStatus =
  | "APPROVAL_REQUIRED"
  | "SNAPSHOT_CHANGED"
  | "BLOCKED"
  | "UNKNOWN"
  | "MUTATION_UPSTREAM_ERROR"
  | ChangeSafePostValidationStatus;

export interface ChangeSafeCheckReport {
  readonly check: ChangeSafeCheck;
  readonly status: ChangeSafeCheckStatus;
  readonly summary: string;
}

export interface ChangeSafePlan {
  readonly status: ChangeSafePlanStatus;
  readonly action: typeof CHANGE_SAFE_ACTION;
  readonly target: { readonly key: string; readonly applicationName: string | null };
  readonly risk: "REQUIRES_APPROVAL";
  readonly proposalFingerprint: string | null;
  readonly prechecks: readonly ChangeSafeCheckReport[];
  readonly limitations: readonly string[];
}

export interface ChangeSafeMutationRecord {
  readonly attempted: boolean;
  readonly occurred: boolean;
  readonly accepted: boolean;
  readonly ref: string | null;
  readonly correlationKey: string | null;
}

export interface ChangeSafePostValidation {
  readonly status: ChangeSafePostValidationStatus;
  readonly deploymentStatus: string | null;
  readonly observedAt: string | null;
  readonly applicationHealthy: boolean | null;
  readonly currentReleaseId: string | null;
  readonly reason: string | null;
}

export interface ChangeSafeExecuteResult {
  readonly status: ChangeSafeExecuteStatus;
  readonly action: typeof CHANGE_SAFE_ACTION;
  readonly target: { readonly key: string; readonly applicationName: string | null };
  readonly executed: boolean;
  readonly reason: string | null;
  readonly risk: "REQUIRES_APPROVAL";
  readonly mutation: ChangeSafeMutationRecord;
  readonly postValidation: ChangeSafePostValidation | null;
  readonly rollback: { readonly available: false; readonly performed: false };
  readonly proposalFingerprint: string | null;
  readonly prechecks: readonly ChangeSafeCheckReport[];
  readonly limitations: readonly string[];
}

export const CHANGE_SAFE_LIMITATIONS: readonly string[] = [
  "Execution is limited to the single allowlisted action application.redeploy through the operator-configured SafeChangeAdapter; no other action, tool, shell, SSH, child process or command surface exists.",
  "PLAN_READY only means the current prechecks permit forming a proposal that still requires approval; it is not approval, not a safety guarantee and not execution.",
  "Mutation authority lives ONLY inside the operator-configured SafeChangeAdapter: the agent never selects tools, URLs, credentials or application identifiers, and no arbitrary backend can be targeted.",
  "One mutation attempt per call: no retry, no auto-recovery, no polling and no watch loop; uncertain outcomes are reported honestly, never repaired.",
  "Rollback is not available in this version: every result reports rollback.available=false and rollback.performed=false, and nothing is ever automatically reverted.",
  "proposalFingerprint is a local correlation/action key; backend idempotency is NOT claimed.",
  "APPLICATION_HEALTH and DOCKER_HEALTH are observational checks; they never gate the plan or execution and are never read as authority.",
  "GC-08C single-flight: while one EXECUTE for a resolved application identifier is in flight on this instance, concurrent EXECUTE calls for the SAME resolved identifier are refused (BLOCKED, zero mutation) before the mutation boundary; different application identifiers never block each other. This is same-instance (same process) protection only: cross-process and cross-machine concurrency are NOT serialized, no distributed lock or persistence exists, and backend idempotency is NOT claimed.",
];

const changeSafeCheckReportSchema = z
  .object({
    check: z.enum(CHANGE_SAFE_CHECKS),
    status: z.enum(["PASS", "BLOCK", "UNKNOWN", "NOT_CONFIGURED", "INFO"]),
    summary: z.string(),
  })
  .strict();

/**
 * Combined output schema. PLAN responses contain exactly the seven PLAN keys;
 * EXECUTE responses add the execute-only keys. The execute-only keys are
 * optional so the PLAN shape stays byte-compatible.
 */
export const vpsChangeSafeOutputSchema = z
  .object({
    status: z.enum([
      "PLAN_READY",
      "BLOCKED",
      "UNKNOWN",
      "APPROVAL_REQUIRED",
      "SNAPSHOT_CHANGED",
      "MUTATION_UPSTREAM_ERROR",
      "VERIFIED",
      "FAILED",
      "PENDING",
      "UNKNOWN_REQUIRES_HUMAN_REVIEW",
    ]),
    action: z.literal(CHANGE_SAFE_ACTION),
    target: z
      .object({ key: z.string(), applicationName: z.string().nullable() })
      .strict(),
    risk: z.literal("REQUIRES_APPROVAL"),
    proposalFingerprint: z.string().length(64).nullable(),
    prechecks: z.array(changeSafeCheckReportSchema),
    limitations: z.array(z.string()),
    // ---- EXECUTE-only keys (absent from PLAN responses) ----
    executed: z.boolean().optional(),
    reason: z.string().nullable().optional(),
    mutation: z
      .object({
        attempted: z.boolean(),
        occurred: z.boolean(),
        accepted: z.boolean(),
        ref: z.string().nullable(),
        correlationKey: z.string().length(64).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    postValidation: z
      .object({
        status: z.enum(CHANGE_SAFE_POST_VALIDATION_STATUSES),
        deploymentStatus: z.string().nullable(),
        observedAt: z.string().nullable(),
        applicationHealthy: z.boolean().nullable(),
        currentReleaseId: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    rollback: z
      .object({ available: z.literal(false), performed: z.literal(false) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Deterministic fingerprint. The proposal is a fixed-order JSON ARRAY of
 * primitive fields (never a key-ordered object), so identical inputs always
 * produce identical bytes. Fields: contract version, action, logical target
 * key, resolved applicationId, resolved applicationName, the full observed
 * application/deployment evidence snapshot and the deterministic status of
 * each evidence-based check (null when an optional source is unconfigured).
 */
function fingerprintProposal(fields: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

interface ChangeSafetyAssessment {
  readonly targetKey: string;
  readonly resolved: ResolvedApplicationTarget | null;
  readonly prechecks: ChangeSafeCheckReport[];
  readonly status: ChangeSafePlanStatus;
  readonly proposalFingerprint: string | null;
  readonly appEvidence: ApplicationDeploymentEvidence | null;
}

/**
 * Shared PLAN/EXECUTE assessment: resolve the target, collect fresh evidence
 * (one collect() per adapter), run the deterministic prechecks and compute
 * the proposal fingerprint (only when every required check passed). Both
 * modes use EXACTLY this logic, so the TOCTOU re-check is the same check set
 * the plan was built from.
 */
function assessChangeSafety(targetKey: string, ctx: ProContext): ChangeSafetyAssessment {
  const prechecks: ChangeSafeCheckReport[] = [];
  let requiredUnknown = false;
  let blocked = false;

  // 1) TARGET_CONFIGURED (required)
  const resolved = ctx.changeTargets[targetKey] ?? null;
  if (resolved === null) {
    prechecks.push({
      check: "TARGET_CONFIGURED",
      status: "BLOCK",
      summary: "BLOCK: logical target is not configured in the operator allowlist; no change can ever be planned for it.",
    });
    blocked = true;
  } else {
    prechecks.push({
      check: "TARGET_CONFIGURED",
      status: "PASS",
      summary: "PASS: logical target resolved against the operator allowlist.",
    });
  }

  // Evidence: one collect() per adapter per call (stateless, read-only).
  const appAdapter = ctx.applicationDeploymentAdapter;
  const appConfigured = appAdapter !== null;
  const appEvidence = appConfigured && appAdapter !== null ? appAdapter.collect() : null;
  const hostEvidence = ctx.systemHealthAdapter.collect();
  const dockerAdapter = ctx.dockerHealthAdapter;
  const dockerConfigured = dockerAdapter !== null;
  const dockerEvidence = dockerConfigured && dockerAdapter !== null ? dockerAdapter.collect() : null;

  // 2) DEPLOYMENT_EVIDENCE_AVAILABLE (required)
  if (!appConfigured) {
    prechecks.push({
      check: "DEPLOYMENT_EVIDENCE_AVAILABLE",
      status: "UNKNOWN",
      summary: "UNKNOWN: no application/deployment evidence source is configured; required planning evidence is unavailable.",
    });
    requiredUnknown = true;
  } else if (appEvidence === null) {
    prechecks.push({
      check: "DEPLOYMENT_EVIDENCE_AVAILABLE",
      status: "UNKNOWN",
      summary: "UNKNOWN: the configured application/deployment evidence source returned no evidence for this call.",
    });
    requiredUnknown = true;
  } else {
    prechecks.push({
      check: "DEPLOYMENT_EVIDENCE_AVAILABLE",
      status: "PASS",
      summary: "PASS: application/deployment evidence observed.",
    });
  }

  // 3) DEPLOYMENT_STATE_KNOWN (required)
  if (appEvidence === null) {
    prechecks.push({
      check: "DEPLOYMENT_STATE_KNOWN",
      status: "UNKNOWN",
      summary: "UNKNOWN: deployment state cannot be known without application/deployment evidence.",
    });
    requiredUnknown = true;
  } else if (appEvidence.deploymentStatus === null) {
    prechecks.push({
      check: "DEPLOYMENT_STATE_KNOWN",
      status: "UNKNOWN",
      summary: "UNKNOWN: the evidence source cannot observe the deployment status.",
    });
    requiredUnknown = true;
  } else {
    prechecks.push({
      check: "DEPLOYMENT_STATE_KNOWN",
      status: "PASS",
      summary: `PASS: deployment status observed as ${appEvidence.deploymentStatus}.`,
    });
  }

  // 4) NO_DEPLOYMENT_IN_FLIGHT (required)
  if (appEvidence === null || appEvidence.deploymentStatus === null) {
    prechecks.push({
      check: "NO_DEPLOYMENT_IN_FLIGHT",
      status: "UNKNOWN",
      summary: "UNKNOWN: in-flight state cannot be verified without an observed deployment status.",
    });
    requiredUnknown = true;
  } else if (appEvidence.deploymentStatus === "IN_PROGRESS" || appEvidence.deploymentStatus === "QUEUED") {
    prechecks.push({
      check: "NO_DEPLOYMENT_IN_FLIGHT",
      status: "BLOCK",
      summary: `BLOCK: a deployment is already ${appEvidence.deploymentStatus} for this application.`,
    });
    blocked = true;
  } else {
    prechecks.push({
      check: "NO_DEPLOYMENT_IN_FLIGHT",
      status: "PASS",
      summary: "PASS: no deployment is in flight.",
    });
  }

  // 5) VPS_HEALTH_ACCEPTABLE (required; host evidence is never null per the adapter contract)
  const vps = assessVpsHealth(hostEvidence);
  if (vps.status === "DEGRADED") {
    prechecks.push({
      check: "VPS_HEALTH_ACCEPTABLE",
      status: "BLOCK",
      summary: "BLOCK: local VPS health is DEGRADED.",
    });
    blocked = true;
  } else if (vps.status === "UNKNOWN") {
    prechecks.push({
      check: "VPS_HEALTH_ACCEPTABLE",
      status: "UNKNOWN",
      summary: "UNKNOWN: local VPS health cannot be determined; fail-closed.",
    });
    requiredUnknown = true;
  } else {
    prechecks.push({
      check: "VPS_HEALTH_ACCEPTABLE",
      status: "PASS",
      summary: "PASS: local VPS health is HEALTHY.",
    });
  }

  // 6) CAPACITY_ACCEPTABLE (required)
  const capacity = assessVpsCapacity(hostEvidence);
  if (capacity.status === "PRESSURED") {
    prechecks.push({
      check: "CAPACITY_ACCEPTABLE",
      status: "BLOCK",
      summary: "BLOCK: local capacity is PRESSURED.",
    });
    blocked = true;
  } else if (capacity.status === "UNKNOWN") {
    prechecks.push({
      check: "CAPACITY_ACCEPTABLE",
      status: "UNKNOWN",
      summary: "UNKNOWN: local capacity cannot be determined; fail-closed.",
    });
    requiredUnknown = true;
  } else {
    prechecks.push({
      check: "CAPACITY_ACCEPTABLE",
      status: "PASS",
      summary: "PASS: local capacity is OK.",
    });
  }

  // 7) APPLICATION_HEALTH (observational)
  if (!appConfigured) {
    prechecks.push({
      check: "APPLICATION_HEALTH",
      status: "NOT_CONFIGURED",
      summary: "NOT_CONFIGURED: no application evidence source; observational check only, never gates planning.",
    });
  } else if (appEvidence === null) {
    prechecks.push({
      check: "APPLICATION_HEALTH",
      status: "INFO",
      summary: "INFO (observational): no application evidence for this call; never gates planning.",
    });
  } else {
    const appHealth = assessApplicationHealth(appEvidence);
    prechecks.push({
      check: "APPLICATION_HEALTH",
      status: "INFO",
      summary: `INFO (observational): application health is ${appHealth.status}; never gates planning.`,
    });
  }

  // 8) DOCKER_HEALTH (observational; an optional capability is never turned into false required evidence)
  let dockerStatus: string | null = null;
  if (!dockerConfigured) {
    prechecks.push({
      check: "DOCKER_HEALTH",
      status: "NOT_CONFIGURED",
      summary: "NOT_CONFIGURED: no docker-health evidence source; observational check only, never gates planning.",
    });
  } else if (dockerEvidence === null) {
    prechecks.push({
      check: "DOCKER_HEALTH",
      status: "INFO",
      summary: "INFO (observational): the configured docker-health source returned no evidence for this call; never gates planning.",
    });
  } else {
    const docker = assessDockerHealth(dockerEvidence);
    dockerStatus = docker.status;
    prechecks.push({
      check: "DOCKER_HEALTH",
      status: "INFO",
      summary: `INFO (observational): docker health is ${docker.status}; never gates planning.`,
    });
  }

  const status: ChangeSafePlanStatus = requiredUnknown ? "UNKNOWN" : blocked ? "BLOCKED" : "PLAN_READY";

  // The fingerprint exists ONLY for the equivalent of PLAN_READY: a proposal
  // exists solely when every required check passed. It binds the evidence
  // snapshot used by the prechecks and the deterministic check outcomes.
  const proposalFingerprint =
    status === "PLAN_READY" && resolved !== null && appEvidence !== null
      ? fingerprintProposal([
          "change-safe-proposal/1",
          CHANGE_SAFE_ACTION,
          targetKey,
          resolved.applicationId,
          resolved.applicationName,
          appEvidence.observedAt,
          appEvidence.source,
          appEvidence.currentReleaseId,
          appEvidence.previousReleaseId,
          appEvidence.deploymentStatus,
          appEvidence.lastDeploymentFinishedAt,
          appEvidence.applicationHealthy,
          vps.status,
          capacity.status,
          dockerStatus,
        ])
      : null;

  return {
    targetKey,
    resolved,
    prechecks,
    status,
    proposalFingerprint,
    appEvidence,
  };
}

function planTarget(resolved: ResolvedApplicationTarget | null, targetKey: string) {
  return {
    key: targetKey,
    applicationName: resolved === null ? null : resolved.applicationName,
  };
}

export function planVpsChangeSafe(input: unknown, ctx: ProContext): ChangeSafePlan {
  const args = vpsChangeSafeInputSchema.parse(input);
  if (args.execute === true) {
    throw new Error("planVpsChangeSafe cannot execute; use runVpsChangeSafe for governed execution");
  }
  const assessment = assessChangeSafety(args.target, ctx);
  return {
    status: assessment.status,
    action: CHANGE_SAFE_ACTION,
    target: planTarget(assessment.resolved, assessment.targetKey),
    risk: "REQUIRES_APPROVAL",
    proposalFingerprint: assessment.proposalFingerprint,
    prechecks: assessment.prechecks,
    limitations: CHANGE_SAFE_LIMITATIONS,
  };
}

/**
 * Mandatory post-validation after an ACCEPTED mutation attempt. Never trusts
 * backend acceptance: fresh evidence must prove the outcome. VERIFIED only
 * when a NEW deployment (new release id or new finish timestamp) is reported
 * as SUCCEEDED; FAILED on explicit failure evidence; PENDING while the
 * deployment is IN_PROGRESS/QUEUED; everything unprovable is
 * UNKNOWN_REQUIRES_HUMAN_REVIEW. Unknown status NEVER becomes success.
 */
function classifyPostValidation(
  post: ApplicationDeploymentEvidence | null,
  pre: ApplicationDeploymentEvidence | null,
): ChangeSafePostValidation {
  const build = (status: ChangeSafePostValidationStatus, reason: string): ChangeSafePostValidation => ({
    status,
    deploymentStatus: post === null ? null : post.deploymentStatus,
    observedAt: post === null ? null : post.observedAt,
    applicationHealthy: post === null ? null : post.applicationHealthy,
    currentReleaseId: post === null ? null : post.currentReleaseId,
    reason,
  });
  if (post === null) {
    return build(
      "UNKNOWN_REQUIRES_HUMAN_REVIEW",
      "no deployment evidence could be re-read after the mutation; the outcome cannot be proven; human review required",
    );
  }
  if (post.deploymentStatus === "FAILED") {
    return build("FAILED", "fresh evidence reports the deployment as FAILED");
  }
  if (post.deploymentStatus === "SUCCEEDED") {
    const newRelease =
      pre !== null && pre.currentReleaseId !== null && post.currentReleaseId !== null && post.currentReleaseId !== pre.currentReleaseId;
    const newFinish =
      pre !== null && pre.lastDeploymentFinishedAt !== null && post.lastDeploymentFinishedAt !== null && post.lastDeploymentFinishedAt !== pre.lastDeploymentFinishedAt;
    if (newRelease || newFinish) {
      return build("VERIFIED", "fresh evidence shows a new deployment completed successfully");
    }
    return build(
      "UNKNOWN_REQUIRES_HUMAN_REVIEW",
      "fresh evidence reports SUCCEEDED but shows no new release or finish timestamp; a new deployment caused by this mutation cannot be proven; human review required",
    );
  }
  if (post.deploymentStatus === "IN_PROGRESS" || post.deploymentStatus === "QUEUED") {
    return build("PENDING", `fresh evidence shows the deployment is still ${post.deploymentStatus}`);
  }
  return build(
    "UNKNOWN_REQUIRES_HUMAN_REVIEW",
    "fresh evidence cannot prove the deployment outcome; human review required",
  );
}

function noMutation(correlationKey: string | null): ChangeSafeMutationRecord {
  return { attempted: false, occurred: false, accepted: false, ref: null, correlationKey };
}

/**
 * GC-08C single-flight reservation for the governed EXECUTE path.
 * Keyed by the RESOLVED applicationId (never by the caller-supplied logical
 * target name): while one EXECUTE for an applicationId is in flight on THIS
 * instance, concurrent EXECUTE calls for the SAME applicationId are refused
 * before the mutation boundary; different applicationIds never block each
 * other. Same-process scope only: no distributed lock, no persistence, no
 * cross-process/cross-machine serialization; backend idempotency NOT claimed.
 */
const inFlightApplicationIds = new Set<string>();

/** Shared EXECUTE result builder (previously the `finish` closure). */
function finishExecuteResult(
  assessment: ChangeSafetyAssessment,
  startedAt: number,
  partial: {
    status: ChangeSafeExecuteStatus;
    executed: boolean;
    reason: string | null;
    mutation: ChangeSafeMutationRecord;
    postValidation: ChangeSafePostValidation | null;
  },
): ChangeSafeExecuteResult {
  const durationMs = Date.now() - startedAt;
  // Metadata-only audit: no applicationId, no URL, no credential, no shell.
  console.log(
    JSON.stringify({
      event: "engineering.vps.change.safe",
      mode: "EXECUTE",
      action: CHANGE_SAFE_ACTION,
      targetKey: assessment.targetKey,
      status: partial.status,
      executed: partial.executed,
      mutationAttempted: partial.mutation.attempted,
      mutationAccepted: partial.mutation.accepted,
      correlationKey: assessment.proposalFingerprint,
      durationMs,
    }),
  );
  // Keys are inserted in sorted order for deterministic serialized output.
  return {
    action: CHANGE_SAFE_ACTION,
    executed: partial.executed,
    limitations: CHANGE_SAFE_LIMITATIONS,
    mutation: partial.mutation,
    postValidation: partial.postValidation,
    prechecks: assessment.prechecks,
    proposalFingerprint: assessment.proposalFingerprint,
    reason: partial.reason,
    risk: "REQUIRES_APPROVAL",
    rollback: { available: false, performed: false },
    status: partial.status,
    target: planTarget(assessment.resolved, assessment.targetKey),
  };
}

/**
 * Refusal for a concurrently executing SAME resolved applicationId. Existing
 * domain vocabulary is reused (status BLOCKED, executed=false, zero mutation,
 * postValidation=null). The ONLY new vocabulary is the reason marker
 * SIMULTANEOUS_EXECUTION_FOR_SAME_APPLICATION_ID_IN_FLIGHT, needed so callers
 * and tests can distinguish this refusal from evidence-based BLOCK results.
 */
function buildSimultaneousExecutionRefusal(
  assessment: ChangeSafetyAssessment,
  startedAt: number,
): ChangeSafeExecuteResult {
  return finishExecuteResult(assessment, startedAt, {
    status: "BLOCKED",
    executed: false,
    reason:
      "SIMULTANEOUS_EXECUTION_FOR_SAME_APPLICATION_IDENTIFIER_IN_FLIGHT: another execution on this instance already holds the single-flight reservation for the same resolved application identifier; the concurrent execution is refused before the mutation boundary; zero mutation performed",
    mutation: noMutation(null),
    postValidation: null,
  });
}

async function executeVpsChangeSafe(args: VpsChangeSafeInput, ctx: ProContext): Promise<ChangeSafeExecuteResult> {
  const startedAt = Date.now();
  const assessment = assessChangeSafety(args.target, ctx);
  // Synchronous check+add with NO await in between: atomic on this instance.
  // Key = RESOLVED applicationId (operator allowlist), never the caller key.
  const reservationKey = assessment.resolved === null ? null : assessment.resolved.applicationId;
  if (reservationKey !== null && inFlightApplicationIds.has(reservationKey)) {
    return buildSimultaneousExecutionRefusal(assessment, startedAt);
  }
  if (reservationKey !== null) {
    inFlightApplicationIds.add(reservationKey);
  }
  try {
    return await executeVpsChangeSafeGated(args, ctx, assessment, startedAt);
  } finally {
    // Mandatory release on EVERY path (refusal, upstream error, throw, success).
    if (reservationKey !== null) {
      inFlightApplicationIds.delete(reservationKey);
    }
  }
}

async function executeVpsChangeSafeGated(
  args: VpsChangeSafeInput,
  ctx: ProContext,
  assessment: ChangeSafetyAssessment,
  startedAt: number,
): Promise<ChangeSafeExecuteResult> {
  const finish = (partial: {
    status: ChangeSafeExecuteStatus;
    executed: boolean;
    reason: string | null;
    mutation: ChangeSafeMutationRecord;
    postValidation: ChangeSafePostValidation | null;
  }): ChangeSafeExecuteResult => finishExecuteResult(assessment, startedAt, partial);

  // Gate 1 - approval binding. An absent or not-granted approval NEVER mutates
  // and never creates authority (authority stays with the operator allowlist).
  const approval = args.approval;
  if (approval === undefined || approval.approved !== true) {
    return finish({
      status: "APPROVAL_REQUIRED",
      executed: false,
      reason:
        "execution requires approval.approved=true with the proposalFingerprint of the plan being executed; zero mutation performed",
      mutation: noMutation(null),
      postValidation: null,
    });
  }

  // Gate 2 - fresh prechecks (TOCTOU step: the SAME checks must still pass).
  if (assessment.status === "BLOCKED") {
    const blocker = assessment.prechecks.find((check) => check.status === "BLOCK");
    return finish({
      status: "BLOCKED",
      executed: false,
      reason: `prechecks blocked the change (${blocker?.check ?? "unknown check"}); zero mutation performed`,
      mutation: noMutation(null),
      postValidation: null,
    });
  }
  if (assessment.status === "UNKNOWN") {
    const unknowable = assessment.prechecks.find((check) => check.status === "UNKNOWN");
    return finish({
      status: "UNKNOWN",
      executed: false,
      reason: `required evidence is unknown (${unknowable?.check ?? "unknown check"}); zero mutation performed`,
      mutation: noMutation(null),
      postValidation: null,
    });
  }

  // Gate 3 - snapshot/TOCTOU binding: the recomputed fingerprint of the FRESH
  // evidence must equal the approved proposalFingerprint exactly.
  const fingerprint = assessment.proposalFingerprint;
  if (fingerprint === null || approval.proposalFingerprint !== fingerprint) {
    return finish({
      status: "SNAPSHOT_CHANGED",
      executed: false,
      reason:
        "fresh evidence no longer matches approval.proposalFingerprint; re-plan and re-approve; zero mutation performed",
      mutation: noMutation(null),
      postValidation: null,
    });
  }

  // Gate 4 - the mutation capability must be operator-configured (fail-closed).
  const adapter: SafeChangeAdapter | null = ctx.safeChangeAdapter;
  const resolved = assessment.resolved;
  if (adapter === null || resolved === null) {
    return finish({
      status: "BLOCKED",
      executed: false,
      reason:
        "no mutation adapter is configured on this server (the operator must configure the change backend); zero mutation performed",
      mutation: noMutation(null),
      postValidation: null,
    });
  }

  // Mutation: exactly ONE attempt through the single allowed capability.
  let outcome: SafeChangeOutcome;
  try {
    outcome = await adapter.redeploy(resolved, fingerprint);
  } catch (error) {
    outcome = {
      accepted: false,
      ref: null,
      message: error instanceof Error ? error.message : "mutation adapter threw",
    };
  }

  if (!outcome.accepted) {
    // No retry. The outcome is honestly unconfirmed, never a success.
    return finish({
      status: "MUTATION_UPSTREAM_ERROR",
      executed: true,
      reason: `mutation call failed or was not accepted by the backend; no retry, no auto-recovery (${outcome.message})`,
      mutation: { attempted: true, occurred: false, accepted: false, ref: null, correlationKey: fingerprint },
      postValidation: null,
    });
  }

  // Mandatory post-validation: re-query read-only evidence. Backend
  // acceptance is NOT success; only fresh evidence can verify.
  const postEvidence =
    ctx.applicationDeploymentAdapter !== null ? ctx.applicationDeploymentAdapter.collect() : null;
  const postValidation = classifyPostValidation(postEvidence, assessment.appEvidence);
  return finish({
    status: postValidation.status,
    executed: true,
    reason: postValidation.reason,
    mutation: { attempted: true, occurred: true, accepted: true, ref: outcome.ref, correlationKey: fingerprint },
    postValidation,
  });
}

/**
 * Registered entry point: PLAN (execute absent/false) or governed EXECUTE.
 */
export async function runVpsChangeSafe(
  input: unknown,
  ctx: ProContext,
): Promise<ChangeSafePlan | ChangeSafeExecuteResult> {
  const args = vpsChangeSafeInputSchema.parse(input);
  if (args.execute === true) {
    return executeVpsChangeSafe(args, ctx);
  }
  return planVpsChangeSafe(args, ctx);
}
