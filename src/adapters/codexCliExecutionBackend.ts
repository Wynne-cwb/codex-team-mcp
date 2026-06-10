import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ExecutionBackend,
  type ExecutionBackendActionResult,
  type ExecutionBackendDescription,
  type ExecutionBackendReconcileResult,
  type ExecutionRunContext,
  type ExecutionTrigger
} from "./execution.js";
import {
  createTerminalCommandRunner,
  type TerminalCommandRunner
} from "./terminalCommand.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  WORK_CLASSIFICATIONS
} from "../state/schema.js";

const BACKEND_NAME = "codex_cli_exec";
const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_TIMEOUT_MS = 180000;
// Bounded wait for the durable `thread.started` event ONLY — never the whole
// agentic task. Default ~15s, env-overridable. The detached process keeps
// running in the background after we return; reconcile captures completion.
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const START_TIMEOUT_ENV = "CODEX_TEAM_EXEC_START_TIMEOUT_MS";

// Per-run JSONL logs live on disk OUTSIDE the conversation transcript, under the
// leader workspace (sibling of the .codex-team state dir). The detached codex
// process redirects stdout+stderr here; reconcile + diagnostics read it back.
const RUNS_LOG_SUBDIR = path.join(".codex-team", "runs");

// Sentinel payloads only when no real prompt is present — never echoes prompts,
// message bodies, or task text into stored results (D-02).
const START_SENTINEL = "printf codex-team-cli-exec-start";
const RESUME_SENTINEL = "printf codex-team-cli-exec-resume";

const UNAVAILABLE_LIMITATION =
  "codex_cli_exec backend unavailable: enable CODEX_TEAM_EXECUTION and ensure `codex` is on PATH (codex exec --help should exit 0).";
const SESSION_METADATA_UNAVAILABLE = "codex_session_metadata_unavailable";
const EXEC_FAILED = "codex_exec_failed";
const EXEC_RESUME_FAILED = "codex_exec_resume_failed";
// Diagnosable prefixes for surfaced codex error events (D-02-safe: short,
// sanitized, never carries prompt/message/task text — only codex's own reason).
const EXEC_TURN_FAILED_PREFIX = "codex_exec_turn_failed";
const EXEC_RESUME_TURN_FAILED_PREFIX = "codex_exec_resume_turn_failed";
// Crash signal: the detached process exited before emitting a terminal event.
const EXEC_PROCESS_EXITED_PREFIX = "codex_exec_process_exited_without_completion";

type SandboxMode = "read-only" | "workspace-write";

// Injectable process seam (testability): the default impl spawns a real detached
// `codex exec` process with stdout+stderr redirected to a log file; tests inject
// a fake that simulates a pid + a controllable log file + a liveness flag, so no
// real `codex` binary is ever spawned and there are no real long sleeps.
export interface DetachedSpawnRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** File the detached process redirects stdout+stderr into (truncated on spawn). */
  logPath: string;
}

export interface DetachedProcessHandle {
  pid: number | undefined;
}

export interface ProcessSpawner {
  spawnDetached(request: DetachedSpawnRequest): DetachedProcessHandle;
  isAlive(pid: number): boolean;
}

export interface CodexCliExecutionBackendOptions {
  runner?: TerminalCommandRunner;
  codexCommand?: string;
  timeoutMs?: number;
  // Detached-execution seam + tunables (all optional, defaulted).
  spawner?: ProcessSpawner;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  // Injectable sync sleep + clock so tests drive the bounded wait deterministically
  // (no real sleeps). Default sleep uses Atomics.wait on a SharedArrayBuffer.
  sleep?: (ms: number) => void;
  now?: () => number;
  // Explicit log directory override (tests / threaded state root). When absent the
  // dir is derived from the run context's workspace_root.
  logDir?: string;
}

/**
 * Real Phase-8-selected backend: launches/resumes `codex exec --json` DETACHED in
 * a caller-specified worktree (`--cd`), waits ONLY for the durable
 * `thread.started` thread_id (bounded, ~15s), and returns FAST with the run still
 * executing in the background. The full agentic task runs to completion under a
 * per-run JSONL log file; `reconcileRun` later reads that log + checks process
 * liveness to finalize the run (idle / failed) and surface the deliverable.
 *
 * It returns LIFECYCLE-ONLY results (ids/status/timestamps/sanitized error class),
 * never stores raw output text (D-02), and never invents a session id (resume is
 * lawful only with a real discovered thread_id).
 *
 * A `TerminalCommandRunner` is injected for the synchronous `codex exec --help`
 * availability probe; a `ProcessSpawner` is injected for the detached run so tests
 * exercise the contract with a fake executor and no real `codex` binary.
 */
