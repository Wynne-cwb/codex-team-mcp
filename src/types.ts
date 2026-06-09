import type { ExecutionBackend } from "./adapters/execution.js";

export type ScaffoldStatus =
  | "scaffold_only"
  | "not_implemented_yet"
  | "requires_later_phase"
  | "unavailable";

export type ToolAvailabilityStatus = ScaffoldStatus | "implemented";

export type CompatibilityToolName =
  | "TeamCreate"
  | "TeamDelete"
  | "Agent"
  | "SendMessage"
  | "TaskCreate"
  | "TaskUpdate"
  | "TaskList"
  | "TaskGet"
  | "TeamDiagnostics";

export interface ToolMapping {
  claudeToolName: CompatibilityToolName;
  codexToolName: CompatibilityToolName;
  description: string;
  status: ToolAvailabilityStatus;
  nextPhase: string;
}

export type PaneBackendPreference = "auto" | "tmux" | "iterm2";

export interface PaneModeOptions {
  enabled?: boolean;
  preferredBackend?: PaneBackendPreference;
  sessionPrefix?: string;
  codexCommand?: string;
}

export interface CodexTeamServerOptions {
  stateRoot?: string;
  workspaceRoot?: string;
  executionBackend?: ExecutionBackend;
  paneMode?: PaneModeOptions;
}
