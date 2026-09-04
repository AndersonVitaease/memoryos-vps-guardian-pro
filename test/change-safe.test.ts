/**
 * engineering.vps.change.safe V2 (PLAN + governed EXECUTE) unit certification.
 * Deterministic fakes only: no real VPS, no network, no I/O, no mutation.
 */
import { describe, expect, it } from "vitest";
import {
  planVpsChangeSafe,
  parseChangeTargets,
  CHANGE_SAFE_ACTION,
  CHANGE_SAFE_CHECKS,
  CHANGE_SAFE_REQUIRED_CHECKS,
  CHANGE_SAFE_LIMITATIONS,
  CHANGE_TARGETS_ENV_VAR,
} from "../src/change/changeSafe";
import type { ChangeTargets } from "../src/change/changeSafe";
import type { ProContext } from "../src/proContext";
import type { SystemHealthAdapter, VpsHealthEvidence } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentAdapter, ApplicationDeploymentEvidence } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { DockerHealthAdapter, DockerHealthEvidence } from "memoryos-vps-guardian/src/adapters/dockerHealth";

function counting<T>(name: string, evidence: T) {
  const adapter = {
    name,
    calls: 0,
    collect(): T {
      adapter.calls += 1;
      return evidence;
    },
  };
  return adapter;
}

// ---- deterministic fixtures ----

const healthyHost: VpsHealthEvidence = {
  uptimeSeconds: 987654,
  cpuCount: 4,
  loadAverage1m: 0.4,
  memoryTotalBytes: 17_179_869_184,
  memoryFreeBytes: 8_589_934_592,
};
const overloadedHost: VpsHealthEvidence = { ...healthyHost, loadAverage1m: 10 };
const pressuredHost: VpsHealthEvidence = { ...healthyHost, memoryTotalBytes: 1_000_000_000, memoryFreeBytes: 50_000_000 };
const unknownHost: VpsHealthEvidence = {
  uptimeSeconds: null,
  cpuCount: null,
  loadAverage1m: null,
  memoryTotalBytes: null,
  memoryFreeBytes: null,
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

const healthyDocker: DockerHealthEvidence = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 2, running: 2, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
};

const ALLOWLIST: ChangeTargets = {
  gateway: { applicationId: "app-1", applicationName: "Gateway" },
};

interface Overrides {
  sysEvidence?: VpsHealthEvidence;
  appAdapter?: ApplicationDeploymentAdapter | null;
  dockerAdapter?: DockerHealthAdapter | null;
  changeTargets?: ChangeTargets;
}

function makeCtx(o: Overrides = {}) {
  const sys = counting("sys-fake", o.sysEvidence ?? healthyHost);
  const appDefault = counting("app-fake", healthyApp);
  const app = o.appAdapter === undefined ? appDefault : o.appAdapter;
  const dockerDefault = counting("docker-fake", healthyDocker);
  const docker = o.dockerAdapter === undefined ? dockerDefault : o.dockerAdapter;
  const ctx: ProContext = {
    systemHealthAdapter: sys,
    applicationDeploymentAdapter: app,
    dockerHealthAdapter: docker,
    logEvidenceAdapter: null,
    changeTargets: o.changeTargets ?? ALLOWLIST,
    safeChangeAdapter: null,
  };
  return {
    ctx,
    sysCalls: () => sys.calls,
    appCalls: () => (o.appAdapter === undefined ? appDefault.calls : 0),
    dockerCalls: () => (o.dockerAdapter === undefined ? dockerDefault.calls : 0),
  };
}

const input = (target = "gateway") => ({ action: CHANGE_SAFE_ACTION, target });

describe("change.safe input contract (closed, fail-closed)", () => {
  it("rejects empty input {}", () => {
    const { ctx } = makeCtx();
    expect(() => planVpsChangeSafe({}, ctx)).toThrowError();
  });

  it("rejects any agent-supplied identity, credential or authority field", () => {
    const { ctx } = makeCtx();
    expect(() => planVpsChangeSafe({ ...input(), applicationId: "app-9" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), credential: "x" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), backend: "https://backend.example" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), url: "https://backend.example" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), toolName: "application-deploy" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), host: "10.0.0.1" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), token: "x" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), command: "rm -rf /" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ ...input(), ssh: true }, ctx)).toThrowError();
  });

  it("rejects an unsupported action", () => {
    const { ctx } = makeCtx();
    expect(() => planVpsChangeSafe({ action: "application.restart", target: "gateway" }, ctx)).toThrowError();
    expect(() => planVpsChangeSafe({ action: "redeploy", target: "gateway" }, ctx)).toThrowError();
  });
});

