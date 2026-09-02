import { describe, expect, it } from "vitest";
import { guardianInputSchema, runVpsGuardian, type VpsGuardianDeps } from "../src/index";

// Fakes only: zero network, zero release runner, zero Dokploy transport, zero
// change backend. Shapes mirror the real Pro contracts (DoctorResult /
// runVpsReconcile / runVpsRecover / ChangeSafeExecuteResult).

type AreaCoverage = "OBSERVED" | "NOT_CONFIGURED";

const area = (name: string, coverage: AreaCoverage, status: string | null = null) => ({
  area: name,
  coverage,
  status,
  summary: status === null ? null : `${name} reports ${status}`,
  attention: false,
});

const OK_AREAS = () => [
  area("VPS_HEALTH", "OBSERVED", "OK"),
  area("CAPACITY", "OBSERVED", "OK"),
  area("APPLICATION_HEALTH", "OBSERVED", "OK"),
  area("DEPLOYMENT", "OBSERVED", "OK"),
  area("DOCKER", "OBSERVED", "OK"),
  area("LOGS", "OBSERVED", "OK"),
];

const doctorResult = (over: Record<string, unknown> = {}) => ({
  status: "STABLE",
  summary: "STABLE: all 6 observed area(s) currently report no condition that needs attention.",
  areas: OK_AREAS(),
  attentionAreas: [] as string[],
  limitations: ["fixed limitations"],
  application: null,
  ...over,
});

/** DEGRADED with the app/deployment attention (the CHANGE_SAFE evidence). */
const degradedAppDoctor = (over: Record<string, unknown> = {}) =>
  doctorResult({
    status: "ATTENTION",
    summary: "ATTENTION: 1 area(s) currently report conditions that need operator attention (DEPLOYMENT).",
    areas: [
      area("VPS_HEALTH", "OBSERVED", "OK"),
      area("CAPACITY", "OBSERVED", "OK"),
      area("APPLICATION_HEALTH", "OBSERVED", "OK"),
      area("DEPLOYMENT", "OBSERVED", "FAILED"),
      area("DOCKER", "OBSERVED", "OK"),
      area("LOGS", "OBSERVED", "OK"),
    ],
    attentionAreas: ["DEPLOYMENT"],
    ...over,
  });

/** DEGRADED with a NON-app attention area (must stay INVESTIGATE). */
const degradedHostDoctor = () =>
  doctorResult({
    status: "ATTENTION",
    summary: "ATTENTION: 1 area(s) currently report conditions that need operator attention (VPS_HEALTH).",
    areas: [
      area("VPS_HEALTH", "OBSERVED", "DEGRADED"),
      area("CAPACITY", "OBSERVED", "OK"),
      area("APPLICATION_HEALTH", "OBSERVED", "OK"),
      area("DEPLOYMENT", "OBSERVED", "OK"),
      area("DOCKER", "OBSERVED", "OK"),
      area("LOGS", "OBSERVED", "OK"),
    ],
    attentionAreas: ["VPS_HEALTH"],
  });

const reconcileResult = (over: Record<string, unknown> = {}) => ({
  status: "IN_SYNC",
  expected: { toolCount: 15, catalogVersion: "pro-tools-v0.1.0" },
  actual: { container: null, catalog: { catalogHash: "h15", catalogVersion: "pro-tools-v0.1.0", toolCount: 15 } },
  findings: [] as unknown[],
  mutationPerformed: false,
  ...over,
});

const recoverPlanResult = (over: Record<string, unknown> = {}) => ({
  status: "PLAN",
  mutationPerformed: false,
  precheck: { reconcile: { status: "DRIFTED", findings: [] }, lkgPresent: true, jobInProgress: false, blockers: [] },
  plan: { action: "rollback", possible: true, requires: ["execute=true", "approval.approved=true"] },
  findings: [] as unknown[],
  ...over,
});

