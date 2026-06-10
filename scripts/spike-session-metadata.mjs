#!/usr/bin/env node
// Phase 8 spike runner: codex-session-metadata-spike
//
// Bounded, read-only, sanitized probe of the six candidate Codex execution
// surfaces (codex CLI exec/resume, MCP, app-server, SDK, tmux, iTerm2). It
// records, per surface, whether the surface exposes durable session/thread/run
// metadata, whether it is worktree-runnable (gate (1)), whether it exposes a
// persistent id usable for resume (gate (2)), and — separately and never as a
// gate — whether it supports an optional OS sandbox (D-06 bonus).
//
// Safety rules (D-05):
//   - All child processes are launched with node:child_process spawnSync using
//     ARGUMENT ARRAYS only. No value is ever interpolated into a shell string.
//   - stdin is detached (stdio "ignore") so no interactive TUI can block.
//   - Every probe has a bounded timeout; help probes are short, the single live
//     read-only `codex exec` turn has its own larger (still bounded) timeout.
//   - The live turns enforce read-only EXPLICITLY (defense-in-depth alignment
//     with D-05), not just via the maintainer's config default: the start probe
//     passes `-s read-only`, and the resume probe — `codex exec resume` exposes
//     no `-s/--sandbox` flag — passes the equivalent `-c sandbox_mode="read-only"`
//     config override.
//   - Payloads are sentinel `printf codex-session-metadata-spike-<surface>`
//     strings only — never prompts, message bodies, or task text.
//   - All captured stdout/stderr is sanitized (SECRET_* + control chars
//     stripped) before anything is printed; raw transcript scrollback is never
//     echoed.
//
// The script exits 0 on a successful probe run even when some surfaces are
// unavailable: availability is data, not a failure.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HELP_TIMEOUT_MS = clampInt(process.env.CODEX_SPIKE_HELP_TIMEOUT_MS, 8000, 1000, 60000);
const EXEC_TIMEOUT_MS = clampInt(process.env.CODEX_SPIKE_EXEC_TIMEOUT_MS, 180000, 5000, 600000);
const LIVE_ENABLED = parseLiveFlag(process.env.CODEX_SPIKE_LIVE);
const CODEX_BIN = optionalText(process.env.CODEX_TEAM_CODEX_COMMAND) ?? "codex";

const SENTINEL_PREFIX = "codex-session-metadata-spike";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// --- sanitization (mirrors src/adapters/paneExecutionBackend.ts sanitizeText) -

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function maskId(value) {
  // Record presence + format of a discovered id WITHOUT persisting the raw id.
  const cleaned = sanitizeText(String(value ?? "")).trim();
  if (!cleaned) {
    return null;
  }
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidLike.test(cleaned) ? "uuid (redacted)" : "opaque (redacted)";
}

// --- bounded child-process helpers (argument arrays only) ---------------------

function runProbe(bin, args, timeoutMs) {
  try {
    const result = spawnSync(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf8",
      env: { ...process.env, TERM: "dumb" }
    });
    const timedOut = result.error && result.error.code === "ETIMEDOUT";
    const missing =
      result.error && (result.error.code === "ENOENT" || result.error.code === "EACCES");
    return {
      ran: !missing,
      missing: Boolean(missing),
      timedOut: Boolean(timedOut),
      status: typeof result.status === "number" ? result.status : null,
      stdout: sanitizeText(result.stdout ?? ""),
      stderr: sanitizeText(result.stderr ?? "")
    };
  } catch {
    return { ran: false, missing: true, timedOut: false, status: null, stdout: "", stderr: "" };
  }
}

function helpExitsZero(bin, args) {
  const probe = runProbe(bin, args, HELP_TIMEOUT_MS);
  return { available: probe.ran && probe.status === 0, probe };
}

function helpMentions(probe, ...needles) {
  const haystack = `${probe.stdout}\n${probe.stderr}`;
  return needles.some((needle) => haystack.includes(needle));
}

// --- per-surface probes -------------------------------------------------------

