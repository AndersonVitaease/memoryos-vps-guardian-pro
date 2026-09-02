/**
 * Pro context: the single composition point for evidence adapters AND for
 * the operator-controlled change-target allowlist.
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
 *
 * The change-target allowlist (MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS) is
 * operator-configured at construction time: a JSON object mapping logical
 * target keys to { applicationId, applicationName }. Missing/empty means an
 * EMPTY allowlist (no change can ever be planned); malformed values throw
 * loudly. The agent never sees or supplies the resolved identities.
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
import { CHANGE_TARGETS_ENV_VAR, parseChangeTargets } from "./change/changeSafe";
import type { ChangeTargets } from "./change/changeSafe";

export interface ProContext {
  /** Local read-only OS evidence (always configured, reused from the public package). */
  readonly systemHealthAdapter: SystemHealthAdapter;
  readonly applicationDeploymentAdapter: ApplicationDeploymentAdapter | null;
  readonly dockerHealthAdapter: DockerHealthAdapter | null;
  readonly logEvidenceAdapter: LogEvidenceAdapter | null;
  /** Operator-configured change-target allowlist (empty = no target may ever be planned). */
  readonly changeTargets: ChangeTargets;
}

export function createProContext(
  read: (name: string) => string | undefined = (name) => process.env[name],
): ProContext {
  return {
    systemHealthAdapter: localSystemHealthAdapter,
    applicationDeploymentAdapter: createApplicationDeploymentAdapterFromEnvironment(read),
    dockerHealthAdapter: createDockerHealthAdapterFromEnvironment(read),
    logEvidenceAdapter: createLogEvidenceAdapterFromEnvironment(read),
    changeTargets: parseChangeTargets(read(CHANGE_TARGETS_ENV_VAR)),
  };
}
