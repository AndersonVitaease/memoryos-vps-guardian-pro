/**
 * MemoryOS VPS Guardian Pro - PRIVATE commercial entry points.
 * Re-exports the minimal public surface of this private package.
 */
export { createProContext } from "./proContext";
export type { ProContext } from "./proContext";
export { buildProServer } from "./proServer";
export { registerDoctor } from "./doctor/registerDoctor";
export {
  assessVpsDoctor,
  handleVpsDoctor,
  DOCTOR_AREA_ORDER,
  DOCTOR_LIMITATIONS,
  vpsDoctorOutputSchema,
} from "./doctor/vpsDoctor";
export type {
  DoctorStatus,
  DoctorArea,
  DoctorCoverage,
  DoctorAreaReport,
  DoctorResult,
  DoctorObservation,
  DoctorObservations,
} from "./doctor/vpsDoctor";
export { registerChangeSafe } from "./change/registerChangeSafe";
export {
  runVpsChangeSafe,
  planVpsChangeSafe,
  CHANGE_SAFE_ACTION,
  CHANGE_SAFE_CHECKS,
  CHANGE_SAFE_REQUIRED_CHECKS,
  CHANGE_SAFE_LIMITATIONS,
  CHANGE_SAFE_POST_VALIDATION_STATUSES,
  CHANGE_TARGETS_ENV_VAR,
  parseChangeTargets,
  vpsChangeSafeInputSchema,
  vpsChangeSafeApprovalSchema,
  vpsChangeSafeOutputSchema,
} from "./change/changeSafe";
export type {
  ResolvedApplicationTarget,
  ChangeTargets,
  ChangeSafeCheck,
  ChangeSafeCheckStatus,
  ChangeSafePlanStatus,
  ChangeSafeCheckReport,
  ChangeSafePlan,
  ChangeSafePostValidationStatus,
  ChangeSafeExecuteStatus,
  ChangeSafeMutationRecord,
  ChangeSafePostValidation,
  ChangeSafeExecuteResult,
} from "./change/changeSafe";
export {
  CHANGE_MUTATION_TOOL,
  CHANGE_BACKEND_URL_ENV,
  CHANGE_BACKEND_CREDENTIAL_ENV,
  CHANGE_BACKEND_SERVER_ID_ENV,
  CHANGE_BACKEND_SERVER_ID_DEFAULT,
  createMcpBridgeSafeChangeAdapter,
  createMcpBridgeCallTransport,
} from "./change/safeChangeAdapter";
export type {
  SafeChangeAdapter,
  SafeChangeOutcome,
  SafeChangeTransport,
  SafeChangeTransportCall,
  SafeChangeTransportResponse,
  McpBridgeTransportOptions,
  McpBridgeSafeChangeAdapterOptions,
} from "./change/safeChangeAdapter";
export { registerReconcile } from "./reconcile/registerReconcile";
export { registerRecover } from "./recover/registerRecover";
export {
  runVpsRecover,
  defaultRecoverReadReleaseState,
  VPS_RECOVER_STATUSES,
  vpsRecoverInputSchema,
} from "./recover/vpsRecover";
export type {
  VpsRecoverStatus,
  VpsRecoverRunnerOperation,
  VpsRecoverRunnerResponse,
  VpsRecoverCatalog,
  VpsRecoverDeps,
  VpsRecoverFinding,
  VpsRecoverPrecheck,
  VpsRecoverResult,
} from "./recover/vpsRecover";export { PRO_CATALOG_TOOL_NAMES } from "./proServer";
export {
  runVpsReconcile,
  defaultReadReleaseState,
  createProCatalogSnapshot,
  RECONCILE_RELEASE_STATE_FILE_ENV,
  PRO_CATALOG_VERSION,
  vpsReconcileInputSchema,
  vpsReconcileOutputSchema,
} from "./reconcile/vpsReconcile";
export type {
  ReconcileStatus,
  ReconcileSeverity,
  ReconcileFinding,
  ExpectedStateSnapshot,
  ActualContainerSnapshot,
  ActualCatalogSnapshot,
  ActualStateSnapshot,
  VpsReconcileDeps,
} from "./reconcile/vpsReconcile";
