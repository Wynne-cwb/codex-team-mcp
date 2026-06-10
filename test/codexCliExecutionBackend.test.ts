import { describe, expect, it } from "vitest";

import { CodexCliExecutionBackend } from "../src/adapters/codexCliExecutionBackend.js";
import {
  createTerminalCommandRunner,
  type TerminalCommandExecutor,
  type TerminalCommandResult
} from "../src/adapters/terminalCommand.js";
import type { ExecutionRunContext } from "../src/adapters/execution.js";

const SECRET_TOKEN = "SECRET_CODEX_CLI_EXEC_SECRET";
const THREAD_STARTED_LINE = JSON.stringify({
  type: "thread.started",
  thread_id: "thread-abc-123"
});

interface RecordedCommand {
  command: string;
  args: string[];
}

// A scriptable fake executor: matches on the args and returns a canned result.
// No real `codex` binary is ever spawned.
function createFakeExecutor(
  responder: (command: string, args: string[]) => TerminalCommandResult
): { executor: TerminalCommandExecutor; calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  const executor: TerminalCommandExecutor = (command, args) => {
    calls.push({ command, args: [...args] });
    return responder(command, [...args]);
  };
  return { executor, calls };
}

function ok(stdout: string): TerminalCommandResult {
  return { stdout, stderr: "", exitCode: 0, exit_code: 0 };
}

function nonZero(stdout = "", stderr = "boom"): TerminalCommandResult {
  return { stdout, stderr, exitCode: 1, exit_code: 1 };
}

function isHelpProbe(args: string[]): boolean {
  return args[0] === "exec" && args[1] === "--help";
}

function backendWith(
  responder: (command: string, args: string[]) => TerminalCommandResult
): { backend: CodexCliExecutionBackend; calls: RecordedCommand[] } {
  const { executor, calls } = createFakeExecutor(responder);
  const runner = createTerminalCommandRunner({ executor });
  const backend = new CodexCliExecutionBackend({ runner, timeoutMs: 1000 });
  return { backend, calls };
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
  it("reports available capabilities when `codex exec --help` exits 0", () => {
    const { backend } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage: codex exec") : ok(THREAD_STARTED_LINE)
    );

    const description = backend.describeBackend();
    expect(description).toMatchObject({
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
    const { backend } = backendWith((_command, args) => {
      if (isHelpProbe(args)) {
        throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      }
      return ok(THREAD_STARTED_LINE);
    });

    const description = backend.describeBackend();
    expect(description.status).toBe("unavailable");
    expect(description.backend).toBe("codex_cli_exec");
    expect(description.capabilities.canStart).toBe(false);
    expect(description.capabilities.canResume).toBe(false);
    expect(description.capabilities.supportsWorkspaces).toBe(false);
    expect(typeof description.limitation).toBe("string");
    expect(description.limitation).toContain("CODEX_TEAM_EXECUTION");
  });

  it("starts a worktree-isolated turn: emits arg array, captures thread_id, lifecycle-only", () => {
    const { backend, calls } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : ok(`warning: ignoring stray line\n${THREAD_STARTED_LINE}`)
    );

    const result = backend.startRun(startContext());

    expect(result.status).toBe("started");
    expect(result.backend).toBe("codex_cli_exec");
    expect(result.thread_id).toBe("thread-abc-123");
    expect(result.backend_run_id).toBe("thread-abc-123");
    expect(result.workspace_path).toBe("/tmp/codex-team-worktree");
    expect(result.turn_completed).toBe(true);
    expect(result.final_backend_status).toBe("idle");
    expect(typeof result.started_at).toBe("string");
    expect(typeof result.ended_at).toBe("string");

    const startCall = calls.find((call) => call.args[0] === "exec" && call.args[1] === "-s");
    expect(startCall).toBeDefined();
    const args = startCall?.args ?? [];
    expect(args).toContain("exec");
    expect(args).toContain("-s");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--json");
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/codex-team-worktree");
    // The real prompt is passed as the final arg (arg array, no shell), but is
    // NEVER stored in the result.
    expect(args.at(-1)).toBe("implement the feature");
  });

  it("uses read-only sandbox and omits --cd for read-only work without a worktree", () => {
    const { backend, calls } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : ok(THREAD_STARTED_LINE)
    );

    backend.startRun(
      startContext({
        work_classification: "read_only",
        isolation_kind: "none",
        workspace_path: null,
        metadata: { prompt: "summarize the repo" }
      })
    );

    const startCall = calls.find((call) => call.args[1] === "-s");
    const args = startCall?.args ?? [];
    expect(args).toContain("read-only");
    expect(args).not.toContain("--cd");
  });

  it("never stores raw output text or secrets in the started result (D-02)", () => {
    const { backend } = backendWith((_command, args) =>
      isHelpProbe(args)
        ? ok("usage")
        : ok(`${SECRET_TOKEN} leaked stdout\n${THREAD_STARTED_LINE}\nmore ${SECRET_TOKEN}`)
    );

    const result = backend.startRun(startContext());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain("leaked stdout");
    expect(result.thread_id).toBe("thread-abc-123");
  });

  it("returns backend_failed with a sanitized error and no fabricated thread_id on non-zero exit", () => {
    const { backend } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : nonZero(`failed ${SECRET_TOKEN}`)
    );

    const result = backend.startRun(startContext());

    expect(result.status).toBe("backend_failed");
    expect(result.backend_status).toBe("failed");
    expect(result).not.toHaveProperty("thread_id");
    expect(result.thread_id).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  it("degrades honestly when no thread_id is parsed (started without a fabricated id)", () => {
    const { backend } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : ok("no json here, just text")
    );

    const result = backend.startRun(startContext());
    expect(result.status).toBe("started");
    expect(result.thread_id).toBeUndefined();
    expect(result.backend_run_id).toBeUndefined();
  });

  it("resumes via `codex exec resume --json <thread_id>` when durable metadata exists", () => {
    const { backend, calls } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : ok(THREAD_STARTED_LINE)
    );

    const result = backend.resumeRun(
      startContext({
        metadata: { backend_thread_id: "thread-abc-123" }
      }),
      { kind: "message", message_id: "message-1" }
    );

    expect(result.status).toBe("resumed");
    expect(result.thread_id).toBe("thread-abc-123");

    const resumeCall = calls.find((call) => call.args[1] === "resume");
    const args = resumeCall?.args ?? [];
    expect(args).toContain("exec");
    expect(args).toContain("resume");
    expect(args).toContain("--json");
    expect(args).toContain("thread-abc-123");
  });

  it("refuses to resume without a durable thread id (never invents one)", () => {
    const { backend, calls } = backendWith((_command, args) =>
      isHelpProbe(args) ? ok("usage") : ok(THREAD_STARTED_LINE)
    );

    const result = backend.resumeRun(
      startContext({ metadata: {} }),
      { kind: "message", message_id: "message-1" }
    );

    expect(result.status).toBe("not_resumable");
    expect(result.last_error).toBe("codex_session_metadata_unavailable");
    expect(result.thread_id).toBeUndefined();
    expect(calls.some((call) => call.args[1] === "resume")).toBe(false);
  });
});
