import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCompatibilityTools } from "./tools/registry.js";
import type { CodexTeamServerOptions } from "./types.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export function createCodexTeamServer(options: CodexTeamServerOptions = {}): McpServer {
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION
  });

  registerCompatibilityTools(server, options);

  return server;
}
