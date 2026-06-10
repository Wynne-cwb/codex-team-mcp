import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexCliExecutionBackend,
  codexExecLogPath,
  extractCodexDeliverable,
  type DetachedProcessHandle,
  type DetachedSpawnRequest,
  type ProcessSpawner
} from "../src/adapters/codexCliExecutionBackend.js";
import {
  createTerminalCommandRunner,
  type TerminalCommandExecutor,
  type TerminalCommandResult
} from "../src/adapters/terminalCommand.js";
import type { ExecutionRunContext } from "../src/adapters/execution.js";

const SECRET_TOKEN = "SECRET_CODEX_CLI_EXEC_SECRET";
const THREAD_ID = "thread-abc-123";
const THREAD_STARTED_LINE = JSON.stringify({
  type: "thread.started",
  thread_id: THREAD_ID
});
const AGENT_MESSAGE_LINE = JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "Summary: the billing module looks healthy." }
});
const TURN_COMPLETED_LINE = JSON.stringify({ type: "turn.completed" });

// Real UAT failure: the durable reason lives in codex's JSONL log, while stderr
// only carries benign noise.
const CODEX_ERROR_MESSAGE = "Missing environment variable: `AM_API_KEY`.";
const STDIN_NOISE = "Reading additional input from stdin...";
const TURN_FAILED_LINE = JSON.stringify({
  type: "turn.failed",
  error: { message: CODEX_ERROR_MESSAGE }
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempLogDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-team-exec-log-"));
  tempDirs.push(dir);
  return dir;
}

function isHelpProbe(args: readonly string[]): boolean {
  return args[0] === "exec" && args[1] === "--help";
}

function ok(stdout: string): TerminalCommandResult {
  return { stdout, stderr: "", exitCode: 0, exit_code: 0 };
}

function nonZero(): TerminalCommandResult {
  return { stdout: "", stderr: "boom", exitCode: 1, exit_code: 1 };
}

// A fake detached spawner: records each spawn request, can write a scripted log
// payload at spawn time (so the bounded thread.started wait finds it), returns a
// controllable pid, and reports a controllable liveness flag. No real `codex`.
interface FakeSpawner {
  spawner: ProcessSpawner;
  requests: DetachedSpawnRequest[];
  setAlive(alive: boolean): void;
}

function createFakeSpawner(options: {
  pid?: number | undefined;
  alive?: boolean;
  writeOnSpawn?: string | null;
} = {}): FakeSpawner {
  const requests: DetachedSpawnRequest[] = [];
  let alive = options.alive ?? true;
  const spawner: ProcessSpawner = {
    spawnDetached(request: DetachedSpawnRequest): DetachedProcessHandle {
      requests.push(request);
      if (typeof options.writeOnSpawn === "string") {
        writeFileSync(request.logPath, options.writeOnSpawn);
      }
      return { pid: options.pid === undefined ? 4242 : options.pid };
    },
    isAlive(): boolean {
      return alive;
    }
  };
  return {
    spawner,
    requests,
    setAlive(next: boolean) {
      alive = next;
    }
  };
}

// Deterministic fake clock: `now` returns a counter that `sleep` advances. No
// real time passes, so the bounded wait terminates instantly in tests.
function createFakeClock(): { now: () => number; sleep: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
    }
  };
}

function makeBackend(options: {
  spawner: ProcessSpawner;
  logDir: string;
  helpOk?: boolean;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => void;
  now?: () => number;
}): CodexCliExecutionBackend {
  const executor: TerminalCommandExecutor = (_command, args) =>
    isHelpProbe(args)
      ? options.helpOk === false
        ? nonZero()
        : ok("usage: codex exec")
      : ok("");
  const runner = createTerminalCommandRunner({ executor });
  return new CodexCliExecutionBackend({
    runner,
    spawner: options.spawner,
    logDir: options.logDir,
    timeoutMs: 1000,
    startTimeoutMs: options.startTimeoutMs ?? 1000,
    pollIntervalMs: options.pollIntervalMs ?? 50,
    sleep: options.sleep ?? (() => {}),
    now: options.now
  });
}

function startContext(
  overrides: Partial<ExecutionRunContext> = {}
): ExecutionRunContext {
  return {
    run_id: "run:test:1",
    team_id: "team-1",
    member_id: "member:1",
    teammate_id: "builder@alpha-team",
    team_name: "alpha-team",
    workspace_root: "/workspace/project",
    prompt_present: true,
    work_classification: "code_implementation",
    isolation_kind: "git_worktree",
    workspace_path: "/tmp/codex-team-worktree",
    metadata: { prompt: "implement the feature" },
    ...overrides
  };
}

