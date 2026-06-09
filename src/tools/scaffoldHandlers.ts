import type { CodexTeamServerOptions, ToolMapping } from "../types.js";

export interface ScaffoldToolPayload {
  claude_tool_name: string;
  codex_tool_name: string;
  status: string;
  message: string;
  next_phase: string;
  implemented_now: false;
  no_generic_subagent_fallback: true;
  diagnostics_hint: string;
  tool_mapping: {
    claude_tool_name: string;
    codex_tool_name: string;
  };
}

export function buildScaffoldToolPayload(mapping: ToolMapping): ScaffoldToolPayload {
  return {
    claude_tool_name: mapping.claudeToolName,
    codex_tool_name: mapping.codexToolName,
    status: mapping.status,
    message:
      "This Phase 1 tool is visible for Agent Team compatibility discovery only. It does not create durable teams, messages, tasks, or addressable TeamMates yet.",
    next_phase: mapping.nextPhase,
    implemented_now: false,
    no_generic_subagent_fallback: true,
    diagnostics_hint: "Call TeamDiagnostics to inspect the loaded compatibility layer.",
    tool_mapping: {
      claude_tool_name: mapping.claudeToolName,
      codex_tool_name: mapping.codexToolName
    }
  };
}

export function createScaffoldToolHandler(
  mapping: ToolMapping,
  _options: CodexTeamServerOptions = {}
): () => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(buildScaffoldToolPayload(mapping), null, 2)
      }
    ]
  });
}
