/**
 * engineering.vps.change.safe V2 - governed EXECUTE certification.
 * Behaviors ported/adapted from the certified ENG-MCP original (13 behaviors)
 * plus the Pro approval/TOCTOU binding. Deterministic fakes only: no real VPS,
 * no network, no I/O, no real mutation. Fake values are obviously synthetic
 * ("fake-*", "r-3", "deploy-77") and must never leak into any output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runVpsChangeSafe,
  planVpsChangeSafe,
  CHANGE_SAFE_ACTION,
} from "../src/change/changeSafe";
import type { ChangeSafePlan, ChangeSafeExecuteResult, ResolvedApplicationTarget } from "../src/change/changeSafe";
import {
  CHANGE_MUTATION_TOOL,
  createMcpBridgeSafeChangeAdapter,
  createMcpBridgeCallTransport,
} from "../src/change/safeChangeAdapter";
import type { SafeChangeAdapter, SafeChangeOutcome } from "../src/change/safeChangeAdapter";
import type { ProContext } from "../src/proContext";
import type { SystemHealthAdapter, VpsHealthEvidence } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentAdapter, ApplicationDeploymentEvidence } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { DockerHealthAdapter, DockerHealthEvidence } from "memoryos-vps-guardian/src/adapters/dockerHealth";

// ---- deterministic fixtures (fixed timestamps: fingerprints are stable) ----

const healthyHost: VpsHealthEvidence = {
  uptimeSeconds: 987654,
  cpuCount: 4,
  loadAverage1m: 0.4,
  memoryTotalBytes: 17_179_869_184,
  memoryFreeBytes: 8_589_934_592,
};

const healthyApp: ApplicationDeploymentEvidence = {
  applicationId: "app-1",
  observedAt: "2026-09-02T12:00:00Z",
  source: "release-state-file",
  deploymentStatus: "SUCCEEDED",
  applicationHealthy: true,
  currentReleaseId: "r-2",
  previousReleaseId: "r-1",
  lastDeploymentFinishedAt: "2026-09-02T11:00:00Z",
};

const newReleaseApp: ApplicationDeploymentEvidence = {
  ...healthyApp,
  observedAt: "2026-09-02T13:00:00Z",
  currentReleaseId: "r-3",
  previousReleaseId: "r-2",
  lastDeploymentFinishedAt: "2026-09-02T12:59:00Z",
};

const driftedApp: ApplicationDeploymentEvidence = {
  ...healthyApp,
  observedAt: "2026-09-02T12:30:00Z",
  currentReleaseId: "r-4",
};

const healthyDocker: DockerHealthEvidence = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 2, running: 2, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
};

const ALLOWLIST = { gateway: { applicationId: "app-1", applicationName: "Gateway" } };

/** Application evidence adapter returning a scripted sequence of snapshots. */
function scriptedAppAdapter(snapshots: Array<ApplicationDeploymentEvidence | null>) {
  let index = 0;
  return {
    name: "app-scripted",
    calls: 0,
    collect(): ApplicationDeploymentEvidence | null {
      const evidence = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      this.calls += 1;
      return evidence;
    },
  };
}

/** Deterministic SafeChangeAdapter fake: records calls, performs no real mutation. */
function fakeSafeChangeAdapter(outcome: Partial<SafeChangeOutcome> = { accepted: true, ref: null, message: "fake accepted" }) {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  return {
    name: "fake-safe-change",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey });
      if (outcome.accepted === false) {
        return { accepted: false, ref: null, message: outcome.message ?? "fake upstream failure" };
      }
      return { accepted: true, ref: outcome.ref ?? null, message: outcome.message ?? "fake accepted" };
    },
  };
}

function throwingSafeChangeAdapter(error: Error) {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  return {
    name: "fake-safe-change-throwing",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey });
      throw error;
    },
  };
}

interface Overrides {
  appSnapshots?: Array<ApplicationDeploymentEvidence | null>;
  safeChangeAdapter?: SafeChangeAdapter | null;
  changeTargets?: Record<string, { applicationId: string; applicationName: string }>;
}