const recoverBlockedResult = (blockers: string[] = ["LKG_MISSING"]) => ({
  status: "BLOCKED",
  mutationPerformed: false,
  precheck: { reconcile: { status: "DRIFTED", findings: [] }, lkgPresent: false, jobInProgress: false, blockers },
  plan: { action: "rollback", possible: false, requires: ["execute=true", "approval.approved=true"] },
  findings: [] as unknown[],
});

const run = (over: VpsGuardianDeps = {}) => runVpsGuardian({}, over);
const runWith = (input: unknown, over: VpsGuardianDeps = {}) => runVpsGuardian(input, over);

// Stateful fake helper: doctor/reconcile fakes that switch results between the
// live pass and the post-validation pass.
const sequential = <T,>(results: T[]) => {
  let index = 0;
  return async (): Promise<T> => results[Math.min(index++, results.length - 1)];
};

// Execution-time result fakes (shape mirrors runVpsRecover / runVpsChangeSafe).
const recoverExecutedResult = (over: Record<string, unknown> = {}) => ({
  status: "RECOVERED",
  mutationPerformed: true,
  precheck: { reconcile: { status: "DRIFTED", findings: [] }, lkgPresent: true, jobInProgress: false, blockers: [] },
  plan: { action: "rollback", possible: true, requires: [] },
  execution: { accepted: true, jobId: "job-recovered", status: "success" },
  jobId: "job-recovered",
  validation: { smoke: "PASS", reconcile: "IN_SYNC", catalog: { catalogHash: "h16", catalogVersion: "pro-tools-v0.1.0", toolCount: 16 } },
  findings: [] as unknown[],
  ...over,
});

const recoverPendingResult = (over: Record<string, unknown> = {}) => ({
  status: "UNKNOWN",
  mutationPerformed: true,
  precheck: { reconcile: { status: "DRIFTED", findings: [] }, lkgPresent: true, jobInProgress: false, blockers: [] },
  plan: { action: "rollback", possible: true, requires: [] },
  execution: { accepted: true, jobId: "job-pending", status: "queued" },
  pending: true,
  jobId: "job-pending",
  nextAction: "Official rollback job job-pending is pending in the durable runner.",
  findings: [{ code: "JOB_STATUS_UNAVAILABLE", severity: "warning" }] as unknown[],
  ...over,
});

const recoverFailedResult = (over: Record<string, unknown> = {}) => ({
  status: "NOT_RECOVERED",
  mutationPerformed: true,
  precheck: { reconcile: { status: "DRIFTED", findings: [] }, lkgPresent: true, jobInProgress: false, blockers: [] },
  plan: { action: "rollback", possible: true, requires: [] },
  execution: { accepted: true, jobId: "job-failed", status: "failed" },
  jobId: "job-failed",
  validation: { smoke: "FAIL", reconcile: "DRIFTED", catalog: null },
  findings: [{ code: "VALIDATION_FAILED", severity: "critical" }] as unknown[],
  ...over,
});

const FINGERPRINT = "a".repeat(64);

const changeSafeExecutedResult = (over: Record<string, unknown> = {}) => ({
  status: "VERIFIED",
  action: "application.redeploy",
  target: { key: "gateway", applicationName: "Gateway" },
  executed: true,
  reason: "fresh evidence shows a new deployment completed successfully",
  risk: "REQUIRES_APPROVAL",
  mutation: { attempted: true, occurred: true, accepted: true, ref: null, correlationKey: FINGERPRINT },
  postValidation: {
    status: "VERIFIED",
    deploymentStatus: "SUCCEEDED",
    observedAt: "2026-09-02T13:00:00Z",
    applicationHealthy: true,
    currentReleaseId: "r-3",
    reason: "fresh evidence shows a new deployment completed successfully",
  },
  rollback: { available: false, performed: false },
  proposalFingerprint: FINGERPRINT,
  prechecks: [],
  limitations: [],
  ...over,
});

const appDoctor = (over: Record<string, unknown> = {}) =>
  degradedAppDoctor({ application: { id: "app-123", name: "api" }, ...over });

