import type {
  ExecutionBackendReconcileStatus,
  ExecutionRunContext,
  ExecutionTrigger
} from "./execution.js";
import {
  TerminalCommandError,
  runTerminalCommand
} from "./terminalCommand.js";
import type { PaneBackendPreference } from "../types.js";

export type PaneBackendType = "tmux" | "iterm2";

export type PaneAvailabilityStatus = "available" | "unavailable" | "degraded";

export interface PaneBackendMetadata {
  mode: "pane";
  backend_type: PaneBackendType;
  availability_status: PaneAvailabilityStatus;
  degradation_reason?: string;
  pane_id?: string;
  session_name?: string;
  window_name?: string;
  socket_name?: string;
  attach_command?: string;
  is_native?: boolean;
}

export interface PaneRunMetadata {
  pane: PaneBackendMetadata;
}

export interface PaneLaunchRequest extends ExecutionRunContext {
  start_command?: readonly string[];
}

export interface PaneLaunchResult {
  ok: boolean;
  pane: PaneBackendMetadata;
  thread_id?: string;
  process_id?: string;
}

export interface PaneReconcileResult {
  status: ExecutionBackendReconcileStatus;
  pane: PaneBackendMetadata;
  deleted: false;
}

export interface PaneBackendCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface PaneBackendCommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv }
  ): PaneBackendCommandResult;
}

export interface PaneBackend {
  describeAvailability(): PaneBackendMetadata;
  createPane(
    context: PaneLaunchRequest,
    command?: readonly string[]
  ): PaneLaunchResult;
  resumePane?(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger,
    command: readonly string[]
  ): PaneLaunchResult;
  reconcilePane?(context: ExecutionRunContext): PaneReconcileResult;
}

export interface PaneBackendRegistry {
  describeAvailability(): PaneBackendMetadata;
  createPane(
    context: PaneLaunchRequest,
    command?: readonly string[]
  ): PaneLaunchResult;
  resumePane(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger,
    command: readonly string[]
  ): PaneLaunchResult;
  reconcilePane(context: ExecutionRunContext): PaneReconcileResult;
}

export interface PaneBackendRegistryOptions {
  preferredBackend?: PaneBackendPreference;
  commandRunner?: PaneBackendCommandRunner;
  env?: NodeJS.ProcessEnv;
  sessionPrefix?: string;
}

export interface TmuxPaneBackendOptions {
  commandRunner?: PaneBackendCommandRunner;
  env?: NodeJS.ProcessEnv;
  sessionPrefix?: string;
  stableId?: string;
}

export interface ITerm2PaneBackendOptions {
  commandRunner?: PaneBackendCommandRunner;
  env?: NodeJS.ProcessEnv;
  stableId?: string;
}

const DEFAULT_SESSION_PREFIX = "codex-team";
const SOCKET_NAME_PREFIX = "codex-team-";
const DEFAULT_WINDOW_NAME = "teammates";
const SECRET_TOKEN_PATTERN = /SECRET_[A-Z0-9_]+/gi;

export function createDefaultPaneBackendRegistry(
  options: PaneBackendRegistryOptions = {}
): PaneBackendRegistry {
  return createPaneBackendRegistry(options);
}

export function createPaneBackendRegistry(
  options: PaneBackendRegistryOptions = {}
): PaneBackendRegistry {
  const preferredBackend = options.preferredBackend ?? "auto";
  const tmux = createTmuxPaneBackend(options);
  const iterm2 = createITerm2PaneBackend(options);

  function selectBackend(): PaneBackend {
    if (preferredBackend === "tmux") {
      return tmux;
    }
    if (preferredBackend === "iterm2") {
      return iterm2;
    }

    const tmuxAvailability = tmux.describeAvailability();
    if (tmuxAvailability.availability_status === "available") {
      return tmux;
    }

    const iterm2Availability = iterm2.describeAvailability();
    if (iterm2Availability.availability_status === "available") {
      return iterm2;
    }

    return tmux;
  }

  return {
    describeAvailability() {
      return selectBackend().describeAvailability();
    },
    createPane(context, command) {
      return selectBackend().createPane(context, command);
    },
    resumePane(context, trigger, command) {
      const backend = selectBackend();
      if (backend.resumePane) {
        return backend.resumePane(context, trigger, command);
      }

      return {
        ok: false,
        pane: unavailablePaneMetadata(
          backend.describeAvailability().backend_type,
          "pane_resume_unavailable"
        )
      };
    },
    reconcilePane(context) {
      const backend = selectBackend();
      if (backend.reconcilePane) {
        return backend.reconcilePane(context);
      }

      const pane = backend.describeAvailability();
      return {
        status:
          pane.availability_status === "available" ? "active" : "unsupported",
        pane,
        deleted: false
      };
    }
  };
}

