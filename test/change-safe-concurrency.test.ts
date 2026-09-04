/**
 * GC-08C — VPS concurrent redeploy hardening (permanent regression).
 *
 * Mission: prevent two simultaneous executions on the SAME instance of the
 * VPS domain/adapter from crossing the mutation boundary for the SAME
 * resolved applicationId, mirroring the GC-08A email single-flight pattern:
 *   - reservation keyed by the RESOLVED applicationId (operator allowlist),
 *     never by the caller-supplied logical target name;
 *   - synchronous check+add with NO await in between (atomic in-process);
 *   - mandatory release in `finally` on every path;
 *   - only SAME-applicationId concurrency is blocked; different
 *     applicationIds keep executing in parallel (no global lock);
 *   - concurrent loser: outcome NOT_EXECUTED-equivalent (executed=false,
 *     zero mutation, postValidation=null), stage/reason indicates the
 *     in-flight same-target conflict (existing BLOCKED vocabulary + one
 *     documented reason marker).
 *
 * Deterministic only: no timers, no random timing, no network, no real VPS,
 * no real mutation. Every overlap is produced by explicit synchronous
 * scheduling (Promise.all executor order + held fake adapter promises).
 *
 * Scope guard (mandatory limitations, also in CHANGE_SAFE_LIMITATIONS):
 * SAME_INSTANCE_SAME_APPLICATION_CONCURRENT_DISPATCH_PROTECTED=yes;
 * CROSS_PROCESS / CROSS_MACHINE serialization NOT provided; no exactly-once;
 * backend idempotency NOT claimed. The stale-decision protection
 * (SNAPSHOT_CHANGED, GC-08B class A) must remain untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runVpsChangeSafe,
  planVpsChangeSafe,
  CHANGE_SAFE_ACTION,
  CHANGE_SAFE_LIMITATIONS,
} from "../src/change/changeSafe";
import type { ChangeSafeExecuteResult, ResolvedApplicationTarget } from "../src/change/changeSafe";
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

const CONCURRENT_REASON = "SIMULTANEOUS_EXECUTION_FOR_SAME_APPLICATION_IDENTIFIER_IN_FLIGHT";

// ---- deterministic concurrency harness ----

/** Application evidence adapter returning a scripted sequence of snapshots (then repeats the last). */
function scriptedAppAdapter(snapshots: Array<ApplicationDeploymentEvidence | null>) {
  let index = 0;
  return {
    name: "app-scripted",
    collect(): ApplicationDeploymentEvidence | null {
      const evidence = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return evidence;
    },
  };
}

/** Application evidence adapter always returning the current evidence (switchable mid-test). */
function switchableAppAdapter(initial: ApplicationDeploymentEvidence) {  let current: ApplicationDeploymentEvidence = initial;
  return {
    name: "app-switchable",
    calls: 0,
    setEvidence(next: ApplicationDeploymentEvidence) {
      current = next;
    },
    collect(): ApplicationDeploymentEvidence {
      this.calls += 1;
      return current;
    },
  };
}

/** Application evidence adapter: first two collects succeed (plan + execute revalidation), later collects throw (post-validation). */
function failingPostAppAdapter() {
  let calls = 0;
  return {
    name: "app-failing-post",
    collect(): ApplicationDeploymentEvidence {
      calls += 1;
      if (calls >= 3) {
        throw new Error("fake post-validation evidence failure");
      }
      return healthyApp;
    },
  };
}

/**
 * Deterministic SafeChangeAdapter fake: records every redeploy call (the
 * mutation boundary) and can HOLD a call open (simulating an in-flight
 * backend deployment) for the applicationIds matched by holdPredicate until
 * releaseAll() is called. No timing, no randomness.
 */
function holdingSafeAdapter(holdPredicate: (applicationId: string) => boolean) {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string; applicationId: string }> = [];
  let armed = false;
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  return {
    name: "holding-safe-change",
    calls,
    armHold() {
      armed = true;
      gate = new Promise<void>((resolve) => {
        release = () => {
          armed = false;
          gate = null;
          release = null;
          resolve();
        };
      });
    },
    releaseAll() {
      const r = release;
      if (r !== null) {
        r();
      }
    },
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey, applicationId: resolved.applicationId });
      if (armed && gate !== null && holdPredicate(resolved.applicationId)) {
        await gate;
      }
      return { accepted: true, ref: `fake-deploy-${calls.length}`, message: "fake accepted" };
    },
  };
}