describe("deterministic planning", () => {
  it("unknown target -> BLOCKED with TARGET_CONFIGURED=BLOCK and no fingerprint", () => {
    const { ctx } = makeCtx();
    const plan = planVpsChangeSafe(input("nope"), ctx);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.proposalFingerprint).toBeNull();
    expect(plan.target).toEqual({ key: "nope", applicationName: null });
    expect(plan.prechecks.find((c) => c.check === "TARGET_CONFIGURED")?.status).toBe("BLOCK");
  });

  it("known target with healthy evidence -> PLAN_READY with fixed structure", () => {
    const plan = planVpsChangeSafe(input(), makeCtx().ctx);
    expect(plan.status).toBe("PLAN_READY");
    expect(plan.risk).toBe("REQUIRES_APPROVAL");
    expect(plan.action).toBe("application.redeploy");
    expect(plan.target).toEqual({ key: "gateway", applicationName: "Gateway" });
    expect(plan.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.prechecks.map((c) => c.check)).toEqual([...CHANGE_SAFE_CHECKS]);
    const byCheck = new Map(plan.prechecks.map((c) => [c.check, c]));
    for (const check of CHANGE_SAFE_REQUIRED_CHECKS) {
      expect(byCheck.get(check)?.status).toBe("PASS");
    }
    expect(byCheck.get("APPLICATION_HEALTH")?.status).toBe("INFO");
    expect(byCheck.get("DOCKER_HEALTH")?.status).toBe("INFO");
  });

  it("deployment IN_PROGRESS blocks", () => {
    const { ctx } = makeCtx({
      appAdapter: counting("app-fake", { ...healthyApp, deploymentStatus: "IN_PROGRESS" }),
    });
    const plan = planVpsChangeSafe(input(), ctx);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.prechecks.find((c) => c.check === "NO_DEPLOYMENT_IN_FLIGHT")?.status).toBe("BLOCK");
  });

  it("deployment QUEUED blocks", () => {
    const { ctx } = makeCtx({
      appAdapter: counting("app-fake", { ...healthyApp, deploymentStatus: "QUEUED" }),
    });
    const plan = planVpsChangeSafe(input(), ctx);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.prechecks.find((c) => c.check === "NO_DEPLOYMENT_IN_FLIGHT")?.status).toBe("BLOCK");
  });

  it("unobservable deployment status -> UNKNOWN overall (fail-closed)", () => {
    const { ctx } = makeCtx({
      appAdapter: counting("app-fake", { ...healthyApp, deploymentStatus: null }),
    });
    const plan = planVpsChangeSafe(input(), ctx);
    expect(plan.status).toBe("UNKNOWN");
    expect(plan.proposalFingerprint).toBeNull();
    expect(plan.prechecks.find((c) => c.check === "DEPLOYMENT_STATE_KNOWN")?.status).toBe("UNKNOWN");
    expect(plan.prechecks.find((c) => c.check === "NO_DEPLOYMENT_IN_FLIGHT")?.status).toBe("UNKNOWN");
  });

  it("configured deployment source returning no evidence -> UNKNOWN overall", () => {
    const { ctx } = makeCtx({ appAdapter: counting("app-fake", null) });
    const plan = planVpsChangeSafe(input(), ctx);
    expect(plan.status).toBe("UNKNOWN");
    expect(plan.prechecks.find((c) => c.check === "DEPLOYMENT_EVIDENCE_AVAILABLE")?.status).toBe("UNKNOWN");
  });

  it("VPS health DEGRADED blocks (shared host snapshot: overloaded load trips both checks)", () => {
    const plan = planVpsChangeSafe(input(), makeCtx({ sysEvidence: overloadedHost }).ctx);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.prechecks.find((c) => c.check === "VPS_HEALTH_ACCEPTABLE")?.status).toBe("BLOCK");
    expect(plan.prechecks.find((c) => c.check === "CAPACITY_ACCEPTABLE")?.status).toBe("BLOCK");
  });

  it("VPS health UNKNOWN -> UNKNOWN overall (fail-closed)", () => {
    const plan = planVpsChangeSafe(input(), makeCtx({ sysEvidence: unknownHost }).ctx);
    expect(plan.status).toBe("UNKNOWN");
    expect(plan.prechecks.find((c) => c.check === "VPS_HEALTH_ACCEPTABLE")?.status).toBe("UNKNOWN");
  });

  it("capacity PRESSURED blocks", () => {
    const plan = planVpsChangeSafe(input(), makeCtx({ sysEvidence: pressuredHost }).ctx);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.prechecks.find((c) => c.check === "CAPACITY_ACCEPTABLE")?.status).toBe("BLOCK");
  });

  it("capacity UNKNOWN -> UNKNOWN overall (fail-closed)", () => {
    const plan = planVpsChangeSafe(input(), makeCtx({ sysEvidence: unknownHost }).ctx);
    expect(plan.status).toBe("UNKNOWN");
    expect(plan.prechecks.find((c) => c.check === "CAPACITY_ACCEPTABLE")?.status).toBe("UNKNOWN");
  });

  it("docker NOT CONFIGURED is represented honestly and never gates planning", () => {
    const plan = planVpsChangeSafe(input(), makeCtx({ dockerAdapter: null }).ctx);
    expect(plan.status).toBe("PLAN_READY");
    const docker = plan.prechecks.find((c) => c.check === "DOCKER_HEALTH");
    expect(docker?.status).toBe("NOT_CONFIGURED");
    expect(docker?.summary).toContain("observational");
  });

  it("unconfigured deployment source is REQUIRED-unknown even when the target resolves", () => {
    const { ctx } = makeCtx({ appAdapter: null });
    const plan = planVpsChangeSafe(input(), ctx);
    expect(plan.status).toBe("UNKNOWN");
    expect(plan.prechecks.find((c) => c.check === "DEPLOYMENT_EVIDENCE_AVAILABLE")?.status).toBe("UNKNOWN");
  });
});