export class CodexCliExecutionBackend implements ExecutionBackend {
  private readonly runner: TerminalCommandRunner;
  private readonly codexCommand: string;
  private readonly timeoutMs: number;
  private readonly spawner: ProcessSpawner;
  private readonly startTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => void;
  private readonly now: () => number;
  private readonly logDir: string | null;
  private availabilityCache: boolean | null = null;

  constructor(options: CodexCliExecutionBackendOptions = {}) {
    this.runner = options.runner ?? createTerminalCommandRunner();
    this.codexCommand =
      normalizeOptionalText(options.codexCommand) ?? DEFAULT_CODEX_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawner = options.spawner ?? createDefaultProcessSpawner();
    this.startTimeoutMs = options.startTimeoutMs ?? resolveStartTimeoutMs();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? atomicsSleep;
    this.now = options.now ?? Date.now;
    this.logDir = normalizeOptionalText(options.logDir);
  }

  describeBackend(): ExecutionBackendDescription {
    if (!this.detectAvailability()) {
      return {
        status: "unavailable",
        teammateExecutionImplemented: false,
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        capabilities: {
          canStart: false,
          canResume: false,
          canReconcile: false,
          supportsWorkspaces: false,
          supportsOsSandbox: false
        },
        limitation: UNAVAILABLE_LIMITATION
      };
    }

    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true,
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    if (!this.detectAvailability()) {
      return this.unavailableActionResult();
    }

    const mode = sandboxModeForClassification(context.work_classification);
    const workspacePath = normalizeOptionalText(context.workspace_path);
    const prompt = promptFromContext(context);
    const args = [
      "exec",
      "-s",
      mode,
      "--json",
      "--skip-git-repo-check",
      ...(workspacePath ? ["--cd", workspacePath] : []),
      prompt
    ];

    const logPath = this.logPathForContext(context);
    const startedAt = new Date().toISOString();
    let handle: DetachedProcessHandle;
    try {
      handle = this.spawner.spawnDetached({
        command: this.codexCommand,
        args,
        cwd: workspacePath ?? undefined,
        env: { ...process.env, TERM: "dumb" },
        logPath
      });
    } catch (error) {
      return this.failedActionResult(
        sanitizeText(errorToMessage(error)) ?? EXEC_FAILED
      );
    }

    // Bounded wait for `thread.started` ONLY (usually <5s) — never the whole task.
    // Honest degradation: if no thread_id appears in the window, return started
    // WITHOUT a fabricated id; reconcile captures it later from the same log.
    const threadId = this.waitForThreadStarted(logPath);
    const branch = optionalMetadataString(context.metadata, "worktree_branch");

    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: threadId ?? undefined,
      thread_id: threadId ?? undefined,
      process_id: pidToString(handle.pid),
      workspace_path: workspacePath ?? undefined,
      started_at: startedAt,
      metadata: cleanMetadata({
        sandbox_mode: mode,
        worktree_branch: branch ?? undefined,
        exec_log_path: logPath
      })
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    _trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    if (!this.detectAvailability()) {
      return this.unavailableActionResult();
    }

    const threadId = durableThreadIdFromContext(context);
    if (!threadId) {
      // Never invent session metadata.
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        last_error: SESSION_METADATA_UNAVAILABLE
      };
    }

    const mode = sandboxModeForClassification(context.work_classification);
    const workspacePath = normalizeOptionalText(context.workspace_path);
    // `codex exec resume` exposes no -s/--sandbox flag; enforce the sandbox via
    // the equivalent `-c sandbox_mode="..."` config override (08-01 evidence).
    const args = [
      "exec",
      "resume",
      "-c",
      `sandbox_mode="${mode}"`,
      "--json",
      threadId,
      RESUME_SENTINEL
    ];

