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
  type TerminalCommandResult,
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

// Sentinel payloads only when no real prompt is present — never echoes prompts,
// message bodies, or task text into stored results (D-02).
const START_SENTINEL = "printf codex-team-cli-exec-start";
const RESUME_SENTINEL = "printf codex-team-cli-exec-resume";

const UNAVAILABLE_LIMITATION =
  "codex_cli_exec backend unavailable: enable CODEX_TEAM_EXECUTION and ensure `codex` is on PATH (codex exec --help should exit 0).";
const SESSION_METADATA_UNAVAILABLE = "codex_session_metadata_unavailable";
const EXEC_FAILED = "codex_exec_failed";
const EXEC_RESUME_FAILED = "codex_exec_resume_failed";

type SandboxMode = "read-only" | "workspace-write";

export interface CodexCliExecutionBackendOptions {
  runner?: TerminalCommandRunner;
  codexCommand?: string;
  timeoutMs?: number;
}

/**
 * Real Phase-8-selected backend: launches/resumes `codex exec --json` in a
 * caller-specified worktree (`--cd`), captures the durable `thread.started`
 * thread_id, and returns LIFECYCLE-ONLY results (ids/status/timestamps/sanitized
 * error class). It never stores raw output text (D-02) and never invents a
 * session id (resume is lawful only with a real discovered thread_id).
 *
 * A `TerminalCommandRunner` is injected so tests exercise the contract with a
 * fake executor and no real `codex` binary.
 */
export class CodexCliExecutionBackend implements ExecutionBackend {
  private readonly runner: TerminalCommandRunner;
  private readonly codexCommand: string;
  private readonly timeoutMs: number;
  private availabilityCache: boolean | null = null;

  constructor(options: CodexCliExecutionBackendOptions = {}) {
    this.runner = options.runner ?? createTerminalCommandRunner();
    this.codexCommand =
      normalizeOptionalText(options.codexCommand) ?? DEFAULT_CODEX_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    const startedAt = new Date().toISOString();
    let result: TerminalCommandResult;
    try {
      result = this.runSync(args, workspacePath);
    } catch (error) {
      return this.failedActionResult(sanitizeText(errorToMessage(error)) ?? EXEC_FAILED);
    }
    const endedAt = new Date().toISOString();

    if (result.exitCode !== 0) {
      return this.failedActionResult(EXEC_FAILED);
    }

    // Honest degradation: if no thread_id parsed, return started WITHOUT a
    // fabricated id (resume will correctly block later).
    const threadId = extractThreadId(result.stdout);
    const branch = optionalMetadataString(context.metadata, "worktree_branch");

    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.idle,
      backend_run_id: threadId ?? undefined,
      thread_id: threadId ?? undefined,
      workspace_path: workspacePath ?? undefined,
      started_at: startedAt,
      ended_at: endedAt,
      turn_completed: true,
      final_backend_status: RUN_BACKEND_STATUSES.idle,
      metadata: cleanMetadata({
        sandbox_mode: mode,
        worktree_branch: branch ?? undefined
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

    const startedAt = new Date().toISOString();
    let result: TerminalCommandResult;
    try {
      result = this.runSync(args, workspacePath);
    } catch (error) {
      return this.failedActionResult(
        sanitizeText(errorToMessage(error)) ?? EXEC_RESUME_FAILED
      );
    }
    const endedAt = new Date().toISOString();

    if (result.exitCode !== 0) {
      return this.failedActionResult(EXEC_RESUME_FAILED);
    }

    const resumedThreadId = extractThreadId(result.stdout) ?? threadId;

    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.idle,
      backend_run_id: resumedThreadId,
      thread_id: resumedThreadId,
      workspace_path: workspacePath ?? undefined,
      started_at: startedAt,
      ended_at: endedAt,
      turn_completed: true,
      final_backend_status: RUN_BACKEND_STATUSES.idle,
      metadata: cleanMetadata({ sandbox_mode: mode })
    };
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    // One-shot exec completes synchronously at start; derive a status from
    // stored durable metadata. Never invent ids; never echo output text.
    const threadId = durableThreadIdFromContext(context);
    if (threadId) {
      return {
        status: "idle",
        backend: BACKEND_NAME,
        backend_status: RUN_BACKEND_STATUSES.idle,
        backend_run_id: threadId,
        thread_id: threadId,
        workspace_path: normalizeOptionalText(context.workspace_path) ?? undefined
      };
    }

    return {
      status: "unknown",
      backend: BACKEND_NAME,
      backend_status: RUN_BACKEND_STATUSES.unknown
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

  private runSync(
    args: readonly string[],
    cwd: string | null
  ): TerminalCommandResult {
    const result = this.runner.run(this.codexCommand, args, {
      cwd: cwd ?? undefined,
      timeoutMs: this.timeoutMs,
      env: { ...process.env, TERM: "dumb" }
    });

    if (isPromise(result)) {
      // ExecutionBackend.startRun/resumeRun are synchronous; the codex exec
      // one-shot model relies on a synchronous runner (execFileSync).
      throw new Error("codex_exec_async_runner_unsupported");
    }

    return result;
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
