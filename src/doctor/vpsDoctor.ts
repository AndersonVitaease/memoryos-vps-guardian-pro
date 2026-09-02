/**
 * engineering.vps.doctor — PRIVATE commercial Supertool (proprietary).
 *
 * Ported from the validated specification (audited, implemented, technically
 * certified and then deliberately REMOVED from the public repository: this
 * tool is commercial and must never be published in the open-source repo).
 *
 * Deterministic read-only stateless composition over the certified PUBLIC
 * assessors: ONE evidence collect per configured source, direct code reuse,
 * no MCP tool-to-tool recursion, no new evidence source, no new adapter type,
 * no environment variable, no state.
 *
 * Contract:
 * - Input must be exactly {} (strict-empty at the function boundary and at
 *   the MCP protocol layer).
 * - Fixed six-area coverage map in fixed order: VPS_HEALTH, CAPACITY,
 *   APPLICATION_HEALTH, DEPLOYMENT, DOCKER, LOGS. Each area reports
 *   { area, coverage: OBSERVED | NOT_CONFIGURED, status, summary, attention }.
 * - NOT_CONFIGURED means no evidence source is configured for that area:
 *   status and summary are null and attention is false. It is NEVER read as
 *   healthy.
 * - A configured source returning no evidence is OBSERVED/UNAVAILABLE and
 *   makes the overall verdict UNKNOWN.
 * - Overall precedence (UNKNOWN-first): any ambiguous observed area
 *   (UNKNOWN or UNAVAILABLE) -> overall UNKNOWN (factual attention areas are
 *   still listed); else any attention -> ATTENTION; else STABLE.
 * - Attention marks observed factual conditions only, via fixed predicates:
 *   VPS_HEALTH/APPLICATION_HEALTH/DOCKER -> DEGRADED, CAPACITY -> PRESSURED,
 *   DEPLOYMENT -> FAILED, LOGS -> EXPLAINED. The public logs taxonomy
 *   classifies error signals only (producer error codes and error message
 *   rules; there is no benign category), so EXPLAINED factually means at
 *   least one problem-class log signal was matched. UNKNOWN and UNAVAILABLE
 *   are never attention.
 * - No causal inference anywhere: attention is correlation, never diagnosis.
 * - Excluded on purpose: change observation (calling what_changed advances
 *   the shared session baseline — a state effect) and deployment readiness
 *   (a decision advisory, not a current-state signal).
 * - No shell, no SSH, no child processes, no network, no Docker socket or
 *   CLI, no journalctl, no raw log access, no secrets, no LLM, no mutation,
 *   no recovery or deployment authority.
 */
import { z } from "zod";
import { assessVpsHealth, assertStrictEmptyInput } from "memoryos-vps-guardian/src/tools/vpsHealth";
import { assessVpsCapacity } from "memoryos-vps-guardian/src/tools/vpsCapacity";
import {
  assessApplicationHealth,
  assessDeployStatus,
} from "memoryos-vps-guardian/src/tools/applicationDeployment";
import { assessDockerHealth } from "memoryos-vps-guardian/src/tools/dockerHealth";
import { assessLogsExplain } from "memoryos-vps-guardian/src/tools/logsExplain";
import type { SystemHealthAdapter } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentAdapter } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type {
  DockerHealthAdapter,
  DockerHealthEvidence,
} from "memoryos-vps-guardian/src/adapters/dockerHealth";
import type { LogEvidence, LogEvidenceAdapter } from "memoryos-vps-guardian/src/adapters/logEvidence";

export type DoctorStatus = "ATTENTION" | "STABLE" | "UNKNOWN";

export type DoctorArea =
  | "VPS_HEALTH"
  | "CAPACITY"
  | "APPLICATION_HEALTH"
  | "DEPLOYMENT"
  | "DOCKER"
  | "LOGS";

export type DoctorCoverage = "OBSERVED" | "NOT_CONFIGURED";

export interface DoctorAreaReport {
  area: DoctorArea;
  coverage: DoctorCoverage;
  status: string | null;
  summary: string | null;
  attention: boolean;
}

export interface DoctorResult {
  status: DoctorStatus;
  summary: string;
  areas: DoctorAreaReport[];
  attentionAreas: DoctorArea[];
  limitations: string[];
}

/** Fixed area order of the coverage map (never reordered, never filtered). */
export const DOCTOR_AREA_ORDER: DoctorArea[] = [
  "VPS_HEALTH",
  "CAPACITY",
  "APPLICATION_HEALTH",
  "DEPLOYMENT",
  "DOCKER",
  "LOGS",
];

