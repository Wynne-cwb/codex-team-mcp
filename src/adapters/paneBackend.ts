import { createHash } from "node:crypto";

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

// Result of a best-effort pane teardown. `ok` reflects whether the underlying
// close command exited 0; `reason` carries a sanitized failure note (or a
// structural marker like "pane_id_missing" / "close_unsupported") when not ok.
// Teardown is non-gating: callers must never let a false `ok` fail the
// originating TeamDelete / SendMessage.
export interface PaneBackendCloseResult {
  ok: boolean;
  pane_id?: string;
  reason?: string;
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
  // Optional teardown of a specific pane. Individual backends may not support
  // it; the registry routes to the right one and reports "close_unsupported"
  // when absent.
  closePane?(pane: PaneBackendMetadata): PaneBackendCloseResult;
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
  // Best-effort pane teardown, routed by pane.backend_type so a pane created in
  // a different terminal context than the current one is still closed correctly.
  closePane(pane: PaneBackendMetadata): PaneBackendCloseResult;
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

// tmux is launched with `-L <socketName>`, which places the socket at
// `/private/tmp/tmux-<uid>/<socketName>`. macOS caps the Unix-domain-socket
// path (`sun_path`) at 104 bytes, so a long team name + run id can overflow it
// and make pane attach fail with "File name too long". We hash the stable key
// into a short, fixed-width name. With the 11-char prefix + 16 hex chars the
// name is ~27 chars (full path ~49 bytes) — comfortably under the limit. The
// hard cap below is purely defensive so a future prefix change can never
// regress past the limit.
const MAX_SOCKET_NAME_LENGTH = 50;
const SOCKET_HASH_LENGTH = 16;

/**
 * Builds a short, deterministic, collision-resistant tmux socket name for a
 * given (team, run/stableId) pair. The same inputs always produce the same name
 * so attach/reconcile resolve the same socket. The recognizable
 * `codex-team-` prefix is preserved and the result is hard-capped well under the
 * macOS 104-byte `sun_path` limit.
 */
export function buildTmuxSocketName(teamName: string, runSuffix: string): string {
  const stableKey = `${teamName}:${runSuffix}`;
  const shortHash = createHash("sha256")
    .update(stableKey)
    .digest("hex")
    .slice(0, SOCKET_HASH_LENGTH);
  return `${SOCKET_NAME_PREFIX}${shortHash}`.slice(0, MAX_SOCKET_NAME_LENGTH);
}

/**
 * Debug-only terminal-context signal (D-02). Three booleans only — never any env
 * values or it2 stdout — so it is safe to surface under TeamDiagnostics
 * include_debug. Lets us confirm whether codex forwards TERM_PROGRAM /
 * ITERM_SESSION_ID to the MCP server process and whether the it2 API is reachable.
 */
export interface TerminalContext {
  inside_tmux: boolean;
  in_iterm2: boolean;
  it2_api_ok: boolean;
}

export interface TerminalContextOptions {
  env?: NodeJS.ProcessEnv;
  commandRunner?: PaneBackendCommandRunner;
}

/**
 * Inside tmux iff the TMUX env var is set. We ONLY check TMUX — never `tmux -V`
 * or `tmux display-message`, which succeed merely because tmux is installed or a
 * server exists, not because THIS process runs inside tmux.
 */
export function isInsideTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX && env.TMUX.trim());
}

/**
 * In iTerm2 iff TERM_PROGRAM === 'iTerm.app' OR ITERM_SESSION_ID is set, matching
 * restored-src detection.ts `isInITerm2`.
 */
export function isInITerm2Env(env: NodeJS.ProcessEnv): boolean {
  return (
    env.TERM_PROGRAM === "iTerm.app" || Boolean(env.ITERM_SESSION_ID?.trim())
  );
}

/**
 * it2 API reachable iff `it2 session list` exits 0 — verifies the it2 CLI AND
 * the iTerm2 Python API, unlike `it2 --version` which passes with the API off.
 */
export function isIt2ApiAvailable(commandRunner: PaneBackendCommandRunner): boolean {
  return commandRunner.run("it2", ["session", "list"]).ok;
}

