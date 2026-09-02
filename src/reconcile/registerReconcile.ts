/**
 * Composition point of the private READ-ONLY drift detection Supertool onto
 * the public McpServer (mirrors registerDoctor.ts / registerChangeSafe.ts).
 *
 * engineering.vps.reconcile compares the operator-configured release-state
 * file (expected) against actually evidenced state (actual: this server's own
 * tool catalog, computed here over the composition's exact tool list).
 * Container inspection is NOT injected in this MVP, so it stays unavailable —
 * exactly like the certified original registration site. Absence of evidence
 * is NEVER drift; undeterminable comparisons return UNKNOWN. Registration
 * grants NO new authority: zero mutation (no execute/approval input exists),
 * no LLM, no SSH/shell, no Dokploy changes, never writes the release-state
 * file, and the catalog comes from the composition's own list — never from
 * agent input.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRO_CATALOG_VERSION,
  createProCatalogSnapshot,
  runVpsReconcile,
  vpsReconcileInputSchema,
  vpsReconcileOutputSchema,
} from "./vpsReconcile";

export function registerReconcile(server: McpServer, catalogToolNames: readonly string[]): void {
  server.registerTool(
    "engineering.vps.reconcile",
    {
      title: "VPS reconcile (read-only drift detection)",
      description:
        "READ-ONLY drift detection Supertool: compares the operator-configured release-state file (expected) against actually evidenced state (actual: this server's internal tool catalog hash/version/toolCount; container inspection is not injected in this MVP, so it stays unavailable). Absence of evidence is NEVER drift - undeterminable comparisons return UNKNOWN, never a mismatch finding. Zero mutation (no execute/approval input exists); no LLM; no SSH/shell; no Dokploy changes; never writes the release-state file. Input must be exactly {}.",
      inputSchema: vpsReconcileInputSchema,
      outputSchema: vpsReconcileOutputSchema,
    },
    async () => {
      try {
        const actualCatalog = createProCatalogSnapshot(catalogToolNames, PRO_CATALOG_VERSION);
        const result = await runVpsReconcile({
          readCatalog: async () => actualCatalog,
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
