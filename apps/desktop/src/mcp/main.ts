import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKm0McpServer } from "./server";

/**
 * `km0-mcp`: KM0's MCP server over stdio, for Claude Desktop's `mcpServers`. KM0 shows the entry to add under
 * Settings → Execution: KM0's own executable run as Node (ELECTRON_RUN_AS_NODE) with this script and the inbox
 * folder (`--dir`, or KM0_DISPATCH_DIR).
 */
const flag = process.argv.indexOf("--dir");
const dir = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.KM0_DISPATCH_DIR;
if (!dir) {
  process.stderr.write("km0-mcp: pass the dispatch folder with --dir or KM0_DISPATCH_DIR.\n");
  process.exit(2);
}
const server = createKm0McpServer(dir, process.env.KM0_VERSION ?? "1.1.0");
void server.connect(new StdioServerTransport());
