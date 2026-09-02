/**
 * engineering.vps.recover — certification suite (adapted from the certified
 * ENG-MCP behaviors). All tests inject FAKE deps: no filesystem, no env, no
 * network, no socket, no LLM, no SSH/shell, no real runner, zero real
 * mutation. Deterministic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { runVpsRecover } from "../src/recover/vpsRecover";
import type { VpsRecoverDeps, VpsRecoverRunnerResponse } from "../src/recover/vpsRecover";
import { vpsRecoverInputSchema } from "../src/recover/vpsRecover";

const JOB_ID = "abcd1234abcd1234abcd1234abcd1234";

const driftedState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  currentRelease: "pro-candidate:release-2",
  previousContainer: "pro-candidate:release-1",
  previousImage: "sha256:previous-fake",
  productionCatalogHash: "85049df6-fake",
  toolCount: 13,
  catalogVersion: "pro-tools-v0.1.0",
  deployStatus: "PASS",
  smokeStatus: "PASS",
  ...over,
});

const catalog = { catalogHash: "85049df6-fake", catalogVersion: "pro-tools-v0.1.0", toolCount: 13 };

/** Base deps: reconcile DRIFTED (live catalog hash differs from expected), LKG present, no job in flight. */
function baseDeps(over: VpsRecoverDeps = {}, stateOver: Record<string, unknown> = {}): VpsRecoverDeps {
  return {
    readReleaseState: async () => driftedState(stateOver),
    readCatalog: async () => ({ catalogHash: "live-catalog-fake", catalogVersion: "pro-tools-v0.1.0", toolCount: 13 }),
    pollAttempts: 2,
    pollDelayMs: 0,
    sleep: async () => {},
    ...over,
  };
}

const accepted: VpsRecoverRunnerResponse = { httpStatus: 202, body: { accepted: true, jobId: JOB_ID, status: "queued" } };
const rolledBack: VpsRecoverRunnerResponse = {
  httpStatus: 200,
  body: { operation: "status", success: true, job: { jobId: JOB_ID, operation: "rollback", status: "rolled_back" } },
};
const running: VpsRecoverRunnerResponse = {
  httpStatus: 200,
  body: { operation: "status", success: true, job: { jobId: JOB_ID, operation: "rollback", status: "running" } },
};
const smokePass: VpsRecoverRunnerResponse = { httpStatus: 200, body: { operation: "smoke", success: true } };

/** runRunner fake: rollback -> accepted; status -> scripted; smoke -> scripted. */
function fakeRunner(statusScript: VpsRecoverRunnerResponse[], smoke: VpsRecoverRunnerResponse = smokePass) {
  let calls = 0;
  const seen: string[] = [];
  return {
    seen,
    runRunner: async (operation: "rollback" | "status" | "smoke", jobId?: string): Promise<VpsRecoverRunnerResponse> => {
      seen.push(operation + (jobId ? ":" + jobId : ""));
      if (operation === "rollback") return accepted;
      if (operation === "status") return statusScript[Math.min(calls++, statusScript.length - 1)];
      return smoke;
    },
  };
}

