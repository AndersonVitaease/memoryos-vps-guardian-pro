/**
 * Pro composition certification: the 10 certified public Simple Tools plus
 * the private engineering.vps.doctor, the governed engineering.vps.change.safe
 * and the read-only engineering.vps.reconcile on ONE McpServer with ONE shared
 * adapter/allowlist wiring. MCP layer exercised through InMemoryTransport
 * (initialize + tools/list + callTool). Deterministic fakes only: no real VPS,
 * no network, no I/O, no mutation.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildProServer, PRO_CATALOG_TOOL_NAMES } from "../src/proServer";
import { createProCatalogSnapshot, PRO_CATALOG_VERSION, RECONCILE_RELEASE_STATE_FILE_ENV } from "../src/index";
import type { ProContext } from "../src/proContext";
import type { SafeChangeAdapter, SafeChangeOutcome, ResolvedApplicationTarget } from "../src/index";
import type { SystemHealthAdapter, VpsHealthEvidence } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentAdapter, ApplicationDeploymentEvidence } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { DockerHealthAdapter, DockerHealthEvidence } from "memoryos-vps-guardian/src/adapters/dockerHealth";
import type { LogEvidenceAdapter, LogEvidence } from "memoryos-vps-guardian/src/adapters/logEvidence";

/** The ten certified public Simple Tools, sorted. */
const PUBLIC_TOOL_NAMES = [
  "engineering.app.health",
  "engineering.deploy.ready",
  "engineering.deploy.status",
  "engineering.docker.health",
  "engineering.logs.explain",
  "engineering.vps.capacity",
  "engineering.vps.health",
  "engineering.vps.incident.summary",
  "engineering.vps.what_changed",
  "engineering.vps.why_down",
];

const PRO_TOOL_NAMES = [
  ...PUBLIC_TOOL_NAMES,
  "engineering.vps.doctor",
  "engineering.vps.change.safe",
  "engineering.vps.reconcile",
  "engineering.vps.recover",
  "engineering.vps.guardian",
].sort();

// ---- deterministic fakes (counting: prove instance sharing and statelessness) ----

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

/** Deterministic SafeChangeAdapter fake: records calls, never mutates anything real. */
function fakeSafeChangeAdapter(outcome: Partial<SafeChangeOutcome> = { accepted: true, ref: null, message: "fake accepted" }) {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  const adapter = {
    name: "fake-safe-change",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      calls.push({ resolved, correlationKey });
      return {
        accepted: outcome.accepted ?? true,
        ref: outcome.ref ?? null,
        message: outcome.message ?? "fake accepted",
      };
    },
  };
  return adapter;
}

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

const healthyDocker: DockerHealthEvidence = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 2, running: 2, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
};

const emptyLogs: LogEvidence = {
  observedAt: "2026-09-02T12:00:00Z",
  source: "test-producer",
  entries: [],
};

interface FakeAdapters {
  systemHealthAdapter: SystemHealthAdapter;
  applicationDeploymentAdapter: ApplicationDeploymentAdapter;
  dockerHealthAdapter: DockerHealthAdapter;
  logEvidenceAdapter: LogEvidenceAdapter;
  counters: { sys: () => number; app: () => number; docker: () => number; logs: () => number };
}

function fakeAdapters(): FakeAdapters {
  const sys = counting("sys-fake", healthyHost);
  const app = counting("app-fake", healthyApp);
  const docker = counting("docker-fake", healthyDocker);
  const logs = counting("logs-fake", emptyLogs);
  return {
    systemHealthAdapter: sys,
    applicationDeploymentAdapter: app,
    dockerHealthAdapter: docker,
    logEvidenceAdapter: logs,
    counters: {
      sys: () => sys.calls,
      app: () => app.calls,
      docker: () => docker.calls,
      logs: () => logs.calls,
    },
  };
}