function probeCodexCliExec() {
  const help = helpExitsZero(CODEX_BIN, ["exec", "--help"]);
  const resumeHelp = helpExitsZero(CODEX_BIN, ["exec", "resume", "--help"]);
  const sandboxHelp = helpExitsZero(CODEX_BIN, ["sandbox", "--help"]);

  const worktreeRunnable =
    help.available && helpMentions(help.probe, "--cd") ? "yes" : help.available ? "unknown" : "no";
  const osSandboxBonus =
    (help.available && helpMentions(help.probe, "--sandbox")) || sandboxHelp.available
      ? "yes"
      : "no";

  let persistentId = "unknown";
  const durableIdKeys = [];
  const notes = [];

  if (!help.available) {
    return record("codex_cli_exec", {
      availability: "unavailable",
      durable_id_keys: [],
      worktree_runnable: "no",
      persistent_id: "no",
      os_sandbox_bonus: osSandboxBonus,
      notes: "codex exec --help did not exit 0; CLI exec surface unavailable here."
    });
  }

  notes.push("codex exec --help exit 0; resume subcommand documented.");
  if (resumeHelp.available) {
    notes.push("codex exec resume --help documents [SESSION_ID] (UUID or thread name).");
  }

  if (LIVE_ENABLED) {
    const start = runProbe(
      CODEX_BIN,
      // `-s read-only` enforces the read-only sandbox explicitly (D-05), instead
      // of relying on the maintainer's codex config default.
      ["exec", "-s", "read-only", "--json", "--skip-git-repo-check", `printf ${SENTINEL_PREFIX}-cli`],
      EXEC_TIMEOUT_MS
    );
    const startThreadId = extractThreadId(start.stdout);
    if (start.timedOut) {
      notes.push("live codex exec --json probe timed out within the bounded window.");
    } else if (start.status === 0 && startThreadId) {
      durableIdKeys.push("thread_id");
      notes.push(`live codex exec --json emitted thread.started thread_id (${maskId(startThreadId)}).`);
      const resume = runProbe(
        CODEX_BIN,
        // `codex exec resume` exposes no `-s/--sandbox` flag; enforce read-only
        // via the equivalent `-c sandbox_mode="read-only"` config override (D-05).
        [
          "exec",
          "resume",
          "-c",
          'sandbox_mode="read-only"',
          "--json",
          startThreadId,
          `printf ${SENTINEL_PREFIX}-cli-resume`
        ],
        EXEC_TIMEOUT_MS
      );
      const resumeThreadId = extractThreadId(resume.stdout);
      if (resume.status === 0 && resumeThreadId === startThreadId) {
        persistentId = "yes";
        notes.push("codex exec resume --json <thread_id> re-emitted the same thread_id.");
      } else if (resume.timedOut) {
        persistentId = "unknown";
        notes.push("live resume probe timed out; durable thread_id observed at start.");
      } else {
        persistentId = "unknown";
        notes.push("resume probe did not re-emit the same thread_id within the bounded window.");
      }
    } else {
      notes.push("live codex exec --json probe did not yield a thread_id within the bounded window.");
    }
  } else {
    notes.push("live exec probe skipped (CODEX_SPIKE_LIVE=0); persistent_id left unknown.");
  }

  return record("codex_cli_exec", {
    availability: "available",
    durable_id_keys: durableIdKeys,
    worktree_runnable: worktreeRunnable,
    persistent_id: persistentId,
    os_sandbox_bonus: osSandboxBonus,
    notes: notes.join(" ")
  });
}

function probeMcp() {
  const mcp = helpExitsZero(CODEX_BIN, ["mcp", "--help"]);
  const mcpServer = helpExitsZero(CODEX_BIN, ["mcp-server", "--help"]);
  const available = mcp.available || mcpServer.available;

  // Do NOT run a write turn or leave a server running. Help only documents a
  // generic -c config override; no per-session workspace/cwd argument and no
  // resumable conversation id is advertised on the help surface.
  const advertisesWorkspaceArg =
    mcpServer.available && helpMentions(mcpServer.probe, "--cd", "cwd", "workspace");

  return record("mcp", {
    availability: available ? "available" : "unavailable",
    durable_id_keys: [],
    worktree_runnable: advertisesWorkspaceArg ? "yes" : "unknown",
    persistent_id: "unknown",
    os_sandbox_bonus: mcpServer.available && helpMentions(mcpServer.probe, "sandbox") ? "yes" : "n/a",
    notes:
      "codex mcp manages external MCP servers; codex mcp-server starts Codex over stdio. " +
      "Help advertises no per-session workspace arg or resumable conversation id; not probed with a write turn."
  });
}

function probeAppServer() {
  const appServer = helpExitsZero(CODEX_BIN, ["app-server", "--help"]);
  const remoteControl = helpExitsZero(CODEX_BIN, ["remote-control", "--help"]);
  const available = appServer.available || remoteControl.available;

  return record("app_server", {
    availability: available ? "available" : "unavailable",
    durable_id_keys: [],
    worktree_runnable: "unknown",
    persistent_id: "unknown",
    os_sandbox_bonus: "unknown",
    notes:
      "app-server and remote-control are marked [experimental]; daemon left unstarted (bounded, no-daemon). " +
      "Durable session ids + per-session workspace not confirmed without starting a daemon; stability risk noted."
  });
}

function probeSdk() {
  const present =
    existsSync(join(packageRoot, "node_modules", "@openai", "codex-sdk")) ||
    existsSync(join(packageRoot, "node_modules", "@openai", "codex"));
  return record("sdk", {
    availability: present ? "available" : "not_available",
    durable_id_keys: [],
    worktree_runnable: present ? "unknown" : "n/a",
    persistent_id: present ? "unknown" : "n/a",
    os_sandbox_bonus: "n/a",
    notes: present
      ? "A Codex SDK package was detected in node_modules; surface not exercised in Phase 8 (no runtime dependency added)."
      : "No @openai/codex-sdk in node_modules; recorded as not_available (honest), which is NOT a gate failure for the chain."
  });
}