describe("engineering.vps.recover precheck gates (zero mutation)", () => {
  it("reconcile UNKNOWN -> BLOCKED refus: recovery refused with RECONCILE_UNKNOWN", async () => {
    const result = await runVpsRecover({}, baseDeps({ readCatalog: async () => null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.mutationPerformed).toBe(false);
    expect(result.precheck.blockers).toContain("RECONCILE_UNKNOWN");
  });

  it("reconcile IN_SYNC -> BLOCKED NOTHING_TO_RECOVER (nothing to recover)", async () => {
    const result = await runVpsRecover(
      {},
      baseDeps({ readCatalog: async () => catalog }),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.precheck.blockers).toContain("NOTHING_TO_RECOVER");
    expect(result.plan.possible).toBe(false);
  });

  it("DRIFTED without last-known-good -> BLOCKED LKG_MISSING", async () => {
    const result = await runVpsRecover({}, baseDeps({}, { previousContainer: undefined, previousImage: undefined }));
    expect(result.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.precheck.blockers).toContain("LKG_MISSING");
  });

  it("DRIFTED with an in-flight job -> BLOCKED JOB_IN_PROGRESS (incompatible job)", async () => {
    const result = await runVpsRecover({}, baseDeps({}, { deployStatus: "IN_PROGRESS" }));
    expect(result.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.precheck.blockers).toContain("JOB_IN_PROGRESS");
  });

  it("DRIFTED + LKG + no in-flight job -> PLAN with plan.possible=true and requires listed", async () => {
    const result = await runVpsRecover({}, baseDeps());
    expect(result.status).toBe("PLAN");
    expect(result.mutationPerformed).toBe(false);
    expect(result.plan).toEqual({ action: "rollback", possible: true, requires: ["execute=true", "approval.approved=true"] });
    expect(result.precheck.blockers).toEqual([]);
  });

  it("execute=true without approval -> BLOCKED APPROVAL_REQUIRED, zero mutation", async () => {
    const result = await runVpsRecover({ execute: true }, baseDeps());
    expect(result.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.precheck.blockers).toContain("APPROVAL_REQUIRED");
  });

  it("approved recovery without a runner channel -> RUNNER_UNAVAILABLE, zero mutation (fail-closed)", async () => {
    const result = await runVpsRecover({ execute: true, approval: { approved: true } }, baseDeps());
    expect(result.status).toBe("UNKNOWN");
    expect(result.mutationPerformed).toBe(false);
    expect(result.findings.some((f) => f.code === "RUNNER_UNAVAILABLE")).toBe(true);
  });
});

describe("engineering.vps.recover governed execution through the injected runner channel", () => {
  it("full happy path: accepted 202 -> rolled_back -> smoke PASS + fresh reconcile IN_SYNC -> RECOVERED", async () => {
    const runner = fakeRunner([rolledBack]);
    // The official smoke re-syncs the release-state production fields: the fresh
    // read after the rollback sees the LIVE catalog hash (simulating the re-sync).
    let readCount = 0;
    const result = await runVpsRecover(
      { execute: true, approval: { approved: true } },
      baseDeps({
        runRunner: runner.runRunner,
        readReleaseState: async () => (readCount++ === 0 ? driftedState() : { ...driftedState(), productionCatalogHash: "live-catalog-fake" }),
      }),
    );
    expect(result.status).toBe("RECOVERED");
    expect(result.mutationPerformed).toBe(true);
    expect(result.jobId).toBe(JOB_ID);
    expect(result.execution).toEqual({ accepted: true, jobId: JOB_ID, status: "rolled_back" });
    expect(result.validation).toEqual({ smoke: "PASS", reconcile: "IN_SYNC", catalog: { catalogHash: "live-catalog-fake", catalogVersion: "pro-tools-v0.1.0", toolCount: 13 } });
    // Only the three fixed operations, with the fixed jobId; nothing caller-controlled.
    expect(runner.seen).toEqual([`rollback`, `status:${JOB_ID}`, "smoke"]);
  });

  it("rollback rejected by the official runner -> NOT_RECOVERED with zero mutation attempt recorded", async () => {
    const runner = fakeRunner([]);
    const bad = { httpStatus: 500, body: { accepted: false, error: "runner refused" } };
    const result = await runVpsRecover(
      { execute: true, approval: { approved: true } },
      baseDeps({ runRunner: async (op) => (op === "rollback" ? bad : smokePass) }),
    );
    expect(result.status).toBe("NOT_RECOVERED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.findings.some((f) => f.code === "ROLLBACK_NOT_ACCEPTED" && f.severity === "critical")).toBe(true);
    void runner;
  });

  it("job failed -> NOT_RECOVERED (mutation happened, validation refuses success)", async () => {
    const failed: VpsRecoverRunnerResponse = {
      httpStatus: 200,
      body: { operation: "status", success: true, job: { jobId: JOB_ID, operation: "rollback", status: "failed", error: "replacement failed" } },
    };
    const result = await runVpsRecover({ execute: true, approval: { approved: true } }, baseDeps({ runRunner: fakeRunner([failed]).runRunner }));
    expect(result.status).toBe("NOT_RECOVERED");
    expect(result.mutationPerformed).toBe(true);
    expect(result.findings.some((f) => f.code === "ROLLBACK_JOB_FAILED")).toBe(true);
  });

  it("polling exhaustion (job still running) -> UNKNOWN/pending with durable jobId; 202/queued never RECOVERED", async () => {
    const result = await runVpsRecover({ execute: true, approval: { approved: true } }, baseDeps({ runRunner: fakeRunner([running]).runRunner }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.mutationPerformed).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe(JOB_ID);
    expect(result.findings.some((f) => f.code === "JOB_STILL_PENDING")).toBe(true);
    expect(result.nextAction).toContain("202/queued is never RECOVERED");
  });

  it("status identity mismatch -> UNKNOWN/pending (never trusts a foreign job)", async () => {
    const foreign: VpsRecoverRunnerResponse = {
      httpStatus: 200,
      body: { operation: "status", success: true, job: { jobId: "ffffffffffffffffffffffffffffffff", operation: "rollback", status: "rolled_back" } },
    };
    const result = await runVpsRecover({ execute: true, approval: { approved: true } }, baseDeps({ runRunner: fakeRunner([foreign]).runRunner }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.pending).toBe(true);
    expect(result.findings.some((f) => f.code === "JOB_IDENTITY_MISMATCH")).toBe(true);
  });

  it("smoke FAIL after rolled_back -> NOT_RECOVERED (no reconcile validation is trusted without official smoke)", async () => {
    const smokeFail: VpsRecoverRunnerResponse = { httpStatus: 200, body: { operation: "smoke", success: false } };
    const result = await runVpsRecover(
      { execute: true, approval: { approved: true } },
      baseDeps({ runRunner: fakeRunner([rolledBack], smokeFail).runRunner }),
    );
    expect(result.status).toBe("NOT_RECOVERED");
    expect(result.validation?.smoke).toBe("FAIL");
    expect(result.findings.some((f) => f.code === "SMOKE_FAILED")).toBe(true);
  });

  it("smoke PASS but reconcile still DRIFTED after rollback -> NOT_RECOVERED", async () => {
    // After the rollback the fixture still reports the drifted catalog hash.
    const runner = fakeRunner([rolledBack]);
    const result = await runVpsRecover(
      { execute: true, approval: { approved: true } },
      baseDeps({ runRunner: runner.runRunner, readCatalog: async () => ({ ...catalog, catalogHash: "stale-fake" }) }),
    );
    expect(result.status).toBe("NOT_RECOVERED");
    expect(result.validation?.reconcile).toBe("DRIFTED");
    expect(result.findings.some((f) => f.code === "RECONCILE_DRIFTED_AFTER_ROLLBACK")).toBe(true);
  });
});

describe("strict input (zero caller-controlled authority)", () => {
  it("input accepts exactly { execute?, approval? } and nothing else", () => {
    expect(vpsRecoverInputSchema.safeParse({}).success).toBe(true);
    expect(vpsRecoverInputSchema.safeParse({ execute: true, approval: { approved: true } }).success).toBe(true);
    for (const extra of [
      { target: "gateway" },
      { applicationId: "app-1" },
      { toolName: "application-redeploy" },
      { command: "rm -rf /" },
      { shell: true },
      { ssh: true },
      { url: "https://backend.example" },
      { socket: "/tmp/runner.sock" },
      { credential: "secret" },
      { operation: "deploy" },
      { jobId: JOB_ID },
      { path: "C:/secret" },
      { approval: { approved: true, proposalFingerprint: "0".repeat(64) } },
    ]) {
      expect(vpsRecoverInputSchema.safeParse(extra).success).toBe(false);
    }
  });

  it("every zero-mutation outcome reports mutationPerformed=false", async () => {
    for (const deps of [
      baseDeps({ readCatalog: async () => null }),
      baseDeps(),
      baseDeps({}, { previousContainer: undefined, previousImage: undefined }),
      baseDeps({}, { deployStatus: "IN_PROGRESS" }),
    ]) {
      const result = await runVpsRecover({}, deps);
      expect(result.mutationPerformed).toBe(false);
    }
    const rejected = await runVpsRecover(
      { execute: true, approval: { approved: true } },
      baseDeps({ runRunner: async () => ({ httpStatus: 500, body: { accepted: false } }) }),
    );
    expect(rejected.mutationPerformed).toBe(false);
  });
});
