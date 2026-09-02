/**
 * Composition point of the private coordinator Supertool onto the public
 * McpServer (mirrors registerDoctor.ts / registerChangeSafe.ts /
 * registerReconcile.ts / registerRecover.ts).
 *
 * engineering.vps.guardian: coordinator/classifier. The Guardian receives the
 * SAME ProContext instances (doctor adapters, operator allowlist) and the SAME
 * catalog snapshot wiring as reconcile/recover — no second evidence path and
 * no mutation backend of its own:
 * - runDoctor     -> the real Pro doctor (handleVpsDoctor) + the operator-
 *                    allowlist identity attachment (certified deterministic
 *                    single-application rule).
 * - runReconcile  -> the real Pro reconcile with the live Pro catalog
 *                    (createProCatalogSnapshot over catalogToolNames).
 * - runRecover    -> the real Pro recover with the same catalog injection and
 *                    ONLY the host/operator-injected runner channel (absent by
 *                    default -> execution fails closed with zero mutation).
 *                    Recover keeps its own gates; Guardian never bypasses them.
 * - runChangeSafe -> the real Pro change.safe: the certified guardian intent
 *                    { action, target: { applicationId }, execute: true,
 *                    approval: { approved: true } } is adapted WITHOUT
 *                    weakening any gate — the logical key is resolved against
 *                    the CURRENT operator allowlist by the Doctor-evidence
 *                    applicationId (unresolved -> BLOCKED, zero mutation),
 *                    PLAN produces the proposalFingerprint and EXECUTE is
 *                    bound to it, so change.safe still re-runs every precheck
 *                    and the TOCTOU comparison itself. The Guardian never
 *                    touches the SafeChangeAdapter and never bypasses
 *                    approval or TOCTOU.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleVpsDoctor } from "../doctor/vpsDoctor";
import type { ProContext } from "../proContext";
import { runVpsReconcile, createProCatalogSnapshot, PRO_CATALOG_VERSION } from "../reconcile/vpsReconcile";
import { runVpsRecover } from "../recover/vpsRecover";
import type { VpsRecoverDeps } from "../recover/vpsRecover";
import { runVpsChangeSafe, CHANGE_SAFE_ACTION } from "../change/changeSafe";
import { guardianInputSchema, runVpsGuardian } from "./vpsGuardian";

type SupervisorResult = Record<string, unknown>;

/**
 * Pro identity adaptation: the certified ENG-MCP doctor resolves the single
 * diagnosed application's identity from real application records and exposes
 * it under `application` ({ id, name }). The Pro doctor observes application
 * evidence but exposes no identity; the operator-configured allowlist is the
 * Pro identity authority. The certified deterministic single-application rule
 * is preserved exactly: the identity is attached ONLY when the doctor actually
 * observed application evidence AND the allowlist resolves EXACTLY ONE target
 * (zero or multiple targets are never guessed -> application stays null and
 * the Guardian then blocks any CHANGE_SAFE execution).
 */
function resolveDoctorApplication(
  doctor: ReturnType<typeof handleVpsDoctor>,
  changeTargets: ProContext["changeTargets"],
): { id: string; name: string } | null {
  const appArea = doctor.areas.find((area) => area.area === "APPLICATION_HEALTH");
  if (appArea === undefined || appArea.coverage !== "OBSERVED") return null;
  const keys = Object.keys(changeTargets);
  if (keys.length !== 1) return null;
  const resolved = changeTargets[keys[0]];
  return { id: resolved.applicationId, name: resolved.applicationName };
}

/**
 * BLOCKED-style change.safe result for a delegation that can never reach the
 * mutation boundary (missing Doctor-evidence applicationId or an applicationId
 * that is not in the operator allowlist). Zero mutation, by construction.
 */
function blockedChangeSafeResult(reason: string): SupervisorResult {
  return {
    status: "BLOCKED",
    action: CHANGE_SAFE_ACTION,
    executed: false,
    reason,
    mutation: { attempted: false, occurred: false, accepted: false, ref: null, correlationKey: null },
    postValidation: null,
    rollback: { available: false, performed: false },
    proposalFingerprint: null,
    prechecks: [],
    limitations: [],
  };
}

/**
 * Pro delegation protocol for the CHANGE_SAFE execution (see module header):
 * certified guardian intent in, governed Pro change.safe PLAN->EXECUTE out.
 */