/** SafeChangeAdapter fake that throws from redeploy (transport-level failure). */
function throwingSafeAdapter() {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  return {
    name: "throwing-safe-change",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey });
      throw new Error("fake transport failure");
    },
  };
}

/** SafeChangeAdapter fake whose transport completes but is not accepted. */
function rejectingSafeAdapter() {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  return {
    name: "rejecting-safe-change",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey });
      return { accepted: false, ref: null, message: "fake upstream rejection" };
    },
  };
}

interface Overrides {
  changeTargets?: Record<string, { applicationId: string; applicationName: string }>;
  appAdapter?: unknown;
  safeChangeAdapter?: unknown;
}

function makeCtx(o: Overrides = {}): ProContext {
  return {
    systemHealthAdapter: {
      name: "sys-fake",
      collect(): VpsHealthEvidence {
        return healthyHost;
      },
    } as unknown as SystemHealthAdapter,
    applicationDeploymentAdapter: (o.appAdapter ?? switchableAppAdapter(healthyApp)) as unknown as ApplicationDeploymentAdapter,
    dockerHealthAdapter: {
      name: "docker-fake",
      collect(): DockerHealthEvidence {
        return healthyDocker;
      },
    } as unknown as DockerHealthAdapter,
    logEvidenceAdapter: null,
    changeTargets: o.changeTargets ?? ALLOWLIST,
    safeChangeAdapter: (o.safeChangeAdapter ?? holdingSafeAdapter(() => false)) as unknown as SafeChangeAdapter,
  } as ProContext;
}

const executeInputFor = (target: string, approval?: { approved: boolean; proposalFingerprint: string }) => ({
  action: CHANGE_SAFE_ACTION,
  target,
  execute: true,
  ...(approval === undefined ? {} : { approval }),
});

const approve = (fingerprint: string) => ({ approved: true, proposalFingerprint: fingerprint });

/** PLAN for one target and return its approval-ready fingerprint. */
function planFingerprint(ctx: ProContext, target = "gateway"): string {
  const plan = planVpsChangeSafe({ action: CHANGE_SAFE_ACTION, target }, ctx);
  expect(plan.status).toBe("PLAN_READY");
  return plan.proposalFingerprint as string;
}

/** GC-08C concurrent-loser shape: existing BLOCKED vocabulary, zero mutation. */
function expectConcurrentRefusal(result: ChangeSafeExecuteResult): void {
  expect(result.status).toBe("BLOCKED");
  expect(result.executed).toBe(false);
  expect(result.reason).toContain(CONCURRENT_REASON);
  expect(result.mutation).toEqual({ attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null });
  expect(result.postValidation).toBeNull();
}