export function createTmuxPaneBackend(
  options: TmuxPaneBackendOptions = {}
): PaneBackend {
  const commandRunner = options.commandRunner ?? createCommandRunner();
  const env = options.env ?? process.env;
  const sessionPrefix = sanitizePaneIdentifier(
    options.sessionPrefix ?? DEFAULT_SESSION_PREFIX,
    DEFAULT_SESSION_PREFIX
  );

  function describeAvailability(): PaneBackendMetadata {
    const version = commandRunner.run("tmux", ["-V"]);
    if (!version.ok) {
      return unavailablePaneMetadata(
        "tmux",
        `tmux command unavailable: ${sanitizePaneText(
          version.stderr || "tmux command not found"
        )}`
      );
    }

    return {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available"
    };
  }

  return {
    describeAvailability,
    createPane(context) {
      const availability = describeAvailability();
      if (availability.availability_status !== "available") {
        return {
          ok: false,
          pane: availability
        };
      }

      if (env.TMUX && env.TMUX_PANE) {
        return createNativeTmuxPane(commandRunner, context, env);
      }

      return createExternalTmuxPane(commandRunner, context, {
        sessionPrefix,
        stableId: options.stableId
      });
    },
    reconcilePane(context) {
      return reconcileTmuxPane(commandRunner, context);
    }
  };
}

export function createITerm2PaneBackend(
  options: ITerm2PaneBackendOptions = {}
): PaneBackend {
  const commandRunner = options.commandRunner ?? createCommandRunner();
  const env = options.env ?? process.env;

  function describeAvailability(): PaneBackendMetadata {
    const version = commandRunner.run("it2", ["--version"]);
    if (!version.ok) {
      return unavailablePaneMetadata(
        "iterm2",
        `it2 command unavailable: ${sanitizePaneText(
          version.stderr || "it2 command not found"
        )}`
      );
    }

    if (env.TERM_PROGRAM !== "iTerm.app" || !env.ITERM_SESSION_ID?.trim()) {
      return unavailablePaneMetadata(
        "iterm2",
        "iterm2_session_unavailable: TERM_PROGRAM=iTerm.app and ITERM_SESSION_ID are required"
      );
    }

    return {
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available"
    };
  }

  return {
    describeAvailability,
    createPane(context) {
      const availability = describeAvailability();
      if (availability.availability_status !== "available") {
        return {
          ok: false,
          pane: availability
        };
      }

      const runSuffix = sanitizePaneIdentifier(
        options.stableId ?? context.run_id,
        "run"
      );
      const result = commandRunner.run("it2", ["split-pane"], {
        cwd: context.workspace_path ?? context.workspace_root
      });
      if (!result.ok) {
        return {
          ok: false,
          pane: degradedPaneMetadata(
            "iterm2",
            sanitizePaneText(result.stderr || "iterm2 split pane failed")
          )
        };
      }

      const paneId = sanitizePaneText(result.stdout.trim() || runSuffix);
      return {
        ok: true,
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: paneId,
          session_name: sanitizePaneText(env.ITERM_SESSION_ID ?? ""),
          window_name: "iTerm2",
          is_native: true
        },
        process_id: paneId
      };
    },
    reconcilePane(context) {
      return reconcileITerm2Pane(commandRunner, context);
    }
  };
}

export function sanitizePaneIdentifier(
  value: string,
  fallback: string
): string {
  const sanitized = value
    .replace(SECRET_TOKEN_PATTERN, "redacted-secret")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return sanitized || fallback;
}

function shellQuoteAttachArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildTmuxAttachCommand(input: {
  socketName?: string;
  sessionName: string;
}): string {
  const sessionName = sanitizePaneText(input.sessionName || "tmux") || "tmux";
  const socketName = input.socketName
    ? sanitizePaneText(input.socketName).trim()
    : "";

  if (socketName) {
    return `tmux -L ${shellQuoteAttachArg(socketName)} attach-session -t ${shellQuoteAttachArg(sessionName)}`;
  }

  return `tmux attach-session -t ${shellQuoteAttachArg(sessionName)}`;
}