async function withServer(ctx: ProContext): Promise<{ client: Client; close(): Promise<void> }> {
  const server = buildProServer(ctx);
  const client = new Client({ name: "pro-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

describe("pro server composition > MCP layer", () => {
  it("lists exactly 15 tools: ten public Simple Tools plus doctor, change.safe, reconcile, recover and guardian", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(PRO_TOOL_NAMES);
      // The composition's declared catalog equals the LIVE registered tools:
      expect(names).toEqual([...PRO_CATALOG_TOOL_NAMES].sort());
      expect(listed.tools).toHaveLength(15);
      expect(names).toContain("engineering.vps.doctor");
      expect(names).toContain("engineering.vps.change.safe");
      expect(names).toContain("engineering.vps.reconcile");
      expect(names).toContain("engineering.vps.recover");
      expect(names).toContain("engineering.vps.guardian");
    } finally {
      await close();
    }
  });

  it("doctor shares the SAME adapter instances with the public composition (single wiring, no second adapters)", async () => {
    const fakes = fakeAdapters();
    const ctx: ProContext = {
      systemHealthAdapter: fakes.systemHealthAdapter,
      applicationDeploymentAdapter: fakes.applicationDeploymentAdapter,
      dockerHealthAdapter: fakes.dockerHealthAdapter,
      logEvidenceAdapter: fakes.logEvidenceAdapter,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      // Public tools consume the shared instances first.
      const appCall = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(appCall.isError).toBeUndefined();
      const dockerCall = await client.callTool({ name: "engineering.docker.health", arguments: {} });
      expect(dockerCall.isError).toBeUndefined();
      expect(fakes.counters.app()).toBe(1);
      expect(fakes.counters.docker()).toBe(1);

      // The private doctor consumes the SAME instances (no separate wiring).
      const doctorCall = await client.callTool({ name: "engineering.vps.doctor", arguments: {} });
      expect(doctorCall.isError).toBeUndefined();
      expect(fakes.counters.app()).toBe(2);
      expect(fakes.counters.docker()).toBe(2);
      expect(fakes.counters.logs()).toBe(1);
      expect(fakes.counters.sys()).toBe(1);
    } finally {
      await close();
    }
  });

  it("doctor rejects non-empty arguments at the protocol layer", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.doctor", arguments: { path: "C:/x" } });
      expect(call.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("doctor zero-config: optional areas NOT_CONFIGURED (never read as healthy), verdict STABLE, fixed limitations", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.doctor", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        summary: string;
        areas: Array<{ area: string; coverage: string; status: string | null; summary: string | null; attention: boolean }>;
        attentionAreas: string[];
        limitations: string[];
      };
      expect(Object.keys(parsed).sort()).toEqual(["areas", "attentionAreas", "limitations", "status", "summary"]);
      expect(parsed.status).toBe("STABLE");
      expect(parsed.attentionAreas).toEqual([]);
      expect(parsed.limitations).toHaveLength(6);
      expect(parsed.areas.map((a) => a.area)).toEqual([
        "VPS_HEALTH",
        "CAPACITY",
        "APPLICATION_HEALTH",
        "DEPLOYMENT",
        "DOCKER",
        "LOGS",
      ]);
      const byArea = new Map(parsed.areas.map((a) => [a.area, a]));
      expect(byArea.get("VPS_HEALTH")?.coverage).toBe("OBSERVED");
      expect(byArea.get("CAPACITY")?.coverage).toBe("OBSERVED");
      for (const area of ["APPLICATION_HEALTH", "DEPLOYMENT", "DOCKER", "LOGS"]) {
        const areaReport = byArea.get(area);
        expect(areaReport?.coverage).toBe("NOT_CONFIGURED");
        expect(areaReport?.status).toBeNull();
        expect(areaReport?.summary).toBeNull();
        expect(areaReport?.attention).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it("change.safe plans over the MCP layer: PLAN_READY with allowlist, never executing, no applicationId exposed", async () => {
    const fakes = fakeAdapters();
    const ctx: ProContext = {
      systemHealthAdapter: fakes.systemHealthAdapter,
      applicationDeploymentAdapter: fakes.applicationDeploymentAdapter,
      dockerHealthAdapter: fakes.dockerHealthAdapter,
      logEvidenceAdapter: fakes.logEvidenceAdapter,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: { action: "application.redeploy", target: "gateway" },
      });
      expect(call.isError).toBeUndefined();
      const text = (call.content as Array<{ text: string }>)[0].text;
      const parsed = JSON.parse(text) as {
        status: string;
        risk: string;
        proposalFingerprint: string | null;
        target: { key: string; applicationName: string | null };
      };
      expect(parsed.status).toBe("PLAN_READY");
      expect(parsed.risk).toBe("REQUIRES_APPROVAL");
      expect(parsed.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.target).toEqual({ key: "gateway", applicationName: "Gateway" });
      expect(text).not.toContain("app-1");
      expect(text).not.toContain("applicationId");
    } finally {
      await close();
    }
  });

  it("change.safe with an unknown logical target -> BLOCKED at the MCP layer, fingerprint null", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: counting("app-fake", healthyApp),
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: { action: "application.redeploy", target: "ghost" },
      });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        proposalFingerprint: string | null;
        prechecks: Array<{ check: string; status: string }>;
      };
      expect(parsed.status).toBe("BLOCKED");
      expect(parsed.proposalFingerprint).toBeNull();
      expect(parsed.prechecks.find((c) => c.check === "TARGET_CONFIGURED")?.status).toBe("BLOCK");
    } finally {
      await close();
    }
  });

  it("change.safe EXECUTE without approval -> APPROVAL_REQUIRED at the protocol layer with ZERO mutation", async () => {
    const fakes = fakeAdapters();
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: fakes.systemHealthAdapter,
      applicationDeploymentAdapter: fakes.applicationDeploymentAdapter,
      dockerHealthAdapter: fakes.dockerHealthAdapter,
      logEvidenceAdapter: fakes.logEvidenceAdapter,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: { action: "application.redeploy", target: "gateway", execute: true },
      });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        executed: boolean;
        reason: string | null;
        mutation: { attempted: boolean; occurred: boolean; accepted: boolean };
        rollback: { available: boolean; performed: boolean };
        proposalFingerprint: string | null;
      };
      expect(parsed.status).toBe("APPROVAL_REQUIRED");
      expect(parsed.executed).toBe(false);
      expect(parsed.reason).toContain("zero mutation");
      expect(parsed.mutation).toEqual({ attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null });
      expect(parsed.rollback).toEqual({ available: false, performed: false });
      expect(parsed.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("change.safe rejects agent-supplied applicationId and other authority fields at the protocol layer", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      for (const extra of [
        { applicationId: "app-9" },
        { credential: "secret" },
        { url: "https://backend.example" },
        { toolName: "application-deploy" },
        { command: "rm -rf /" },
      ]) {
        const call = await client.callTool({
          name: "engineering.vps.change.safe",
          arguments: { action: "application.redeploy", target: "gateway", ...extra },
        });
        expect(call.isError).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it("change.safe EXECUTE over the MCP layer: approval bound to the plan fingerprint -> VERIFIED, no applicationId in output", async () => {
    const app = scriptedAppAdapter([healthyApp, healthyApp, newReleaseApp]);
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: app as unknown as ApplicationDeploymentAdapter,
      dockerHealthAdapter: counting("docker-fake", healthyDocker),
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      // PLAN first: the fingerprint is the approval anchor.
      const planCall = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: { action: "application.redeploy", target: "gateway" },
      });
      expect(planCall.isError).toBeUndefined();
      const plan = JSON.parse((planCall.content as Array<{ text: string }>)[0].text) as { status: string; proposalFingerprint: string | null };
      expect(plan.status).toBe("PLAN_READY");
      expect(plan.proposalFingerprint).not.toBeNull();

      // EXECUTE with the approved fingerprint: one mutation attempt, then post-validation.
      const execCall = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: {
          action: "application.redeploy",
          target: "gateway",
          execute: true,
          approval: { approved: true, proposalFingerprint: plan.proposalFingerprint as string },
        },
      });
      expect(execCall.isError).toBeUndefined();
      const text = (execCall.content as Array<{ text: string }>)[0].text;
      const parsed = JSON.parse(text) as {
        status: string;
        executed: boolean;
        mutation: { attempted: boolean; occurred: boolean; accepted: boolean; correlationKey: string | null };
        postValidation: { status: string; currentReleaseId: string | null } | null;
        rollback: { available: boolean; performed: boolean };
        target: { key: string; applicationName: string | null };
      };
      expect(parsed.status).toBe("VERIFIED");
      expect(parsed.executed).toBe(true);
      expect(parsed.mutation).toEqual({
        attempted: true,
        occurred: true,
        accepted: true,
        ref: null,
        correlationKey: plan.proposalFingerprint,
      });
      expect(parsed.mutation.correlationKey).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.postValidation?.status).toBe("VERIFIED");
      expect(parsed.postValidation?.currentReleaseId).toBe("r-3");
      expect(parsed.rollback).toEqual({ available: false, performed: false });
      // Exactly one mutation call, with the operator-resolved target and the approved fingerprint.
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0].correlationKey).toBe(plan.proposalFingerprint);
      // Output safety: applicationId never leaks through the MCP layer.
      expect(text).not.toContain("app-1");
      expect(text).not.toContain("applicationId");
    } finally {
      await close();
    }
  });
});