function makeCtx(o: Overrides = {}) {
  const ctx: ProContext = {
    systemHealthAdapter: {
      name: "sys-fake",
      collect(): VpsHealthEvidence {
        return healthyHost;
      },
    } as unknown as SystemHealthAdapter,
    applicationDeploymentAdapter:
      (o.appSnapshots ? scriptedAppAdapter(o.appSnapshots) : scriptedAppAdapter([healthyApp])) as unknown as ApplicationDeploymentAdapter,
    dockerHealthAdapter: {
      name: "docker-fake",
      collect(): DockerHealthEvidence {
        return healthyDocker;
      },
    } as unknown as DockerHealthAdapter,
    logEvidenceAdapter: null,
    changeTargets: o.changeTargets ?? ALLOWLIST,
    safeChangeAdapter: o.safeChangeAdapter === undefined ? (fakeSafeChangeAdapter() as unknown as SafeChangeAdapter) : o.safeChangeAdapter,
  };
  return ctx;
}

const input = (target = "gateway") => ({ action: CHANGE_SAFE_ACTION, target });
const executeInput = (approval?: { approved: boolean; proposalFingerprint: string }) => ({
  action: CHANGE_SAFE_ACTION,
  target: "gateway",
  execute: true,
  ...(approval === undefined ? {} : { approval }),
});
const approve = (fingerprint: string) => ({ approved: true, proposalFingerprint: fingerprint });

