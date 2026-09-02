/**
 * Pro MCP server: ONE composition of the certified public server plus the
 * private Supertools.
 *
 * buildServer() (public) registers the 10 certified free Simple Tools;
 * registerDoctor() (private) adds engineering.vps.doctor onto the SAME
 * McpServer instance with the SAME adapter instances. The result is a single
 * stdio MCP server exposing exactly 11 tools (10 public + doctor): no
 * placeholders, no plugin framework, no entitlement logic in this stage.
 */
import { buildServer } from "memoryos-vps-guardian/src/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDoctor } from "./doctor/registerDoctor";
import { createProContext } from "./proContext";
import type { ProContext } from "./proContext";

export function buildProServer(ctx: ProContext = createProContext()): McpServer {
  const server = buildServer({
    applicationDeploymentAdapter: ctx.applicationDeploymentAdapter,
    dockerHealthAdapter: ctx.dockerHealthAdapter,
    logsEvidenceAdapter: ctx.logEvidenceAdapter,
  });
  registerDoctor(server, ctx);
  return server;
}
