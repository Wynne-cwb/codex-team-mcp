#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCodexTeamServer } from "./server.js";
import type { PaneBackendPreference, PaneModeOptions } from "./types.js";

function parsePaneModeOptions(env: NodeJS.ProcessEnv): PaneModeOptions {
  return {
    enabled: parsePaneModeEnabled(env.CODEX_TEAM_PANE_MODE),
    preferredBackend: parsePaneBackendPreference(env.CODEX_TEAM_PANE_BACKEND),
    sessionPrefix: optionalEnvValue(env.CODEX_TEAM_PANE_SESSION_PREFIX),
    codexCommand: optionalEnvValue(env.CODEX_TEAM_CODEX_COMMAND)
  };
}

function parsePaneModeEnabled(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "enabled"
  );
}

function parsePaneBackendPreference(
  value: string | undefined
): PaneBackendPreference {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "tmux" ||
    normalized === "iterm2"
  ) {
    return normalized;
  }

  return "auto";
}

function optionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

try {
  const server = createCodexTeamServer({
    stateRoot: process.env.CODEX_TEAM_STATE_ROOT,
    workspaceRoot: process.env.CODEX_TEAM_WORKSPACE_ROOT,
    paneMode: parsePaneModeOptions(process.env)
  });
  await server.connect(new StdioServerTransport());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-team-mcp startup failed: ${message}`);
  process.exit(1);
}