describe("engineering.vps.guardian (certified port, read-only composition)", () => {
  it("01 - HEALTHY + IN_SYNC -> HEALTHY / NONE", async () => {
    const result = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult(),
      runRecover: async () => {
        throw new Error("recover must not be called");
      },
    });
    expect(result.status).toBe("HEALTHY");
    expect(result.recommendedAction).toBe("NONE");
    expect(result.health).toBe("HEALTHY");
    expect(result.drift).toBe("IN_SYNC");
  });

  it("02 - DEGRADED + DEPLOYMENT FAILED + IN_SYNC -> CHANGE_SAFE (recomendação, nunca executa change.safe)", async () => {
    const result = await run({
      runDoctor: async () => degradedAppDoctor(),
      runReconcile: async () => reconcileResult(),
      runRecover: async () => {
        throw new Error("recover must not be called");
      },
      runChangeSafe: async () => {
        throw new Error("change.safe must not be called in read-only mode");
      },
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.recommendedAction).toBe("CHANGE_SAFE");
    expect(String(result.recommendedNextAction)).toMatch(/engineering\.vps\.change\.safe/);
    expect(String(result.recommendedNextAction)).toMatch(/applicationId/);
    expect(result.mode).toBe("read-only");
    expect(result.mutationPerformed).toBe(false);
  });

  it("03 - DEGRADED + attention não-app (VPS_HEALTH) -> INVESTIGATE", async () => {
    const result = await run({
      runDoctor: async () => degradedHostDoctor(),
      runReconcile: async () => reconcileResult(),
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.recommendedAction).toBe("INVESTIGATE");
  });

  it("04 - doctor status fora do vocabulário Pro -> UNKNOWN/BLOCKED e recover NÃO chamado", async () => {
    let recoverCalls = 0;
    const result = await run({
      runDoctor: async () => doctorResult({ status: "WEIRD" }),
      runReconcile: async () => reconcileResult(),
      runRecover: async () => {
        recoverCalls += 1;
        return recoverPlanResult();
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(recoverCalls).toBe(0);
    expect("recover" in (result.evidence as object)).toBe(false);
  });

  it("05 - DRIFTED + recover PLAN possible=true -> RECOVER (ponteiro para engineering.vps.recover)", async () => {
    let recoverInput: unknown = "not-called";
    const result = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInput = input;
        return recoverPlanResult();
      },
    });
    expect(result.status).toBe("DRIFTED");
    expect(result.recommendedAction).toBe("RECOVER");
    expect(String(result.recommendedNextAction)).toMatch(/engineering\.vps\.recover/);
    expect(recoverInput).toEqual({});
  });

  it("06 - DRIFTED + recover BLOCKED LKG_MISSING -> BLOCKED com blocker exposto", async () => {
    const result = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async () => recoverBlockedResult(["LKG_MISSING"]),
    });
    expect(result.status).toBe("DRIFTED");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(String(result.reason)).toMatch(/LKG_MISSING/);
  });

  it("07 - reconcile UNKNOWN -> UNKNOWN/BLOCKED e recover NÃO chamado", async () => {
    let recoverCalls = 0;
    const result = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "UNKNOWN", actual: { container: null, catalog: null } }),
      runRecover: async () => {
        recoverCalls += 1;
        return recoverPlanResult();
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(recoverCalls).toBe(0);
  });

  it("08 - doctor UNKNOWN -> UNKNOWN/BLOCKED mas reconcile AINDA executa", async () => {
    let reconcileCalls = 0;
    const result = await run({
      runDoctor: async () => doctorResult({ status: "UNKNOWN", summary: "UNKNOWN: evidence is incomplete" }),
      runReconcile: async () => {
        reconcileCalls += 1;
        return reconcileResult();
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(reconcileCalls).toBe(1);
    expect((result.evidence as Record<string, unknown>).reconcile !== undefined).toBe(true);
  });

  it("09 - doctor UNKNOWN (fonte sem evidência) -> UNKNOWN/BLOCKED", async () => {
    const result = await run({
      runDoctor: async () =>
        doctorResult({
          status: "UNKNOWN",
          summary: "UNKNOWN: evidence is incomplete or unavailable for 1 observed area(s) (LOGS).",
          areas: [area("LOGS", "OBSERVED", "UNAVAILABLE")],
          attentionAreas: [],
        }),
      runReconcile: async () => reconcileResult(),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
  });

  it("10 - INVARIANTE: recover recebe EXATAMENTE {} (nunca execute/approval) e só em DRIFTED", async () => {
    const inputs: unknown[] = [];
    const drifted = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        inputs.push(input);
        return recoverPlanResult();
      },
    });
    expect(drifted.recommendedAction).toBe("RECOVER");
    const healthy = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult(),
      runRecover: async (input) => {
        inputs.push(input);
        return recoverPlanResult();
      },
    });
    expect(healthy.recommendedAction).toBe("NONE");
    expect(inputs.length).toBe(1);
    expect(inputs[0]).toEqual({});
    expect(Object.keys(inputs[0] as object).length).toBe(0);
  });

  it("11 - input público estrito: {}, execute e approval ok; alvo/operação/chave arbitrária rejeitados", () => {
    expect(guardianInputSchema.parse({})).toEqual({});
    expect(guardianInputSchema.parse({ execute: true })).toEqual({ execute: true });
    expect(guardianInputSchema.parse({ approval: { approved: true } })).toEqual({ approval: { approved: true } });
    expect(guardianInputSchema.parse({ execute: false, approval: { approved: false } })).toEqual({ execute: false, approval: { approved: false } });
    expect(() => guardianInputSchema.parse({ target: "x" })).toThrow();
    expect(() => guardianInputSchema.parse({ applicationId: "x" })).toThrow();
    expect(() => guardianInputSchema.parse({ operation: "rollback" })).toThrow();
    expect(() => guardianInputSchema.parse({ action: "application.redeploy" })).toThrow();
    expect(() => guardianInputSchema.parse({ approval: { approved: "yes" } })).toThrow();
    expect(() => guardianInputSchema.parse({ execute: "true" })).toThrow();
    expect(() => guardianInputSchema.parse({ arbitrary: 1 })).toThrow();
  });

  it("12 - mutationPerformed=false em TODOS os caminhos read-only", async () => {
    const paths = await Promise.all([
      run({ runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult() }),
      run({ runDoctor: async () => degradedAppDoctor(), runReconcile: async () => reconcileResult() }),
      run({ runDoctor: async () => degradedHostDoctor(), runReconcile: async () => reconcileResult() }),
      run({ runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult({ status: "DRIFTED" }), runRecover: async () => recoverPlanResult() }),
      run({ runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult({ status: "DRIFTED" }), runRecover: async () => recoverBlockedResult() }),
      run({ runDoctor: async () => doctorResult({ status: "UNKNOWN" }), runReconcile: async () => reconcileResult({ status: "UNKNOWN" }) }),
    ]);
    for (const result of paths) expect(result.mutationPerformed).toBe(false);
    expect((paths[3] as Record<string, unknown>).mode).toBe("read-only");
  });

  it("13 - guarda: DEGRADED + área DEPLOYMENT FAILED mas application não OBSERVED -> INVESTIGATE", async () => {
    const result = await run({
      runDoctor: async () =>
        doctorResult({
          status: "ATTENTION",
          areas: [
            area("VPS_HEALTH", "OBSERVED", "OK"),
            area("CAPACITY", "OBSERVED", "OK"),
            area("APPLICATION_HEALTH", "NOT_CONFIGURED"),
            area("DEPLOYMENT", "NOT_CONFIGURED"),
            area("DOCKER", "OBSERVED", "DEGRADED"),
            area("LOGS", "OBSERVED", "OK"),
          ],
          attentionAreas: ["DOCKER"],
        }),
      runReconcile: async () => reconcileResult(),
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.recommendedAction).toBe("INVESTIGATE");
  });

  it("14 - default {} continua read-only: NONE, sem execution/validation, mutationPerformed=false", async () => {
    const result = await run({
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult(),
      runRecover: async () => {
        throw new Error("recover must not be called");
      },
      runChangeSafe: async () => {
        throw new Error("change.safe must not be called");
      },
    });
    expect(result.status).toBe("HEALTHY");
    expect(result.recommendedAction).toBe("NONE");
    expect(result.mode).toBe("read-only");
    expect(result.mutationPerformed).toBe(false);
    expect("execution" in (result as object)).toBe(false);
    expect("validation" in (result as object)).toBe(false);
  });

  it("15 - execute=false nunca muta (mesmo DRIFTED): recover só plan-mode {}", async () => {
    const recoverInputs: unknown[] = [];
    const result = await runWith({ execute: false }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInputs.push(input);
        return recoverPlanResult();
      },
    });
    expect(result.recommendedAction).toBe("RECOVER");
    expect(result.mode).toBe("read-only");
    expect(result.mutationPerformed).toBe(false);
    expect(recoverInputs).toEqual([{}]);
  });

  it("16 - approval=true sem execute não muta (default read-only)", async () => {
    const recoverInputs: unknown[] = [];
    const result = await runWith({ approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInputs.push(input);
        return recoverPlanResult();
      },
    });
    expect(result.mode).toBe("read-only");
    expect(result.mutationPerformed).toBe(false);
    expect(recoverInputs).toEqual([{}]);
  });

  it("17 - execute=true sem approval -> BLOCKED, nenhuma mutação", async () => {
    const recoverInputs: unknown[] = [];
    const result = await runWith({ execute: true }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInputs.push(input);
        return recoverPlanResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("BLOCKED");
    expect(execution.authorized).toBe(false);
    expect(result.mutationPerformed).toBe(false);
    expect(recoverInputs).toEqual([{}]); // apenas o plan-mode da classificação
    expect("validation" in (result as object)).toBe(false);
  });

  it("18 - execute+approval + RECOVER -> executa Recover exatamente uma vez", async () => {
    const recoverInputs: unknown[] = [];
    let changeSafeCalls = 0;
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInputs.push(input);
        return recoverInputs.length === 1 ? recoverPlanResult() : recoverExecutedResult();
      },
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(recoverInputs.length).toBe(2); // plan-mode {} + execução única
    expect(execution.status).toBe("PERFORMED");
    expect(execution.performed).toBe(true);
    expect(result.mutationPerformed).toBe(true);
    expect(changeSafeCalls).toBe(0);
  });

  it("19 - Recover de execução recebe EXATAMENTE {execute:true, approval:{approved:true}}", async () => {
    const recoverInputs: unknown[] = [];
    await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        recoverInputs.push(input);
        return recoverInputs.length === 1 ? recoverPlanResult() : recoverExecutedResult();
      },
    });
    expect(recoverInputs.length).toBe(2);
    expect(recoverInputs[1]).toEqual({ execute: true, approval: { approved: true } });
    const keys = Object.keys(recoverInputs[1] as object).sort();
    expect(keys).toEqual(["approval", "execute"]);
  });

  it("20 - RECOVER pending (202/queued) NÃO vira sucesso final", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: sequential([reconcileResult({ status: "DRIFTED" }), reconcileResult({ status: "DRIFTED" })]),
      runRecover: async (input) => (input && typeof input === "object" && "execute" in (input as object) ? recoverPendingResult() : recoverPlanResult()),
    });
    expect(result.status).toBe("DRIFTED"); // classificação preservada
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("PENDING");
    expect(execution.success).toBe(false);
    const validation = (result as Record<string, unknown>).validation as Record<string, unknown>;
    expect(validation.converged).toBe(false);
    expect(result.mutationPerformed).toBe(true); // rollback job aceito = mutação real iniciada (espelha a Recover)
  });

  it("21 - RECOVER sucesso + pós-validação saudável -> sucesso final", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([doctorResult(), doctorResult()]),
      runReconcile: sequential([reconcileResult({ status: "DRIFTED" }), reconcileResult()]),
      runRecover: async (input) => (input && typeof input === "object" && "execute" in (input as object) ? recoverExecutedResult() : recoverPlanResult()),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("PERFORMED");
    expect(execution.success).toBe(true);
    const validation = (result as Record<string, unknown>).validation as Record<string, unknown>;
    expect(validation.converged).toBe(true);
    expect(validation.status).toBe("HEALTHY");
    expect(result.mutationPerformed).toBe(true);
  });

  it("22 - RECOVER falha (NOT_RECOVERED) -> erro exposto, converged=false", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([doctorResult(), doctorResult()]),
      runReconcile: sequential([reconcileResult({ status: "DRIFTED" }), reconcileResult({ status: "DRIFTED" })]),
      runRecover: async (input) => (input && typeof input === "object" && "execute" in (input as object) ? recoverFailedResult() : recoverPlanResult()),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("FAILED");
    const recoverResult = execution.result as Record<string, unknown>;
    expect(Array.isArray(recoverResult.findings) && recoverResult.findings.length > 0).toBe(true); // erro não escondido
    const validation = (result as Record<string, unknown>).validation as Record<string, unknown>;
    expect(validation.converged).toBe(false);
    expect(result.mutationPerformed).toBe(true); // espelha a Recover (job aceito)
  });

  it("23 - CHANGE_SAFE recomendada mas sem applicationId confiável -> BLOCKED", async () => {
    let changeSafeCalls = 0;
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => degradedAppDoctor(), // application: null
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.recommendedAction).toBe("CHANGE_SAFE");
    expect(execution.status).toBe("BLOCKED");
    expect(String(execution.reason)).toMatch(/applicationId/);
    expect(changeSafeCalls).toBe(0);
    expect(result.mutationPerformed).toBe(false);
    expect("validation" in (result as object)).toBe(false);
  });

  it("24 - CHANGE_SAFE com applicationId do doctor -> chama change.safe exatamente uma vez", async () => {
    let changeSafeCalls = 0;
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([appDoctor(), appDoctor()]),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(changeSafeCalls).toBe(1);
    expect(execution.status).toBe("PERFORMED");
    expect(execution.performed).toBe(true);
    expect(execution.success).toBe(true);
    expect(result.mutationPerformed).toBe(true);
  });

  it("25 - change.safe recebe action hardcoded 'application.redeploy' + target só com o applicationId do doctor", async () => {
    const changeSafeInputs: unknown[] = [];
    await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => appDoctor(),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async (input) => {
        changeSafeInputs.push(input);
        return changeSafeExecutedResult();
      },
    });
    expect(changeSafeInputs.length).toBe(1);
    expect(changeSafeInputs[0]).toEqual({ action: "application.redeploy", target: { applicationId: "app-123" }, execute: true, approval: { approved: true } });
  });

  it("26 - NONE + execute=true + approval -> nenhuma mutação", async () => {
    let recoverCalls = 0;
    let changeSafeCalls = 0;
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult(),
      runRecover: async () => {
        recoverCalls += 1;
        return recoverPlanResult();
      },
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.recommendedAction).toBe("NONE");
    expect(execution.status).toBe("BLOCKED");
    expect(recoverCalls).toBe(0);
    expect(changeSafeCalls).toBe(0);
    expect(result.mutationPerformed).toBe(false);
  });

  it("27 - INVESTIGATE (DEGRADED não-app) + execute=true -> nenhuma mutação", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => degradedHostDoctor(),
      runReconcile: async () => reconcileResult(),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.recommendedAction).toBe("INVESTIGATE");
    expect(execution.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
  });

  it("28 - UNKNOWN/BLOCKED + execute=true -> nenhuma mutação", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult({ status: "UNKNOWN" }),
      runReconcile: async () => reconcileResult({ status: "UNKNOWN", actual: { container: null, catalog: null } }),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(execution.status).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
  });

  it("29 - input arbitrário rejeitado em runtime", async () => {
    await expect(runWith({ arbitrary: 1 }, {})).rejects.toThrow();
    await expect(runWith({ target: "x" }, {})).rejects.toThrow();
    await expect(runWith({ applicationId: "x" }, {})).rejects.toThrow();
  });

  it("30 - mutationPerformed exato em todos os caminhos", async () => {
    const defaultHealthy = await run({ runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult() });
    const driftedPlan = await run({ runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult({ status: "DRIFTED" }), runRecover: async () => recoverPlanResult() });
    const withoutApproval = await runWith({ execute: true }, { runDoctor: async () => doctorResult(), runReconcile: async () => reconcileResult({ status: "DRIFTED" }), runRecover: async () => recoverPlanResult() });
    const recoverExecuted = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([doctorResult(), doctorResult()]),
      runReconcile: sequential([reconcileResult({ status: "DRIFTED" }), reconcileResult()]),
      runRecover: async (input) => (input && typeof input === "object" && "execute" in (input as object) ? recoverExecutedResult() : recoverPlanResult()),
    });
    const changeSafeExecuted = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([appDoctor(), appDoctor()]),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => changeSafeExecutedResult(),
    });
    const changeSafeBlocked = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => degradedAppDoctor(),
      runReconcile: async () => reconcileResult(),
    });
    expect(defaultHealthy.mutationPerformed).toBe(false);
    expect(driftedPlan.mutationPerformed).toBe(false);
    expect(withoutApproval.mutationPerformed).toBe(false);
    expect(recoverExecuted.mutationPerformed).toBe(true);
    expect(changeSafeExecuted.mutationPerformed).toBe(true);
    expect(changeSafeBlocked.mutationPerformed).toBe(false);
  });

  it("31 - Guardian nunca executa Recover e change.safe na mesma execução", async () => {
    let recoverExecCalls = 0;
    let changeSafeCalls = 0;
    await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => doctorResult(),
      runReconcile: async () => reconcileResult({ status: "DRIFTED" }),
      runRecover: async (input) => {
        const isExecution = input && typeof input === "object" && "execute" in (input as object);
        if (isExecution) recoverExecCalls += 1;
        return isExecution ? recoverExecutedResult() : recoverPlanResult();
      },
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    expect(recoverExecCalls).toBe(1);
    expect(changeSafeCalls).toBe(0);
    await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => appDoctor(),
      runReconcile: async () => reconcileResult(),
      runRecover: async (input) => {
        const isExecution = input && typeof input === "object" && "execute" in (input as object);
        if (isExecution) recoverExecCalls += 1;
        return isExecution ? recoverExecutedResult() : recoverPlanResult();
      },
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    expect(recoverExecCalls).toBe(1); // inalterado: recover não executado de novo
    expect(changeSafeCalls).toBe(1);
  });

  // ---- Pro change.safe contract adaptation: three-way execution mapping ----

  it("32 - change.safe gate refusal (SNAPSHOT_CHANGED) -> BLOCKED, zero mutação", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([appDoctor(), appDoctor()]),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => changeSafeExecutedResult({ status: "SNAPSHOT_CHANGED", executed: false, mutation: { attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null }, postValidation: null, proposalFingerprint: null }),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("BLOCKED");
    expect(execution.success).toBe(false);
    expect(result.mutationPerformed).toBe(false);
  });

  it("33 - change.safe tentativa não confirmada (MUTATION_UPSTREAM_ERROR) -> FAILED, sem mutação confirmada", async () => {
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: sequential([appDoctor(), appDoctor()]),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => changeSafeExecutedResult({ status: "MUTATION_UPSTREAM_ERROR", mutation: { attempted: true, occurred: false, accepted: false, ref: null, correlationKey: FINGERPRINT }, postValidation: null }),
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(execution.status).toBe("FAILED");
    expect(execution.success).toBe(false);
    expect(result.mutationPerformed).toBe(false); // espelha change.safe: occurred=false nunca conta como mutação
  });

  it("34 - falha de compose (runDoctor lança) degrada para UNKNOWN sem inventar evidência", async () => {
    const result = await run({
      runDoctor: async () => {
        throw new Error("wiring broken");
      },
      runReconcile: async () => reconcileResult(),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    const evidence = (result.evidence as Record<string, unknown>).doctor as Record<string, unknown>;
    expect(evidence.guardianError).toBe("wiring broken");
  });

  it("35 - defaults sem composição falham fechado: doctor/change.safe -> UNKNOWN, recover/reconcile reais honestos", async () => {
    const result = await runVpsGuardian({});
    expect(result.status).toBe("UNKNOWN");
    expect(result.recommendedAction).toBe("BLOCKED");
    expect(result.mutationPerformed).toBe(false);
    expect(result.mode).toBe("read-only");
  });
});