/** Fixed limitations, returned verbatim in every result. */
export const DOCTOR_LIMITATIONS: string[] = [
  "This verdict is a read-only advisory summary: doctor never changes, deploys, restarts, repairs or approves anything.",
  "It synthesizes only the evidence sources already available to this server; it never reaches new systems.",
  "attention marks an observed factual condition, not a cause, a diagnosis and not a severity ranking.",
  "It has no access to raw log content: the LOGS area reflects the fixed error taxonomy over operator-supplied signals only.",
  "NOT_CONFIGURED means no evidence source is configured for that area; it is never a signal of health.",
  "Change observation and deployment readiness are intentionally excluded from this composition.",
];

export const vpsDoctorOutputSchema = z.object({
  status: z.enum(["ATTENTION", "STABLE", "UNKNOWN"]),
  summary: z.string(),
  areas: z.array(
    z.object({
      area: z.enum([
        "VPS_HEALTH",
        "CAPACITY",
        "APPLICATION_HEALTH",
        "DEPLOYMENT",
        "DOCKER",
        "LOGS",
      ]),
      coverage: z.enum(["OBSERVED", "NOT_CONFIGURED"]),
      status: z.string().nullable(),
      summary: z.string().nullable(),
      attention: z.boolean(),
    }),
  ),
  attentionAreas: z.array(
    z.enum(["VPS_HEALTH", "CAPACITY", "APPLICATION_HEALTH", "DEPLOYMENT", "DOCKER", "LOGS"]),
  ),
  limitations: z.array(z.string()),
});

/** One doctor observation for a single fixed area. */
export type DoctorObservation =
  | { kind: "not_configured" }
  | { kind: "observed"; status: string; summary: string };

export interface DoctorObservations {
  vpsHealth: DoctorObservation;
  capacity: DoctorObservation;
  applicationHealth: DoctorObservation;
  deployment: DoctorObservation;
  docker: DoctorObservation;
  logs: DoctorObservation;
}

const NOT_CONFIGURED_REPORT: Omit<DoctorAreaReport, "area"> = {
  coverage: "NOT_CONFIGURED",
  status: null,
  summary: null,
  attention: false,
};

const APPLICATION_UNAVAILABLE_SUMMARY =
  "UNAVAILABLE: the configured application/deployment evidence source returned no evidence for this call; nothing was inferred.";
const DOCKER_UNAVAILABLE_SUMMARY =
  "UNAVAILABLE: the configured docker-health evidence source returned no evidence for this call; nothing was inferred.";
const LOGS_UNAVAILABLE_SUMMARY =
  "UNAVAILABLE: the configured log-evidence source returned no evidence for this call; nothing was inferred.";

/**
 * Fixed factual attention predicates, one per area. Validated against the
 * public classifiers before approval; no heuristic and no severity ranking.
 */
function isAttentionArea(area: DoctorArea, status: string): boolean {
  switch (area) {
    case "VPS_HEALTH":
    case "APPLICATION_HEALTH":
    case "DOCKER":
      return status === "DEGRADED";
    case "CAPACITY":
      return status === "PRESSURED";
    case "DEPLOYMENT":
      return status === "FAILED";
    // The public logs taxonomy classifies error signals only (producer error
    // codes and error message rules; there is no benign category), so
    // EXPLAINED factually means at least one problem-class log signal was
    // matched. UNKNOWN and UNAVAILABLE are never attention.
    case "LOGS":
      return status === "EXPLAINED";
  }
}

/** An observed area is ambiguous when its condition cannot be determined. */
function isAmbiguousArea(status: string): boolean {
  return status === "UNKNOWN" || status === "UNAVAILABLE";
}

function observationsForArea(observations: DoctorObservations, area: DoctorArea): DoctorObservation {
  switch (area) {
    case "VPS_HEALTH":
      return observations.vpsHealth;
    case "CAPACITY":
      return observations.capacity;
    case "APPLICATION_HEALTH":
      return observations.applicationHealth;
    case "DEPLOYMENT":
      return observations.deployment;
    case "DOCKER":
      return observations.docker;
    case "LOGS":
      return observations.logs;
  }
}

function areaReport(area: DoctorArea, observation: DoctorObservation): DoctorAreaReport {
  if (observation.kind === "not_configured") {
    return { area, ...NOT_CONFIGURED_REPORT };
  }
  return {
    area,
    coverage: "OBSERVED",
    status: observation.status,
    summary: observation.summary,
    attention: isAttentionArea(area, observation.status),
  };
}

/**
 * Pure deterministic assessment over the six fixed areas. The summary of each
 * verdict is factual: it counts and names areas, it never explains causes.
 */
