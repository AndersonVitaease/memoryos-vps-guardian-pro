/**
 * Composition point of the private recovery Supertool onto the public
 * McpServer (mirrors registerDoctor.ts / registerChangeSafe.ts /
 * registerReconcile.ts).
 *
 * engineering.vps.recover: controlled official-rollback recovery. The ONLY
 * mutable operation is the official release runner rollback, hardcoded over
 * the runner channel INJECTED BY THE HOST (runRunner) — the caller can never
 * choose operation, target, applicationId, toolName, command, shell, URL,
 * socket, headers, token, image or container. When no operator-configured
 * runner channel exists, execution fails closed with RUNNER_UNAVAILABLE and
 * zero mutation (PLAN/precheck flows stay fully available). Input is strictly
 * { execute?, approval? }.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createProCatalogSnapshot,
  PRO_CATALOG_VERSION,
} from "../reconcile/vpsReconcile";
import {
  runVpsRecover,
  vpsRecoverInputSchema,
} from "./vpsRecover";
import type { VpsRecoverDeps } from "./vpsRecover";

export function registerRecover(server: McpServer, catalogToolNames: readonly string[], deps: Pick<VpsRecoverDeps, "runRunner"> = {}): void {
  server.registerTool(
    "engineering.vps.recover",
    {
      title: "VPS recover (controlled official rollback)",
      description:
        "Controlled official-rollback recovery Supertool: PLAN mode (execute defaults to false) is read-only and deterministically reuses engineering.vps.reconcile plus the release-state last-known-good evidence; the only mutable operation is the official release runner rollback, hardcoded over the operator-injected runner channel (the caller can never choose operation, target, applicationId, toolName, command, shell, URL, socket, headers, token, image or container). Mutation requires execute=true AND approval.approved=true, reconcile=DRIFTED, last-known-good present and no incompatible job in progress. 202/queued is NEVER RECOVERED: bounded official job status polling returns UNKNOWN/pending with the durable jobId. Post-validation runs the official smoke (which re-syncs the release-state production fields left stale by rollbackAction), reads the live catalog and re-runs reconcile: RECOVERED only with full evidence, NOT_RECOVERED on failed validation, UNKNOWN on insufficient evidence. No LLM; no SSH/shell; no new executor/gateway.",
      inputSchema: vpsRecoverInputSchema,
    },
    async (args: unknown) => {
      try {
        const result = await runVpsRecover(args, {
          ...deps,
          readCatalog: async () => createProCatalogSnapshot(catalogToolNames, PRO_CATALOG_VERSION),
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
