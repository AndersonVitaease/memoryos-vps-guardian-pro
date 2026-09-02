/**
 * Pro context: the single composition point for evidence adapters, for the
 * operator-controlled change-target allowlist AND for the operator-configured
 * change backend.
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
 *
 * The change backend for the SafeChangeAdapter is ALSO operator-configured at
 * construction time (MEMORYOS_VPS_GUARDIAN_CHANGE_BACKEND_URL +
 * MEMORYOS_VPS_GUARDIAN_CHANGE_CREDENTIAL, with optional
 * MEMORYOS_VPS_GUARDIAN_CHANGE_SERVER_ID). Both must be set together or both
 * absent; absent means NO mutation capability exists (fail-closed). The URL
 * and credential are construction-time operator values: never agent input,
 * never output, never logged.
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
import {
  CHANGE_BACKEND_CREDENTIAL_ENV,
  CHANGE_BACKEND_SERVER_ID_DEFAULT,
  CHANGE_BACKEND_SERVER_ID_ENV,
  CHANGE_BACKEND_URL_ENV,
  createMcpBridgeCallTransport,
  createMcpBridgeSafeChangeAdapter,
} from "./change/safeChangeAdapter";
import type { SafeChangeAdapter } from "./change/safeChangeAdapter";

export interface ProContext {
  /** Local read-only OS evidence (always configured, reused from the public package). */
  readonly systemHealthAdapter: SystemHealthAdapter;
  readonly applicationDeploymentAdapter: ApplicationDeploymentAdapter | null;
  readonly dockerHealthAdapter: DockerHealthAdapter | null;
  readonly logEvidenceAdapter: LogEvidenceAdapter | null;
  /** Operator-configured change-target allowlist (empty = no target may ever be planned). */
  readonly changeTargets: ChangeTargets;
  /**
   * The ONLY component with mutation/network authority (null = not configured:
 * execution then always fails closed with zero mutation).
   */
  readonly safeChangeAdapter: SafeChangeAdapter | null;
}

export function createProContext(
  read: (name: string) => string | undefined = (name) => process.env[name],
): ProContext {
  const backendUrl = read(CHANGE_BACKEND_URL_ENV) ?? "";
  const backendCredential = read(CHANGE_BACKEND_CREDENTIAL_ENV) ?? "";
  const backendServerId = read(CHANGE_BACKEND_SERVER_ID_ENV) ?? CHANGE_BACKEND_SERVER_ID_DEFAULT;
  if ((backendUrl === "") !== (backendCredential === "")) {
    throw new Error(
      `invalid change backend configuration: ${CHANGE_BACKEND_URL_ENV} and ${CHANGE_BACKEND_CREDENTIAL_ENV} must be configured together (or both absent)`,
    );
  }
  const safeChangeAdapter: SafeChangeAdapter | null =
    backendUrl === ""
      ? null
      : createMcpBridgeSafeChangeAdapter({
          transport: createMcpBridgeCallTransport({
            endpointUrl: backendUrl,
            credential: backendCredential,
            serverId: backendServerId,
          }),
        });
  return {
    systemHealthAdapter: localSystemHealthAdapter,
    applicationDeploymentAdapter: createApplicationDeploymentAdapterFromEnvironment(read),
    dockerHealthAdapter: createDockerHealthAdapterFromEnvironment(read),
    logEvidenceAdapter: createLogEvidenceAdapterFromEnvironment(read),
    changeTargets: parseChangeTargets(read(CHANGE_TARGETS_ENV_VAR)),
    safeChangeAdapter,
  };
}
