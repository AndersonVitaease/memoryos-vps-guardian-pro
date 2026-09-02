/**
 * Private Supertool engineering.vps.doctor — deterministic certification.
 * Pure assessors + handler composition with counting fakes. No real VPS,
 * no network, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  assessVpsDoctor,
  handleVpsDoctor,
  DOCTOR_AREA_ORDER,
  DOCTOR_LIMITATIONS,
} from "../src/doctor/vpsDoctor";
import type { DoctorObservation, DoctorObservations } from "../src/doctor/vpsDoctor";
import { assessLogsExplain } from "memoryos-vps-guardian/src/tools/logsExplain";
import type { VpsHealthEvidence } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentEvidence } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { DockerHealthEvidence } from "memoryos-vps-guardian/src/adapters/dockerHealth";
import type { LogEvidence } from "memoryos-vps-guardian/src/adapters/logEvidence";

const observed = (status: string): DoctorObservation => ({ kind: "observed", status, summary: "test" });
const notConfigured = (): DoctorObservation => ({ kind: "not_configured" });

function observationsOf(parts: Partial<DoctorObservations>): DoctorObservations {
  return {
    vpsHealth: parts.vpsHealth ?? notConfigured(),
    capacity: parts.capacity ?? notConfigured(),
    applicationHealth: parts.applicationHealth ?? notConfigured(),
    deployment: parts.deployment ?? notConfigured(),
    docker: parts.docker ?? notConfigured(),
    logs: parts.logs ?? notConfigured(),
  };
}

function counting<T>(name: string, evidence: T): { name: string; calls: number; collect(): T } {
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

function countingNull(name: string): { name: string; calls: number; collect(): null } {
  const adapter = {
    name,
    calls: 0,
    collect(): null {
      adapter.calls += 1;
      return null;
    },
  };
  return adapter;
}

// ---- evidence fixtures (deterministic, valid per the public contracts) ----

const healthyHost: VpsHealthEvidence = {
  uptimeSeconds: 987654,
  cpuCount: 4,
  loadAverage1m: 0.4,
  memoryTotalBytes: 17_179_869_184,
  memoryFreeBytes: 8_589_934_592,
};

const degradedHost: VpsHealthEvidence = {
  uptimeSeconds: 100,
  cpuCount: 4,
  loadAverage1m: 0.4,
  memoryTotalBytes: 1_000_000_000,
  memoryFreeBytes: 50_000_000,
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

const degradedAndFailedApp: ApplicationDeploymentEvidence = {
  ...healthyApp,
  applicationHealthy: false,
  deploymentStatus: "FAILED",
};

const healthyDocker: DockerHealthEvidence = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 2, running: 2, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
};

const degradedDocker: DockerHealthEvidence = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 1, running: 0, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 },
};

const unclassifiableLogs: LogEvidence = {
  observedAt: "2026-09-02T12:00:00Z",
  source: "test-producer",
  entries: [],
};

const explainedLogs: LogEvidence = {
  observedAt: "2026-09-02T12:00:00Z",
  source: "test-producer",
  entries: [
    { timestamp: "2026-09-02T11:59:00Z", severity: "ERROR", code: "OOM", message: "out of memory" },
  ],
};

describe("engineering.vps.doctor > strict input (function boundary)", () => {
  it("accepts exactly {} (no parameters)", () => {
    const result = handleVpsDoctor({}, counting("sys", healthyHost), null, null, null);
    expect(result.status).toBe("STABLE");
  });

  it("rejects non-empty input with the strict-empty contract message", () => {
    expect(() => handleVpsDoctor({ extra: true }, counting("sys", healthyHost), null, null, null)).toThrowError(
      "input must be exactly {} (no parameters)",
    );
  });
});

describe("engineering.vps.doctor > pure assessor (fixed areas, deterministic precedence)", () => {
  it("healthy observed areas with unconfigured optionals -> STABLE, fixed area order, no attention", () => {
    const result = assessVpsDoctor(
      observationsOf({
        vpsHealth: observed("HEALTHY"),
        capacity: observed("OK"),
        applicationHealth: observed("HEALTHY"),
        deployment: observed("OK"),
        docker: observed("HEALTHY"),
      }),
    );
    expect(result.status).toBe("STABLE");
    expect(result.summary).toMatch(/^STABLE: all 5 observed area\(s\)/);
    expect(result.areas.map((a) => a.area)).toEqual(DOCTOR_AREA_ORDER);
    expect(result.attentionAreas).toEqual([]);
    expect(result.areas.every((a) => a.attention === false)).toBe(true);
  });

  it("ATTENTION lists attentionAreas in the fixed area order across all six areas", () => {
    const result = assessVpsDoctor(
      observationsOf({
        vpsHealth: observed("DEGRADED"),
        capacity: observed("PRESSURED"),
        applicationHealth: observed("DEGRADED"),
        deployment: observed("FAILED"),
        docker: observed("DEGRADED"),
        logs: observed("EXPLAINED"),
      }),
    );
    expect(result.status).toBe("ATTENTION");
    expect(result.attentionAreas).toEqual([
      "VPS_HEALTH",
      "CAPACITY",
      "APPLICATION_HEALTH",
      "DEPLOYMENT",
      "DOCKER",
      "LOGS",
    ]);
  });

  it("UNKNOWN-first: ambiguous observed areas force UNKNOWN while factual attention areas remain listed", () => {
    const result = assessVpsDoctor(
      observationsOf({
        vpsHealth: observed("DEGRADED"),
        capacity: observed("OK"),
        applicationHealth: observed("UNAVAILABLE"),
        deployment: observed("OK"),
        docker: observed("UNKNOWN"),
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toMatch(
      /^UNKNOWN: evidence is incomplete or unavailable for 2 observed area\(s\) \(APPLICATION_HEALTH, DOCKER\)/,
    );
    expect(result.attentionAreas).toEqual(["VPS_HEALTH"]);
  });

  it("NOT_CONFIGURED observations carry null status/summary and are never attention", () => {
    const result = assessVpsDoctor(observationsOf({}));
    const logsArea = result.areas.find((a) => a.area === "LOGS");
    expect(logsArea).toEqual({
      area: "LOGS",
      coverage: "NOT_CONFIGURED",
      status: null,
      summary: null,
      attention: false,
    });
    expect(result.limitations).toEqual(DOCTOR_LIMITATIONS);
  });
});

describe("engineering.vps.doctor > handler composition (one collect per adapter, shared instances)", () => {
  it("collects EXACTLY once per configured adapter per call (stateless)", () => {
    const sys = counting("sys", healthyHost);
    const app = counting("app", healthyApp);
    const docker = counting("docker", healthyDocker);
    const logs = counting("logs", unclassifiableLogs);

    handleVpsDoctor({}, sys, app, docker, logs);
    handleVpsDoctor({}, sys, app, docker, logs);

    expect(sys.calls).toBe(2);
    expect(app.calls).toBe(2);
    expect(docker.calls).toBe(2);
    expect(logs.calls).toBe(2);
  });

  it("unconfigured optional adapters -> NOT_CONFIGURED areas; verdict stays STABLE on healthy host", () => {
    const result = handleVpsDoctor({}, counting("sys", healthyHost), null, null, null);
    expect(result.status).toBe("STABLE");
    const byArea = new Map(result.areas.map((a) => [a.area, a]));
    for (const area of ["APPLICATION_HEALTH", "DEPLOYMENT", "DOCKER", "LOGS"] as const) {
      expect(byArea.get(area)?.coverage).toBe("NOT_CONFIGURED");
      expect(byArea.get(area)?.status).toBeNull();
      expect(byArea.get(area)?.summary).toBeNull();
      expect(byArea.get(area)?.attention).toBe(false);
    }
    expect(byArea.get("VPS_HEALTH")?.coverage).toBe("OBSERVED");
    expect(byArea.get("VPS_HEALTH")?.status).toBe("HEALTHY");
    expect(byArea.get("CAPACITY")?.status).toBe("OK");
  });

  it("configured-but-null evidence -> OBSERVED/UNAVAILABLE areas and overall UNKNOWN", () => {
    const app = countingNull("app");
    const result = handleVpsDoctor({}, counting("sys", healthyHost), app, null, null);
    expect(app.calls).toBe(1);
    expect(result.status).toBe("UNKNOWN");
    const byArea = new Map(result.areas.map((a) => [a.area, a]));
    expect(byArea.get("APPLICATION_HEALTH")?.coverage).toBe("OBSERVED");
    expect(byArea.get("APPLICATION_HEALTH")?.status).toBe("UNAVAILABLE");
    expect(byArea.get("DEPLOYMENT")?.status).toBe("UNAVAILABLE");
    expect(byArea.get("APPLICATION_HEALTH")?.summary).toMatch(/^UNAVAILABLE: the configured application\/deployment/);
  });

  it("factual attention only: degraded host, failed deployment, degraded docker and explained logs -> ATTENTION with all six areas", () => {
    const result = handleVpsDoctor(
      {},
      counting("sys", degradedHost),
      counting("app", degradedAndFailedApp),
      counting("docker", degradedDocker),
      counting("logs", explainedLogs),
    );
    expect(result.status).toBe("ATTENTION");
    expect(result.attentionAreas).toEqual([
      "VPS_HEALTH",
      "CAPACITY",
      "APPLICATION_HEALTH",
      "DEPLOYMENT",
      "DOCKER",
      "LOGS",
    ]);
  });

  it("LOGS follows the public error taxonomy: classifiable error code -> EXPLAINED (attention); nothing classifiable -> UNKNOWN (ambiguous, never attention)", () => {
    expect(assessLogsExplain(explainedLogs).status).toBe("EXPLAINED");
    expect(assessLogsExplain(unclassifiableLogs).status).toBe("UNKNOWN");

    const result = handleVpsDoctor({}, counting("sys", healthyHost), null, null, counting("logs", unclassifiableLogs));
    expect(result.status).toBe("UNKNOWN");
    const logsArea = result.areas.find((a) => a.area === "LOGS");
    expect(logsArea?.coverage).toBe("OBSERVED");
    expect(logsArea?.status).toBe("UNKNOWN");
    expect(logsArea?.attention).toBe(false);
  });
});
