import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { startHttpServer } from "./http.js";
import { SERVER_NAME, createServer } from "./server.js";

/**
 * Entrypoint. MCP_TRANSPORT selects the transport:
 *
 *   stdio (default) — an MCP host spawns this process; see mcp.json.
 *   http            — Streamable HTTP on PORT, which is how it runs in
 *                     Kubernetes behind PingGateway.
 *
 * Note that stdio mode must never write to stdout: stdout IS the protocol
 * channel. All logging goes to stderr.
 */
async function main(): Promise<void> {
  if (config.server.transport === "http") {
    startHttpServer();
    return;
  }

  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`${SERVER_NAME} running on stdio (FHIR ${config.fhir.version})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
