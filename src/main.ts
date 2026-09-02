/**
 * stdio entry point of the private Pro MCP server (mirrors the public
 * server's main(): env wiring read exactly once at startup, then connect).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { buildProServer } from "./proServer";

export async function main(): Promise<void> {
  const server = buildProServer();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
