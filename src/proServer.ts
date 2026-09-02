/**
 * Pro MCP server: ONE composition of the certified public server plus the
 * private Supertools.
 *
 * buildServer() (public) registers the 10 certified free Simple Tools;
 * registerDoctor() and registerChangeSafe() (private) add engineering.vps.doctor
 * and the STRICTLY PLAN_ONLY engineering.vps.change.safe onto the SAME
 * McpServer instance with the SAME adapter/allowlist wiring. The result is a
 * single stdio MCP server exposing exactly 12 tools (10 public + doctor +
 * change.safe): no placeholders, no plugin framework, no entitlement logic,
 * no mutation primitive, no execution authority in this stage.
 */
import { buildServer } from "memoryos-vps-guardian/src/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDoctor } from "./doctor/registerDoctor";
import { registerChangeSafe } from "./change/registerChangeSafe";
import { createProContext } from "./proContext";
import type { ProContext } from "./proContext";

export function buildProServer(ctx: ProContext = createProContext()): McpServer {
  const server = buildServer({
    applicationDeploymentAdapter: ctx.applicationDeploymentAdapter,
    dockerHealthAdapter: ctx.dockerHealthAdapter,
    logsEvidenceAdapter: ctx.logEvidenceAdapter,
  });
  registerDoctor(server, ctx);
  registerChangeSafe(server, ctx);
  return server;
}