/**
 * Bounded deterministic wait for a harness condition. The conditions used in
 * these tests become true synchronously; the loop only guards against a hang
 * (which would otherwise look like an accidental global lock).
 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`deterministic harness condition not met (possible hang or accidental global lock): ${label}`);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TESTE 1 (doubles as red-team attack A) — same target, many callers
// ---------------------------------------------------------------------------
describe("GC-08C TESTE 1 / red-team A: same resolved applicationId, N simultaneous callers", () => {
  it("16 simultaneous executions -> exactly 1 dispatch, 15 concurrent refusals before the mutation boundary", async () => {
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const appAdapter = switchableAppAdapter(healthyApp);
    const ctx = makeCtx({ appAdapter, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx);

    const executions = Array.from({ length: 16 }, () =>
      runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>,
    );
    const all = Promise.all(executions);
    all.catch(() => {}); // no unhandled rejection while the winner is held

    // Deterministic: caller #1 reserves synchronously and is held inside the
    // fake mutation; callers #2..#16 are refused synchronously (no await
    // between their check and the refusal).
    await waitFor(() => adapter.calls.length === 1, "exactly one dispatch crossing the boundary");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].applicationId).toBe("app-1");

    // Let the single in-flight mutation complete and prove the new release.
    appAdapter.setEvidence(newReleaseApp);
    adapter.releaseAll();
    const results = await all;

    const winners = results.filter((r) => r.mutation.occurred === true);
    const losers = results.filter((r) => r.mutation.occurred === false && r.mutation.attempted === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(15);
    expect(adapter.calls).toHaveLength(1); // MUTATION_DISPATCH_COUNT = 1

    const winner = winners[0];
    expect(winner.executed).toBe(true);
    expect(winner.status).toBe("VERIFIED");
    expect(winner.mutation.attempted).toBe(true);
    expect(winner.mutation.occurred).toBe(true);
    expect(winner.mutation.ref).toBe("fake-deploy-1");

    for (const loser of losers) {
      expectConcurrentRefusal(loser);
      expect(loser.reason).toContain("zero mutation performed");
    }
  });
});

// ---------------------------------------------------------------------------
// TESTE 2 (doubles as red-team B) — different targets stay parallel
// ---------------------------------------------------------------------------
describe("GC-08C TESTE 2 / red-team B: different applicationIds never block each other", () => {
  const THREE_TARGETS = {
    alpha: { applicationId: "app-1", applicationName: "Alpha" },
    beta: { applicationId: "app-2", applicationName: "Beta" },
    gamma: { applicationId: "app-3", applicationName: "Gamma" },
  };

  it("3 different applicationIds in flight simultaneously -> 3 dispatches, no improper blocking", async () => {
    const adapter = holdingSafeAdapter(() => true); // hold ALL: all three must still arrive
    adapter.armHold();
    const appAdapter = switchableAppAdapter(healthyApp);
    const ctx = makeCtx({ changeTargets: THREE_TARGETS, appAdapter, safeChangeAdapter: adapter });

    const fingerprints = ["alpha", "beta", "gamma"].map((t) => planFingerprint(ctx, t));
    expect(new Set(fingerprints).size).toBe(3); // per-target proposals, pairwise distinct

    const executions = ["alpha", "beta", "gamma"].map((t, i) =>
      runVpsChangeSafe(executeInputFor(t, approve(fingerprints[i])), ctx) as Promise<ChangeSafeExecuteResult>,
    );
    const all = Promise.all(executions);
    all.catch(() => {});

    // All three cross the mutation boundary: the reservation is keyed by the
    // resolved applicationId, NOT global.
    await waitFor(() => adapter.calls.length === 3, "three dispatches crossing the boundary");
    expect(adapter.calls.map((c) => c.applicationId).sort()).toEqual(["app-1", "app-2", "app-3"]);

    appAdapter.setEvidence(newReleaseApp);
    adapter.releaseAll();
    const results = await all;

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.executed).toBe(true);
      expect(result.mutation.occurred).toBe(true);
      expect(result.status).toBe("VERIFIED");
      expect(result.reason).not.toContain(CONCURRENT_REASON);
    }
    expect(adapter.calls).toHaveLength(3); // MUTATION_DISPATCH_COUNT = 3
  });

  it("app-1 held in-flight does NOT block app-2 (red-team B direction: blocked A, running B)", async () => {
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const appAdapter = switchableAppAdapter(healthyApp);
    const ctx = makeCtx({ changeTargets: THREE_TARGETS, appAdapter, safeChangeAdapter: adapter });

    const fpAlpha = planFingerprint(ctx, "alpha");
    const fpBeta = planFingerprint(ctx, "beta");

    const alphaPromise = runVpsChangeSafe(executeInputFor("alpha", approve(fpAlpha)), ctx) as Promise<ChangeSafeExecuteResult>;
    alphaPromise.catch(() => {});
    await waitFor(() => adapter.calls.length === 1, "alpha dispatch held in flight");

    // beta runs to completion WHILE alpha is still held inside its mutation.
    const beta = (await runVpsChangeSafe(executeInputFor("beta", approve(fpBeta)), ctx)) as ChangeSafeExecuteResult;
    expect(beta.executed).toBe(true);
    expect(beta.mutation.occurred).toBe(true);
    expect(beta.reason).not.toContain(CONCURRENT_REASON);
    expect(adapter.calls).toHaveLength(2);

    adapter.releaseAll();
    const alpha = await alphaPromise;
    expect(alpha.executed).toBe(true);
    expect(alpha.mutation.occurred).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  it("reservation never gates PLAN: planning stays available while an EXECUTE is in flight", async () => {
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const ctx = makeCtx({ safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx);

    const inFlight = runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>;
    inFlight.catch(() => {});
    await waitFor(() => adapter.calls.length === 1, "execute held in flight");

    const plan = planVpsChangeSafe({ action: CHANGE_SAFE_ACTION, target: "gateway" }, ctx);
    expect(plan.status).toBe("PLAN_READY");
    expect(plan.proposalFingerprint).toBe(fingerprint);

    adapter.releaseAll();
    await inFlight;
  });
});

// ---------------------------------------------------------------------------
// TESTE 3 (doubles as red-team C) — release after failure
// ---------------------------------------------------------------------------
describe("GC-08C TESTE 3 / red-team C: reservation is always released (finally), no deadlock", () => {
  it("adapter.redeploy throws -> MUTATION_UPSTREAM_ERROR, reservation released, immediate re-execution proceeds", async () => {
    const throwing = throwingSafeAdapter();
    const ctx1 = makeCtx({ safeChangeAdapter: throwing });
    const fingerprint = planFingerprint(ctx1);

    const first = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx1)) as ChangeSafeExecuteResult;
    expect(first.status).toBe("MUTATION_UPSTREAM_ERROR");
    expect(first.executed).toBe(true);
    expect(first.mutation.attempted).toBe(true);
    expect(first.mutation.occurred).toBe(false);
    expect(throwing.calls).toHaveLength(1);

    // Same instance, same applicationId, immediately after the failure: the
    // finally clause must have released the reservation (no deadlock).
    const accepting = holdingSafeAdapter(() => false);
    const ctx2 = makeCtx({ appAdapter: switchableAppAdapter(healthyApp), safeChangeAdapter: accepting });
    const second = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx2)) as ChangeSafeExecuteResult;
    expect(second.mutation.attempted).toBe(true);
    expect(second.mutation.occurred).toBe(true);
    expect(second.reason).not.toContain(CONCURRENT_REASON);
    expect(accepting.calls).toHaveLength(1);
  });

  it("transport completes but not accepted -> MUTATION_UPSTREAM_ERROR, reservation released, re-execution proceeds", async () => {
    const rejecting = rejectingSafeAdapter();
    const ctx1 = makeCtx({ safeChangeAdapter: rejecting });
    const fingerprint = planFingerprint(ctx1);

    const first = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx1)) as ChangeSafeExecuteResult;
    expect(first.status).toBe("MUTATION_UPSTREAM_ERROR");
    expect(first.mutation.attempted).toBe(true);
    expect(first.mutation.occurred).toBe(false);
    expect(rejecting.calls).toHaveLength(1);

    const accepting = holdingSafeAdapter(() => false);
    const ctx2 = makeCtx({ appAdapter: switchableAppAdapter(healthyApp), safeChangeAdapter: accepting });
    const second = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx2)) as ChangeSafeExecuteResult;
    expect(second.mutation.occurred).toBe(true);
    expect(second.reason).not.toContain(CONCURRENT_REASON);
    expect(accepting.calls).toHaveLength(1);
  });

  it("post-validation evidence collect throws -> promise rejects, finally still releases, re-execution proceeds", async () => {
    const appAdapter = failingPostAppAdapter();
    const adapter = holdingSafeAdapter(() => false);
    const ctx1 = makeCtx({ appAdapter, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx1);

    const first = runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx1) as Promise<ChangeSafeExecuteResult>;
    first.catch(() => {});
    await expect(first).rejects.toThrow("fake post-validation evidence failure");
    expect(adapter.calls).toHaveLength(1); // the mutation itself was attempted once

    // The throwing path still released the reservation via finally.
    const ctx2 = makeCtx({ appAdapter: switchableAppAdapter(healthyApp), safeChangeAdapter: holdingSafeAdapter(() => false) });
    const second = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx2)) as ChangeSafeExecuteResult;
    expect(second.executed).toBe(true);
    expect(second.mutation.occurred).toBe(true);
    expect(second.reason).not.toContain(CONCURRENT_REASON);
  });
});

// ---------------------------------------------------------------------------
// TESTE 4 — GC-08B D1/D3 attack regression (was 2 dispatches, now 1)
// ---------------------------------------------------------------------------
describe("GC-08C TESTE 4: GC-08B D1/D3 deterministic attack regression", () => {
  it("D1 barrier equivalent: loser passes fresh revalidation (visibility lag) yet is refused BEFORE adapter.redeploy; mutationDispatchCount=1", async () => {
    // Visibility-lag model: the app evidence NEVER surfaces IN_PROGRESS, so
    // the loser's NO_DEPLOYMENT_IN_FLIGHT precheck and its fingerprint
    // comparison would both PASS (exactly the GC-08B collision window).
    const appAdapter = switchableAppAdapter(healthyApp);
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const ctx = makeCtx({ appAdapter, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx);

    const winnerPromise = runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>;
    winnerPromise.catch(() => {});
    await waitFor(() => adapter.calls.length === 1, "winner dispatch held in flight");

    // Loser starts while the winner's mutation is still in flight. Its own
    // fresh evidence is unchanged (same fingerprint), so only the reservation
    // can stop it — before the mutation boundary.
    const loser = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expectConcurrentRefusal(loser);
    expect(adapter.calls).toHaveLength(1); // refused BEFORE adapter.redeploy
    const inFlightCheck = loser.prechecks.find((c) => c.check === "NO_DEPLOYMENT_IN_FLIGHT");
    expect(inFlightCheck?.status).toBe("PASS"); // prechecks alone would NOT have stopped it
    expect(loser.proposalFingerprint).toBe(fingerprint); // fingerprint binding alone would NOT have stopped it

    appAdapter.setEvidence(newReleaseApp);
    adapter.releaseAll();
    const winner = await winnerPromise;
    expect(winner.status).toBe("VERIFIED");
    expect(winner.mutation.occurred).toBe(true);
    expect(adapter.calls).toHaveLength(1); // MUTATION_DISPATCH_COUNT = 1 (was 2 in GC-08B)
  });

  it("D3 equivalent: natural overlap with an instant (non-held) backend -> still exactly 1 dispatch", async () => {
    const adapter = holdingSafeAdapter(() => false); // nothing held: pure natural overlap
    const appAdapter = switchableAppAdapter(healthyApp);
    const ctx = makeCtx({ appAdapter, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx);

    const executions = Array.from({ length: 12 }, () =>
      runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>,
    );
    const results = await Promise.all(executions);

    expect(adapter.calls).toHaveLength(1); // mutationDispatchCount = 1
    const losers = results.filter((r) => r.mutation.attempted === false && r.mutation.occurred === false);
    const winners = results.filter((r) => r.mutation.occurred === true);
    expect(losers).toHaveLength(11);
    expect(winners).toHaveLength(1);
    for (const loser of losers) {
      expectConcurrentRefusal(loser);
    }
  });
});

// ---------------------------------------------------------------------------
// TESTE 5 — stale protection regression (GC-08B class A must stay intact)
// ---------------------------------------------------------------------------
describe("GC-08C TESTE 5: stale SNAPSHOT_CHANGED protection regression", () => {
  it("bind on state X, drift to state Z, apply -> SNAPSHOT_CHANGED with zero mutation; new mechanism neither replaces nor weakens it", async () => {
    const appAdapter = scriptedAppAdapter([healthyApp, driftedApp, driftedApp]);
    const adapter = holdingSafeAdapter(() => false);
    const ctx = makeCtx({ appAdapter, safeChangeAdapter: adapter });

    // bind on state X (healthy evidence)
    const fingerprintX = planFingerprint(ctx);
    expect(adapter.calls).toHaveLength(0);

    // evidence drifted to state Z; apply with the stale approval
    const stale = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprintX)), ctx)) as ChangeSafeExecuteResult;
    expect(stale.status).toBe("SNAPSHOT_CHANGED");
    expect(stale.executed).toBe(false);
    expect(stale.mutation).toEqual({ attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null });
    expect(stale.reason).toContain("fresh evidence no longer matches approval.proposalFingerprint");
    expect(stale.reason).not.toContain(CONCURRENT_REASON); // refusal came from the STALE gate, not the reservation
    expect(adapter.calls).toHaveLength(0); // zero mutation

    // the reservation was released after the stale refusal: a fresh plan on
    // state Z + apply proceeds normally through the whole gated flow.
    const fingerprintZ = planFingerprint(ctx);
    const second = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprintZ)), ctx)) as ChangeSafeExecuteResult;
    expect(second.executed).toBe(true);
    expect(second.mutation.occurred).toBe(true);
    expect(adapter.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Red-team D — caller cannot escape the resolved-identifier key
// ---------------------------------------------------------------------------
describe("GC-08C red-team D: alternative caller keys cannot escape the resolved key", () => {
  const ALIAS_ALLOWLIST = {
    gateway: { applicationId: "app-1", applicationName: "Gateway" },
    gatewayAlias: { applicationId: "app-1", applicationName: "Gateway" },
  };

  it("alias logical key resolving to the SAME applicationId is refused while that applicationId is in flight", async () => {
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const ctx = makeCtx({ changeTargets: ALIAS_ALLOWLIST, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx, "gateway");

    const winnerPromise = runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>;
    winnerPromise.catch(() => {});
    await waitFor(() => adapter.calls.length === 1, "gateway dispatch held in flight");

    // Different caller-supplied key, SAME resolved applicationId app-1.
    const aliasResult = (await runVpsChangeSafe(executeInputFor("gatewayAlias", approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expectConcurrentRefusal(aliasResult);
    expect(adapter.calls).toHaveLength(1); // never reached adapter.redeploy
    expect(aliasResult.target.key).toBe("gatewayAlias");
    const targetConfigured = aliasResult.prechecks.find((c) => c.check === "TARGET_CONFIGURED");
    expect(targetConfigured?.status).toBe("PASS"); // the alias itself is authorized; the KEY is the resolved id

    adapter.releaseAll();
    const winner = await winnerPromise;
    expect(winner.mutation.occurred).toBe(true);
  });

  it("unconfigured caller key is refused by the existing TARGET_CONFIGURED gate (zero mutation, no reservation side effects)", async () => {
    const adapter = holdingSafeAdapter((id) => id === "app-1");
    adapter.armHold();
    const ctx = makeCtx({ changeTargets: ALIAS_ALLOWLIST, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx, "gateway");

    const winnerPromise = runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx) as Promise<ChangeSafeExecuteResult>;
    winnerPromise.catch(() => {});
    await waitFor(() => adapter.calls.length === 1, "gateway dispatch held in flight");

    const ghost = (await runVpsChangeSafe(executeInputFor("ghost", approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(ghost.status).toBe("BLOCKED");
    expect(ghost.executed).toBe(false);
    expect(ghost.reason).toContain("TARGET_CONFIGURED");
    expect(ghost.reason).not.toContain(CONCURRENT_REASON);
    expect(ghost.mutation.attempted).toBe(false);
    expect(adapter.calls).toHaveLength(1);

    adapter.releaseAll();
    const winner = await winnerPromise;
    expect(winner.mutation.occurred).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Red-team E — re-entry after completion must work
// ---------------------------------------------------------------------------
describe("GC-08C red-team E: re-entry after completion", () => {
  it("after an execution completes, the same applicationId can execute again immediately", async () => {
    const adapter = holdingSafeAdapter(() => false);
    const appAdapter = switchableAppAdapter(healthyApp);
    const ctx = makeCtx({ appAdapter, safeChangeAdapter: adapter });
    const fingerprint = planFingerprint(ctx);

    const first = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(first.executed).toBe(true);
    expect(first.mutation.occurred).toBe(true);
    expect(adapter.calls).toHaveLength(1);

    // Immediate re-entry on the SAME applicationId with unchanged evidence:
    // no stale reservation, full gated flow runs again.
    const second = (await runVpsChangeSafe(executeInputFor("gateway", approve(fingerprint)), ctx)) as ChangeSafeExecuteResult;
    expect(second.executed).toBe(true);
    expect(second.mutation.occurred).toBe(true);
    expect(second.mutation.ref).toBe("fake-deploy-2");
    expect(second.reason).not.toContain(CONCURRENT_REASON);
    expect(adapter.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scope documentation guard (PASS criterion 10)
// ---------------------------------------------------------------------------
describe("GC-08C scope documentation", () => {
  it("limitations document the same-instance scope and refuse distributed/exactly-once claims", () => {
    const text = CHANGE_SAFE_LIMITATIONS.join(" ");
    expect(text).toContain("single-flight");
    expect(text).toContain("same-instance (same process) protection only");
    expect(text).toContain("cross-process and cross-machine concurrency are NOT serialized");
    expect(text).toContain("no distributed lock or persistence exists");
    expect(text).toContain("backend idempotency is NOT claimed");
    expect(text.toLowerCase()).not.toContain("exactly-once");
    expect(text.toLowerCase()).not.toContain("cross-process serialization is provided");
  });
});