/** PLAN first, then use its fingerprint as the approval anchor. */
async function planAndApprove(ctx: ProContext): Promise<{ fingerprint: string; plan: ChangeSafePlan }> {
  const plan = planVpsChangeSafe(input(), ctx);
  expect(plan.status).toBe("PLAN_READY");
  expect(plan.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  return { fingerprint: plan.proposalFingerprint as string, plan };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
describe("execute gating: zero-mutation outcomes", () => {
  it("approval absent (execute only) -> APPROVAL_REQUIRED with ZERO mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({ safeChangeAdapter: adapter as unknown as SafeChangeAdapter });
    const result = (await runVpsChangeSafe(executeInput(), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("APPROVAL_REQUIRED");
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("zero mutation performed");
    expect(result.mutation).toEqual({ attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null });
    expect(result.postValidation).toBeNull();
    expect(adapter.calls).toHaveLength(0);
  });

  it("approval not granted (approved:false) -> APPROVAL_REQUIRED with ZERO mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({ safeChangeAdapter: adapter as unknown as SafeChangeAdapter });
    const result = (await runVpsChangeSafe(executeInput({ approved: false, proposalFingerprint: "a".repeat(64) }), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("APPROVAL_REQUIRED");
    expect(adapter.calls).toHaveLength(0);
  });

  it("wrong fingerprint (any 64-hex that is not the plan fingerprint) -> SNAPSHOT_CHANGED with ZERO mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({ safeChangeAdapter: adapter as unknown as SafeChangeAdapter });
    const result = (await runVpsChangeSafe(executeInput(approve("b".repeat(64))), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("SNAPSHOT_CHANGED");
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("zero mutation performed");
    expect(adapter.calls).toHaveLength(0);
  });

  it("snapshot changed since approval (fresh evidence drifted) -> SNAPSHOT_CHANGED with ZERO mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, driftedApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("SNAPSHOT_CHANGED");
    expect(result.proposalFingerprint).not.toBe(fingerprint);
    expect(adapter.calls).toHaveLength(0);
  });

  it("unknown logical target never mutates -> BLOCKED (TARGET_CONFIGURED)", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      changeTargets: {},
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const result = (await runVpsChangeSafe(executeInput(approve("c".repeat(64))), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("BLOCKED");
    expect(result.prechecks.find((c) => c.check === "TARGET_CONFIGURED")?.status).toBe("BLOCK");
    expect(adapter.calls).toHaveLength(0);
  });

  it("precheck BLOCK never mutates (deployment already IN_PROGRESS)", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [{ ...healthyApp, deploymentStatus: "IN_PROGRESS" }],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const result = (await runVpsChangeSafe(executeInput(approve("d".repeat(64))), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("NO_DEPLOYMENT_IN_FLIGHT");
    expect(adapter.calls).toHaveLength(0);
  });

  it("precheck UNKNOWN never mutates (deployment state unobservable)", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [{ ...healthyApp, deploymentStatus: null }],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const result = (await runVpsChangeSafe(executeInput(approve("e".repeat(64))), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("UNKNOWN");
    expect(result.reason).toContain("DEPLOYMENT_STATE_KNOWN");
    expect(adapter.calls).toHaveLength(0);
  });

  it("no mutation adapter configured (operator absent) -> BLOCKED with ZERO mutation even with valid approval", async () => {
    const ctx = makeCtx({ safeChangeAdapter: null });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("no mutation adapter is configured");
    expect(result.executed).toBe(false);
  });
});

describe("execute mutation: one attempt, one tool, no retry", () => {
  it("mutation happens EXACTLY ONCE, with the operator-resolved target and the approved fingerprint as correlation key", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.executed).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].resolved).toEqual({ applicationId: "app-1", applicationName: "Gateway" });
    expect(adapter.calls[0].correlationKey).toBe(fingerprint);
    expect(result.mutation.correlationKey).toBe(fingerprint);
  });

  it("transport failure -> exactly ONE attempt, MUTATION_UPSTREAM_ERROR, no retry, outcome honestly unconfirmed", async () => {
    const adapter = fakeSafeChangeAdapter({ accepted: false, message: "FAKE_UPSTREAM_FAILURE" });
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("MUTATION_UPSTREAM_ERROR");
    expect(result.executed).toBe(true);
    expect(result.mutation).toEqual({ attempted: true, occurred: false, accepted: false, ref: null, correlationKey: fingerprint });
    expect(result.reason).toContain("no retry");
    expect(result.postValidation).toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it("adapter throwing -> exactly ONE attempt, MUTATION_UPSTREAM_ERROR, no retry, never a success status", async () => {
    const adapter = throwingSafeChangeAdapter(new Error("fake adapter threw"));
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("MUTATION_UPSTREAM_ERROR");
    expect(adapter.calls).toHaveLength(1);
    expect(result.postValidation).toBeNull();
  });

  it("backend acceptance is NOT VERIFIED: SUCCEEDED without a new release -> UNKNOWN_REQUIRES_HUMAN_REVIEW", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, healthyApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).not.toBe("VERIFIED");
    expect(result.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
    expect(result.mutation.accepted).toBe(true);
    expect(result.postValidation?.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
  });
});

describe("execute post-validation: fresh evidence decides, never backend acceptance", () => {
  it("VERIFIED: fresh evidence shows a NEW release deployed successfully", async () => {
    const adapter = fakeSafeChangeAdapter({ accepted: true, ref: "deploy-77" });
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("VERIFIED");
    expect(result.postValidation?.status).toBe("VERIFIED");
    expect(result.postValidation?.currentReleaseId).toBe("r-3");
    expect(result.mutation.ref).toBe("deploy-77");
  });

  it("FAILED: fresh evidence reports the deployment as FAILED", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, { ...newReleaseApp, deploymentStatus: "FAILED" }],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("FAILED");
    expect(result.postValidation?.status).toBe("FAILED");
  });

  it("PENDING: fresh evidence shows IN_PROGRESS or QUEUED", async () => {
    const adapter = fakeSafeChangeAdapter();
    for (const status of ["IN_PROGRESS", "QUEUED"] as const) {
      const ctx = makeCtx({
        appSnapshots: [healthyApp, healthyApp, { ...newReleaseApp, deploymentStatus: status }],
        safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
      });
      const { fingerprint } = await planAndApprove(ctx);
      const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
      expect(result.status).toBe("PENDING");
      expect(result.postValidation?.deploymentStatus).toBe(status);
    }
  });

  it("UNKNOWN_REQUIRES_HUMAN_REVIEW: no evidence can be re-read after the mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, null],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
    expect(result.postValidation?.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
    expect(result.postValidation?.deploymentStatus).toBeNull();
  });

  it("rollback is honestly unavailable in every outcome", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const denied = (await runVpsChangeSafe(executeInput(), ctx)) as ChangeSafeExecuteResult;
    expect(denied.rollback).toEqual({ available: false, performed: false });
    const { fingerprint } = await planAndApprove(ctx);
    const executed = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(executed.rollback).toEqual({ available: false, performed: false });
  });
});

describe("execute input contract: closed schema, agent never holds authority", () => {
  it("rejects agent-supplied applicationId, credential, backend URL, toolName, host, token, command and ssh", async () => {
    const ctx = makeCtx();
    for (const extra of [
      { applicationId: "app-9" },
      { credential: "fake-credential-value" },
      { backend: "https://backend.example" },
      { url: "https://backend.example" },
      { toolName: "application-deploy" },
      { host: "10.0.0.1" },
      { token: "fake-token-value" },
      { command: "rm -rf /" },
      { ssh: true },
    ]) {
      await expect(runVpsChangeSafe({ ...executeInput(approve("a".repeat(64))), ...extra }, ctx)).rejects.toThrowError();
    }
  });

  it("rejects malformed approval shapes (missing fingerprint, wrong length, non-hex)", async () => {
    const ctx = makeCtx();
    await expect(runVpsChangeSafe({ ...executeInput(), approval: { approved: true } }, ctx)).rejects.toThrowError();
    await expect(runVpsChangeSafe({ ...executeInput(), approval: { approved: true, proposalFingerprint: "short" } }, ctx)).rejects.toThrowError();
    await expect(runVpsChangeSafe({ ...executeInput(), approval: { approved: true, proposalFingerprint: "g".repeat(64) } }, ctx)).rejects.toThrowError();
    await expect(runVpsChangeSafe({ ...executeInput(), approval: { approved: true, proposalFingerprint: "a".repeat(64), extra: 1 } }, ctx)).rejects.toThrowError();
  });

  it("PLAN mode via runVpsChangeSafe stays byte-compatible with planVpsChangeSafe", async () => {
    const ctx = makeCtx();
    const viaRun = (await runVpsChangeSafe(input(), ctx)) as ChangeSafePlan;
    const viaPlan = planVpsChangeSafe(input(), makeCtx());
    expect(viaRun).toEqual(viaPlan);
    expect(Object.keys(viaRun).sort()).toEqual([
      "action",
      "limitations",
      "prechecks",
      "proposalFingerprint",
      "risk",
      "status",
      "target",
    ]);
  });

  it("planVpsChangeSafe refuses to execute (no bypass)", async () => {
    const ctx = makeCtx();
    expect(() => planVpsChangeSafe(executeInput(approve("a".repeat(64))), ctx)).toThrowError(/cannot execute/);
  });
});

describe("execute output safety: no identity, credential or URL leakage", () => {
  it("applicationId never leaks into the execute output", async () => {
    const adapter = fakeSafeChangeAdapter({ accepted: true, ref: "deploy-77" });
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    const text = JSON.stringify(result);
    expect(text).not.toContain("app-1");
    expect(text).not.toContain("applicationId");
    expect(text).not.toContain("C:/");
    expect(text).not.toContain("fake-credential");
  });

  it("audit log is metadata-only (no applicationId, no credential, no URL)", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx);
    const logged = vi.mocked(console.log).mock.calls
      .map((call) => call.map((part) => String(part)).join(" "))
      .filter((line) => line.startsWith("{"));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("app-1");
      expect(line).not.toContain("fake-credential");
      expect(line).not.toContain("https://");
    }
    const executorAudit = logged
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "engineering.vps.change.safe");
    expect(executorAudit).toBeDefined();
    expect(executorAudit?.mode).toBe("EXECUTE");
    expect(executorAudit?.correlationKey).toBe(fingerprint);
    expect(Object.keys(executorAudit as Record<string, unknown>).sort()).toEqual([
      "action",
      "correlationKey",
      "durationMs",
      "event",
      "executed",
      "mode",
      "mutationAccepted",
      "mutationAttempted",
      "status",
      "targetKey",
    ]);
  });
});