// ---- Guardian: applicationId exclusively via Doctor evidence ----

describe("engineering.vps.guardian (target resolution via Doctor evidence)", () => {
  it("guardian-target 01 CHANGE_SAFE forwards ONLY the Doctor-evidence applicationId to change.safe", async () => {
    const changeSafeInputs: unknown[] = [];
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => appDoctor(),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async (input) => {
        changeSafeInputs.push(input);
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.recommendedAction).toBe("CHANGE_SAFE");
    expect(changeSafeInputs.length).toBe(1);
    expect(changeSafeInputs[0]).toEqual({ action: "application.redeploy", target: { applicationId: "app-123" }, execute: true, approval: { approved: true } });
    expect(execution.status).toBe("PERFORMED");
    expect(result.mutationPerformed).toBe(true);
  });

  it("guardian-target 02 schema keeps rejecting caller-supplied applicationId/target/action", () => {
    expect(() => guardianInputSchema.parse({ applicationId: "app-1" })).toThrow();
    expect(() => guardianInputSchema.parse({ target: { applicationId: "app-1" } })).toThrow();
    expect(() => guardianInputSchema.parse({ action: "application.redeploy" })).toThrow();
    expect(() => guardianInputSchema.parse({ applicationId: "app-1", execute: true })).toThrow();
  });

  it("guardian-target 03 CHANGE_SAFE recommendation with execute=false -> read-only, change.safe never called", async () => {
    let changeSafeCalls = 0;
    const result = await runWith({ execute: false }, {
      runDoctor: async () => appDoctor(),
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    expect(result.recommendedAction).toBe("CHANGE_SAFE");
    expect((result as Record<string, unknown>).mode).toBe("read-only");
    expect(result.mutationPerformed).toBe(false);
    expect(changeSafeCalls).toBe(0);
    expect("execution" in (result as object)).toBe(false);
    expect("validation" in (result as object)).toBe(false);
  });

  it("guardian-target 04 recommendation CHANGE_SAFE but no reliable applicationId -> BLOCKED, zero change.safe calls", async () => {
    let changeSafeCalls = 0;
    const result = await runWith({ execute: true, approval: { approved: true } }, {
      runDoctor: async () => degradedAppDoctor(), // application: null
      runReconcile: async () => reconcileResult(),
      runChangeSafe: async () => {
        changeSafeCalls += 1;
        return changeSafeExecutedResult();
      },
    });
    const execution = (result as Record<string, unknown>).execution as Record<string, unknown>;
    expect(result.recommendedAction).toBe("CHANGE_SAFE");
    expect(execution.status).toBe("BLOCKED");
    expect(String(execution.reason)).toMatch(/applicationId/);
    expect(changeSafeCalls).toBe(0);
    expect(result.mutationPerformed).toBe(false);
    expect("validation" in (result as object)).toBe(false);
  });
});
