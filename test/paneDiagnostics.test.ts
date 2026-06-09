import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendActionResult,
  ExecutionBackendDescription,
  ExecutionBackendReconcileResult,
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  TASK_STATUSES
} from "../src/state/schema.js";
import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";

const tempRoots: string[] = [];
const SECRET_PANE_DIAGNOSTICS_PROMPT = "SECRET_PANE_DIAGNOSTICS_PROMPT";
const SECRET_PANE_TRANSCRIPT = "SECRET_PANE_TRANSCRIPT";

class DiagnosticsFakePaneBackend implements ExecutionBackend {
  readonly reconcileCalls: ExecutionRunContext[] = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "diagnostics-fake-pane",
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true
      }
    };
  }

  startRun(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: "diagnostics-fake-pane",
      backend_status: RUN_BACKEND_STATUSES.notStarted
    };
  }

  resumeRun(
    _context: ExecutionRunContext,
    _trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    return this.startRun();
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    this.reconcileCalls.push(context);
    return {
      status: "stale",
      backend: "diagnostics-fake-pane",
      backend_status: RUN_BACKEND_STATUSES.stale,
      last_error: "fake pane missing"
    };
  }
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createPaneDiagnosticsState(input: {
  stateRoot: string;
  workspaceRoot: string;
  callerMetadata: unknown;
}): void {
  const caller = normalizeCallerMetadata(input.callerMetadata);
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot: input.workspaceRoot,
    caller
  });
  const adapter = new DurableStateAdapter({
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot
  });
  const isolatedWorkspace = createTempRoot("codex-team-pane-workspace-");

  try {
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Pane diagnostics team",
      identity
    });
    const teammate = new AgentService({ db, statePath }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: SECRET_PANE_DIAGNOSTICS_PROMPT,
      description: "Create pane diagnostics Builder",
      identity
    });
    if (!("debug" in teammate)) {
      throw new Error("Expected TeamMate creation for pane diagnostics");
    }

    db.prepare(
      `
        UPDATE ${TABLE_NAMES.members}
        SET status = ?
        WHERE member_id = ?
      `
    ).run(MEMBER_STATUSES.running, teammate.debug.internal_member_id);
    db.prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_run_id = ?,
            backend_thread_id = ?,
            backend_process_id = ?,
            workspace_path = ?,
            review_status = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE run_id = ?
      `
    ).run(
      MEMBER_STATUSES.running,
      "tmux",
      RUN_BACKEND_STATUSES.running,
      "thread-pane-1",
      "thread-pane-1",
      "%12",
      isolatedWorkspace,
      RUN_REVIEW_STATUSES.pendingReview,
      JSON.stringify({
        prompt: SECRET_PANE_DIAGNOSTICS_PROMPT,
        transcript: SECRET_PANE_TRANSCRIPT,
        backend_metadata: {
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
      }),
      "2026-06-08T00:00:00.000Z",
      teammate.run_id
    );

    const messageService = new MessageService({ db, statePath });
    messageService.sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "SECRET_PANE_MESSAGE_BODY",
      summary: "pane message summary",
      identity
    });

    const taskService = new TaskService({ db, statePath });
    const created = taskService.createTask({
      teamName: "alpha-team",
      subject: "Pane task summary",
      description: "SECRET_PANE_TASK_DESCRIPTION",
      owner: "Builder",
      identity
    });
    taskService.updateTask({
      teamName: "alpha-team",
      taskId: created.public_task_id,
      status: TASK_STATUSES.inProgress,
      notes: "SECRET_PANE_TASK_NOTES",
      identity
    });
  } finally {
    adapter.close();
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pane diagnostics", () => {
  it("reports paneSummary attach lifecycle message task and workspace review state", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    }) as ReturnType<typeof buildDiagnosticsPayload> & {
      paneSummary?: Record<string, unknown>;
    };

    expect(payload.paneSummary).toMatchObject({
      total: 1,
      by_backend_type: {
        tmux: 1
      },
      by_availability_status: {
        available: 1
      },
      attachable: 1,
      messageSummary: {
        total: 1,
        queued: 1,
        by_delivery_status: {
          [MESSAGE_DELIVERY_STATUSES.queuedForNextTurn]: 1
        }
      },
      taskSummary: {
        total: 1,
        by_status: {
          [TASK_STATUSES.inProgress]: 1
        },
        assigned: 1
      },
      workspaceReviewSummary: {
        pending_review: 1,
        needs_review: 0,
        with_workspace_path: 1
      },
      panes: [
        expect.objectContaining({
          teammate_id: "builder@alpha-team",
          lifecycle_status: MEMBER_STATUSES.running,
          backend_status: RUN_BACKEND_STATUSES.running,
          backend_type: "tmux",
          availability_status: "available",
          pane_id: "%12",
          session_name: "codex-team-alpha-team",
          window_name: "teammates",
          socket_name: "codex-team-alpha-team-run-alpha-builder",
          attach_command:
            "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team",
          review_status: RUN_REVIEW_STATUSES.pendingReview,
          workspace_path: expect.stringContaining("codex-team-pane-workspace-")
        })
      ]
    });
  });

  it("redacts raw prompt message body task text payload_json and transcript from paneSummary", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    }) as ReturnType<typeof buildDiagnosticsPayload> & {
      paneSummary?: Record<string, unknown>;
    };
    const serialized = JSON.stringify({ paneSummary: payload.paneSummary });

    expect(serialized).toContain("paneSummary");
    expect(serialized).toContain("pending_review");
    expect(serialized).toContain("workspace_path");
    expect(serialized).not.toContain(SECRET_PANE_DIAGNOSTICS_PROMPT);
    expect(serialized).not.toContain("SECRET_PANE_MESSAGE_BODY");
    expect(serialized).not.toContain("SECRET_PANE_TASK_DESCRIPTION");
    expect(serialized).not.toContain("SECRET_PANE_TASK_NOTES");
    expect(serialized).not.toContain(SECRET_PANE_TRANSCRIPT);
    for (const redactedKey of [
      "prompt",
      "message",
      "body",
      "description",
      "notes",
      "payload_json",
      "transcript"
    ]) {
      expect(serialized).not.toContain(`"${redactedKey}"`);
    }
  });

  it("redacts legacy unsafe pane metadata before diagnostics display", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const run = db
        .prepare(`SELECT run_id FROM ${TABLE_NAMES.runs} LIMIT 1`)
        .get() as { run_id: string };
      db.prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET metadata_json = ?
          WHERE run_id = ?
        `
      ).run(
        JSON.stringify({
          backend_metadata: {
            pane: {
              mode: "pane",
              backend_type: "tmux",
              availability_status: "available",
              pane_id: "%12",
              session_name: "SECRET_API_TOKEN",
              socket_name: "secret_api_token",
              attach_command: "tmux attach-session -t work; rm -rf \"$HOME\""
            }
          }
        }),
        run.run_id
      );
    } finally {
      adapter.close();
    }

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    }) as ReturnType<typeof buildDiagnosticsPayload> & {
      paneSummary?: Record<string, unknown>;
    };
    const serialized = JSON.stringify({ paneSummary: payload.paneSummary });

    expect(serialized).toContain("unsafe_attach_metadata_omitted");
    expect(serialized).toContain("[redacted_secret]");
    expect(serialized).not.toContain("SECRET_API_TOKEN");
    expect(serialized).not.toContain("secret_api_token");
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("attach_command");
  });

  it("omits attach commands with newline command separators from diagnostics display", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const run = db
        .prepare(`SELECT run_id FROM ${TABLE_NAMES.runs} LIMIT 1`)
        .get() as { run_id: string };
      db.prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET metadata_json = ?
          WHERE run_id = ?
        `
      ).run(
        JSON.stringify({
          backend_metadata: {
            pane: {
              mode: "pane",
              backend_type: "tmux",
              availability_status: "available",
              pane_id: "%12",
              session_name: "work",
              attach_command: 'tmux attach-session -t work\nrm -rf "$HOME"'
            }
          }
        }),
        run.run_id
      );
    } finally {
      adapter.close();
    }

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    }) as ReturnType<typeof buildDiagnosticsPayload> & {
      paneSummary?: Record<string, unknown>;
    };
    const serialized = JSON.stringify({ paneSummary: payload.paneSummary });

    expect(serialized).toContain("unsafe_attach_metadata_omitted");
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("attach_command");
  });

  it("keeps safe POSIX escaped single quote attach commands in diagnostics display", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };
    const safeAttachCommand = "tmux attach-session -t 'a'\\''b;c'";

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const run = db
        .prepare(`SELECT run_id FROM ${TABLE_NAMES.runs} LIMIT 1`)
        .get() as { run_id: string };
      db.prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET metadata_json = ?
          WHERE run_id = ?
        `
      ).run(
        JSON.stringify({
          backend_metadata: {
            pane: {
              mode: "pane",
              backend_type: "tmux",
              availability_status: "available",
              pane_id: "%12",
              session_name: "a'b;c",
              attach_command: safeAttachCommand
            }
          }
        }),
        run.run_id
      );
    } finally {
      adapter.close();
    }

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    }) as ReturnType<typeof buildDiagnosticsPayload> & {
      paneSummary?: {
        panes?: Array<Record<string, unknown>>;
      };
    };
    const firstPane = payload.paneSummary?.panes?.[0];

    expect(firstPane).toMatchObject({
      attach_command: safeAttachCommand
    });
    expect(String(firstPane?.degradation_reason ?? "")).not.toContain(
      "unsafe_attach_metadata_omitted"
    );
  });

  it("uses configured execution backend for diagnostics execution and report reconciliation", () => {
    const stateRoot = createTempRoot("codex-team-pane-diagnostics-state-");
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-pane", clientName: "codex" };
    const fakeBackend = new DiagnosticsFakePaneBackend();

    createPaneDiagnosticsState({ stateRoot, workspaceRoot, callerMetadata });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      paneMode: { enabled: true },
      executionBackend: fakeBackend,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const run = adapter
        .getDatabase()
        .prepare(`SELECT status FROM ${TABLE_NAMES.runs} LIMIT 1`)
        .get() as { status: string };

      expect(run.status).toBe(MEMBER_STATUSES.running);
    } finally {
      adapter.close();
    }

    expect(payload.execution.backend).toBe("diagnostics-fake-pane");
    expect(payload.execution.backend).not.toBe("none");
    expect(payload.reconciliationSummary.runningRunsChecked).toBe(1);
    expect(fakeBackend.reconcileCalls).toHaveLength(1);
  });
});
