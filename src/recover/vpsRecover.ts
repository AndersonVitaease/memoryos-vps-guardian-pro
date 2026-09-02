/**
 * engineering.vps.recover — controlled official-rollback recovery Supertool.
 * Ported from the certified ENG-MCP implementation (src/vpsRecover.ts) with
 * certified semantics preserved EXACTLY:
 *
 * Scope is hardcoded: the ONLY mutable operation is the official release
 * runner rollback. The caller can never choose operation, target,
 * applicationId, toolName, command, shell, URL, socket, headers, token, image
 * or container: the input schema is strictly { execute?, approval? } and the
 * runner operation is a fixed constant sent over the operator-injected runner
 * channel (runRunner dep; no new gateway/scheduler/executor/provider exists).
 *
 * PLAN mode (execute defaults to false) is fully read-only: it deterministically
 * reuses engineering.vps.reconcile (runVpsReconcile), checks the last-known-good
 * evidence in the operator-configured release-state file
 * (previousContainer/previousImage) and evaluates blockers. Reconcile UNKNOWN
 * blocks recovery; reconcile IN_SYNC is BLOCKED (NOTHING_TO_RECOVER); only
 * DRIFTED may proceed when the other requirements pass. The existing in-flight
 * job signal (deployStatus=IN_PROGRESS) is reused to refuse incompatible jobs.
 *
 * Mutation requires execute=true AND approval.approved=true SIMULTANEOUSLY.
 * The runner answers 202 {accepted, jobId, status:"queued"} for rollback:
 * 202/queued is NEVER RECOVERED. Bounded official job status polling; on
 * exhaustion or disconnection it returns UNKNOWN/pending with the durable
 * jobId. Post-validation only runs after a REAL rolled_back job: official
 * smoke (which re-syncs the release-state production fields), live catalog,
 * then a fresh reconcile. RECOVERED requires smoke PASS + live catalog +
 * reconcile IN_SYNC; failed validation -> NOT_RECOVERED; insufficient
 * evidence -> UNKNOWN. No LLM; no SSH/shell; never writes the release-state
 * file.
 *
 * Only real incompatibility adapted (integration, not semantics): the
 * certified original read release-state.json under ENG_MCP_REPOSITORY_ROOT;
 * the Pro reads the operator-configured release-state file path from its
 * existing environment convention (same as reconcile).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runVpsReconcile } from "../reconcile/vpsReconcile";
import { RECONCILE_RELEASE_STATE_FILE_ENV } from "../reconcile/vpsReconcile";

export const VPS_RECOVER_STATUSES = ["PLAN", "RECOVERED", "NOT_RECOVERED", "BLOCKED", "UNKNOWN"] as const;
export type VpsRecoverStatus = (typeof VPS_RECOVER_STATUSES)[number];

export const vpsRecoverInputSchema = z
  .object({
    execute: z.boolean().optional(),
    approval: z.object({ approved: z.boolean() }).strict().optional(),
  })
  .strict();
export type VpsRecoverInput = z.infer<typeof vpsRecoverInputSchema>;

export type VpsRecoverRunnerOperation = "rollback" | "status" | "smoke";
export interface VpsRecoverRunnerResponse {
  httpStatus: number;
  body: unknown;
}

export interface VpsRecoverCatalog {
  catalogHash?: string;
  catalogVersion?: string;
  toolCount?: number;
}

export interface VpsRecoverDeps {
  runRunner?: (operation: VpsRecoverRunnerOperation, jobId?: string) => Promise<VpsRecoverRunnerResponse>;
  readReleaseState?: () => Promise<unknown>;
  readCatalog?: () => Promise<VpsRecoverCatalog | null>;
  pollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface VpsRecoverFinding {
  code: string;
  severity: "critical" | "warning" | "info";
  detail?: string;
  httpStatus?: number;
}

export interface VpsRecoverPrecheck {
  reconcile: { status: string; findings: unknown[] };
  lkgPresent: boolean;
  jobInProgress: boolean;
  blockers: string[];
}

export interface VpsRecoverResult {
  status: VpsRecoverStatus;
  mutationPerformed: boolean;
  precheck: VpsRecoverPrecheck;
  plan: { action: "rollback"; possible: boolean; requires: string[] };
  execution?: { accepted: boolean; jobId: string; status: string };
  pending?: true;
  jobId?: string;
  nextAction?: string;
  validation?: { smoke: "PASS" | "FAIL" | "NOT_RUN"; reconcile: string; catalog: VpsRecoverCatalog | null };
  findings: VpsRecoverFinding[];
}

const JOB_ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const PLAN_REQUIRES = ["execute=true", "approval.approved=true"];

/**
 * Default expected-state reader: the operator-configured release-state file
 * (existing Pro convention, same surface as reconcile). Absent env or any
 * read/parse failure yields null. Never writes anything.
 */