describe("proposal fingerprint (output only, deterministic)", () => {
  it("is deterministic for an identical snapshot", () => {
    const a = planVpsChangeSafe(input(), makeCtx().ctx);
    const b = planVpsChangeSafe(input(), makeCtx().ctx);
    expect(a.proposalFingerprint).toBeTruthy();
    expect(a.proposalFingerprint).toBe(b.proposalFingerprint);
  });

  it("changes when relevant evidence changes", () => {
    const a = planVpsChangeSafe(input(), makeCtx().ctx);
    const b = planVpsChangeSafe(
      input(),
      makeCtx({ appAdapter: counting("app-fake", { ...healthyApp, lastDeploymentFinishedAt: "2026-09-02T10:30:00Z" }) }).ctx,
    );
    expect(a.proposalFingerprint).not.toBe(b.proposalFingerprint);
  });

  it("changes when the logical target changes", () => {
    const targets: ChangeTargets = {
      gateway: { applicationId: "app-1", applicationName: "Gateway" },
      edge: { applicationId: "app-2", applicationName: "Edge" },
    };
    const a = planVpsChangeSafe(input("gateway"), makeCtx({ changeTargets: targets }).ctx);
    const b = planVpsChangeSafe(input("edge"), makeCtx({ changeTargets: targets }).ctx);
    expect(a.proposalFingerprint).toBeTruthy();
    expect(b.proposalFingerprint).toBeTruthy();
    expect(a.proposalFingerprint).not.toBe(b.proposalFingerprint);
  });
});

describe("output safety and semantics", () => {
  it("never exposes the resolved applicationId, paths or credentials in the output", () => {
    const plan = planVpsChangeSafe(input(), makeCtx().ctx);
    const text = JSON.stringify(plan);
    expect(text).not.toContain("app-1");
    expect(text).not.toContain("applicationId");
    expect(text).not.toContain("C:/");
    expect(text).not.toContain("password");
  });

  it("PLAN_READY still carries fixed risk REQUIRES_APPROVAL and the honest limitations", () => {
    const plan = planVpsChangeSafe(input(), makeCtx().ctx);
    expect(plan.status).toBe("PLAN_READY");
    expect(plan.risk).toBe("REQUIRES_APPROVAL");
    expect(plan.limitations).toEqual([...CHANGE_SAFE_LIMITATIONS]);
    expect(CHANGE_SAFE_LIMITATIONS.some((l) => l.includes("it is not approval"))).toBe(true);
    expect(CHANGE_SAFE_LIMITATIONS.some((l) => l.includes("SafeChangeAdapter"))).toBe(true);
  });

  it("never mutates anything: one read-only collect per adapter per call, plan-shaped output only", () => {
    const w = makeCtx();
    planVpsChangeSafe(input(), w.ctx);
    planVpsChangeSafe(input(), w.ctx);
    expect(w.sysCalls()).toBe(2);
    expect(w.appCalls()).toBe(2);
    expect(w.dockerCalls()).toBe(2);
    const plan = planVpsChangeSafe(input(), w.ctx);
    expect(Object.keys(plan).sort()).toEqual([
      "action",
      "limitations",
      "prechecks",
      "proposalFingerprint",
      "risk",
      "status",
      "target",
    ]);
    expect(plan.limitations).toHaveLength(8);
    expect(
      CHANGE_SAFE_LIMITATIONS.some((l) => l.includes("GC-08C single-flight") && l.includes("same-instance (same process) protection only")),
    ).toBe(true);
  });
});

describe("operator allowlist configuration", () => {
  it("env var name is the documented one", () => {
    expect(CHANGE_TARGETS_ENV_VAR).toBe("MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS");
  });

  it("missing/empty value means an empty allowlist (fail-closed)", () => {
    expect(parseChangeTargets(undefined)).toEqual({});
    expect(parseChangeTargets("")).toEqual({});
  });

  it("parses a valid operator allowlist exactly as supplied", () => {
    const parsed = parseChangeTargets('{"gateway":{"applicationId":"app-1","applicationName":"Gateway"}}');
    expect(parsed).toEqual(ALLOWLIST);
  });

  it("throws loudly on malformed or invalid allowlist values (never repairs)", () => {
    expect(() => parseChangeTargets("not-json")).toThrowError(/not valid JSON/);
    expect(() => parseChangeTargets('{"gateway":{"applicationId":""}}')).toThrowError(/invalid change-target allowlist/);
    expect(() => parseChangeTargets('{"gateway":{"applicationId":"a","applicationName":"b","host":"x"}}')).toThrowError(
      /invalid change-target allowlist/,
    );
  });
});
