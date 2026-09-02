/**
 * MemoryOS VPS Guardian Pro — PRIVATE commercial entry points.
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