export function describeTerminalContext(
  options: TerminalContextOptions = {}
): TerminalContext {
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? createTerminalContextCommandRunner();
  return {
    inside_tmux: isInsideTmuxEnv(env),
    in_iterm2: isInITerm2Env(env),
    it2_api_ok: isIt2ApiAvailable(commandRunner)
  };
}

/**
 * Parses the new session id from `it2 session split` output
 * ("Created new pane: <session-id>"), mirroring ITermBackend.ts parseSplitOutput.
 * Returns "" when the line is absent so callers can fall back.
 */
export function parseITerm2SplitOutput(output: string): string {
  const match = output.match(/Created new pane:\s*(.+)/);
  return match && match[1] ? match[1].trim() : "";
}

/**
 * Extracts the leader session UUID from ITERM_SESSION_ID ("wXtYpZ:UUID").
 * Returns null when not in iTerm2 / the env var is missing or malformed.
 */
function iterm2LeaderSessionId(env: NodeJS.ProcessEnv): string | null {
  const sessionId = env.ITERM_SESSION_ID;
  if (!sessionId) {
    return null;
  }
  const colonIndex = sessionId.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const uuid = sessionId.slice(colonIndex + 1).trim();
  return uuid.length > 0 ? uuid : null;
}

/**
 * Builds the `it2 session split` args. Uses `-v` (vertical split) and targets the
 * leader session with `-s <sessionId>` when it can be derived, else splits the
 * active session. Passed to execFile as an argv array (no shell), so the raw
 * session id is safe and must stay un-mangled for `-s` targeting to work.
 */
function buildITerm2SplitArgs(env: NodeJS.ProcessEnv): string[] {
  const leaderSessionId = iterm2LeaderSessionId(env);
  return leaderSessionId
    ? ["session", "split", "-v", "-s", leaderSessionId]
    : ["session", "split", "-v"];
}

export function createDefaultPaneBackendRegistry(
  options: PaneBackendRegistryOptions = {}
): PaneBackendRegistry {
  return createPaneBackendRegistry(options);
}

