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
  // Ordered list (MOST RECENTLY CREATED FIRST) of this team's already-open
  // iTerm2 pane ids, derived from the durable DB by the lifecycle layer. The
  // iTerm2 backend anchors a new teammate split off the first LIVE candidate so
  // panes stack vertically down the right column. This is DB-derived rather than
  // in-process closure state because the pane backend is re-instantiated on every
  // Agent tool call — the old closure tracking reset each time, so every teammate
  // was treated as "first" and re-split the leader, piling up horizontally. tmux
  // ignores this field (its layout is handled per-session natively).
  previousTeammatePaneIds?: readonly string[];
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
  // Optional "type text into an already-open pane" capability. Used by the
  // pane-hosted execution backend to deliver a resume nudge into a teammate's
  // live codex TUI (iTerm2: `it2 session run -s <id> <text>`; tmux:
  // `send-keys -t <id> <text> Enter`). Best-effort: the result mirrors the
  // underlying command's exit status and is never allowed to throw to the caller.
  sendToPane?(
    pane: PaneBackendMetadata,
    command: readonly string[]
  ): PaneBackendCommandResult;
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
  // Best-effort text delivery into an already-open pane (resume nudge), routed by
  // pane.backend_type. Optional: a registry whose selected backend cannot deliver
  // text reports ok:false rather than throwing.
  sendToPane?(
    pane: PaneBackendMetadata,
    command: readonly string[]
  ): PaneBackendCommandResult;
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
  // Synchronous settle between the two-step submit sends (see sendToPane). Tests
  // inject a no-op; production defaults to a real blocking sleep.
  sleep?: (ms: number) => void;
}

const DEFAULT_SESSION_PREFIX = "codex-team";
const SOCKET_NAME_PREFIX = "codex-team-";
const DEFAULT_WINDOW_NAME = "teammates";
const SECRET_TOKEN_PATTERN = /SECRET_[A-Z0-9_]+/gi;

// Settle delay between delivering the bracketed-paste body and the lone carriage
// return that submits it. Keeps the CR clear of codex's 120ms paste-burst suppress
// window. Production uses a real synchronous sleep; tests inject a no-op.
const PANE_SUBMIT_SETTLE_MS = 400;

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
    },
    sendToPane(pane, command) {
      // Route by the pane's OWN backend_type, mirroring closePane: the teammate
      // pane being nudged was created under that backend, which may differ from
      // selectBackend() in an unusual terminal context.
      const target = pane.backend_type === "iterm2" ? iterm2 : tmux;
      if (!target.sendToPane) {
        return {
          ok: false,
          stdout: "",
          stderr: "send_unsupported",
          exit_code: 1
        };
      }
      return target.sendToPane(pane, command);
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
    },
    sendToPane(pane, command) {
      const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
      if (!paneId) {
        return { ok: false, stdout: "", stderr: "pane_id_missing", exit_code: 1 };
      }
      if (!command || command.length === 0) {
        return { ok: false, stdout: "", stderr: "empty_command", exit_code: 1 };
      }

      // `tmux send-keys -t <pane> <literal text> Enter` types the text into the
      // pane's foreground process (the codex TUI input) and submits it. send-keys
      // types literal characters, so the tokens are joined raw (sanitized only) —
      // NOT shell-quoted, which would type stray quotes into the TUI.
      const socketName = sanitizePaneText(pane.socket_name ?? "").trim();
      const text = command
        .map((token) => sanitizePaneText(token))
        .join(" ");
      const args = socketName
        ? ["-L", socketName, "send-keys", "-t", paneId, text, "Enter"]
        : ["send-keys", "-t", paneId, text, "Enter"];
      return commandRunner.run("tmux", args);
    }
  };
}