    const logPath = this.logPathForContext(context);
    const startedAt = new Date().toISOString();
    let handle: DetachedProcessHandle;
    try {
      handle = this.spawner.spawnDetached({
        command: this.codexCommand,
        args,
        cwd: workspacePath ?? undefined,
        env: { ...process.env, TERM: "dumb" },
        logPath
      });
    } catch (error) {
      return this.failedActionResult(
        sanitizeText(errorToMessage(error)) ?? EXEC_RESUME_FAILED
      );
    }

    // Resume re-runs into the SAME thread; the resumed turn may re-announce
    // thread.started. Wait briefly, otherwise keep the durable id (never fabricate).
    const resumedThreadId = this.waitForThreadStarted(logPath) ?? threadId;

    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: resumedThreadId,
      thread_id: resumedThreadId,
      process_id: pidToString(handle.pid),
      workspace_path: workspacePath ?? undefined,
      started_at: startedAt,
      metadata: cleanMetadata({
        sandbox_mode: mode,
        exec_log_path: logPath
      })
    };
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    // Log-based reconcile: read the per-run JSONL log + check process liveness.
    // Never invent ids; never echo output text (D-02 — only a sanitized class).
    const logPath = this.resolveReconcileLogPath(context);
    const logContent = readLogSafe(logPath);
    const workspacePath = normalizeOptionalText(context.workspace_path) ?? undefined;
    const storedThreadId = durableThreadIdFromContext(context);
    // Capture the thread_id from the log if it was not durably stored yet
    // (start returned before thread.started appeared) — honest, never fabricated.
    const threadId =
      storedThreadId ??
      extractThreadStartedId(logContent) ??
      extractThreadId(logContent) ??
      undefined;
    const pid = pidFromContext(context);

    // Terminal failure wins: codex wrote a turn.failed / error event.
    const codexError = extractCodexError(logContent);
    if (codexError) {
      return {
        status: "failed",
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.failed,
        backend_run_id: threadId,
        thread_id: threadId,
        process_id: pid !== null ? String(pid) : undefined,
        workspace_path: workspacePath,
        ended_at: new Date().toISOString(),
        last_error: `${EXEC_TURN_FAILED_PREFIX}: ${sanitizeText(codexError)}`
      };
    }

    // Completed turn: the task ran to completion in the background.
    if (hasTurnCompleted(logContent)) {
      return {
        status: "idle",
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.idle,
        backend_run_id: threadId,
        thread_id: threadId,
        process_id: pid !== null ? String(pid) : undefined,
        workspace_path: workspacePath,
        ended_at: new Date().toISOString()
      };
    }

    // No terminal event yet — distinguish "still running" from "crashed" via pid.
    if (pid !== null && this.spawner.isAlive(pid)) {
      return {
        status: "active",
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.running,
        backend_run_id: threadId,
        thread_id: threadId,
        process_id: String(pid),
        workspace_path: workspacePath
      };
    }

    if (pid !== null) {
      // pid is dead and no terminal event was ever written → crash.
      return {
        status: "failed",
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.failed,
        backend_run_id: threadId,
        thread_id: threadId,
        process_id: String(pid),
        workspace_path: workspacePath,
        ended_at: new Date().toISOString(),
        last_error: EXEC_PROCESS_EXITED_PREFIX
      };
    }

    // No pid to check and no terminal event — cannot confirm; honest unknown.
    return {
      status: "unknown",
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.unknown,
      backend_run_id: threadId,
      thread_id: threadId,
      workspace_path: workspacePath
    };
  }

  private detectAvailability(): boolean {
    if (this.availabilityCache !== null) {
      return this.availabilityCache;
    }

    let available = false;
    try {
      const result = this.runner.run(this.codexCommand, ["exec", "--help"], {
        timeoutMs: this.timeoutMs,
        env: { ...process.env, TERM: "dumb" }
      });
      if (!isPromise(result)) {
        available = result.exitCode === 0;
      }
    } catch {
      available = false;
    }

    this.availabilityCache = available;
    return available;
  }

  // Bounded synchronous poll of the log file for a `thread.started` thread_id.
  // Blocks the event loop ONLY for the (short) thread.started window — never the
  // full task. Uses the injected sync sleep between polls.
  private waitForThreadStarted(logPath: string): string | null {
    const deadline = this.now() + this.startTimeoutMs;
    let threadId = extractThreadStartedId(readLogSafe(logPath));
    while (!threadId && this.now() < deadline) {
      this.sleep(this.pollIntervalMs);
      threadId = extractThreadStartedId(readLogSafe(logPath));
    }
    return threadId;
  }

  private logPathForContext(context: ExecutionRunContext): string {
    return codexExecLogPath(context.workspace_root, context.run_id, this.logDir);
  }

  private resolveReconcileLogPath(context: ExecutionRunContext): string {
    // Prefer the path durably persisted at start (exact write location), then fall
    // back to deterministic reconstruction from workspace_root + run_id (immune to
    // metadata sanitization stripping the path value).
    return (
      persistedLogPathFromContext(context) ?? this.logPathForContext(context)
    );
  }

  private unavailableActionResult(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: UNAVAILABLE_LIMITATION
    };
  }

  private failedActionResult(reason: string): ExecutionBackendActionResult {
    return {
      status: "backend_failed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.failed,
      last_error: normalizeOptionalText(reason) ?? EXEC_FAILED
    };
  }
}

