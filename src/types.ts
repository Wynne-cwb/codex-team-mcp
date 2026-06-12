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
  | "TeamDiagnostics"
  // Phase 12 (D-04): codex-team extension tool (NOT a native Claude tool, same
  // precedent as TeamDiagnostics). The 8 Claude target tools are unchanged.
  | "TeamMerge"
  // Phase 16 (T7 / §3.3): codex-team extension tool (NOT a native Claude tool).
  // Pull unread (and optionally read-history) messages addressed to the caller.
  // Available to ALL roles; the 8 Claude target tools are unchanged.
  | "CheckInbox";

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

export interface ExecutionOptions {
  enabled?: boolean;
  backend?: string;
}

export interface CodexTeamServerOptions {
  stateRoot?: string;
  workspaceRoot?: string;
  executionBackend?: ExecutionBackend;
  execution?: ExecutionOptions;
  paneMode?: PaneModeOptions;
}
