import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Locates the codex rollout transcript for a single run and extracts its
// session id. Groundwork for the "pane-as-executor" mode where a teammate's
// codex runs natively inside an iTerm2 pane (`codex exec` WITHOUT `--json`, so
// the pane shows codex's own UI). In native mode there is no JSON event stream
// to parse, but codex ALWAYS writes a full transcript to a rollout file at
// `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionUUID>.jsonl`. The
// FIRST line of that file is a `session_meta` record carrying the session id
// (`payload.id`) and the working directory (`payload.cwd`). Because each
// teammate's worktree path is unique, matching on `payload.cwd` deterministically
// pins a run's rollout even under concurrency.
//
// Privacy: this locator reads ONLY the first line of each candidate file (the
// `session_meta` record) — never the conversation transcript that follows. The
// injectable `RolloutFsLike` seam exposes no whole-file read, so the privacy
// contract is enforced structurally.
//
// Contract: best-effort and pure/injectable. It NEVER throws — any failure
// (missing directory, unreadable file, malformed JSON, absent fields) is
// swallowed and yields `null`.

// Maximum number of rollout files (newest first by mtime) to inspect. Keeps the
// scan bounded on machines with deep session histories.
const MAX_CANDIDATES = 50;

// Maximum directory depth to descend from the sessions root. The expected
// layout is `sessions/YYYY/MM/DD/<file>` (3 dir levels); extra headroom guards
// against unexpected nesting without risking runaway traversal.
const MAX_DEPTH = 6;

const ROLLOUT_PREFIX = "rollout-";
const ROLLOUT_SUFFIX = ".jsonl";

export interface RolloutStatLike {
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

// Minimal filesystem seam. Deliberately omits any whole-file read: only the
// first line of a rollout is ever needed, and exposing nothing more keeps the
// privacy contract impossible to violate from the call site.
export interface RolloutFsLike {
  readdirSync(dir: string): string[];
  statSync(target: string): RolloutStatLike;
  // Returns the first line (newline-delimited) of the file, or null if it
  // cannot be read. Implementations must not read the entire transcript.
  readFirstLine(target: string): string | null;
}

export interface RolloutLocateInput {
  // Absolute worktree path for the run; matched against `session_meta.payload.cwd`.
  workspaceCwd: string;
  // Only accept rollouts whose mtime is >= this value (filters stale sessions).
  notBeforeMs?: number;
  // Override the sessions root directory (testing). Defaults to
  // `<CODEX_HOME>/sessions`.
  sessionsRoot?: string;
  // Environment used to resolve CODEX_HOME. Defaults to `process.env`.
  env?: NodeJS.ProcessEnv;
  // Filesystem seam (testing). Defaults to a node:fs implementation.
  fs?: RolloutFsLike;
  // Clock seam. Defaults to `Date.now`.
  now?: () => number;
}

export interface RolloutLocateResult {
  session_id: string;
  rollout_path: string;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

interface SessionMeta {
  id: string;
  cwd: string;
}

export function locateRolloutSessionId(
  input: RolloutLocateInput
): RolloutLocateResult | null {
  try {
    const fs = input.fs ?? defaultRolloutFs;
    const now = input.now ?? Date.now;
    const env = input.env ?? process.env;

    const sessionsRoot = resolveSessionsRoot(input.sessionsRoot, env);
    const targetCwd = path.resolve(input.workspaceCwd);
    const nowMs = now();

    const candidates = collectRolloutFiles(fs, sessionsRoot);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let best: { result: RolloutLocateResult; mtimeMs: number } | null = null;

    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      // Reject future-dated rollouts (clock skew / corrupt mtime). Real codex
      // writes mtime <= wall clock, so this never drops legitimate data.
      if (candidate.mtimeMs > nowMs) {
        continue;
      }
      if (
        typeof input.notBeforeMs === "number" &&
        candidate.mtimeMs < input.notBeforeMs
      ) {
        continue;
      }

      const meta = readSessionMeta(fs, candidate.path);
      if (!meta) {
        continue;
      }
      if (path.resolve(meta.cwd) !== targetCwd) {
        continue;
      }

      if (!best || candidate.mtimeMs > best.mtimeMs) {
        best = {
          result: { session_id: meta.id, rollout_path: candidate.path },
          mtimeMs: candidate.mtimeMs
        };
      }
    }

    return best ? best.result : null;
  } catch {
    return null;
  }
}

function resolveSessionsRoot(
  override: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  const explicit = normalizeOptionalText(override);
  if (explicit) {
    return explicit;
  }

  const codexHome =
    normalizeOptionalText(env.CODEX_HOME) ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function collectRolloutFiles(
  fs: RolloutFsLike,
  root: string
): RolloutCandidate[] {
  const out: RolloutCandidate[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      break;
    }

    let names: string[];
    try {
      names = fs.readdirSync(entry.dir);
    } catch {
      // Directory missing / unreadable — skip it.
      continue;
    }

    for (const name of names) {
      const full = path.join(entry.dir, name);
      let stat: RolloutStatLike;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }

      try {
        if (stat.isDirectory()) {
          if (entry.depth < MAX_DEPTH) {
            stack.push({ dir: full, depth: entry.depth + 1 });
          }
        } else if (stat.isFile() && isRolloutFileName(name)) {
          out.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Defensive: malformed stat seam — skip.
        continue;
      }
    }
  }

  return out;
}

function isRolloutFileName(name: string): boolean {
  return name.startsWith(ROLLOUT_PREFIX) && name.endsWith(ROLLOUT_SUFFIX);
}

// Reads ONLY the first line of the rollout and validates it as a session_meta
// record. Returns the session id + cwd, or null on any problem.
function readSessionMeta(fs: RolloutFsLike, target: string): SessionMeta | null {
  try {
    const line = fs.readFirstLine(target);
    if (!line) {
      return null;
    }

    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session_meta") {
      return null;
    }

    const payload = parsed.payload;
    if (!isRecord(payload)) {
      return null;
    }

    const id = normalizeOptionalText(payload.id);
    const cwd = normalizeOptionalText(payload.cwd);
    if (!id || !cwd) {
      return null;
    }

    return { id, cwd };
  } catch {
    return null;
  }
}

const defaultRolloutFs: RolloutFsLike = {
  readdirSync(dir: string): string[] {
    return readdirSync(dir);
  },
  statSync(target: string): RolloutStatLike {
    return statSync(target);
  },
  readFirstLine(target: string): string | null {
    return defaultReadFirstLine(target);
  }
};

// Reads bytes up to the first newline (bounded) using a file descriptor, so the
// conversation transcript that follows is never loaded into memory.
function defaultReadFirstLine(target: string): string | null {
  const CHUNK_BYTES = 64 * 1024;
  const MAX_BYTES = 1024 * 1024; // 1 MiB safety cap for a pathological first line
  let fd: number | null = null;
  try {
    fd = openSync(target, "r");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let acc = "";
    let position = 0;

    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, CHUNK_BYTES, position);
      if (bytesRead <= 0) {
        break;
      }
      position += bytesRead;
      acc += buffer.toString("utf8", 0, bytesRead);

      const newlineIndex = acc.indexOf("\n");
      if (newlineIndex !== -1) {
        acc = acc.slice(0, newlineIndex);
        break;
      }
      if (position >= MAX_BYTES) {
        break;
      }
    }

    return acc.replace(/\r$/, "");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