export function assessVpsDoctor(observations: DoctorObservations): DoctorResult {
  const areas = DOCTOR_AREA_ORDER.map((area) =>
    areaReport(area, observationsForArea(observations, area)),
  );

  const observedAreas = areas.filter((a) => a.coverage === "OBSERVED");
  const attentionAreas = areas.filter((a) => a.attention).map((a) => a.area);
  const ambiguousAreas = observedAreas.filter(
    (a) => a.status !== null && isAmbiguousArea(a.status),
  );

  if (ambiguousAreas.length > 0) {
    return {
      status: "UNKNOWN",
      summary:
        `UNKNOWN: evidence is incomplete or unavailable for ${ambiguousAreas.length} observed area(s) ` +
        `(${ambiguousAreas.map((a) => a.area).join(", ")}); no reliable overall verdict is inferred.`,
      areas,
      attentionAreas,
      limitations: DOCTOR_LIMITATIONS,
    };
  }

  if (attentionAreas.length > 0) {
    return {
      status: "ATTENTION",
      summary:
        `ATTENTION: ${attentionAreas.length} area(s) currently report conditions that need operator attention ` +
        `(${attentionAreas.join(", ")}); this is an observed correlation, not a causal diagnosis.`,
      areas,
      attentionAreas,
      limitations: DOCTOR_LIMITATIONS,
    };
  }

  return {
    status: "STABLE",
    summary: `STABLE: all ${observedAreas.length} observed area(s) currently report no condition that needs attention.`,
    areas,
    attentionAreas,
    limitations: DOCTOR_LIMITATIONS,
  };
}

/**
 * MCP handler: strict-empty input; ONE collect() per configured adapter;
 * the SAME adapter instances as the public composition (no second wiring).
 * VPS_HEALTH and CAPACITY share ONE local system-health snapshot (same
 * pattern as the public why_down composition).
 */
export function handleVpsDoctor(
  input: unknown,
  systemHealthAdapter: SystemHealthAdapter,
  applicationDeploymentAdapter: ApplicationDeploymentAdapter | null | undefined,
  dockerHealthAdapter: DockerHealthAdapter | null | undefined,
  logEvidenceAdapter: LogEvidenceAdapter | null | undefined,
): DoctorResult {
  assertStrictEmptyInput(input);

  const hostEvidence = systemHealthAdapter.collect();
  const vpsHealth = assessVpsHealth(hostEvidence);
  const capacity = assessVpsCapacity(hostEvidence);

  let applicationHealth: DoctorObservation;
  let deployment: DoctorObservation;
  if (applicationDeploymentAdapter === null || applicationDeploymentAdapter === undefined) {
    applicationHealth = { kind: "not_configured" };
    deployment = { kind: "not_configured" };
  } else {
    const evidence = applicationDeploymentAdapter.collect();
    if (evidence === null) {
      applicationHealth = { kind: "observed", status: "UNAVAILABLE", summary: APPLICATION_UNAVAILABLE_SUMMARY };
      deployment = { kind: "observed", status: "UNAVAILABLE", summary: APPLICATION_UNAVAILABLE_SUMMARY };
    } else {
      const appResult = assessApplicationHealth(evidence);
      const deployResult = assessDeployStatus(evidence);
      applicationHealth = { kind: "observed", status: appResult.status, summary: appResult.summary };
      deployment = { kind: "observed", status: deployResult.status, summary: deployResult.summary };
    }
  }

  let docker: DoctorObservation;
  if (dockerHealthAdapter === null || dockerHealthAdapter === undefined) {
    docker = { kind: "not_configured" };
  } else {
    const evidence: DockerHealthEvidence | null = dockerHealthAdapter.collect();
    if (evidence === null) {
      docker = { kind: "observed", status: "UNAVAILABLE", summary: DOCKER_UNAVAILABLE_SUMMARY };
    } else {
      const result = assessDockerHealth(evidence);
      docker = { kind: "observed", status: result.status, summary: result.summary };
    }
  }

  let logs: DoctorObservation;
  if (logEvidenceAdapter === null || logEvidenceAdapter === undefined) {
    logs = { kind: "not_configured" };
  } else {
    const evidence: LogEvidence | null = logEvidenceAdapter.collect();
    if (evidence === null) {
      logs = { kind: "observed", status: "UNAVAILABLE", summary: LOGS_UNAVAILABLE_SUMMARY };
    } else {
      const result = assessLogsExplain(evidence);
      logs = { kind: "observed", status: result.status, summary: result.summary };
    }
  }

  return assessVpsDoctor({
    vpsHealth: { kind: "observed", status: vpsHealth.status, summary: vpsHealth.summary },
    capacity: { kind: "observed", status: capacity.status, summary: capacity.summary },
    applicationHealth,
    deployment,
    docker,
    logs,
  });
}