describe("pro server composition > engineering.vps.reconcile (read-only drift detection)", () => {
  let dir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir !== null) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  function writeReleaseStateFixture(over: Record<string, unknown>): string {
    dir = mkdtempSync(join(tmpdir(), "pro-reconcile-"));
    const file = join(dir, "release-state.json");
    writeFileSync(file, JSON.stringify(over), "utf8");
    return file;
  }

  it("no expected-state source configured -> UNKNOWN fail-closed, catalog visible, ZERO mutation", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    vi.stubEnv(RECONCILE_RELEASE_STATE_FILE_ENV, "");
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.reconcile", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        findings: Array<{ code: string; severity: string }>;
        actual: { catalog: { toolCount: number; catalogVersion: string; catalogHash: string } | null; container: unknown };
        mutationPerformed: boolean;
      };
      // Absence of evidence is NEVER drift: expected unavailable + catalog-only -> UNKNOWN.
      expect(parsed.status).toBe("UNKNOWN");
      expect(parsed.findings.some((f) => f.code === "EXPECTED_STATE_INCOMPLETE" && f.severity === "info")).toBe(true);
      expect(parsed.findings.some((f) => f.severity === "critical")).toBe(false);
      expect(parsed.actual.catalog?.toolCount).toBe(15);
      expect(parsed.actual.catalog?.catalogVersion).toBe(PRO_CATALOG_VERSION);
      expect(parsed.actual.catalog?.catalogHash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.mutationPerformed).toBe(false);
      // The mutation boundary is untouched: reconcile has no execution authority at all.
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("release-state fixture in sync -> IN_SYNC over the live Pro catalog", async () => {
    vi.stubEnv(
      RECONCILE_RELEASE_STATE_FILE_ENV,
      writeReleaseStateFixture({
        currentRelease: "pro-candidate:fake",
        productionCatalogHash: createProCatalogSnapshot(PRO_CATALOG_TOOL_NAMES).catalogHash,
        toolCount: 15,
        catalogVersion: PRO_CATALOG_VERSION,
        deployStatus: "PASS",
      }),
    );
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.reconcile", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        findings: Array<{ code: string; severity: string }>;
        mutationPerformed: boolean;
      };
      expect(parsed.status).toBe("IN_SYNC");
      expect(parsed.findings.some((f) => f.severity === "critical")).toBe(false);
      expect(parsed.mutationPerformed).toBe(false);
    } finally {
      await close();
    }
  });

  it("drifted toolCount in release-state -> DRIFTED + TOOL_COUNT_MISMATCH (critical)", async () => {
    vi.stubEnv(
      RECONCILE_RELEASE_STATE_FILE_ENV,
      writeReleaseStateFixture({
        toolCount: 12,
        catalogVersion: PRO_CATALOG_VERSION,
        deployStatus: "PASS",
      }),
    );
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.reconcile", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        findings: Array<{ code: string; severity: string; expected: number; actual: number }>;
        mutationPerformed: boolean;
      };
      expect(parsed.status).toBe("DRIFTED");
      const finding = parsed.findings.find((f) => f.code === "TOOL_COUNT_MISMATCH");
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("critical");
      expect(finding?.expected).toBe(12);
      expect(finding?.actual).toBe(15);
      expect(parsed.mutationPerformed).toBe(false);
    } finally {
      await close();
    }
  });

  it("strict input at the protocol layer: exactly {} (no path, no credential, no URL, no tool selection)", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      for (const extra of [
        { path: "C:/secret" },
        { credential: "secret" },
        { url: "https://backend.example" },
        { toolName: "application-redeploy" },
        { command: "rm -rf /" },
        { applicationId: "app-9" },
      ]) {
        const call = await client.callTool({ name: "engineering.vps.reconcile", arguments: extra });
        expect(call.isError).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

describe("pro server composition > engineering.vps.recover (controlled official rollback)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("recover via MCP without any evidence or runner channel -> fail-closed UNKNOWN, ZERO mutation, strict input", async () => {
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    vi.stubEnv(RECONCILE_RELEASE_STATE_FILE_ENV, "");
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.recover", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        mutationPerformed: boolean;
        precheck: { reconcile: { status: string }; blockers: string[] };
        plan: { action: string; possible: boolean };
      };
      // No evidence at all -> reconcile UNKNOWN -> recovery refused (fail-closed).
      expect(parsed.status).toBe("UNKNOWN");
      expect(parsed.mutationPerformed).toBe(false);
      expect(parsed.precheck.reconcile.status).toBe("UNKNOWN");
      expect(parsed.precheck.blockers).toContain("RECONCILE_UNKNOWN");
      expect(parsed.plan.action).toBe("rollback");
      // The mutation boundary is untouched by recover.
      expect(adapter.calls).toHaveLength(0);
      // Strict input at the protocol layer.
      for (const extra of [
        { toolName: "application-redeploy" },
        { command: "rm -rf /" },
        { credential: "secret" },
        { socket: "/tmp/runner.sock" },
        { applicationId: "app-9" },
      ]) {
        const strict = await client.callTool({ name: "engineering.vps.recover", arguments: extra });
        expect(strict.isError).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

describe("pro server composition > engineering.vps.guardian (coordinator/classifier)", () => {
  let dir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir !== null) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  function writeReleaseStateFixture(over: Record<string, unknown>): string {
    dir = mkdtempSync(join(tmpdir(), "pro-guardian-"));
    const file = join(dir, "release-state.json");
    writeFileSync(file, JSON.stringify(over), "utf8");
    return file;
  }

  const inSyncEnv = () => {
    vi.stubEnv(
      RECONCILE_RELEASE_STATE_FILE_ENV,
      writeReleaseStateFixture({
        currentRelease: "pro-candidate:fake",
        productionCatalogHash: createProCatalogSnapshot(PRO_CATALOG_TOOL_NAMES).catalogHash,
        toolCount: 15,
        catalogVersion: PRO_CATALOG_VERSION,
        deployStatus: "PASS",
      }),
    );
  };

  it("default {} stays fully read-only: HEALTHY/NONE over healthy evidence + IN_SYNC catalog, ZERO mutation", async () => {
    inSyncEnv();
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: counting("app-fake", healthyApp) as unknown as ApplicationDeploymentAdapter,
      dockerHealthAdapter: counting("docker-fake", healthyDocker),
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.guardian", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        health: string;
        drift: string;
        recommendedAction: string;
        mode: string;
        mutationPerformed: boolean;
        execution?: unknown;
        validation?: unknown;
      };
      expect(parsed.status).toBe("HEALTHY");
      expect(parsed.health).toBe("HEALTHY");
      expect(parsed.drift).toBe("IN_SYNC");
      expect(parsed.recommendedAction).toBe("NONE");
      expect(parsed.mode).toBe("read-only");
      expect(parsed.mutationPerformed).toBe(false);
      expect(parsed.execution).toBeUndefined();
      expect(parsed.validation).toBeUndefined();
      // The mutation boundary is untouched in read-only mode.
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("strict input at the protocol layer: no arbitrary target/applicationId/command/credential/action/toolName; ZERO mutation", async () => {
    inSyncEnv();
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      for (const extra of [
        { target: "gateway" },
        { target: { applicationId: "app-1" } },
        { applicationId: "app-1" },
        { command: "rm -rf /" },
        { credential: "secret" },
        { url: "https://backend.example" },
        { toolName: "application-redeploy" },
        { action: "application.redeploy" },
        { approval: { approved: "yes" } },
      ]) {
        const call = await client.callTool({ name: "engineering.vps.guardian", arguments: extra });
        expect(call.isError).toBe(true);
      }
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("execute=true without approval -> execution BLOCKED (authorized=false), ZERO mutation", async () => {
    inSyncEnv();
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: counting("app-fake", healthyApp) as unknown as ApplicationDeploymentAdapter,
      dockerHealthAdapter: counting("docker-fake", healthyDocker),
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.guardian", arguments: { execute: true } });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        mode: string;
        mutationPerformed: boolean;
        execution: { requested: boolean; authorized: boolean; status: string; performed: boolean };
        validation?: unknown;
      };
      expect(parsed.mode).toBe("execute");
      expect(parsed.execution.authorized).toBe(false);
      expect(parsed.execution.status).toBe("BLOCKED");
      expect(parsed.execution.performed).toBe(false);
      expect(parsed.mutationPerformed).toBe(false);
      expect(parsed.validation).toBeUndefined();
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("DRIFTED catalog -> reconcile feeds the classification; recover runs STRICTLY in plan-mode {} and BLOCKED (LKG missing), ZERO mutation", async () => {
    vi.stubEnv(
      RECONCILE_RELEASE_STATE_FILE_ENV,
      writeReleaseStateFixture({ toolCount: 12, catalogVersion: PRO_CATALOG_VERSION, deployStatus: "PASS" }),
    );
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.guardian", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        drift: string;
        recommendedAction: string;
        reason: string;
        mode: string;
        mutationPerformed: boolean;
        evidence: { recover: { status: string; precheck: { blockers: string[] } } | null };
      };
      expect(parsed.status).toBe("DRIFTED");
      expect(parsed.drift).toBe("DRIFTED");
      expect(parsed.recommendedAction).toBe("BLOCKED");
      expect(parsed.reason).toContain("LKG_MISSING");
      expect(parsed.mode).toBe("read-only");
      expect(parsed.mutationPerformed).toBe(false);
      // recover was used CORRECTLY: plan-mode only, with its own blockers exposed.
      expect(parsed.evidence.recover).not.toBeNull();
      expect(parsed.evidence.recover?.status).toBe("BLOCKED");
      expect(parsed.evidence.recover?.precheck.blockers).toContain("LKG_MISSING");
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("no expected-state source -> evidence UNKNOWN -> UNKNOWN/BLOCKED, read-only, ZERO mutation", async () => {
    vi.stubEnv(RECONCILE_RELEASE_STATE_FILE_ENV, "");
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
      safeChangeAdapter: null,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({ name: "engineering.vps.guardian", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        recommendedAction: string;
        mode: string;
        mutationPerformed: boolean;
        execution?: unknown;
      };
      expect(parsed.status).toBe("UNKNOWN");
      expect(parsed.recommendedAction).toBe("BLOCKED");
      expect(parsed.mode).toBe("read-only");
      expect(parsed.mutationPerformed).toBe(false);
      expect(parsed.execution).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("authorized CHANGE_SAFE delegates to engineering.vps.change.safe (PLAN fingerprint + TOCTOU): one adapter call, Doctor-evidence target, convergence reported", async () => {
    inSyncEnv();
    // App evidence script: guardian doctor pass, change.safe PLAN, change.safe
    // EXECUTE prechecks, change.safe post-validation (new release -> VERIFIED),
    // guardian post-validation doctor pass.
    const failedApp: ApplicationDeploymentEvidence = {
      ...healthyApp,
      observedAt: "2026-09-02T12:30:00Z",
      deploymentStatus: "FAILED",
      applicationHealthy: false,
      lastDeploymentFinishedAt: "2026-09-02T12:00:00Z",
    };
    const app = scriptedAppAdapter([failedApp, failedApp, failedApp, newReleaseApp, failedApp]);
    const adapter = fakeSafeChangeAdapter();
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: app as unknown as ApplicationDeploymentAdapter,
      dockerHealthAdapter: counting("docker-fake", healthyDocker),
      logEvidenceAdapter: null,
      changeTargets: { gateway: { applicationId: "app-1", applicationName: "Gateway" } },
      safeChangeAdapter: adapter as unknown as SafeChangeAdapter,
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({
        name: "engineering.vps.guardian",
        arguments: { execute: true, approval: { approved: true } },
      });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text) as {
        status: string;
        recommendedAction: string;
        mode: string;
        mutationPerformed: boolean;
        execution: {
          action: string | null;
          status: string;
          performed: boolean;
          success: boolean | undefined;
          target: { applicationId: string } | null;
          result: { status: string; executed: boolean; mutation: { occurred: boolean; accepted: boolean; correlationKey: string | null } } | null;
        };
        validation: { converged: boolean; drift: string; health: string };
      };
      // Doctor evidence (DEPLOYMENT FAILED, app observed) + IN_SYNC -> CHANGE_SAFE.
      expect(parsed.status).toBe("DEGRADED");
      expect(parsed.recommendedAction).toBe("CHANGE_SAFE");
      expect(parsed.mode).toBe("execute");
      expect(parsed.execution.action).toBe("CHANGE_SAFE");
      expect(parsed.execution.status).toBe("PERFORMED");
      expect(parsed.execution.performed).toBe(true);
      expect(parsed.execution.success).toBe(true);
      // The target came ONLY from Doctor evidence mapped against the operator allowlist.
      expect(parsed.execution.target).toEqual({ applicationId: "app-1" });
      expect(parsed.mutationPerformed).toBe(true);
      // The delegated change.safe result: executed with a confirmed mutation, fingerprint-bound.
      expect(parsed.execution.result?.status).toBe("VERIFIED");
      expect(parsed.execution.result?.executed).toBe(true);
      expect(parsed.execution.result?.mutation.occurred).toBe(true);
      expect(parsed.execution.result?.mutation.correlationKey).toMatch(/^[0-9a-f]{64}$/);
      // Post-validation re-ran doctor + reconcile and reported convergence.
      expect(parsed.validation.converged).toBe(true);
      expect(parsed.validation.drift).toBe("IN_SYNC");
      // MUTATION AUTHORITY stays in the Supertool: exactly ONE SafeChangeAdapter
      // call, made by change.safe, with the operator-resolved target.
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0].resolved).toEqual({ applicationId: "app-1", applicationName: "Gateway" });
    } finally {
      await close();
    }
  });
});