// Default real spawner: detached process with stdout+stderr redirected to a log
// file via fds (NOT pipes that keep the parent alive); child.unref() so the
// parent never blocks on the child. Liveness via signal-0 probe.
export function createDefaultProcessSpawner(): ProcessSpawner {
  return {
    spawnDetached(request: DetachedSpawnRequest): DetachedProcessHandle {
      mkdirSync(path.dirname(request.logPath), { recursive: true });
      // Truncate/create so the per-run log only ever holds the CURRENT turn's
      // events (start or the latest resume) — reconcile reflects the live turn.
      const fd = openSync(request.logPath, "w");
      try {
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          detached: true,
          stdio: ["ignore", fd, fd],
          windowsHide: true
        });
        child.unref();
        return { pid: child.pid };
      } finally {
        // The child holds its own dup of the fd; the parent can close its copy.
        closeSync(fd);
      }
    },
    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM => the process exists but is not ours (still "alive").
        return (error as NodeJS.ErrnoException)?.code === "EPERM";
      }
    }
  };
}

// ── Log-path helpers (shared with diagnostics so the convention is single-source) ──

const codexExecLogFileName = (runId: string): string => {
  const safe = String(runId).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe.length > 0 ? safe : "run"}.jsonl`;
};

export function codexExecLogDirForWorkspace(
  workspaceRoot: string | null | undefined,
  override?: string | null
): string {
  const explicit = normalizeOptionalText(override);
  if (explicit) {
    return explicit;
  }
  const workspace = normalizeOptionalText(workspaceRoot);
  if (workspace) {
    return path.join(workspace, RUNS_LOG_SUBDIR);
  }
  return path.join(os.tmpdir(), "codex-team-runs");
}

export function codexExecLogPath(
  workspaceRoot: string | null | undefined,
  runId: string,
  override?: string | null
): string {
  return path.join(
    codexExecLogDirForWorkspace(workspaceRoot, override),
    codexExecLogFileName(runId)
  );
}

function persistedLogPathFromContext(
  context: ExecutionRunContext
): string | null {
  return (
    stringFromMetadata(context.metadata, "exec_log_path") ??
    stringFromNestedMetadata(context.metadata, "backend_metadata", "exec_log_path")
  );
}

function readLogSafe(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function resolveStartTimeoutMs(): number {
  const raw = process.env[START_TIMEOUT_ENV];
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_START_TIMEOUT_MS;
}

// Synchronous sleep that blocks only the calling turn briefly. Atomics.wait on a
// never-notified SharedArrayBuffer slot waits out the full timeout.
function atomicsSleep(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function sandboxModeForClassification(
  classification: string | null | undefined
): SandboxMode {
  if (
    classification === WORK_CLASSIFICATIONS.codeImplementation ||
    classification === WORK_CLASSIFICATIONS.artifactWriting
  ) {
    return "workspace-write";
  }

  return "read-only";
}

function promptFromContext(context: ExecutionRunContext): string {
  return optionalMetadataString(context.metadata, "prompt") ?? START_SENTINEL;
}

// Tolerant thread_id parse (08-01 spike): codex exec --json interleaves non-JSON
// warning lines with JSONL events. Skip non-`{` lines, JSON.parse, read
// thread_id / thread.thread_id; regex fallback as a last resort.
export function extractThreadId(stdout: string): string | null {
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        thread_id?: unknown;
        thread?: { thread_id?: unknown };
      };
      const id = event.thread_id ?? event.thread?.thread_id;
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

// Specifically the durable `thread.started` thread_id (the event the bounded
// start wait blocks on). Falls back to extractThreadId for tolerant capture.
export function extractThreadStartedId(stdout: string): string | null {
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        thread_id?: unknown;
        thread?: { thread_id?: unknown };
      };
      if (event.type === "thread.started") {
        const id = event.thread_id ?? event.thread?.thread_id;
        if (typeof id === "string" && id.length > 0) {
          return id;
        }
      }
    } catch {
      // ignore non-JSON / partial lines
    }
  }

  return null;
}

// True once codex emits a `turn.completed` event for the current turn.
export function hasTurnCompleted(stdout: string): boolean {
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as { type?: unknown };
      if (event.type === "turn.completed") {
        return true;
      }
    } catch {
      // ignore non-JSON / partial lines
    }
  }

  return false;
}

// Tolerant codex error parse: `codex exec --json` writes the durable failure
// reason as JSONL events on STDOUT (stderr only carries benign noise like
// "Reading additional input from stdin..."). Scan the same way as
// extractThreadId and return the LAST error message from either shape:
//   {"type":"error","message":"..."}              -> message
//   {"type":"turn.failed","error":{"message":...}} -> error.message
// Returns null if no error event is present.
export function extractCodexError(stdout: string): string | null {
  let lastMessage: string | null = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        message?: unknown;
        error?: { message?: unknown } | null;
      };
      if (event.type === "error" && typeof event.message === "string" && event.message.length > 0) {
        lastMessage = event.message;
      } else if (
        event.type === "turn.failed" &&
        isRecord(event.error) &&
        typeof event.error.message === "string" &&
        event.error.message.length > 0
      ) {
        lastMessage = event.error.message;
      }
    } catch {
      // ignore non-JSON / partial lines
    }
  }

  return lastMessage;
}

// Deliverable capture: the agent's final output text lives in
// {"type":"item.completed","item":{"type":"agent_message","text":…}} events.
// Concatenate every agent_message (in order) so a multi-message deliverable is
// not truncated. Returns the RAW text; the surface (TeamDiagnostics) sanitizes
// and bounds it. Returns null when no agent_message is present.
export function extractCodexDeliverable(stdout: string): string | null {
  const texts: string[] = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        item?: { type?: unknown; text?: unknown } | null;
      };
      if (
        event.type === "item.completed" &&
        isRecord(event.item) &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string" &&
        event.item.text.length > 0
      ) {
        texts.push(event.item.text);
      }
    } catch {
      // ignore non-JSON / partial lines
    }
  }

  return texts.length > 0 ? texts.join("\n\n") : null;
}

function durableThreadIdFromContext(
  context: ExecutionRunContext
): string | null {
  return (
    stringFromMetadata(context.metadata, "backend_thread_id") ??
    stringFromMetadata(context.metadata, "thread_id") ??
    stringFromMetadata(context.metadata, "backend_run_id") ??
    stringFromNestedMetadata(context.metadata, "backend_metadata", "thread_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_thread_id"
    )
  );
}

function pidFromContext(context: ExecutionRunContext): number | null {
  const raw =
    stringFromMetadata(context.metadata, "backend_process_id") ??
    stringFromMetadata(context.metadata, "process_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_process_id"
    );
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!metadata) {
    return null;
  }

  return normalizeOptionalText(metadata[key]);
}

function stringFromNestedMetadata(
  metadata: Record<string, unknown> | undefined,
  containerKey: string,
  key: string
): string | null {
  if (!metadata || !isRecord(metadata[containerKey])) {
    return null;
  }

  return normalizeOptionalText((metadata[containerKey] as Record<string, unknown>)[key]);
}

function optionalMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  return stringFromMetadata(metadata, key);
}

function pidToString(pid: number | undefined): string | undefined {
  return typeof pid === "number" && Number.isFinite(pid) ? String(pid) : undefined;
}

function cleanMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  );
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).then === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