export function createPaneBackendRegistry(
  options: PaneBackendRegistryOptions = {}
): PaneBackendRegistry {
  const preferredBackend = options.preferredBackend ?? "auto";
  const env = options.env ?? process.env;
  const tmux = createTmuxPaneBackend(options);
  const iterm2 = createITerm2PaneBackend(options);

  // Auto-selection mirrors restored-src swarm backend detection: pick the
  // backend matching the ACTUAL terminal context the MCP server runs in, NOT
  // merely what is INSTALLED. The previous logic gated on `tmux -V` (installed)
  // and so always picked tmux on any machine with tmux on PATH — even in a plain
  // iTerm2 window where the native split should go to iTerm2.
  function selectBackend(): PaneBackend {
    if (preferredBackend === "tmux") {
      return tmux;
    }
    if (preferredBackend === "iterm2") {
      return iterm2;
    }

    // 1. Inside tmux (TMUX env var set) -> tmux backend. createPane does the
    //    native split when env.TMUX && env.TMUX_PANE are present.
    if (isInsideTmuxEnv(env)) {
      return tmux;
    }

    // 2. In an iTerm2 window AND the it2 Python API is reachable
    //    (`it2 session list` exits 0) -> iTerm2 backend. The context check
    //    short-circuits so we never probe it2 outside iTerm2.
    if (
      isInITerm2Env(env) &&
      iterm2.describeAvailability().availability_status === "available"
    ) {
      return iterm2;
    }

    // 3. tmux is INSTALLED (`tmux -V` ok) -> external detached tmux session.
    //    Nothing auto-opens here, so this surfaces as attach-only / degraded UX.
    if (tmux.describeAvailability().availability_status === "available") {
      return tmux;
    }

    // 4. Nothing available -> tmux backend returns its `unavailable` metadata.
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
    },
    closePane(pane) {
      // Route by the pane's OWN backend_type, NOT selectBackend(): the pane being
      // torn down (e.g. on TeamDelete) may have been created under a different
      // terminal context than the one the MCP server currently runs in.
      const target = pane.backend_type === "iterm2" ? iterm2 : tmux;
      if (!target.closePane) {
        return { ok: false, reason: "close_unsupported" };
      }
      return target.closePane(pane);
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
    createPane(context, command) {
      const availability = describeAvailability();
      if (availability.availability_status !== "available") {
        return {
          ok: false,
          pane: availability
        };
      }

      if (env.TMUX && env.TMUX_PANE) {
        return createNativeTmuxPane(commandRunner, context, env, command);
      }

      return createExternalTmuxPane(commandRunner, context, {
        sessionPrefix,
        stableId: options.stableId,
        command
      });
    },
    reconcilePane(context) {
      return reconcileTmuxPane(commandRunner, context);
    },
    closePane(pane) {
      const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
      const socketName = sanitizePaneText(pane.socket_name ?? "").trim();
      const sessionName = sanitizePaneText(pane.session_name ?? "").trim();

      // External (detached) tmux session: target the dedicated `-L <socket>`.
      // Prefer kill-pane on the exact pane; fall back to kill-session when the
      // pane id is unknown but the session is.
      if (socketName) {
        if (paneId) {
          const result = commandRunner.run("tmux", [
            "-L",
            socketName,
            "kill-pane",
            "-t",
            paneId
          ]);
          return {
            ok: result.ok,
            pane_id: paneId,
            reason: result.ok
              ? undefined
              : sanitizePaneText(result.stderr || "tmux kill-pane failed")
          };
        }
        if (sessionName) {
          const result = commandRunner.run("tmux", [
            "-L",
            socketName,
            "kill-session",
            "-t",
            sessionName
          ]);
          return {
            ok: result.ok,
            reason: result.ok
              ? undefined
              : sanitizePaneText(result.stderr || "tmux kill-session failed")
          };
        }
        return { ok: false, reason: "pane_id_missing" };
      }

      // Native tmux pane (we run inside tmux): plain kill-pane on the user server.
      if (!paneId) {
        return { ok: false, reason: "pane_id_missing" };
      }
      const result = commandRunner.run("tmux", ["kill-pane", "-t", paneId]);
      return {
        ok: result.ok,
        pane_id: paneId,
        reason: result.ok
          ? undefined
          : sanitizePaneText(result.stderr || "tmux kill-pane failed")
      };
    }
  };
}

