/**
 * Pro context: the single composition point for evidence adapters.
 *
 * Builds (or receives) the operator-controlled evidence adapters EXACTLY ONCE
 * and hands the SAME instances to the public buildServer() composition and to
 * the private Supertools. No second wiring path exists: whatever runs in this
 * process observes the same evidence through the same objects.
 *
 * The local system-health evidence REUSES the existing public adapter
 * (localSystemHealthAdapter): the Pro never duplicates public evidence code.
 *
 * Optional adapters are null when the operator has not configured the
 * corresponding environment variable (same convention as the public server:
 * MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE,
 * MEMORYOS_VPS_GUARDIAN_DOCKER_HEALTH_FILE,
 * MEMORYOS_VPS_GUARDIAN_LOG_EVIDENCE_FILE).
 */
import {
  createApplicationDeploymentAdapterFromEnvironment,
  createDockerHealthAdapterFromEnvironment,
  createLogEvidenceAdapterFromEnvironment,
} from "memoryos-vps-guardian/src/server";
import { localSystemHealthAdapter } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { SystemHealthAdapter } from "memoryos-vps-guardian/src/adapters/systemHealth";
import type { ApplicationDeploymentAdapter } from "memoryos-vps-guardian/src/adapters/applicationDeployment";
import type { DockerHealthAdapter } from "memoryos-vps-guardian/src/adapters/dockerHealth";
import type { LogEvidenceAdapter } from "memoryos-vps-guardian/src/adapters/logEvidence";

export interface ProContext {
  /** Local read-only OS evidence (always configured, reused from the public package). */
  readonly systemHealthAdapter: SystemHealthAdapter;
  readonly applicationDeploymentAdapter: ApplicationDeploymentAdapter | null;
  readonly dockerHealthAdapter: DockerHealthAdapter | null;
  readonly logEvidenceAdapter: LogEvidenceAdapter | null;
}

export function createProContext(
  read: (name: string) => string | undefined = (name) => process.env[name],
): ProContext {
  return {
    systemHealthAdapter: localSystemHealthAdapter,
    applicationDeploymentAdapter: createApplicationDeploymentAdapterFromEnvironment(read),
    dockerHealthAdapter: createDockerHealthAdapterFromEnvironment(read),
    logEvidenceAdapter: createLogEvidenceAdapterFromEnvironment(read),
  };
}