async function delegateChangeSafe(input: unknown, ctx: ProContext): Promise<SupervisorResult> {
  const intent = (input ?? {}) as { action?: unknown; target?: unknown };
  const target = intent.target !== null && typeof intent.target === "object" ? (intent.target as { applicationId?: unknown }).applicationId : undefined;
  const applicationId = typeof target === "string" && target.length > 0 ? target : null;
  if (applicationId === null) {
    return blockedChangeSafeResult("guardian intent sem applicationId da evidência do doctor; nenhuma mutação foi executada");
  }
  const entry = Object.entries(ctx.changeTargets).find(([, resolved]) => resolved.applicationId === applicationId);
  if (entry === undefined) {
    return blockedChangeSafeResult("applicationId não está configurado na allowlist do operador; nenhuma mudança pode ser planejada para ele; nenhuma mutação foi executada");
  }
  const targetKey = entry[0];
  // PLAN first: the proposalFingerprint is the TOCTOU anchor change.safe will
  // re-verify against FRESH evidence during execution.
  const plan = await runVpsChangeSafe({ action: CHANGE_SAFE_ACTION, target: targetKey }, ctx);
  if (plan.status !== "PLAN_READY" || plan.proposalFingerprint === null) {
    // BLOCKED/UNKNOWN plan: no fingerprint exists, execution is impossible.
    return plan as unknown as SupervisorResult;
  }
  return runVpsChangeSafe(
    { action: CHANGE_SAFE_ACTION, target: targetKey, execute: true, approval: { approved: true, proposalFingerprint: plan.proposalFingerprint } },
    ctx,
  ) as unknown as SupervisorResult;
}

export function registerGuardian(
  server: McpServer,
  ctx: ProContext,
  catalogToolNames: readonly string[],
  deps: Pick<VpsRecoverDeps, "runRunner"> = {},
): void {
  server.registerTool(
    "engineering.vps.guardian",
    {
      title: "VPS guardian (coordinator/classifier)",
      description:
        "Coordinator/classifier supertool with CONTROLLED write mode (v2): default {} stays fully read-only — deterministically composes engineering.vps.doctor (always) and engineering.vps.reconcile (always), plus engineering.vps.recover STRICTLY in PLAN mode (input exactly {}, only when reconcile=DRIFTED) into one conservative answer: status HEALTHY|DEGRADED|CRITICAL|DRIFTED|UNKNOWN (precedence UNKNOWN > CRITICAL > DRIFTED > DEGRADED > HEALTHY) with recommendedAction NONE|INVESTIGATE|RECOVER|CHANGE_SAFE|BLOCKED. Mutation ONLY with execute=true AND approval.approved=true, and ONLY the recommended action: RECOVER via engineering.vps.recover (official rollback, Recover keeps its own gates) or CHANGE_SAFE via engineering.vps.change.safe (action hardcoded application.redeploy; applicationId resolved ONLY from Doctor's own evidence mapped against the operator allowlist, never caller-supplied — unresolved applicationId blocks; approval is bound to a fresh plan fingerprint so the TOCTOU gate is preserved, never bypassed). NONE/INVESTIGATE/BLOCKED/UNKNOWN never mutate. Post-validation re-runs doctor + reconcile after any mutation attempt; accepted/pending is never counted as final success. No LLM, no memory, no scheduler, no watch loop, no new framework; the Guardian owns no mutation backend and coordinates only the existing Supertools.",
      inputSchema: guardianInputSchema,
    },
    async (args: unknown) => {
      try {
        const result = await runVpsGuardian(args, {
          runDoctor: async () => {
            const doctor = handleVpsDoctor(
              {},
              ctx.systemHealthAdapter,
              ctx.applicationDeploymentAdapter,
              ctx.dockerHealthAdapter,
              ctx.logEvidenceAdapter,
            );
            return { ...doctor, application: resolveDoctorApplication(doctor, ctx.changeTargets) };
          },
          runReconcile: async () =>
            runVpsReconcile({ readCatalog: async () => createProCatalogSnapshot(catalogToolNames, PRO_CATALOG_VERSION) }),
          runRecover: async (recoverInput: unknown): Promise<SupervisorResult> =>
            runVpsRecover(recoverInput, {
              ...deps,
              readCatalog: async () => createProCatalogSnapshot(catalogToolNames, PRO_CATALOG_VERSION),
            }).then((result) => ({ ...result })),
          runChangeSafe: async (changeInput: unknown) => delegateChangeSafe(changeInput, ctx),
        });
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );
}