export function createITerm2PaneBackend(
  options: ITerm2PaneBackendOptions = {}
): PaneBackend {
  const commandRunner = options.commandRunner ?? createCommandRunner();
  const env = options.env ?? process.env;
  const sleep =
    options.sleep ??
    ((ms: number) => {
      if (ms > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      }
    });

  // NOTE (layout determinism): this backend keeps NO in-process layout state.
  // The anchor a new teammate splits off is derived from the durable DB and
  // passed in via context.previousTeammatePaneIds. The previous design tracked
  // teammateSessionIds/firstPaneUsed in a closure, but the backend is rebuilt on
  // every Agent tool call, so that closure reset each time and every teammate was
  // (wrongly) treated as the first — re-splitting the leader and stacking panes
  // horizontally. Sourcing anchors from the DB makes the layout survive re-instantiation.

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
      // teammate stacked vertically down the right. With NO prior teammate panes
      // the FIRST teammate splits the leader session vertically (`-v -s <leader>`,
      // via buildITerm2SplitArgs); when prior panes exist a SUBSEQUENT teammate
      // splits OFF the most recent one (no `-v`) so it stacks instead of
      // re-splitting the leader (the v1 bug where every teammate piled up
      // horizontally). `-s` targets the exact session so the layout is correct no
      // matter which pane the user last clicked.
      //
      // The anchor candidates come from context.previousTeammatePaneIds (DB-derived,
      // most-recent first) — NOT an in-process closure that resets on every Agent
      // tool call. `cursor` walks them.
      //
      // At-fault recovery: if a targeted teammate session is dead (user closed it),
      // `it2 session list` confirms death before we advance to the next candidate.
      // We never advance on a systemic it2 failure (Python API off, it2 gone,
      // transient socket error), which would mistake a live anchor for dead.
      // Bounded at O(N+1) iterations: each `continue` advances the cursor by one;
      // once every candidate is exhausted we fall back to the leader split once.
      const candidates = context.previousTeammatePaneIds ?? [];
      let cursor = 0;
      let fellBackToLeader = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let splitArgs: string[];
        let targetedTeammateId: string | undefined;
        if (fellBackToLeader || candidates.length === 0) {
          // No live candidate anchor (first teammate, or all prior panes dead):
          // split the leader vertically so the leader stays on the left.
          splitArgs = buildITerm2SplitArgs(env);
        } else {
          targetedTeammateId = candidates[cursor];
          splitArgs = targetedTeammateId
            ? ["session", "split", "-s", targetedTeammateId]
            : buildITerm2SplitArgs(env);
        }

        const splitResult = commandRunner.run("it2", splitArgs, { cwd });

        if (!splitResult.ok) {
          if (targetedTeammateId) {
            const { ok: listOk, ids } = listITerm2SessionIds(commandRunner);
            if (listOk && !ids.includes(targetedTeammateId)) {
              // Confirmed dead — advance to the next candidate; when the list is
              // exhausted, fall back to the leader split on the next iteration.
              cursor += 1;
              if (cursor >= candidates.length) {
                fellBackToLeader = true;
              }
              continue;
            }
            // Target alive or undeterminable — don't retry blindly; degrade below.
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

      // No closure layout state to prune: anchor candidates are derived fresh from
      // the durable DB on each createPane, and a closed pane is marked unavailable
      // there (markRunPaneClosed), so it is naturally excluded from future anchors.

      return {
        ok: result.ok,
        pane_id: paneId,
        reason: result.ok
          ? undefined
          : sanitizePaneText(result.stderr || "iterm2 session close failed")
      };
    },
    sendToPane(pane, command) {
      const paneId = sanitizePaneText(pane.pane_id ?? "").trim();
      if (!paneId) {
        return { ok: false, stdout: "", stderr: "pane_id_missing", exit_code: 1 };
      }
      if (!command || command.length === 0) {
        return { ok: false, stdout: "", stderr: "empty_command", exit_code: 1 };
      }

      // Deliver a message into the teammate's LIVE codex TUI composer and SUBMIT it.
      // Empirically the only reliable way (see research): wrap the body in an explicit
      // BRACKETED PASTE (ESC[200~ … ESC[201~) so codex treats it as a paste-insert
      // (never auto-submits) AND clears its paste-burst suppress window on the paste
      // end; THEN a separate lone carriage return submits cleanly. A single
      // `send "text\r"` is swallowed by codex's paste-burst heuristic and never
      // submits. The body is RAW (sanitizePaneText strips ESC/other control bytes so
      // it cannot break out of the paste or inject escapes); the ESC[200~/201~ markers
      // and the CR are added by us, outside the sanitized body.
      // The markers are the REAL bracketed-paste control bytes — ESC (0x1B, written
      // `\x1b`) followed by `[200~` / `[201~`, matching the empirically-PASS script's
      // `printf '\033[200~%s\033[201~'`. A literal `[200~` (no ESC) is NOT a paste
      // sequence and would just type those characters into the composer. sanitizePaneText
      // strips ESC/control bytes from the BODY, so only our markers carry ESC.
      const body = command.map((token) => sanitizePaneText(token)).join(" ");
      const paste = `\x1b[200~${body}\x1b[201~`;
      const pasted = commandRunner.run("it2", ["session", "send", "-s", paneId, paste]);
      if (!pasted.ok) {
        return pasted;
      }
      sleep(PANE_SUBMIT_SETTLE_MS);
      return commandRunner.run("it2", ["session", "send", "-s", paneId, "\r"]);
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

// Lists live iTerm2 session ids via the MACHINE-READABLE JSON form. The default
// `it2 session list` renders a WIDTH-TRUNCATED table (Session ID shown as e.g.
// `DD1441FC-0CE1-44…`), so matching a full session UUID against it ALWAYS fails —
// which made reconcile see every LIVE pane as dead and wrongly fail completed
// teammates. `--json` emits the full `id`. ok:false means the listing itself
// failed (it2 API off / unparseable) — i.e. liveness is UNDETERMINABLE, NOT
// "confirmed dead".
function listITerm2SessionIds(
  commandRunner: PaneBackendCommandRunner
): { ok: boolean; ids: string[] } {
  const result = commandRunner.run("it2", ["session", "list", "--json"]);
  if (!result.ok) {
    return { ok: false, ids: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: true, ids: [] };
    }
    const ids = parsed
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { id?: unknown }).id
          : undefined
      )
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    return { ok: true, ids };
  } catch {
    return { ok: false, ids: [] };
  }
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
  const { ok, ids } = listITerm2SessionIds(commandRunner);
  if (!ok) {
    return stalePaneResult("iterm2", "iterm2 session unavailable", pane);
  }
  if (
    (paneId && ids.includes(paneId)) ||
    (sessionName && ids.includes(sessionName))
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
