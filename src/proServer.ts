/**
 * Pro MCP server: ONE composition of the certified public server plus the
 * private Supertools.
 *
 * buildServer() (public) registers the 10 certified free Simple Tools;
 * registerDoctor(), registerChangeSafe() and registerReconcile() (private)
 * add engineering.vps.doctor, the governed engineering.vps.change.safe and
 * the read-only engineering.vps.reconcile onto the SAME McpServer instance
 * with the SAME adapter/allowlist wiring. The result is a single stdio MCP
 * server exposing exactly 13 tools (10 public + doctor + change.safe +
 * reconcile): no placeholders, no plugin framework, no entitlement logic,
 * no mutation primitive, no execution authority outside change.safe.
 *
 * PRO_CATALOG_TOOL_NAMES is the composition's exact registered tool list:
 * the single source consumed by engineering.vps.reconcile's actual-state
 * catalog snapshot and asserted by the composition tests against the live
 * tools/list result (drift between the two fails tests loudly).
 */
import { buildServer } from "memoryos-vps-guardian/src/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDoctor } from "./doctor/registerDoctor";
import { registerChangeSafe } from "./change/registerChangeSafe";
import { registerReconcile } from "./reconcile/registerReconcile";
import { createProContext } from "./proContext";
import type { ProContext } from "./proContext";

export const PRO_CATALOG_TOOL_NAMES = [
  // 10 certified public Simple Tools (pinned public release v0.1.0):
  "engineering.vps.health",
  "engineering.vps.capacity",
  "engineering.vps.what_changed",
  "engineering.vps.incident.summary",
  "engineering.deploy.status",
  "engineering.app.health",
  "engineering.deploy.ready",
  "engineering.docker.health",
  "engineering.vps.why_down",
  "engineering.logs.explain",
  // 3 private Supertools:
  "engineering.vps.doctor",
  "engineering.vps.change.safe",
  "engineering.vps.reconcile",
] as const;

export function buildProServer(ctx: ProContext = createProContext()): McpServer {
  const server = buildServer({
    applicationDeploymentAdapter: ctx.applicationDeploymentAdapter,
    dockerHealthAdapter: ctx.dockerHealthAdapter,
    logsEvidenceAdapter: ctx.logEvidenceAdapter,
  });
  registerDoctor(server, ctx);
  registerChangeSafe(server, ctx);
  registerReconcile(server, PRO_CATALOG_TOOL_NAMES);
  return server;
}
