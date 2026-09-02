/**
 * Composition point of the governed change Supertool onto the public
 * McpServer (mirrors registerDoctor.ts).
 *
 * engineering.vps.change.safe V2 is PLAN + governed EXECUTE for the single
 * allowlisted action application.redeploy. PLAN (default) resolves the
 * logical target exclusively against the operator-configured allowlist
 * carried in ProContext and returns a fingerprinted plan. EXECUTE requires
 * approval bound to the plan's proposalFingerprint (TOCTOU-verified against
 * fresh evidence before ANY mutation) and performs exactly ONE mutation
 * attempt through the operator-configured SafeChangeAdapter, followed by
 * mandatory read-only post-validation. The agent never supplies an
 * applicationId, credential, backend URL, command, shell, SSH or tool
 * selection; unknown fields are rejected at the protocol layer.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runVpsChangeSafe, vpsChangeSafeInputSchema, vpsChangeSafeOutputSchema } from "./changeSafe";
import type { ProContext } from "../proContext";

export function registerChangeSafe(server: McpServer, ctx: ProContext): void {
  server.registerTool(
    "engineering.vps.change.safe",
    {
      title: "VPS change safe (plan + governed execute)",
      description:
        "Governed controlled change Supertool for the single allowlisted action application.redeploy. PLAN mode (default): { action, target } resolves the logical target ONLY against the operator-configured allowlist injected at server construction, collects existing read-only evidence (application/deployment when configured, local VPS health/capacity always, docker health when configured), runs deterministic prechecks and returns a plan (PLAN_READY | BLOCKED | UNKNOWN) with fixed risk REQUIRES_APPROVAL and a deterministic SHA-256 proposalFingerprint (output only; it authorizes nothing). EXECUTE mode: adds execute=true and approval={approved, proposalFingerprint}; the tool re-resolves the target, re-collects fresh evidence, re-runs the prechecks, recomputes the fingerprint and compares it with approval.proposalFingerprint - a mismatch returns SNAPSHOT_CHANGED and absent/not-granted approval returns APPROVAL_REQUIRED, both with ZERO mutation. Only then does it perform exactly ONE mutation attempt through the operator-configured SafeChangeAdapter (single capability application-redeploy; no retry, no auto-recovery, no polling), followed by mandatory read-only post-validation reported as VERIFIED | FAILED | PENDING | UNKNOWN_REQUIRES_HUMAN_REVIEW; backend acceptance is never treated as success. Rollback is not available: rollback.available=false always. The agent never supplies and the output never contains an applicationId, credential, backend URL, host, IP, command, shell, SSH or tool selection. Input is strictly { action: 'application.redeploy', target: string, execute?: boolean, approval?: { approved: boolean, proposalFingerprint: string } }; nothing else is accepted.",
      inputSchema: vpsChangeSafeInputSchema,
      outputSchema: vpsChangeSafeOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = await runVpsChangeSafe(args, ctx);
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