export function buildExternalTmuxAttachCommand(input: {
  socketName: string;
  sessionName: string;
}): string {
  const socketName = sanitizePaneIdentifier(input.socketName, "codex-team");
  const sessionName = sanitizePaneIdentifier(input.sessionName, "codex-team");
  return buildTmuxAttachCommand({ socketName, sessionName });
}

function createExternalTmuxPane(
  commandRunner: PaneBackendCommandRunner,
  context: ExecutionRunContext,
  options: { sessionPrefix: string; stableId?: string }
): PaneLaunchResult {
  const teamName = sanitizePaneIdentifier(context.team_name ?? "team", "team");
  const runSuffix = sanitizePaneIdentifier(
    options.stableId ?? context.run_id,
    "run"
  );
  const socketName = `${SOCKET_NAME_PREFIX}${teamName}-${runSuffix}`;
  const sessionName = `${options.sessionPrefix}-${teamName}`;
  const windowName = DEFAULT_WINDOW_NAME;
  const result = commandRunner.run(
    "tmux",
    [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{pane_id}"
    ],
    {
      cwd: context.workspace_path ?? context.workspace_root
    }
  );

  if (!result.ok) {
    return {
      ok: false,
      pane: degradedPaneMetadata(
        "tmux",
        sanitizePaneText(result.stderr || "tmux new-session failed")
      )
    };
  }

  const paneId = sanitizePaneText(result.stdout.trim());
  return {
    ok: true,
    pane: {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: paneId,
      session_name: sessionName,
      window_name: windowName,
      socket_name: socketName,
      attach_command: buildExternalTmuxAttachCommand({
        socketName,
        sessionName
      }),
      is_native: false
    },
    process_id: paneId || undefined
  };
}

function createNativeTmuxPane(
  commandRunner: PaneBackendCommandRunner,
  context: ExecutionRunContext,
  env: NodeJS.ProcessEnv
): PaneLaunchResult {
  const socketName = tmuxSocketNameFromEnv(env.TMUX);
  const sessionName = sanitizePaneText(
    commandRunner.run("tmux", ["display-message", "-p", "#{session_name}"]).stdout.trim()
  );
  const windowName = sanitizePaneText(
    commandRunner.run("tmux", ["display-message", "-p", "#{window_name}"]).stdout.trim()
  );
  const split = commandRunner.run(
    "tmux",
    ["split-window", "-d", "-P", "-F", "#{pane_id}"],
    {
      cwd: context.workspace_path ?? context.workspace_root
    }
  );

  if (!split.ok) {
    return {
      ok: false,
      pane: degradedPaneMetadata(
        "tmux",
        sanitizePaneText(split.stderr || "tmux split-window failed")
      )
    };
  }

  const paneId = sanitizePaneText(split.stdout.trim());
  return {
    ok: true,
    pane: {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: paneId,
      session_name: sessionName || "tmux",
      window_name: windowName || DEFAULT_WINDOW_NAME,
      socket_name: socketName,
      attach_command: buildTmuxAttachCommand({
        sessionName: sessionName || "tmux",
        socketName: socketName && socketName !== "default" ? socketName : undefined
      }),
      is_native: true
    },
    process_id: paneId || undefined
  };
}

function extractContextPaneMetadata(
  context: ExecutionRunContext
): PaneBackendMetadata | null {
  const backendMetadata = context.metadata?.backend_metadata;
  const paneFromBackendMetadata =
    isRecord(backendMetadata) && isPaneMetadata(backendMetadata.pane)
      ? backendMetadata.pane
      : null;
  if (paneFromBackendMetadata) {
    return paneFromBackendMetadata;
  }

  return isPaneMetadata(context.metadata?.pane) ? context.metadata.pane : null;
}

function reconcileTmuxPane(
  commandRunner: PaneBackendCommandRunner,
  context: ExecutionRunContext
): PaneReconcileResult {
  const pane = extractContextPaneMetadata(context);
  if (!pane) {
    return stalePaneResult("tmux", "pane_metadata_unavailable");
  }
  if (pane.availability_status !== "available") {
    return preserveNonActivePaneResult(pane);
  }

  const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
  const sessionName = sanitizePaneText(pane.session_name ?? "").trim();
  const socketName = sanitizePaneText(pane.socket_name ?? "").trim();

  if (paneId) {
    const args = socketName
      ? ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id}"]
      : ["list-panes", "-a", "-F", "#{pane_id}"];
    const result = commandRunner.run("tmux", args);
    if (result.ok && outputContainsLine(result.stdout, paneId)) {
      return { status: "active", pane, deleted: false };
    }

    return stalePaneResult("tmux", "tmux pane not found", pane);
  }

  if (sessionName) {
    const args = socketName
      ? ["-L", socketName, "has-session", "-t", sessionName]
      : ["has-session", "-t", sessionName];
    const result = commandRunner.run("tmux", args);
    if (result.ok) {
      return { status: "active", pane, deleted: false };
    }

    return stalePaneResult("tmux", "tmux session not found", pane);
  }

  return stalePaneResult("tmux", "pane_metadata_unavailable", pane);
}