export function createITerm2PaneBackend(
  options: ITerm2PaneBackendOptions = {}
): PaneBackend {
  const commandRunner = options.commandRunner ?? createCommandRunner();
  const env = options.env ?? process.env;

  // Instance-level (closure) teammate-session tracking. Kept per backend INSTANCE
  // (never module-level) so the layout state survives across createPane calls
  // within one registry yet stays isolated between independent backends and tests.
  // commandRunner.run is synchronous (execFileSync-style), so the reference's async
  // lock is unnecessary — the state below is mutated strictly in call order.
  let teammateSessionIds: string[] = [];
  let firstPaneUsed = false;

  function describeAvailability(): PaneBackendMetadata {
    // Require the iTerm2 env context first so we never probe it2 outside iTerm2.
    if (!isInITerm2Env(env)) {
      return unavailablePaneMetadata(
        "iterm2",
        "iterm2_session_unavailable: TERM_PROGRAM=iTerm.app or ITERM_SESSION_ID is required"
      );
    }

    // `it2 session list` (exit 0) verifies BOTH the it2 CLI is present AND the
    // iTerm2 Python API is reachable. `it2 --version` passes even when the API
    // is disabled, which makes `it2 session split` fail later with no fallback.
    const sessionList = commandRunner.run("it2", ["session", "list"]);
    if (!sessionList.ok) {
      return unavailablePaneMetadata(
        "iterm2",
        `it2 session list unavailable: ${sanitizePaneText(
          sessionList.stderr || "it2 CLI or iTerm2 Python API not reachable"
        )}`
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
    createPane(context, command) {
      const availability = describeAvailability();
      if (availability.availability_status !== "available") {
        return {
          ok: false,
          pane: availability
        };
      }

      const cwd = context.workspace_path ?? context.workspace_root;

      // Layout (mirrors restored-src ITermBackend.ts): leader on the left, each
      // teammate stacked vertically on the right. The FIRST teammate splits the
      // leader session vertically (`-v -s <leader>`, via buildITerm2SplitArgs);
      // SUBSEQUENT teammates split OFF the previous teammate session (no `-v`) so
      // they stack instead of re-splitting the leader (the v1 bug where every
      // teammate piled up horizontally). `-s` targets the exact session so the
      // layout is correct no matter which pane the user last clicked.
      //
      // At-fault recovery: if a targeted teammate session is dead (user closed it),
      // `it2 session list` confirms death before we prune and retry with the next
      // teammate (or leader). We never prune on a systemic it2 failure (Python API
      // off, it2 gone, transient socket error), which would drain all live ids.
      // Bounded at O(N+1) iterations: each `continue` shrinks teammateSessionIds by
      // one; empty → firstPaneUsed resets → next iteration targets the leader.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const isFirstTeammate = !firstPaneUsed;
        let splitArgs: string[];
        let targetedTeammateId: string | undefined;
        if (isFirstTeammate) {
          splitArgs = buildITerm2SplitArgs(env);
        } else {
          targetedTeammateId =
            teammateSessionIds[teammateSessionIds.length - 1];
          splitArgs = targetedTeammateId
            ? ["session", "split", "-s", targetedTeammateId]
            : ["session", "split"];
        }

        const splitResult = commandRunner.run("it2", splitArgs, { cwd });

        if (!splitResult.ok) {
          if (targetedTeammateId) {
            const listResult = commandRunner.run("it2", ["session", "list"]);
            if (
              listResult.ok &&
              !listResult.stdout.includes(targetedTeammateId)
            ) {
              // Confirmed dead — prune and retry with the next-to-last teammate.
              const idx = teammateSessionIds.indexOf(targetedTeammateId);
              if (idx !== -1) {
                teammateSessionIds.splice(idx, 1);
              }
              if (teammateSessionIds.length === 0) {
                firstPaneUsed = false;
              }
              continue;
            }
            // Target alive or undeterminable — don't corrupt state; degrade below.
          }
          // Best-effort, non-gating: degrade rather than throw.
          return {
            ok: false,
            pane: degradedPaneMetadata(
              "iterm2",
              sanitizePaneText(splitResult.stderr || "iterm2 split pane failed")
            )
          };
        }

        const paneId = sanitizePaneText(parseITerm2SplitOutput(splitResult.stdout));
        if (!paneId) {
          return {
            ok: false,
            pane: degradedPaneMetadata(
              "iterm2",
              "iterm2 split pane returned no session id"
            )
          };
        }

        if (isFirstTeammate) {
          firstPaneUsed = true;
        }
        teammateSessionIds.push(paneId);

        // Run the visibility command (e.g. `tail -f <exec_log_path>`) inside the
        // freshly split pane. `it2 session run` takes the whole command as ONE arg
        // that it2 hands to a shell, so we pass a single shell-quoted string (paths
        // may contain spaces). A failed `session run` keeps the (successfully
        // split) pane and only records a degradation_reason — the split succeeded,
        // so the pane is available; content failure must not flip it to failed.
        let degradationReason: string | undefined;
        if (command && command.length > 0) {
          const runResult = commandRunner.run(
            "it2",
            ["session", "run", "-s", paneId, buildTailCommandString(command)],
            { cwd }
          );
          if (!runResult.ok) {
            degradationReason = sanitizePaneText(
              runResult.stderr || "iterm2 session run failed"
            );
          }
        }

        return {
          ok: true,
          pane: {
            mode: "pane",
            backend_type: "iterm2",
            availability_status: "available",
            ...(degradationReason
              ? { degradation_reason: degradationReason }
              : {}),
            pane_id: paneId,
            session_name: sanitizePaneText(env.ITERM_SESSION_ID ?? ""),
            window_name: "iTerm2",
            is_native: true
          },
          process_id: paneId
        };
      }
    },
    reconcilePane(context) {
      return reconcileITerm2Pane(commandRunner, context);
    },
    closePane(pane) {
      const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
      if (!paneId) {
        return { ok: false, reason: "pane_id_missing" };
      }

      // Mirror restored-src ITermBackend.killPane: `-f` (force) is required so
      // iTerm2 closes without honoring the "Confirm before closing" prompt that
      // would otherwise refuse while the pane's shell still runs.
      const result = commandRunner.run("it2", [
        "session",
        "close",
        "-f",
        "-s",
        paneId
      ]);

      // Clean up closure layout state REGARDLESS of the close result — even if the
      // pane was already gone (user closed it), pruning the stale id is correct so
      // a later split doesn't target a dead session. Empty -> reset firstPaneUsed
      // so the next split re-targets the leader.
      const idx = teammateSessionIds.indexOf(paneId);
      if (idx !== -1) {
        teammateSessionIds.splice(idx, 1);
      }
      if (teammateSessionIds.length === 0) {
        firstPaneUsed = false;
      }

      return {
        ok: result.ok,
        pane_id: paneId,
        reason: result.ok
          ? undefined
          : sanitizePaneText(result.stderr || "iterm2 session close failed")
      };
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

/**
 * Builds a single shell-command string from a command argv by shell-quoting each
 * token and joining with spaces. The result is passed as ONE argv element to
 * `it2 session run` and tmux's trailing `[shell-command]` — both hand that element
 * to `sh -c`. Quoting every token keeps workspace paths that contain spaces (e.g.
 * "Automizely Marketing") intact and prevents word-splitting / injection when sh
 * re-parses the string. The argv array itself reaches execFile without a shell, so
 * passing one already-quoted string is safe.
 */
function buildTailCommandString(command: readonly string[]): string {
  return command
    .map((token) => shellQuoteAttachArg(sanitizePaneText(token)))
    .join(" ");
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
  options: {
    sessionPrefix: string;
    stableId?: string;
    command?: readonly string[];
  }
): PaneLaunchResult {
  const teamName = sanitizePaneIdentifier(context.team_name ?? "team", "team");
  const runSuffix = sanitizePaneIdentifier(
    options.stableId ?? context.run_id,
    "run"
  );
  const socketName = buildTmuxSocketName(teamName, runSuffix);
  const sessionName = `${options.sessionPrefix}-${teamName}`;
  const windowName = DEFAULT_WINDOW_NAME;
  // tmux runs the trailing `[shell-command]` arg in the new session's pane. Mirror
  // restored-src TmuxBackend: append the visibility command (e.g. `tail -f <log>`)
  // as a SINGLE shell-quoted string so paths with spaces stay intact. Omitted when
  // no command is given, preserving the original empty-shell behavior.
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
      "#{pane_id}",
      ...(options.command && options.command.length > 0
        ? [buildTailCommandString(options.command)]
        : [])
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
  env: NodeJS.ProcessEnv,
  command?: readonly string[]
): PaneLaunchResult {
  const socketName = tmuxSocketNameFromEnv(env.TMUX);
  const sessionName = sanitizePaneText(
    commandRunner.run("tmux", ["display-message", "-p", "#{session_name}"]).stdout.trim()
  );
  const windowName = sanitizePaneText(
    commandRunner.run("tmux", ["display-message", "-p", "#{window_name}"]).stdout.trim()
  );
  // tmux runs the trailing `[shell-command]` arg in the new pane. Mirror
  // restored-src TmuxBackend: append the visibility command (e.g. `tail -f <log>`)
  // as a SINGLE shell-quoted string so paths with spaces stay intact. Omitted when
  // no command is given, preserving the original empty-shell behavior.
  const split = commandRunner.run(
    "tmux",
    [
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      ...(command && command.length > 0 ? [buildTailCommandString(command)] : [])
    ],
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

// Debug-only terminal-context probe runner. Bounds `it2 session list` with a
// short timeout so a hung iTerm2 Python API can never stall a diagnostics call;
// a timeout/spawn error is caught and reported as ok:false (it2_api_ok = false).
const TERMINAL_CONTEXT_PROBE_TIMEOUT_MS = 3000;

function createTerminalContextCommandRunner(): PaneBackendCommandRunner {
  return {
    run(command, args, options) {
      try {
        const result = runTerminalCommand(command, args, {
          ...options,
          timeoutMs: TERMINAL_CONTEXT_PROBE_TIMEOUT_MS
        });
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
