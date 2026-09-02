/**
 * engineering.vps.change.safe V1 - PLAN_ONLY (private Supertool).
 *
 * This tool NEVER executes a change. It turns a logical operator-configured
 * target plus current read-only evidence into a deterministic, fingerprinted
 * PLAN (PLAN_READY | BLOCKED | UNKNOWN) with fixed risk REQUIRES_APPROVAL.
 * Execution, approval and mutation authority belong to a future sprint: no
 * mutation primitive exists in this process, and none is created here.
 *
 * Security boundary of this file:
 * - Input is a closed schema: action (single literal) + logical target key.
 *   No command, shell, script, SSH, host, IP, URL, path, token, credential,
 *   execute flag, approval or raw arguments are ever accepted.
 * - The logical target key resolves ONLY against the operator-configured
 *   allowlist injected in ProContext (construction time). The agent never
 *   supplies an applicationId, host, URL or credential; the resolved real
 *   applicationId is never exposed in the output (it only feeds the
 *   fingerprint hash).
 * - Evidence is collected exclusively through the pinned public read-only
 *   adapters (one collect() per adapter per call, stateless, no I/O here).
 * - proposalFingerprint is OUTPUT only. It authorizes nothing; it is the
 *   deterministic anchor a future approval/TOCTOU binding contract will use.
 * - Fail-closed precedence: any REQUIRED check UNKNOWN -> UNKNOWN; else any
 *   BLOCK -> BLOCKED; else PLAN_READY. PLAN_READY is NOT approval, NOT a
 *   safety guarantee and NOT execution.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { assessVpsHealth } from "memoryos-vps-guardian/src/tools/vpsHealth";
import { assessVpsCapacity } from "memoryos-vps-guardian/src/tools/vpsCapacity";
import { assessApplicationHealth } from "memoryos-vps-guardian/src/tools/applicationDeployment";
import { assessDockerHealth } from "memoryos-vps-guardian/src/tools/dockerHealth";
import type { ProContext } from "../proContext";

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

export const vpsChangeSafeInputSchema = z
  .object({
    action: z.literal(CHANGE_SAFE_ACTION),
    target: z.string().min(1).max(200),
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
 * REQUIRED checks gate the plan (BLOCK/UNKNOWN influence the verdict).
 * APPLICATION_HEALTH and DOCKER_HEALTH are OBSERVATIONAL: assessed semantics
 * show no public rule gates redeploy planning on them (application DEGRADED
 * is exactly the condition a redeploy may remediate), so they are reported
 * as INFO/NOT_CONFIGURED and never gate the plan.
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
 * observational check that never gates the plan; NOT_CONFIGURED marks an
 * optional evidence source that is not configured (never read as healthy
 * and never read as authority).
 */
export type ChangeSafeCheckStatus = "PASS" | "BLOCK" | "UNKNOWN" | "NOT_CONFIGURED" | "INFO";

export type ChangeSafePlanStatus = "PLAN_READY" | "BLOCKED" | "UNKNOWN";

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

export const CHANGE_SAFE_LIMITATIONS: readonly string[] = [
  "PLAN_ONLY: this tool never executes a change; approval and execution belong to a future sprint.",
  "PLAN_READY only means the current prechecks permit forming a proposal that still requires approval and future execution; it is not approval, not a safety guarantee and not execution.",
  "No mutation primitive exists in this process: no shell, no SSH, no network call, no child process, no credential access, no redeploy.",
  "proposalFingerprint is OUTPUT only and authorizes nothing; it is the deterministic anchor for a future approval/TOCTOU binding contract.",
  "APPLICATION_HEALTH and DOCKER_HEALTH are observational checks; they never gate the plan and are never read as authority.",
];

export const vpsChangeSafeOutputSchema = z
  .object({
    status: z.enum(["PLAN_READY", "BLOCKED", "UNKNOWN"]),
    action: z.literal(CHANGE_SAFE_ACTION),
    target: z
      .object({ key: z.string(), applicationName: z.string().nullable() })
      .strict(),
    risk: z.literal("REQUIRES_APPROVAL"),
    proposalFingerprint: z.string().length(64).nullable(),
    prechecks: z.array(
      z
        .object({
          check: z.enum(CHANGE_SAFE_CHECKS),
          status: z.enum(["PASS", "BLOCK", "UNKNOWN", "NOT_CONFIGURED", "INFO"]),
          summary: z.string(),
        })
        .strict(),
    ),
    limitations: z.array(z.string()),
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

export function planVpsChangeSafe(input: unknown, ctx: ProContext): ChangeSafePlan {
  const args = vpsChangeSafeInputSchema.parse(input);

  const prechecks: ChangeSafeCheckReport[] = [];
  let requiredUnknown = false;
  let blocked = false;

  // 1) TARGET_CONFIGURED (required)
  const resolved = ctx.changeTargets[args.target] ?? null;
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

  // The fingerprint exists ONLY for PLAN_READY: a proposal exists solely when
  // every required check passed. It binds the evidence snapshot used by the
  // prechecks and the deterministic check outcomes.
  const proposalFingerprint =
    status === "PLAN_READY" && resolved !== null && appEvidence !== null
      ? fingerprintProposal([
          "change-safe-proposal/1",
          CHANGE_SAFE_ACTION,
          args.target,
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
    status,
    action: CHANGE_SAFE_ACTION,
    target: {
      key: args.target,
      applicationName: resolved === null ? null : resolved.applicationName,
    },
    risk: "REQUIRES_APPROVAL",
    proposalFingerprint,
    prechecks,
    limitations: CHANGE_SAFE_LIMITATIONS,
  };
}

/**
 * Future boundary ONLY (not used by PLAN_ONLY and intentionally NOT
 * implemented): the single private component that would ever hold mutation
 * authority in a later sprint. It must accept ONLY operator-resolved
 * targets - never agent input, never credentials from callers.
 */
export interface FutureSafeChangeAdapter {
  readonly name: string;
  redeploy(
    resolved: ResolvedApplicationTarget,
    idempotencyKey: string,
  ): Promise<{ accepted: boolean; ref: string | null; message: string }>;
}
