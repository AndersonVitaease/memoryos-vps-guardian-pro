/**
 * Composition point of the private change-planning Supertool onto the public
 * McpServer (mirrors registerDoctor.ts).
 *
 * engineering.vps.change.safe V1 is STRICTLY PLAN_ONLY: it receives a closed
 * input (action + logical target key), resolves the target exclusively
 * against the operator-configured allowlist carried in ProContext, runs
 * deterministic prechecks over the existing read-only evidence and returns a
 * fingerprinted plan. It never executes anything: there is no execute flag,
 * no approval input, no mutation adapter, no credential, no network, no
 * subprocess. Registration grants NO new authority.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { planVpsChangeSafe, vpsChangeSafeInputSchema, vpsChangeSafeOutputSchema } from "./changeSafe";
import type { ProContext } from "../proContext";

export function registerChangeSafe(server: McpServer, ctx: ProContext): void {
  server.registerTool(
    "engineering.vps.change.safe",
    {
      title: "VPS change safe (PLAN_ONLY)",
      description:
        "Plan (never execute) the single supported controlled change action application.redeploy for an operator-configured logical target. Deterministic PLAN_ONLY composition: resolves the logical target ONLY against the operator-configured allowlist injected at server construction, collects existing read-only evidence (application/deployment when configured, local VPS health/capacity always, docker health when configured), runs deterministic prechecks and returns a plan (PLAN_READY | BLOCKED | UNKNOWN) with fixed risk REQUIRES_APPROVAL, a fixed-order precheck map and a deterministic SHA-256 proposalFingerprint. PLAN_READY means only that the current prechecks permit forming a proposal that still requires approval and future execution; it is NOT approval, NOT a safety guarantee and NOT execution. proposalFingerprint is output only and authorizes nothing. " +
        "No execute input, no approval input, no mutation primitive, no shell, no SSH, no network call, no child process, no Docker socket, no credential access, no retry, no persistence. Input is strictly { action: 'application.redeploy', target: string }; nothing else is accepted.",
      inputSchema: vpsChangeSafeInputSchema,
      outputSchema: vpsChangeSafeOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = planVpsChangeSafe(args, ctx);
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