function probeTmux() {
  const version = helpExitsZero("tmux", ["-V"]);
  const inTmux = Boolean(optionalText(process.env.TMUX)) || Boolean(optionalText(process.env.TMUX_PANE));
  const durableIdKeys = version.available ? ["pane_id", "session_name", "socket_name"] : [];
  return record("tmux", {
    availability: version.available ? "available" : "unavailable",
    durable_id_keys: durableIdKeys,
    worktree_runnable: version.available ? "yes" : "no",
    persistent_id: "no",
    os_sandbox_bonus: "n/a",
    notes:
      `tmux -V ${version.available ? "exit 0" : "unavailable"}; ` +
      `inside tmux: ${inTmux ? "yes" : "no"}. ` +
      "Visibility/attach transport only: exposes terminal pane/session ids, NOT a durable Codex session id. " +
      "Composes over a real Codex runner (e.g. codex exec); not a standalone qualifying backend."
  });
}

function probeIterm2() {
  const version = helpExitsZero("it2", ["--version"]);
  const isIterm = optionalText(process.env.TERM_PROGRAM) === "iTerm.app" || Boolean(optionalText(process.env.ITERM_SESSION_ID));
  const durableIdKeys = version.available ? ["pane_id", "session_name"] : [];
  return record("iterm2", {
    availability: version.available ? "available" : "unavailable",
    durable_id_keys: durableIdKeys,
    worktree_runnable: version.available ? "yes" : "no",
    persistent_id: "no",
    os_sandbox_bonus: "n/a",
    notes:
      `it2 --version ${version.available ? "exit 0" : "unavailable"}; ` +
      `iTerm2 environment: ${isIterm ? "yes" : "no"}. macOS-only. ` +
      "Visibility/attach transport only: terminal ids, NOT a durable Codex session id. Composes over a Codex runner."
  });
}

// --- helpers ------------------------------------------------------------------

function extractThreadId(stdout) {
  // codex exec --json interleaves warning lines with JSONL events; tolerate
  // non-JSON lines and extract thread.started thread_id robustly.
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed);
      const id = event?.thread_id ?? event?.thread?.thread_id;
      if (typeof id === "string" && id.length > 0) {
        return id;
      }
    } catch {
      // ignore non-JSON / partial lines
    }
  }
  const match = String(stdout).match(/"thread_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function record(surface, fields) {
  const worktree_runnable = fields.worktree_runnable;
  const persistent_id = fields.persistent_id;
  // qualifies is computed ONLY from the two lowered-gate items. os_sandbox_bonus
  // is recorded separately and NEVER affects this value (D-06).
  const qualifies = worktree_runnable === "yes" && persistent_id === "yes" ? "yes" : "no";
  return {
    surface,
    availability: fields.availability,
    durable_id_keys: fields.durable_id_keys,
    worktree_runnable,
    persistent_id,
    os_sandbox_bonus: fields.os_sandbox_bonus,
    qualifies,
    notes: sanitizeText(fields.notes)
  };
}

function rankQualifiers(surfaces) {
  // Ranking criteria (only applied to qualifiers): id quality > worktree
  // robustness > availability > OS-sandbox bonus tiebreak. tmux/iTerm2 are
  // transports and never rank as standalone runners.
  const order = ["codex_cli_exec", "mcp", "app_server", "sdk"];
  return surfaces
    .filter((entry) => entry.qualifies === "yes")
    .sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseLiveFlag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") {
    return false;
  }
  return true;
}

function optionalText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : undefined;
}

// --- main ---------------------------------------------------------------------

const surfaces = [
  probeCodexCliExec(),
  probeMcp(),
  probeAppServer(),
  probeSdk(),
  probeTmux(),
  probeIterm2()
];

const qualifiers = rankQualifiers(surfaces);
const convergedBackend = qualifiers.length > 0 ? qualifiers[0].surface : null;
const escalateToTeamLead = qualifiers.length === 0;

const codexVersionProbe = runProbe(CODEX_BIN, ["--version"], HELP_TIMEOUT_MS);
const codexVersion = codexVersionProbe.status === 0 ? codexVersionProbe.stdout.trim() : "unknown";

const summary = {
  spike: SENTINEL_PREFIX,
  codex_version: codexVersion,
  live_exec_enabled: LIVE_ENABLED,
  lowered_gate: "worktree_runnable === yes && persistent_id === yes (OS sandbox excluded)",
  surfaces,
  converged_backend: convergedBackend,
  escalate_to_team_lead: escalateToTeamLead,
  ranked_qualifiers: qualifiers.map((entry, index) => ({ rank: index + 1, surface: entry.surface }))
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(0);