describe("CodexCliExecutionBackend", () => {
  describe("describeBackend", () => {
    it("reports available capabilities when `codex exec --help` exits 0", () => {
      const fake = createFakeSpawner();
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      expect(backend.describeBackend()).toMatchObject({
        status: "available",
        backend: "codex_cli_exec",
        capabilities: {
          canStart: true,
          canResume: true,
          canReconcile: true,
          supportsWorkspaces: true,
          supportsOsSandbox: true
        }
      });
    });

    it("reports unavailable + remediation limitation when the help probe errors", () => {
      const fake = createFakeSpawner();
      const backend = makeBackend({
        spawner: fake.spawner,
        logDir: createTempLogDir(),
        helpOk: false
      });

      const description = backend.describeBackend();
      expect(description.status).toBe("unavailable");
      expect(description.capabilities.canStart).toBe(false);
      expect(description.capabilities.canResume).toBe(false);
      expect(typeof description.limitation).toBe("string");
      expect(description.limitation).toContain("CODEX_TEAM_EXECUTION");
    });
  });

  describe("startRun (detached, bounded thread.started wait)", () => {
    it("spawns a detached worktree-isolated run and returns running with the captured thread_id", () => {
      const fake = createFakeSpawner({ pid: 5150, writeOnSpawn: THREAD_STARTED_LINE });
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      const result = backend.startRun(startContext());

      // NEW async contract: started ⇒ running (NOT idle, NOT turn_completed).
      expect(result.status).toBe("started");
      expect(result.backend).toBe("codex_cli_exec");
      expect(result.backend_status).toBe("running");
      expect(result.turn_completed).toBeUndefined();
      expect(result.final_backend_status).toBeUndefined();
      expect(result.ended_at).toBeUndefined();
      expect(result.thread_id).toBe(THREAD_ID);
      expect(result.backend_run_id).toBe(THREAD_ID);
      expect(result.process_id).toBe("5150");
      expect(result.workspace_path).toBe("/tmp/codex-team-worktree");
      expect(typeof result.started_at).toBe("string");

      // The detached process was launched with the worktree-isolated arg array.
      expect(fake.requests).toHaveLength(1);
      const args = fake.requests[0]?.args ?? [];
      expect(args).toContain("exec");
      expect(args).toContain("-s");
      expect(args).toContain("workspace-write");
      expect(args).toContain("--json");
      expect(args).toContain("--cd");
      expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/codex-team-worktree");
      // The real prompt is the final arg (arg array, no shell), never stored.
      expect(args.at(-1)).toBe("implement the feature");
      expect(fake.requests[0]?.cwd).toBe("/tmp/codex-team-worktree");
    });

    it("uses read-only sandbox and omits --cd for read-only work without a worktree", () => {
      const fake = createFakeSpawner({ writeOnSpawn: THREAD_STARTED_LINE });
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      backend.startRun(
        startContext({
          work_classification: "read_only",
          isolation_kind: "none",
          workspace_path: null,
          metadata: { prompt: "summarize the repo" }
        })
      );

      const args = fake.requests[0]?.args ?? [];
      expect(args).toContain("read-only");
      expect(args).not.toContain("--cd");
    });

    it("persists the per-run log path so reconcile/diagnostics can find it", () => {
      const logDir = createTempLogDir();
      const fake = createFakeSpawner({ writeOnSpawn: THREAD_STARTED_LINE });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.startRun(startContext());
      const expectedPath = codexExecLogPath("/workspace/project", "run:test:1", logDir);

      expect(result.metadata?.exec_log_path).toBe(expectedPath);
      expect(fake.requests[0]?.logPath).toBe(expectedPath);
    });

    it("captures the thread_id when thread.started appears within the timeout", () => {
      const logDir = createTempLogDir();
      const clock = createFakeClock();
      // Nothing at spawn; the scripted sleep writes thread.started after a poll.
      const expectedPath = codexExecLogPath("/workspace/project", "run:test:1", logDir);
      const fake = createFakeSpawner();
      let polls = 0;
      const sleep = (ms: number): void => {
        clock.sleep(ms);
        polls += 1;
        if (polls === 2) {
          writeFileSync(expectedPath, `warning: stray\n${THREAD_STARTED_LINE}`);
        }
      };
      const backend = makeBackend({
        spawner: fake.spawner,
        logDir,
        startTimeoutMs: 1000,
        pollIntervalMs: 50,
        now: clock.now,
        sleep
      });

      const result = backend.startRun(startContext());
      expect(result.status).toBe("started");
      expect(result.thread_id).toBe(THREAD_ID);
    });

    it("degrades honestly when thread.started never appears within the timeout (no fabricated id)", () => {
      const clock = createFakeClock();
      const fake = createFakeSpawner({ writeOnSpawn: "no json here, just warnings" });
      const backend = makeBackend({
        spawner: fake.spawner,
        logDir: createTempLogDir(),
        startTimeoutMs: 300,
        pollIntervalMs: 50,
        now: clock.now,
        sleep: clock.sleep
      });

      const result = backend.startRun(startContext());
      expect(result.status).toBe("started");
      expect(result.backend_status).toBe("running");
      expect(result.thread_id).toBeUndefined();
      expect(result.backend_run_id).toBeUndefined();
      // A pid is still returned so reconcile can later capture the thread_id + status.
      expect(result.process_id).toBe("4242");
    });

    it("never stores raw log output or secrets in the started result (D-02)", () => {
      const fake = createFakeSpawner({
        writeOnSpawn: `${SECRET_TOKEN} leaked stdout\n${THREAD_STARTED_LINE}\nmore ${SECRET_TOKEN}`
      });
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      const result = backend.startRun(startContext());
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(SECRET_TOKEN);
      expect(serialized).not.toContain("leaked stdout");
      expect(result.thread_id).toBe(THREAD_ID);
    });

    it("returns backend_failed (no fabricated id) when the detached spawn throws", () => {
      const spawner: ProcessSpawner = {
        spawnDetached() {
          throw Object.assign(new Error(`spawn codex ETIMEDOUT ${SECRET_TOKEN}`), {
            code: "ETIMEDOUT"
          });
        },
        isAlive: () => false
      };
      const backend = makeBackend({ spawner, logDir: createTempLogDir() });

      const result = backend.startRun(startContext());
      expect(result.status).toBe("backend_failed");
      expect(result.backend_status).toBe("failed");
      expect(result.thread_id).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
    });
  });

  describe("resumeRun (detached async path)", () => {
    it("resumes via `codex exec resume --json <thread_id>` and returns running", () => {
      const fake = createFakeSpawner({ pid: 9001, writeOnSpawn: THREAD_STARTED_LINE });
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      const result = backend.resumeRun(
        startContext({ metadata: { backend_thread_id: THREAD_ID } }),
        { kind: "message", message_id: "message-1" }
      );

      expect(result.status).toBe("resumed");
      expect(result.backend_status).toBe("running");
      expect(result.turn_completed).toBeUndefined();
      expect(result.thread_id).toBe(THREAD_ID);
      expect(result.process_id).toBe("9001");

      const args = fake.requests[0]?.args ?? [];
      expect(args).toContain("exec");
      expect(args).toContain("resume");
      expect(args).toContain("--json");
      expect(args).toContain(THREAD_ID);
    });

    it("refuses to resume without a durable thread id (never invents one, never spawns)", () => {
      const fake = createFakeSpawner();
      const backend = makeBackend({ spawner: fake.spawner, logDir: createTempLogDir() });

      const result = backend.resumeRun(startContext({ metadata: {} }), {
        kind: "message",
        message_id: "message-1"
      });

      expect(result.status).toBe("not_resumable");
      expect(result.last_error).toBe("codex_session_metadata_unavailable");
      expect(result.thread_id).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("reconcileRun (log + liveness)", () => {
    function writeLog(logDir: string, runId: string, contents: string): string {
      const logPath = codexExecLogPath("/workspace/project", runId, logDir);
      writeFileSync(logPath, contents);
      return logPath;
    }

    function reconcileContext(
      overrides: Partial<ExecutionRunContext> = {}
    ): ExecutionRunContext {
      return startContext({
        work_classification: "read_only",
        metadata: { backend_process_id: "4242", backend_thread_id: THREAD_ID },
        ...overrides
      });
    }

    it("transitions running → idle when the log contains turn.completed", () => {
      const logDir = createTempLogDir();
      writeLog(
        logDir,
        "run:test:1",
        `${THREAD_STARTED_LINE}\n${AGENT_MESSAGE_LINE}\n${TURN_COMPLETED_LINE}`
      );
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(reconcileContext());
      expect(result.status).toBe("idle");
      expect(result.backend_status).toBe("idle");
      expect(result.thread_id).toBe(THREAD_ID);
      expect(typeof result.ended_at).toBe("string");
    });

    it("captures the thread_id from the log when it was not durably stored at start", () => {
      const logDir = createTempLogDir();
      writeLog(logDir, "run:test:1", `${THREAD_STARTED_LINE}\n${TURN_COMPLETED_LINE}`);
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(
        reconcileContext({ metadata: { backend_process_id: "4242" } })
      );
      expect(result.status).toBe("idle");
      expect(result.thread_id).toBe(THREAD_ID);
    });

    it("transitions running → failed with the surfaced sanitized reason on turn.failed", () => {
      const logDir = createTempLogDir();
      writeLog(logDir, "run:test:1", `${STDIN_NOISE}\n${TURN_FAILED_LINE}`);
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(reconcileContext());
      expect(result.status).toBe("failed");
      expect(result.backend_status).toBe("failed");
      expect(result.last_error).toContain("codex_exec_turn_failed");
      expect(result.last_error).toContain("Missing environment variable");
    });

    it("sanitizes secrets inside a surfaced reconcile failure reason (D-02)", () => {
      const logDir = createTempLogDir();
      const line = JSON.stringify({
        type: "turn.failed",
        error: { message: `boom ${SECRET_TOKEN} leaked` }
      });
      writeLog(logDir, "run:test:1", line);
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(reconcileContext());
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
      expect(result.last_error).toContain("[redacted_secret]");
    });

    it("reports active (running) when the pid is alive and no terminal event yet", () => {
      const logDir = createTempLogDir();
      writeLog(logDir, "run:test:1", THREAD_STARTED_LINE);
      const fake = createFakeSpawner({ alive: true });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(reconcileContext());
      expect(result.status).toBe("active");
      expect(result.backend_status).toBe("running");
      expect(result.thread_id).toBe(THREAD_ID);
    });

    it("reports failed (crash) when the pid is dead and no terminal event was written", () => {
      const logDir = createTempLogDir();
      writeLog(logDir, "run:test:1", THREAD_STARTED_LINE);
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(reconcileContext());
      expect(result.status).toBe("failed");
      expect(result.backend_status).toBe("failed");
      expect(result.last_error).toContain("codex_exec_process_exited_without_completion");
    });

    it("reports unknown when there is no pid to probe and no terminal event", () => {
      const logDir = createTempLogDir();
      writeLog(logDir, "run:test:1", THREAD_STARTED_LINE);
      const fake = createFakeSpawner({ alive: true });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(
        reconcileContext({ metadata: { backend_thread_id: THREAD_ID } })
      );
      expect(result.status).toBe("unknown");
      expect(result.backend_status).toBe("unknown");
    });

    it("prefers the persisted exec_log_path from backend_metadata when present", () => {
      const logDir = createTempLogDir();
      const otherDir = createTempLogDir();
      // Write the completed log under a DIFFERENT directory and point the run at it
      // via the persisted path, proving the persisted path wins over reconstruction.
      const persistedPath = path.join(otherDir, "persisted.jsonl");
      writeFileSync(persistedPath, `${THREAD_STARTED_LINE}\n${TURN_COMPLETED_LINE}`);
      const fake = createFakeSpawner({ alive: false });
      const backend = makeBackend({ spawner: fake.spawner, logDir });

      const result = backend.reconcileRun(
        reconcileContext({
          metadata: {
            backend_process_id: "4242",
            backend_metadata: { exec_log_path: persistedPath }
          }
        })
      );
      expect(result.status).toBe("idle");
      expect(result.thread_id).toBe(THREAD_ID);
    });
  });

  describe("extractCodexDeliverable", () => {
    it("concatenates agent_message texts and ignores other events", () => {
      const log = [
        THREAD_STARTED_LINE,
        JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "thinking..." }
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "First finding." }
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Second finding." }
        }),
        TURN_COMPLETED_LINE
      ].join("\n");

      expect(extractCodexDeliverable(log)).toBe("First finding.\n\nSecond finding.");
    });

    it("returns null when there is no agent_message", () => {
      expect(extractCodexDeliverable(`${THREAD_STARTED_LINE}\n${TURN_COMPLETED_LINE}`)).toBeNull();
      expect(extractCodexDeliverable("")).toBeNull();
    });
  });

  it("does not leak the log file: the result references a path only, never contents", () => {
    const logDir = createTempLogDir();
    const fake = createFakeSpawner({ writeOnSpawn: `${THREAD_STARTED_LINE}\n${AGENT_MESSAGE_LINE}` });
    const backend = makeBackend({ spawner: fake.spawner, logDir });

    const result = backend.startRun(startContext());
    const logContents = readFileSync(result.metadata?.exec_log_path as string, "utf8");

    expect(logContents).toContain("agent_message");
    // The deliverable text lives ONLY in the on-disk log, never in the result.
    expect(JSON.stringify(result)).not.toContain("agent_message");
  });
});