function reconcileITerm2Pane(
  commandRunner: PaneBackendCommandRunner,
  context: ExecutionRunContext
): PaneReconcileResult {
  const pane = extractContextPaneMetadata(context);
  if (!pane) {
    return stalePaneResult("iterm2", "pane_metadata_unavailable");
  }
  if (pane.availability_status !== "available") {
    return preserveNonActivePaneResult(pane);
  }

  const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
  const sessionName = sanitizePaneText(pane.session_name ?? "").trim();
  const result = commandRunner.run("it2", ["session", "list"]);
  if (!result.ok) {
    return stalePaneResult("iterm2", "iterm2 session unavailable", pane);
  }
  if (
    outputContainsExactToken(result.stdout, paneId) ||
    outputContainsExactToken(result.stdout, sessionName)
  ) {
    return { status: "active", pane, deleted: false };
  }

  return stalePaneResult("iterm2", "iterm2 pane not found", pane);
}

function preserveNonActivePaneResult(pane: PaneBackendMetadata): PaneReconcileResult {
  return {
    status: pane.availability_status === "unavailable" ? "unsupported" : "stale",
    pane,
    deleted: false
  };
}

function stalePaneResult(
  backendType: PaneBackendType,
  reason: string,
  pane?: PaneBackendMetadata
): PaneReconcileResult {
  return {
    status: "stale",
    pane: {
      mode: "pane",
      backend_type: backendType,
      ...(pane ?? {}),
      availability_status: "degraded",
      degradation_reason: sanitizePaneText(reason)
    },
    deleted: false
  };
}

function outputContainsLine(stdout: string, expectedLine: string): boolean {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(expectedLine);
}

function outputContainsExactToken(stdout: string, expected: string): boolean {
  if (!expected) {
    return false;
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === expected || line.split(/\s+/).includes(expected));
}

function createCommandRunner(): PaneBackendCommandRunner {
  return {
    run(command, args, options) {
      try {
        const result = runTerminalCommand(command, args, options);
        return {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode
        };
      } catch (error) {
        if (error instanceof TerminalCommandError) {
          return {
            ok: false,
            stdout: error.stdout,
            stderr: error.stderr || error.message,
            exit_code: error.exitCode
          };
        }

        return {
          ok: false,
          stdout: "",
          stderr: sanitizePaneText(error instanceof Error ? error.message : String(error)),
          exit_code: 1
        };
      }
    }
  };
}

function unavailablePaneMetadata(
  backendType: PaneBackendType,
  reason: string
): PaneBackendMetadata {
  return {
    mode: "pane",
    backend_type: backendType,
    availability_status: "unavailable",
    degradation_reason: sanitizePaneText(reason)
  };
}

function degradedPaneMetadata(
  backendType: PaneBackendType,
  reason: string
): PaneBackendMetadata {
  return {
    mode: "pane",
    backend_type: backendType,
    availability_status: "degraded",
    degradation_reason: sanitizePaneText(reason)
  };
}

function tmuxSocketNameFromEnv(tmuxEnv: string | undefined): string | undefined {
  if (!tmuxEnv) {
    return undefined;
  }

  const socketPath = tmuxEnv.split(",")[0] ?? "";
  const socketName = socketPath.split("/").filter(Boolean).at(-1);
  return socketName ? sanitizePaneIdentifier(socketName, "default") : undefined;
}

function sanitizePaneText(value: string): string {
  return value
    .replace(SECRET_TOKEN_PATTERN, "[redacted_secret]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaneMetadata(value: unknown): value is PaneBackendMetadata {
  return (
    isRecord(value) &&
    value.mode === "pane" &&
    (value.backend_type === "tmux" || value.backend_type === "iterm2") &&
    (value.availability_status === "available" ||
      value.availability_status === "unavailable" ||
      value.availability_status === "degraded")
  );
}