export async function defaultRecoverReadReleaseState(
  read: (name: string) => string | undefined = (name) => process.env[name],
): Promise<unknown> {
  const filePath = read(RECONCILE_RELEASE_STATE_FILE_ENV);
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runVpsRecover(rawInput: unknown, deps: VpsRecoverDeps = {}): Promise<VpsRecoverResult> {
  const input = vpsRecoverInputSchema.parse(rawInput ?? {});
  const runRunner = deps.runRunner;
  const readReleaseState = deps.readReleaseState ?? defaultRecoverReadReleaseState;
  const readCatalog = deps.readCatalog ?? (async (): Promise<VpsRecoverCatalog | null> => null);
  const pollAttempts = deps.pollAttempts ?? 3;
  const pollDelayMs = deps.pollDelayMs ?? 2_000;
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const findings: VpsRecoverFinding[] = [];
  const blockers: string[] = [];
  const pushFinding = (code: string, severity: VpsRecoverFinding["severity"], extra: { detail?: string; httpStatus?: number } = {}): void => {
    findings.push({ code, severity, ...extra });
  };
  const pushBlocker = (code: string): void => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  // 1. Expected state (raw, read once) + last-known-good + existing in-flight signal.
  let rawState: unknown = null;
  try {
    rawState = await readReleaseState();
  } catch {
    rawState = null;
  }
  const state = asRecord(rawState);
  const lkgPresent = Boolean(nonEmptyString(state?.previousContainer) && nonEmptyString(state?.previousImage));
  const jobInProgress = state?.deployStatus === "IN_PROGRESS";

  // 2. Deterministic reuse of engineering.vps.reconcile (container inspection is
  // not injected here, exactly like the reconcile registration site).
  let reconcile: { status: string; findings: unknown[] } = { status: "UNKNOWN", findings: [] };
  try {
    const result = await runVpsReconcile({ readReleaseState: async () => rawState, readCatalog: readCatalog });
    reconcile = { status: result.status, findings: result.findings };
  } catch {
    reconcile = { status: "UNKNOWN", findings: [] };
  }

  const precheck: VpsRecoverPrecheck = { reconcile, lkgPresent, jobInProgress, blockers };
  const plan = { action: "rollback" as const, possible: false, requires: PLAN_REQUIRES };
  const result: VpsRecoverResult = { status: "UNKNOWN", mutationPerformed: false, precheck, plan, findings };

  // 3. Strict precheck.
  if (reconcile.status === "UNKNOWN") {
    pushBlocker("RECONCILE_UNKNOWN");
    pushFinding("RECONCILE_UNKNOWN", "warning", { detail: "reconcile could not determine expected vs actual state; recovery is refused" });
    return result;
  }
  if (reconcile.status === "IN_SYNC") {
    pushBlocker("NOTHING_TO_RECOVER");
    pushFinding("NOTHING_TO_RECOVER", "info", { detail: "reconcile is IN_SYNC; production matches the release runner expected state" });
    result.status = "BLOCKED";
    return result;
  }
  if (!lkgPresent) {
    pushBlocker("LKG_MISSING");
    pushFinding("LKG_MISSING", "critical", { detail: "release-state.json has no last-known-good evidence (previousContainer/previousImage)" });
    result.status = "BLOCKED";
    return result;
  }
  if (jobInProgress) {
    pushBlocker("JOB_IN_PROGRESS");
    pushFinding("JOB_IN_PROGRESS", "warning", { detail: "an incompatible release job is in progress (deployStatus=IN_PROGRESS)" });
    result.status = "BLOCKED";
    return result;
  }
  plan.possible = true;

  // 4. PLAN mode (execute defaults to false) — zero mutation.
  if (input.execute !== true) {
    result.status = "PLAN";
    return result;
  }

  // 5. Approval gate: execute=true AND approval.approved=true are required together.
  if (input.approval?.approved !== true) {
    pushBlocker("APPROVAL_REQUIRED");
    pushFinding("APPROVAL_REQUIRED", "critical", { detail: "mutation requires execute=true AND approval.approved=true" });
    result.status = "BLOCKED";
    return result;
  }

  // 6. Execution: official runner rollback. The operation is a fixed constant;
  // the runner channel is injected; nothing caller-controlled reaches the request.
  if (!runRunner) {
    pushFinding("RUNNER_UNAVAILABLE", "warning", { detail: "official release runner channel is not available" });
    return result;
  }
  let jobId: string;
  try {
    const accepted = await runRunner("rollback");
    const body = asRecord(accepted.body);
    const candidateJobId = nonEmptyString(body?.jobId);
    if (accepted.httpStatus !== 202 || body?.accepted !== true || body?.status !== "queued" || !candidateJobId || !JOB_ID_PATTERN.test(candidateJobId)) {
      const errorText = typeof body?.error === "string" ? body.error.slice(0, 256) : "no error detail";
      pushFinding("ROLLBACK_NOT_ACCEPTED", "critical", { httpStatus: accepted.httpStatus, detail: `official runner did not accept the rollback request: ${errorText}` });
      result.status = "NOT_RECOVERED";
      return result;
    }
    jobId = candidateJobId;
  } catch (error) {
    pushFinding("RUNNER_UNAVAILABLE", "warning", { detail: `official runner unreachable: ${error instanceof Error ? error.message.slice(0, 256) : "unknown error"}` });
    return result;
  }

  // A rollback job was accepted by the official runner: a real mutation attempt
  // exists from here on, on every downstream outcome.
  result.mutationPerformed = true;
  result.jobId = jobId;
  result.execution = { accepted: true, jobId, status: "queued" };

  // 7. Bounded official job status polling (202/queued is NEVER RECOVERED).
  const pendingUnknown = (code: string, detail: string, nextAction: string): VpsRecoverResult => {
    pushFinding(code, "warning", { detail });
    result.status = "UNKNOWN";
    result.pending = true;
    result.nextAction = nextAction;
    return result;
  };
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleep(pollDelayMs);
    let statusBody: Record<string, unknown> | null;
    try {
      const response = await runRunner("status", jobId);
      statusBody = asRecord(response.body);
      if (response.httpStatus !== 200 || statusBody?.operation !== "status" || statusBody?.success !== true) statusBody = null;
    } catch {
      statusBody = null;
    }
    if (statusBody === null) {
      return pendingUnknown(
        "JOB_STATUS_UNAVAILABLE",
        "official job status could not be confirmed; the rollback container replacement likely disconnected this call",
        `Official rollback job ${jobId} is pending in the durable runner; reconnect and re-run engineering.vps.recover to re-evaluate. 202/queued is never RECOVERED.`,
      );
    }
    const job = asRecord(statusBody.job);
    const jobStatus = nonEmptyString(job?.status) ?? "unknown";
    if (job?.jobId !== jobId || job?.operation !== "rollback") {
      return pendingUnknown(
        "JOB_IDENTITY_MISMATCH",
        "official job status did not match the accepted rollback job",
        `Official rollback job ${jobId} could not be confirmed; reconnect and re-run engineering.vps.recover to re-evaluate.`,
      );
    }
    result.execution = { accepted: true, jobId, status: jobStatus };
    if (jobStatus === "rolled_back") return finishPostValidation(result, { runRunner, readReleaseState, readCatalog, pushFinding });
    if (jobStatus === "failed") {
      const jobError = typeof job.error === "string" ? job.error.slice(0, 256) : "no error detail";
      pushFinding("ROLLBACK_JOB_FAILED", "critical", { detail: `official rollback job failed: ${jobError}` });
      result.status = "NOT_RECOVERED";
      return result;
    }
    if (jobStatus !== "queued" && jobStatus !== "running") {
      return pendingUnknown(
        "JOB_STATUS_UNEXPECTED",
        `official job reported unexpected status: ${jobStatus.slice(0, 64)}`,
        `Official rollback job ${jobId} is in an unexpected state; reconnect and re-run engineering.vps.recover to re-evaluate.`,
      );
    }
  }
  return pendingUnknown(
    "JOB_STILL_PENDING",
    "official rollback job is still queued/running after the bounded polling window",
    `Official rollback job ${jobId} remains queued/running in the durable runner; reconnect and re-run engineering.vps.recover to re-evaluate. 202/queued is never RECOVERED.`,
  );

  // 8. Post-validation after a REAL rolled_back job: official smoke (which also
  // re-syncs the release-state production fields left stale by rollbackAction),
  // live catalog evidence, then a fresh deterministic reconcile.
  async function finishPostValidation(
    current: VpsRecoverResult,
    context: {
      runRunner: NonNullable<VpsRecoverDeps["runRunner"]>;
      readReleaseState: () => Promise<unknown>;
      readCatalog: () => Promise<VpsRecoverCatalog | null>;
      pushFinding: typeof pushFinding;
    },
  ): Promise<VpsRecoverResult> {
    const validation: NonNullable<VpsRecoverResult["validation"]> = { smoke: "NOT_RUN", reconcile: "UNKNOWN", catalog: null };

    // 8.1 Official smoke first (official mechanism that re-syncs the release-state
    // productionCatalogHash/toolCount/catalogVersion/productionImageId with live
    // production after the rollback).
    try {
      const smoke = await context.runRunner("smoke");
      const body = asRecord(smoke.body);
      if (smoke.httpStatus === 200 && body?.operation === "smoke" && body?.success === true) validation.smoke = "PASS";
      else {
        validation.smoke = "FAIL";
        context.pushFinding("SMOKE_FAILED", "critical", { httpStatus: smoke.httpStatus, detail: "official smoke did not pass after the rollback" });
      }
    } catch (error) {
      validation.smoke = "FAIL";
      context.pushFinding("SMOKE_FAILED", "critical", { detail: `official smoke unreachable: ${error instanceof Error ? error.message.slice(0, 256) : "unknown error"}` });
    }
    if (validation.smoke !== "PASS") {
      current.status = "NOT_RECOVERED";
      current.validation = validation;
      return current;
    }

    // 8.2 Live catalog evidence.
    let catalog: VpsRecoverCatalog | null = null;
    try {
      catalog = await context.readCatalog();
    } catch {
      catalog = null;
    }
    validation.catalog = catalog;

    // 8.3 Fresh reconcile against the re-synced expected state.
    let freshState: unknown = null;
    try {
      freshState = await context.readReleaseState();
    } catch {
      freshState = null;
    }
    try {
      const fresh = await runVpsReconcile({ readReleaseState: async () => freshState, readCatalog: () => context.readCatalog() });
      validation.reconcile = fresh.status;
    } catch {
      validation.reconcile = "UNKNOWN";
    }

    current.validation = validation;
    if (validation.reconcile === "IN_SYNC") {
      current.status = "RECOVERED";
      return current;
    }
    if (validation.reconcile === "DRIFTED") {
      context.pushFinding("RECONCILE_DRIFTED_AFTER_ROLLBACK", "critical", { detail: "expected state is incoherent with the rolled-back production: the official smoke re-sync did not converge" });
      current.status = "NOT_RECOVERED";
      return current;
    }
    context.pushFinding("VALIDATION_INSUFFICIENT", "warning", { detail: "post-rollback evidence is insufficient (live catalog or expected state unavailable)" });
    current.status = "UNKNOWN";
    return current;
  }
}
