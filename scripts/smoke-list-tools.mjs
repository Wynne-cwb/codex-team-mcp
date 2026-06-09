#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedTools = [
  "TeamCreate",
  "TeamDelete",
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TeamDiagnostics"
];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtServerRelativePath = "dist/index.js";
const serverPath = join(packageRoot, ...builtServerRelativePath.split("/"));

if (!existsSync(serverPath)) {
  console.error("Run npm run build first");
  process.exit(1);
}

const client = new Client({
  name: "codex-team-smoke",
  version: "0.1.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: packageRoot,
  stderr: "pipe"
});

try {
  await client.connect(transport);
  const result = await client.listTools();
  const visibleTools = new Set(result.tools.map((tool) => tool.name));
  const missingTools = expectedTools.filter((tool) => !visibleTools.has(tool));

  if (missingTools.length > 0) {
    console.error(`Missing codex-team MCP tools: ${missingTools.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`codex-team MCP tools visible: ${expectedTools.length}/${expectedTools.length}`);
  }
} finally {
  await client.close();
}
