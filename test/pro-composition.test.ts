/**
 * Pro composition certification: the 10 certified public Simple Tools plus
 * the private engineering.vps.doctor and the STRICTLY PLAN_ONLY
 * engineering.vps.change.safe on ONE McpServer with ONE shared adapter and
 * allowlist wiring. MCP layer exercised through InMemoryTransport (initialize
 * + tools/list + callTool). No real VPS, no network, no I/O, no mutation.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildProServer } from "../src/proServer";
import type { ProContext } from "../src/proContext";
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

const PRO_TOOL_NAMES = [...PUBLIC_TOOL_NAMES, "engineering.vps.doctor", "engineering.vps.change.safe"].sort();

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
  it("lists exactly 12 tools: ten public Simple Tools plus doctor and PLAN_ONLY change.safe", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
    };
    const { client, close } = await withServer(ctx);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(PRO_TOOL_NAMES);
      expect(listed.tools).toHaveLength(12);
      expect(names).toContain("engineering.vps.doctor");
      expect(names).toContain("engineering.vps.change.safe");
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

  it("change.safe rejects extra fields (execute/approval do not exist) at the protocol layer", async () => {
    const ctx: ProContext = {
      systemHealthAdapter: counting("sys-fake", healthyHost),
      applicationDeploymentAdapter: null,
      dockerHealthAdapter: null,
      logEvidenceAdapter: null,
      changeTargets: {},
    };
    const { client, close } = await withServer(ctx);
    try {
      const call = await client.callTool({
        name: "engineering.vps.change.safe",
        arguments: { action: "application.redeploy", target: "gateway", execute: true },
      });
      expect(call.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
