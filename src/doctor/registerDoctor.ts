/**
 * Composition point of the private Supertool onto the public McpServer.
 *
 * This is the ONLY place where a private tool enters the Pro catalog, and the
 * only place a future entitlement gate may ever decide whether registration
 * happens. Registration here grants NO new authority: doctor is read-only,
 * stateless, strict {} and deterministic, and it receives the SAME adapter
 * instances that were handed to the public buildServer() composition.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleVpsDoctor, vpsDoctorOutputSchema } from "./vpsDoctor";
import type { ProContext } from "../proContext";

export function registerDoctor(server: McpServer, ctx: ProContext): void {
  server.registerTool(
    "engineering.vps.doctor",
    {
      title: "VPS doctor",
      description:
        'What is the overall state of this VPS and which areas need my attention right now? Deterministic read-only advisory composition of the evidence already available to this server: local VPS health and capacity (always observed), plus the operator-configured application/deployment, docker-health and log-evidence sources when present. ' +
        "Returns one consolidated verdict (ATTENTION | STABLE | UNKNOWN) with a fixed six-area coverage map (VPS_HEALTH, CAPACITY, APPLICATION_HEALTH, DEPLOYMENT, DOCKER, LOGS in fixed order), deterministic attentionAreas in that fixed order and fixed limitations. NOT_CONFIGURED means no evidence source is configured for that area; its condition is not known and is never read as healthy. A configured source returning no evidence is reported as UNAVAILABLE and makes the overall verdict UNKNOWN. Attention marks observed factual conditions only (health DEGRADED, capacity PRESSURED, application DEGRADED, deployment FAILED, docker DEGRADED, logs EXPLAINED); it is not a cause, a diagnosis and not a severity ranking. Change detection and deployment readiness are intentionally excluded. " +
        "No shell, no SSH, no network probe, no Docker socket, no raw log access, no secrets, no LLM, no mutation, no recovery or deployment authority. Input must be exactly {}.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsDoctorOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleVpsDoctor(
          args,
          ctx.systemHealthAdapter,
          ctx.applicationDeploymentAdapter,
          ctx.dockerHealthAdapter,
          ctx.logEvidenceAdapter,
        );
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