describe("bridge transport adapter (proven channel, injectable fetch, redaction)", () => {
  interface CapturedRequest {
    url: string;
    init: RequestInit;
  }

  function fakeFetch(response: { status?: number; body?: unknown; bodyText?: string }) {
    const captured: CapturedRequest[] = [];
    const fetchImpl = (async (input: URL | Request, init?: RequestInit) => {
      captured.push({ url: String(input), init: init ?? {} });
      const text = response.bodyText ?? (response.body === undefined ? "" : JSON.stringify(response.body));
      return new Response(text, { status: response.status ?? 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { captured, fetchImpl };
  }

  const ENDPOINT = "https://bridge.example/functions/agentMemoryBridge";
  const CREDENTIAL = "fake-credential-value";

  function bridgeAdapter(fetchImpl: typeof fetch) {
    const transport = createMcpBridgeCallTransport({
      endpointUrl: ENDPOINT,
      credential: CREDENTIAL,
      serverId: "fake-server-id",
      fetchImpl,
    });
    return createMcpBridgeSafeChangeAdapter({ transport });
  }

  it("calls EXACTLY application-redeploy through mcp_execute, once, with the operator-resolved applicationId and no retry", async () => {
    const { captured, fetchImpl } = fakeFetch({ body: { ok: true, result: { structuredContent: { deployId: "deploy-77" } } } });
    const adapter = bridgeAdapter(fetchImpl);
    const outcome = await adapter.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome.accepted).toBe(true);
    expect(outcome.ref).toBe("deploy-77");
    expect(captured).toHaveLength(1);
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body.operation).toBe("mcp_execute");
    expect(body.toolName).toBe("application-redeploy");
    expect(body.confirmation).toEqual({ toolName: "application-redeploy" });
    expect(body.arguments).toEqual({ applicationId: "app-1" });
    expect(CHANGE_MUTATION_TOOL).toBe("application-redeploy");
  });

  it("credential travels only in the transport header and NEVER appears in any outcome", async () => {
    const { captured, fetchImpl } = fakeFetch({ body: { ok: true, result: { structuredContent: {} } } });
    const adapter = bridgeAdapter(fetchImpl);
    const outcome = await adapter.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["x-agent-memory-token"]).toBe(CREDENTIAL);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(CREDENTIAL);
    expect(text).not.toContain(ENDPOINT);
  });

  it("sensitive keys in backend results are redacted before they can reach the output", async () => {
    const { fetchImpl } = fakeFetch({
      body: { ok: true, result: { structuredContent: { deployId: "deploy-77", token: "fake-secret-token-value", password: "fake-password-value" } } },
    });
    const transport = createMcpBridgeCallTransport({
      endpointUrl: ENDPOINT,
      credential: CREDENTIAL,
      serverId: "fake-server-id",
      fetchImpl,
    });
    // Transport level: sensitive keys are stripped in place (values never survive).
    const response = await transport.call({
      toolName: CHANGE_MUTATION_TOOL,
      arguments: { applicationId: "app-1" },
      mutating: true,
      confirmation: { toolName: CHANGE_MUTATION_TOOL },
    });
    expect(response.ok).toBe(true);
    const transportText = JSON.stringify(response.result);
    expect(transportText).not.toContain("fake-secret-token-value");
    expect(transportText).not.toContain("fake-password-value");
    expect(transportText).toContain("[REDACTED]");
    // Adapter level: only the extracted ref (and no sensitive value) reaches the outcome.
    const adapter = createMcpBridgeSafeChangeAdapter({ transport });
    const outcome = await adapter.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome.ref).toBe("deploy-77");
    const text = JSON.stringify(outcome);
    expect(text).not.toContain("fake-secret-token-value");
    expect(text).not.toContain("fake-password-value");
  });

  it("bridge errors (HTTP failure, non-JSON, bridge error field, transport throw) are non-accepted with NO retry", async () => {
    const httpFailure = fakeFetch({ status: 502, body: { error: "FAKE_UPSTREAM_FAILURE" } });
    const adapter1 = bridgeAdapter(httpFailure.fetchImpl);
    const outcome1 = await adapter1.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome1.accepted).toBe(false);
    expect(outcome1.message).toContain("FAKE_UPSTREAM_FAILURE");
    expect(httpFailure.captured).toHaveLength(1);

    const nonJson = fakeFetch({ bodyText: "not-json" });
    const adapter2 = bridgeAdapter(nonJson.fetchImpl);
    const outcome2 = await adapter2.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome2.accepted).toBe(false);
    expect(nonJson.captured).toHaveLength(1);

    const bridgeError = fakeFetch({ body: { ok: false, error: "TOOL_NOT_ALLOWLISTED" } });
    const adapter3 = bridgeAdapter(bridgeError.fetchImpl);
    const outcome3 = await adapter3.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome3.accepted).toBe(false);
    expect(bridgeError.captured).toHaveLength(1);

    const throwingFetch = (async () => {
      throw new Error("fake network down");
    }) as unknown as typeof fetch;
    const transport = createMcpBridgeCallTransport({
      endpointUrl: ENDPOINT,
      credential: CREDENTIAL,
      serverId: "fake-server-id",
      fetchImpl: throwingFetch,
    });
    const adapter4 = createMcpBridgeSafeChangeAdapter({ transport });
    const outcome4 = await adapter4.redeploy({ applicationId: "app-1", applicationName: "Gateway" }, "f".repeat(64));
    expect(outcome4.accepted).toBe(false);
    expect(outcome4.message).toContain("fake network down");
  });

  it("full EXECUTE through the real bridge adapter: accepted -> post-validation decides, credential never in the tool result", async () => {
    const { fetchImpl } = fakeFetch({ body: { ok: true, result: { structuredContent: { deployId: "deploy-77" } } } });
    const adapter = bridgeAdapter(fetchImpl);
    const ctx = makeCtx({
      appSnapshots: [healthyApp, healthyApp, newReleaseApp],
      safeChangeAdapter: adapter,
    });
    const { fingerprint } = await planAndApprove(ctx);
    const result = (await runVpsChangeSafe(executeInput(approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(result.status).toBe("VERIFIED");
    expect(result.mutation.ref).toBe("deploy-77");
    const text = JSON.stringify(result);
    expect(text).not.toContain(CREDENTIAL);
    expect(text).not.toContain(ENDPOINT);
    expect(text).not.toContain("app-1");
  });
});
