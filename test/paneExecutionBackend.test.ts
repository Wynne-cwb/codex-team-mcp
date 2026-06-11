import { describe, expect, it } from "vitest";

import type {
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { PaneExecutionBackend } from "../src/adapters/paneExecutionBackend.js";

const runContext: ExecutionRunContext = {
  run_id: "run:alpha:builder",
  team_id: "team-alpha",
  member_id: "teammate:team-alpha:builder",
  teammate_id: "builder@alpha-team",
  team_name: "alpha-team",
  workspace_root: "/workspace",
  prompt_present: true,
  work_classification: "read_only",
  isolation_kind: "none",
  workspace_path: null,
  metadata: {
    backend_thread_id: "thread-pane-1"
  }
};

function createFakePaneBackend(input?: {
  available?: boolean;
  stale?: boolean;
  paneId?: string;
}) {
  const commands: string[][] = [];
  const createCalls: ExecutionRunContext[] = [];
  const reconcileCalls: ExecutionRunContext[] = [];
  const metadata = {
    mode: "pane",
    backend_type: "tmux",
    availability_status: input?.available === false ? "unavailable" : "available",
    degradation_reason:
      input?.available === false ? "tmux command not found" : undefined,
    pane_id: input?.paneId ?? "%12",
    session_name: "codex-team-alpha-team",
    window_name: "teammates",
    socket_name: "codex-team-alpha-team-run-alpha-builder",
    attach_command:
      "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team",
    is_native: false
  };

  return {
    commands,
    createCalls,
    reconcileCalls,
    describeAvailability() {
      return metadata;
    },
    createPane(context: ExecutionRunContext, command: string[]) {
      createCalls.push(context);
      commands.push(command);
      if (input?.available === false) {
        return { ok: false, pane: metadata };
      }

      return {
        ok: true,
        pane: metadata,
        thread_id: "thread-pane-1",
        process_id: metadata.pane_id
      };
    },
    resumePane(context: ExecutionRunContext, trigger: ExecutionTrigger, command: string[]) {
      commands.push(command);
      return {
        ok: true,
        pane: metadata,
        thread_id:
          typeof context.metadata?.backend_thread_id === "string"
            ? context.metadata.backend_thread_id
            : "thread-pane-1",
        process_id: metadata.pane_id,
        trigger_kind: trigger.kind
      };
    },
    reconcilePane(context: ExecutionRunContext) {
      reconcileCalls.push(context);
      return {
        status: input?.stale ? "stale" : "active",
        pane: {
          ...metadata,
          availability_status: input?.stale ? "degraded" : "available",
          degradation_reason: input?.stale
            ? "pane metadata no longer maps to a live pane"
            : undefined
        },
        deleted: false
      };
    },
    closePane() {
      return { ok: true, pane_id: metadata.pane_id };
    }
  };
}

describe("PaneExecutionBackend", () => {
  it("defaults to attach/status only and does not advertise durable start or resume", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createFakePaneBackend(),
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    const description = backend.describeBackend();
    const startResult = backend.startRun(runContext);
    const resumeResult = backend.resumeRun(runContext, {
      kind: "message",
      message_id: "message:alpha:1"
    });
    const serializedResults = JSON.stringify({ startResult, resumeResult });

    expect(description).toMatchObject({
      status: "unavailable",
      teammateExecutionImplemented: false,
      backend: "tmux",
      backend_status: "not_started",
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        supportsWorkspaces: true
      },
      limitation: "codex_session_metadata_unavailable"
    });
    expect(startResult).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      backend: "tmux",
      backend_status: "not_started"
    });
    expect(resumeResult).toMatchObject({
      status: "not_resumable",
      delivery_status: "backend_unavailable",
      backend: "tmux",
      backend_status: "not_started"
    });
    expect(serializedResults).not.toContain("backend_start_attempted");
    expect(serializedResults).not.toContain("backend_resume_attempted");
  });

  it("starts a TeamMate run through ExecutionBackend and records pane metadata", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend({
      paneBackend,
      executionClaim: "durable_start_resume_supported",
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    const result = backend.startRun(runContext);

    expect(result).toMatchObject({
      status: "started",
      delivery_status: "backend_start_attempted",
      backend: "tmux",
      backend_status: "running",
      thread_id: "thread-pane-1",
      process_id: "%12",
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "tmux",
          availability_status: "available",
          pane_id: "%12",
          session_name: "codex-team-alpha-team",
          window_name: "teammates",
          socket_name: "codex-team-alpha-team-run-alpha-builder",
          attach_command:
            "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team"
        }
      }
    });
    expect(paneBackend.createCalls).toEqual([runContext]);
  });

  it("degrades to backend_unavailable when pane mode is enabled but no backend is available", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createFakePaneBackend({ available: false }),
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    expect(backend.describeBackend()).toMatchObject({
      status: "unavailable",
      teammateExecutionImplemented: false,
      backend: "tmux",
      backend_status: "not_started",
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        supportsWorkspaces: true
      },
      limitation: expect.stringContaining("tmux")
    });
    expect(backend.startRun(runContext)).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      backend: "tmux",
      backend_status: "not_started",
      metadata: {
        pane: {
          mode: "pane",
          availability_status: "unavailable",
          degradation_reason: "tmux command not found"
        }
      }
    });
  });

  it("does not expose raw prompt message task description or transcript in action metadata", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createFakePaneBackend(),
      commandBuilder: {
        buildStartCommand: () => [
          "codex",
          "exec",
          "--json",
          "SECRET_PANE_PROMPT message task description transcript"
        ],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    const result = backend.startRun({
      ...runContext,
      metadata: {
        prompt: "SECRET_PANE_PROMPT",
        message: "SECRET_PANE_MESSAGE",
        task: "SECRET_PANE_TASK",
        description: "SECRET_PANE_DESCRIPTION",
        transcript: "SECRET_PANE_TRANSCRIPT"
      }
    });
    const serialized = JSON.stringify(result.metadata);

    expect(serialized).not.toContain("SECRET_PANE_PROMPT");
    expect(serialized).not.toContain("SECRET_PANE_MESSAGE");
    expect(serialized).not.toContain("SECRET_PANE_TASK");
    expect(serialized).not.toContain("SECRET_PANE_DESCRIPTION");
    expect(serialized).not.toContain("SECRET_PANE_TRANSCRIPT");
    for (const redactedKey of [
      "prompt",
      "message",
      "task",
      "description",
      "transcript"
    ]) {
      expect(result.metadata).not.toHaveProperty(redactedKey);
    }
  });

  it("does not shell-send SendMessage content during resume", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend({
      paneBackend,
      executionClaim: "durable_start_resume_supported",
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: (context: ExecutionRunContext) => [
          "codex",
          "exec",
          "resume",
          "--json",
          String(context.metadata?.backend_thread_id)
        ]
      }
    });
    const secretMessageBody = "SECRET_SENDMESSAGE_BODY";

    const result = backend.resumeRun(runContext, {
      kind: "message",
      message_id: "message:alpha:1",
      metadata: {
        body: secretMessageBody
      }
    });
    const commands = paneBackend.commands.flat().join(" ");

    expect(result).toMatchObject({
      status: "resumed",
      delivery_status: "backend_resume_attempted",
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "tmux"
        }
      }
    });
    expect(commands).toContain("codex exec resume --json thread-pane-1");
    expect(commands).not.toContain(secretMessageBody);
  });

  it("reconciles stale pane metadata without deleting sessions", () => {
    const paneBackend = createFakePaneBackend({ stale: true });
    const backend = new PaneExecutionBackend({
      paneBackend,
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    expect(backend.reconcileRun(runContext)).toMatchObject({
      status: "stale",
      backend: "tmux",
      backend_status: "stale",
      metadata: {
        pane: {
          mode: "pane",
          availability_status: "degraded",
          degradation_reason: "pane metadata no longer maps to a live pane"
        },
        session_deleted: false
      }
    });
    expect(paneBackend.reconcileCalls).toEqual([runContext]);
  });

  it("keeps file-modifying work behind workspace isolation or review diff requirements", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend({
      paneBackend,
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    expect(
      backend.startRun({
        ...runContext,
        work_classification: "code_implementation",
        isolation_kind: "none",
        workspace_path: null
      })
    ).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      last_error: expect.stringContaining("workspace isolation"),
      metadata: {
        pane: {
          availability_status: "degraded"
        }
      }
    });
    expect(paneBackend.createCalls).toHaveLength(0);
  });
});
