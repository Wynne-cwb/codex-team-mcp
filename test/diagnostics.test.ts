import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { CodexCliExecutionBackend } from "../src/adapters/codexCliExecutionBackend.js";
import { createTerminalCommandRunner } from "../src/adapters/terminalCommand.js";
import { FALLBACK_CALLER_KEY, normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { STATE_DB_FILENAME } from "../src/state/root.js";
import {
  ACTIVE_BINDING_STATUSES,
  EVENT_TYPES,
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  TASK_STATUSES,
  TEAM_STATUSES
} from "../src/state/schema.js";
import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";

const tempRoots: string[] = [];
const SECRET_PHASE5_DIAGNOSTICS_PROMPT = "SECRET_PHASE5_DIAGNOSTICS_PROMPT";
const SECRET_OBS01_TEAMMATE_PROMPT = "SECRET_OBS01_TEAMMATE_PROMPT";

interface ScheduledAgentLike {
  run_id: string;
  debug: { internal_member_id: string };
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-diagnostics-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createTeamForDiagnostics(input: {
  stateRoot: string;
  workspaceRoot: string;
  callerMetadata: unknown;
}): { bindingKey: string; callerKey: string } {
  const caller = normalizeCallerMetadata(input.callerMetadata);
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot: input.workspaceRoot,
    caller
  });
  const adapter = new DurableStateAdapter({
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot
  });

  try {
    new TeamService({
      db: adapter.getDatabase(),
      statePath: adapter.describeStateRoot().stateRoot
    }).createTeam({
      teamName: "Alpha Team",
      description: "Diagnostics test team",
      identity
    });
  } finally {
    adapter.close();
  }

  return {
    bindingKey: identity.bindingKey,
    callerKey: identity.callerKey
  };
}

function createScheduledTeamMateForDiagnostics(input: {
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

  try {
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({
      db: adapter.getDatabase(),
      statePath
    }).createTeam({
      teamName: "Alpha Team",
      description: "Diagnostics scheduled TeamMate team",
      identity
    });
    new AgentService({
      db: adapter.getDatabase(),
      statePath
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "Sensitive prompt must not appear in diagnostics events",
      description: "Create scheduled diagnostics TeamMate",
      identity
    });
  } finally {
    adapter.close();
  }
}

function createMessageAndTaskStateForDiagnostics(input: {
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

  try {
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({
      db: adapter.getDatabase(),
      statePath
    }).createTeam({
      teamName: "Alpha Team",
      description: "Diagnostics message and task team",
      identity
    });
    const agentService = new AgentService({
      db: adapter.getDatabase(),
      statePath
    });
    const builder = agentService.createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "Sensitive Builder prompt must not appear in diagnostics",
      description: "Create diagnostics Builder",
      identity
    });
    const reviewer = agentService.createAgent({
      name: "Reviewer",
      teamName: "alpha-team",
      prompt: "Sensitive Reviewer prompt must not appear in diagnostics",
      description: "Create diagnostics Reviewer",
      identity
    });

    adapter
      .getDatabase()
      .prepare("UPDATE members SET status = ? WHERE member_id = ?")
      .run(MEMBER_STATUSES.running, builder.debug.internal_member_id);
    adapter
      .getDatabase()
      .prepare("UPDATE members SET status = ? WHERE member_id = ?")
      .run(MEMBER_STATUSES.idle, reviewer.debug.internal_member_id);

    const messageService = new MessageService({
      db: adapter.getDatabase(),
      statePath
    });
    messageService.sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Sensitive running message body must not appear in diagnostics",
      summary: "running message",
      identity
    });
    messageService.sendMessage({
      teamName: "alpha-team",
      to: "Reviewer",
      message: "Sensitive idle message body must not appear in diagnostics",
      summary: "idle message",
      identity
    });

    const taskService = new TaskService({
      db: adapter.getDatabase(),
      statePath
    });
    const assigned = taskService.createTask({
      teamName: "alpha-team",
      subject: "Diagnostics assigned task",
      description: "Sensitive diagnostics task description must not appear",
      owner: "Reviewer",
      identity
    });
    const blocker = taskService.createTask({
      teamName: "alpha-team",
      subject: "Diagnostics blocker task",
      identity
    });
    taskService.updateTask({
      teamName: "alpha-team",
      taskId: assigned.public_task_id,
      status: TASK_STATUSES.inProgress,
      notes: "Sensitive diagnostics task note must not appear",
      addBlockedBy: [blocker.public_task_id],
      identity
    });
  } finally {
    adapter.close();
  }
}

function createLifecycleStateForDiagnostics(input: {
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
  const isolatedWorkspace = createTempStateRoot();

  try {
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({
      db: adapter.getDatabase(),
      statePath
    }).createTeam({
      teamName: "Alpha Team",
      description: "Diagnostics lifecycle team",
      identity
    });
    const created = new AgentService({
      db: adapter.getDatabase(),
      statePath
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: SECRET_PHASE5_DIAGNOSTICS_PROMPT,
      description: "Create lifecycle diagnostics Builder",
      identity
    });

    adapter
      .getDatabase()
      .prepare(
        `
          UPDATE ${TABLE_NAMES.members}
          SET status = ?
          WHERE member_id = ?
        `
      )
      .run(MEMBER_STATUSES.running, created.debug.internal_member_id);
    adapter
      .getDatabase()
      .prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET status = ?,
              backend = ?,
              backend_status = ?,
              backend_run_id = ?,
              backend_thread_id = ?,
              backend_process_id = ?,
              workspace_path = ?,
              base_revision = ?,
              review_status = ?,
              changed_files_json = ?,
              last_error = ?,
              updated_at = ?
          WHERE run_id = ?
        `
      )
      .run(
        MEMBER_STATUSES.running,
        "fake-backend",
        RUN_BACKEND_STATUSES.running,
        "backend-run-debug",
        "thread-debug",
        "process-debug",
        isolatedWorkspace,
        "base-debug",
        RUN_REVIEW_STATUSES.needsReview,
        JSON.stringify(["changed.ts"]),
        "Sensitive diagnostics prompt last_error should not appear",
        "2026-06-05T00:00:00.000Z",
        created.run_id
      );
  } finally {
    adapter.close();
  }
}

function createTeammatesWithRealStatusForDiagnostics(input: {
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

  try {
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "OBS-01 per-teammate status team",
      identity
    });
    const agentService = new AgentService({ db, statePath });
    const create = (name: string): ScheduledAgentLike =>
      agentService.createAgent({
        name,
        teamName: "alpha-team",
        prompt: SECRET_OBS01_TEAMMATE_PROMPT,
        description: `Create OBS-01 ${name}`,
        identity
      }) as unknown as ScheduledAgentLike;

    const runner = create("Runner");
    const reviewer = create("Reviewer");
    const staley = create("Staley");
    const blocked = create("Blocked");
    const attachy = create("Attachy");

    const setMemberStatus = (memberId: string, status: string): void => {
      db.prepare(
        `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`
      ).run(status, memberId);
    };
    const setRun = (runId: string, columns: Record<string, string>): void => {
      const assignments = Object.keys(columns)
        .map((column) => `${column} = ?`)
        .join(", ");
      db.prepare(
        `UPDATE ${TABLE_NAMES.runs} SET ${assignments} WHERE run_id = ?`
      ).run(...Object.values(columns), runId);
    };

    // Runner: running.
    setMemberStatus(runner.debug.internal_member_id, MEMBER_STATUSES.running);
    setRun(runner.run_id, {
      backend_status: RUN_BACKEND_STATUSES.running,
      review_status: RUN_REVIEW_STATUSES.none
    });

    // Reviewer: idle + needs_review derived flag.
    setMemberStatus(reviewer.debug.internal_member_id, MEMBER_STATUSES.idle);
    setRun(reviewer.run_id, {
      backend_status: RUN_BACKEND_STATUSES.idle,
      review_status: RUN_REVIEW_STATUSES.needsReview
    });

    // Staley: stale.
    setMemberStatus(staley.debug.internal_member_id, MEMBER_STATUSES.stale);

    // Blocked: scheduled run whose backend never started ->
    // codex_session_metadata_unavailable maps to OBS-01 `unavailable`.
    setRun(blocked.run_id, {
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: "codex_session_metadata_unavailable",
      review_status: RUN_REVIEW_STATUSES.none
    });

    // Attachy: running with a persisted available pane -> attached:true.
    setMemberStatus(attachy.debug.internal_member_id, MEMBER_STATUSES.running);
    setRun(attachy.run_id, {
      backend_status: RUN_BACKEND_STATUSES.running,
      review_status: RUN_REVIEW_STATUSES.none,
      metadata_json: JSON.stringify({
        prompt: SECRET_OBS01_TEAMMATE_PROMPT,
        backend_metadata: {
          pane: {
            mode: "pane",
            backend_type: "tmux",
            availability_status: "available",
            pane_id: "%21",
            session_name: "codex-team-alpha-team"
          }
        }
      })
    });
  } finally {
    adapter.close();
  }
}

// Finalize-on-poll fixtures: a real detached codex_cli_exec run that is durably
// `running` with a per-run JSONL log on disk. The injected CodexCliExecutionBackend
// reconciles purely from that log (+ pid liveness) — no real `codex` binary is
// spawned (the availability probe is faked) so reconcile is deterministic in CI.
function seedRunningCodexExecRun(input: {
  stateRoot: string;
  workspaceRoot: string;
  callerMetadata: unknown;
  name: string;
  prompt: string;
  logLines: string[];
  processId?: number;
}): { runId: string; memberId: string; logPath: string } {
  const caller = normalizeCallerMetadata(input.callerMetadata);
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot: input.workspaceRoot,
    caller
  });
  const adapter = new DurableStateAdapter({
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot
  });

  try {
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Finalize-on-poll diagnostics team",
      identity
    });
    const created = new AgentService({ db, statePath }).createAgent({
      name: input.name,
      teamName: "alpha-team",
      prompt: input.prompt,
      description: `Create finalize-on-poll ${input.name}`,
      identity
    }) as unknown as ScheduledAgentLike;

    // The per-run codex JSONL log lives on disk OUTSIDE the transcript.
    const logDir = createTempStateRoot();
    const logPath = path.join(logDir, `${input.name.toLowerCase()}-run.jsonl`);
    writeFileSync(logPath, input.logLines.join("\n"));

    db.prepare(
      `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`
    ).run(MEMBER_STATUSES.running, created.debug.internal_member_id);
    db.prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_process_id = ?,
            metadata_json = ?
        WHERE run_id = ?
      `
    ).run(
      MEMBER_STATUSES.running,
      "codex_cli_exec",
      RUN_BACKEND_STATUSES.running,
      input.processId !== undefined ? String(input.processId) : null,
      JSON.stringify({
        prompt: input.prompt,
        backend_metadata: { exec_log_path: logPath }
      }),
      created.run_id
    );

    return {
      runId: created.run_id,
      memberId: created.debug.internal_member_id,
      logPath
    };
  } finally {
    adapter.close();
  }
}

// A CodexCliExecutionBackend whose availability probe is faked (never spawns a
// real `codex exec --help`). reconcileRun never touches the probe — it reads the
// per-run log + checks pid liveness — so reconcile stays fully deterministic.
function createCodexExecBackendForDiagnostics(): CodexCliExecutionBackend {
  return new CodexCliExecutionBackend({
    runner: createTerminalCommandRunner({
      executor: () => ({ stdout: "", stderr: "", exitCode: 0, exit_code: 0 })
    })
  });
}

function countEventsByType(
  stateRoot: string,
  workspaceRoot: string,
  eventType: string
): number {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    const row = adapter
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM ${TABLE_NAMES.events} WHERE event_type = ?`
      )
      .get(eventType) as { count: number };
    return row.count;
  } finally {
    adapter.close();
  }
}

function readRunAndMemberStatus(
  stateRoot: string,
  workspaceRoot: string,
  runId: string,
  memberId: string
): { runStatus: string; runBackendStatus: string; memberStatus: string } {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    const db = adapter.getDatabase();
    const run = db
      .prepare(
        `SELECT status, backend_status FROM ${TABLE_NAMES.runs} WHERE run_id = ?`
      )
      .get(runId) as { status: string; backend_status: string };
    const member = db
      .prepare(`SELECT status FROM ${TABLE_NAMES.members} WHERE member_id = ?`)
      .get(memberId) as { status: string };
    return {
      runStatus: run.status,
      runBackendStatus: run.backend_status,
      memberStatus: member.status
    };
  } finally {
    adapter.close();
  }
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("TeamDiagnostics payload", () => {
  it("reports package, registry, fallback caller, durable state, and execution scaffold status", () => {
    const stateRoot = createTempStateRoot();
    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot: "/workspace",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.package.name).toBe("codex-team-mcp");
    expect(payload.phase).toBe("05-lifecycle-isolation-and-status");
    expect(payload.tools.targetClaudeTools).toEqual([...TARGET_CLAUDE_TOOLS]);
    expect(payload.tools.registeredTools).toEqual(
      COMPATIBILITY_TOOLS.map((tool) => tool.codexToolName)
    );
    expect(payload.fallbackCallerKey).toBe("codex-team:anonymous-local");
    expect(payload.caller.callerKey).toBe("codex-team:anonymous-local");
    expect(payload.caller.fallbackUsed).toBe(true);
    expect(payload.state.durableStateImplemented).toBe(true);
    expect(payload.state).toMatchObject({
      workspaceRoot: path.resolve("/workspace"),
      stateRoot,
      databasePath: path.join(stateRoot, STATE_DB_FILENAME),
      warnings: [],
      migrationStatus: {
        status: "up_to_date",
        latestVersion: 8,
        targetVersion: 8,
        pendingMigrations: []
      },
      tableCounts: {
        schema_migrations: 8,
        teams: 0,
        members: 0,
        active_bindings: 0,
        component_initializations: 0,
        messages: 0,
        tasks: 0,
        task_edges: 0,
        task_events: 0,
        runs: 0,
        events: 0
      },
      messageSummary: {
        total: 0,
        queued: 0,
        by_delivery_status: {}
      },
      taskSummary: {
        total: 0,
        by_status: {},
        assigned: 0,
        blocked: 0
      },
      recentEvents: []
    });
    expect(payload.lifecycleSummary).toEqual({
      total: 0,
      by_status: {}
    });
    expect(payload.runSummary).toEqual({
      total: 0,
      by_status: {},
      by_backend_status: {},
      stale: 0
    });
    expect(payload.workspaceReviewSummary).toEqual({
      pending_review: 0,
      needs_review: 0,
      with_workspace_path: 0,
      merged: 0,
      merge_conflict: 0,
      escalated: 0
    });
    expect(payload.reconciliationSummary).toMatchObject({
      teams: 0,
      staleRunsMarked: 0,
      orphanedQueuedMessages: 0,
      missingRunLinks: 0,
      orphanedRuns: 0,
      reviewNeededWorkspaces: 0
    });
    expect(payload.execution).toMatchObject({
      status: "scheduled_only",
      backend: "none",
      backend_status: "not_started",
      teammateExecutionImplemented: false
    });
  });

  it("reports implemented lifecycle and Agent tool statuses in diagnostics mapping", () => {
    const payload = buildDiagnosticsPayload({
      stateRoot: createTempStateRoot(),
      workspaceRoot: "/workspace",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const statusByTool = Object.fromEntries(
      payload.tools.mapping.map((tool) => [tool.codexToolName, tool.status])
    );

    expect(statusByTool).toMatchObject({
      TeamCreate: "implemented",
      TeamDelete: "implemented",
      Agent: "implemented",
      SendMessage: "implemented",
      TaskCreate: "implemented",
      TaskUpdate: "implemented",
      TaskList: "implemented",
      TaskGet: "implemented",
      TeamDiagnostics: "implemented"
    });
    expect(payload.execution).toMatchObject({
      status: "scheduled_only",
      backend: "none",
      backend_status: "not_started",
      teammateExecutionImplemented: false
    });
  });

  it("reports active binding, known teams, and recent durable events", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const created = createTeamForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.state).toMatchObject({
      durableStateImplemented: true,
      tableCounts: {
        teams: 1,
        members: 1,
        active_bindings: 1,
        component_initializations: 4,
        messages: 0,
        tasks: 0,
        task_edges: 0,
        task_events: 0,
        events: 7
      },
      messageSummary: {
        total: 0,
        queued: 0,
        by_delivery_status: {}
      },
      taskSummary: {
        total: 0,
        by_status: {},
        assigned: 0,
        blocked: 0
      },
      activeBinding: {
        binding_key: created.bindingKey,
        caller_key: created.callerKey,
        team_name: "alpha-team",
        status: ACTIVE_BINDING_STATUSES.active,
        fallback_used: false
      },
      knownTeams: [
        {
          team_name: "alpha-team",
          status: "active",
          lead_agent_id: "team-lead@alpha-team"
        }
      ]
    });
    expect(payload.state.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.teamCreated,
          team_id: expect.any(String)
        })
      ])
    );
    expect(payload.execution).toMatchObject({
      status: "scheduled_only",
      backend: "none",
      backend_status: "not_started",
      teammateExecutionImplemented: false
    });
  });

  it("reports sanitized message and task summaries without raw bodies or task text", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createMessageAndTaskStateForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const serialized = JSON.stringify(payload);

    expect(payload.state).toMatchObject({
      tableCounts: {
        teams: 1,
        members: 3,
        messages: 3,
        tasks: 2,
        task_edges: 1
      },
      messageSummary: {
        total: 3,
        queued: 3,
        by_delivery_status: {
          [MESSAGE_DELIVERY_STATUSES.queuedForNextTurn]: 1,
          [MESSAGE_DELIVERY_STATUSES.queuedWhileIdle]: 2
        }
      },
      taskSummary: {
        total: 2,
        by_status: {
          [TASK_STATUSES.inProgress]: 1,
          [TASK_STATUSES.pending]: 1
        },
        assigned: 1,
        blocked: 1
      }
    });
    expect(serialized).not.toContain("Sensitive running message body");
    expect(serialized).not.toContain("Sensitive idle message body");
    expect(serialized).not.toContain("Sensitive diagnostics task description");
    expect(serialized).not.toContain("Sensitive diagnostics task note");
    expect(serialized).not.toContain("Sensitive Builder prompt");
    expect(serialized).not.toContain("Sensitive Reviewer prompt");
    expect(serialized).not.toContain("payload_json");
    expect(serialized).not.toContain("body_json");
    expect(serialized).not.toContain("\"prompt\"");
    expect(serialized).not.toContain("\"message\"");
    expect(serialized).not.toContain("\"body\"");
    expect(serialized).not.toContain("\"notes\"");
  });

  it("reports Phase 5 lifecycle, run, review, and reconciliation summaries by default", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createLifecycleStateForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const serialized = JSON.stringify(payload);

    expect(payload.lifecycleSummary).toMatchObject({
      total: 2,
      by_status: {
        [MEMBER_STATUSES.active]: 1,
        [MEMBER_STATUSES.running]: 1
      }
    });
    expect(payload.runSummary).toMatchObject({
      total: 1,
      by_status: {
        [MEMBER_STATUSES.running]: 1
      },
      by_backend_status: {
        [RUN_BACKEND_STATUSES.running]: 1
      },
      stale: 0
    });
    expect(payload.workspaceReviewSummary).toMatchObject({
      pending_review: 0,
      needs_review: 1,
      with_workspace_path: 1
    });
    // TeamDiagnostics reconciles in FINALIZE mode (finalize-on-poll): it observes
    // statuses (staleRunsMarked counts the scaffold backend's unsupported result,
    // reviewNeededWorkspaces reflects the durable review_status) but performs NO
    // mutation here — the running run is NOT marked stale, the workspace-inspection
    // loop is SKIPPED (workspaceInspectionFailures stays 0), and no events are
    // appended (the run reconciles to a stale, non-terminal outcome). Only a
    // terminal idle/failed running run would be finalized + emit one event.
    expect(payload.reconciliationSummary).toMatchObject({
      teams: 1,
      runningRunsChecked: 1,
      staleRunsMarked: 1,
      reviewNeededWorkspaces: 1,
      workspaceInspectionFailures: 0,
      eventsAppended: 0
    });
    expect(serialized).toContain("needs_review");
    expect(serialized).not.toContain(SECRET_PHASE5_DIAGNOSTICS_PROMPT);
    expect(serialized).not.toContain("Sensitive diagnostics prompt last_error");
    expect(serialized).not.toContain("payload_json");
    expect(serialized).not.toContain("\"prompt\"");
  });

  it("includes sanitized run debug metadata when requested", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createLifecycleStateForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const serialized = JSON.stringify(payload);
    const debugSerialized = JSON.stringify(payload.debug);

    expect(payload.debug?.runs).toEqual([
      expect.objectContaining({
        run_id: expect.stringMatching(/^run:/),
        member_id: expect.stringMatching(/^teammate:/),
        backend: "fake-backend",
        backend_status: RUN_BACKEND_STATUSES.running,
        backend_run_id: "backend-run-debug",
        backend_thread_id: "thread-debug",
        backend_process_id: "process-debug",
        base_revision: "base-debug",
        review_status: RUN_REVIEW_STATUSES.needsReview,
        changed_files: ["changed.ts"],
        last_error: "[redacted_sensitive]"
      })
    ]);
    expect(serialized).toContain("needs_review");
    expect(serialized).not.toContain(SECRET_PHASE5_DIAGNOSTICS_PROMPT);
    expect(serialized).not.toContain("Sensitive diagnostics prompt last_error");
    expect(debugSerialized).not.toContain("payload_json");
    expect(debugSerialized).not.toContain("\"prompt\"");
    expect(debugSerialized).not.toContain("\"message\"");
    expect(debugSerialized).not.toContain("\"body\"");
    expect(debugSerialized).not.toContain("\"notes\"");
    expect(debugSerialized).not.toContain("\"description\"");
  });

  it("reports merge/conflict/escalated counts plus debug branch and merge commit", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/merge-diag";
    const callerMetadata = { sessionId: "merge-diag", clientName: "codex" };
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot,
      caller: normalizeCallerMetadata(callerMetadata)
    });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Merge diagnostics team",
      identity
    });
    const agentService = new AgentService({ db, statePath });
    const mk = (name: string): ScheduledAgentLike =>
      agentService.createAgent({
        name,
        teamName: "alpha-team",
        prompt: SECRET_PHASE5_DIAGNOSTICS_PROMPT,
        description: `Create merge diagnostics ${name}`,
        identity
      }) as unknown as ScheduledAgentLike;

    const merged = mk("Merged");
    const conflicted = mk("Conflicted");
    const escalated = mk("Escalated");
    // A non-merge run (left at its scaffold review_status) proves merge_status is
    // null for runs whose review_status is not merge-related.
    mk("Pending");

    const setRun = (runId: string, columns: Record<string, string>): void => {
      const assignments = Object.keys(columns)
        .map((column) => `${column} = ?`)
        .join(", ");
      db.prepare(
        `UPDATE ${TABLE_NAMES.runs} SET ${assignments} WHERE run_id = ?`
      ).run(...Object.values(columns), runId);
    };

    setRun(merged.run_id, {
      isolation_kind: "git_worktree",
      review_status: RUN_REVIEW_STATUSES.merged,
      workspace_path: "/tmp/wt-merged",
      base_revision: "base-merged",
      worktree_branch: "codex-team/alpha-team/merged/r1",
      merge_commit: "abc1234def"
    });
    setRun(conflicted.run_id, {
      isolation_kind: "git_worktree",
      review_status: RUN_REVIEW_STATUSES.mergeConflict,
      workspace_path: "/tmp/wt-conflicted",
      base_revision: "base-conflicted",
      worktree_branch: "codex-team/alpha-team/conflicted/r2",
      merge_conflict_files_json: JSON.stringify(["tracked.txt"])
    });
    setRun(escalated.run_id, {
      isolation_kind: "git_worktree",
      review_status: RUN_REVIEW_STATUSES.escalated,
      workspace_path: "/tmp/wt-escalated",
      base_revision: "base-escalated",
      worktree_branch: "codex-team/alpha-team/escalated/r3"
    });
    adapter.close();

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.workspaceReviewSummary).toMatchObject({
      merged: 1,
      merge_conflict: 1,
      escalated: 1
    });

    const debugRuns = payload.debug?.runs ?? [];
    const mergedRow = debugRuns.find(
      (row) => row.review_status === RUN_REVIEW_STATUSES.merged
    );
    expect(mergedRow).toMatchObject({
      merge_status: RUN_REVIEW_STATUSES.merged,
      worktree_branch: "codex-team/alpha-team/merged/r1",
      merge_commit: "abc1234def"
    });
    const conflictRow = debugRuns.find(
      (row) => row.review_status === RUN_REVIEW_STATUSES.mergeConflict
    );
    expect(conflictRow?.merge_status).toBe(RUN_REVIEW_STATUSES.mergeConflict);
    const escalatedRow = debugRuns.find(
      (row) => row.review_status === RUN_REVIEW_STATUSES.escalated
    );
    expect(escalatedRow?.merge_status).toBe(RUN_REVIEW_STATUSES.escalated);
    // A non-merge run reports merge_status null (review_status is not merge-related).
    const pendingRow = debugRuns.find(
      (row) => row.merge_status === null
    );
    expect(pendingRow).toBeDefined();

    // Redaction: no secret/prompt/diff content surfaced.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_PHASE5_DIAGNOSTICS_PROMPT);
    expect(serialized).not.toContain("\"prompt\"");
  });

  it("scopes recent events to the diagnostics workspace for shared state roots", () => {
    const stateRoot = createTempStateRoot();
    const firstWorkspace = "/workspace/one";
    const secondWorkspace = "/workspace/two";
    const firstCallerMetadata = { sessionId: "session-one", clientName: "codex" };
    const secondCallerMetadata = { sessionId: "session-two", clientName: "codex" };

    createTeamForDiagnostics({
      stateRoot,
      workspaceRoot: firstWorkspace,
      callerMetadata: firstCallerMetadata
    });
    createTeamForDiagnostics({
      stateRoot,
      workspaceRoot: secondWorkspace,
      callerMetadata: secondCallerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot: firstWorkspace,
      callerMetadata: firstCallerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const recentEvents = payload.state.status === "durable"
      ? payload.state.recentEvents
      : [];
    const serializedEvents = JSON.stringify(recentEvents);

    expect(recentEvents.length).toBeGreaterThan(0);
    expect(recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_root: path.resolve(firstWorkspace),
          event_type: EVENT_TYPES.teamCreated
        })
      ])
    );
    for (const event of recentEvents) {
      expect(event.workspace_root).toBe(path.resolve(firstWorkspace));
    }
    expect(serializedEvents).not.toContain(path.resolve(secondWorkspace));
    expect(payload.state).toMatchObject({
      knownTeams: [
        {
          workspace_root: path.resolve(firstWorkspace),
          team_name: "alpha-team"
        }
      ]
    });
  });

  it("keeps scheduled TeamMate recent events sanitized in diagnostics", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createScheduledTeamMateForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const recentEvents = payload.state.status === "durable"
      ? payload.state.recentEvents
      : [];
    const serializedEvents = JSON.stringify(recentEvents);

    expect(payload.state).toMatchObject({
      tableCounts: {
        teams: 1,
        members: 2,
        runs: 1
      }
    });
    expect(recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: EVENT_TYPES.teammateCreated }),
        expect.objectContaining({ event_type: EVENT_TYPES.teammateRunScheduled })
      ])
    );
    for (const event of recentEvents) {
      expect(event).not.toHaveProperty("payload_json");
      expect(event).not.toHaveProperty("prompt");
      expect(event).not.toHaveProperty("message");
      expect(event).not.toHaveProperty("body");
      expect(event).not.toHaveProperty("notes");
      expect(event).not.toHaveProperty("description");
    }
    expect(serializedEvents).not.toContain("payload_json");
    expect(serializedEvents).not.toContain("prompt");
    expect(serializedEvents).not.toContain("message");
    expect(serializedEvents).not.toContain("body");
    expect(serializedEvents).not.toContain("notes");
    expect(serializedEvents).not.toContain("description");
  });

  it("surfaces the sanitized run deliverable from the codex log (default preview + full under include_debug)", () => {
    const stateRoot = createTempStateRoot();
    const logDir = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const deliverablePrompt = "implement the billing summary feature";
    const deliverableSecret = "SECRET_DELIVERABLE_LEAK";

    const caller = normalizeCallerMetadata(callerMetadata);
    const identity = buildWorkspaceScopedCallerIdentity({ workspaceRoot, caller });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Deliverable diagnostics team",
      identity
    });
    const created = new AgentService({ db, statePath }).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: deliverablePrompt,
      description: "Create deliverable diagnostics Researcher",
      identity
    }) as unknown as ScheduledAgentLike;

    // The per-run codex JSONL log lives on disk OUTSIDE the transcript. It echoes
    // the prompt + a secret to prove both are redacted out of the surfaced result.
    const logPath = path.join(logDir, "researcher-run.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-deliverable" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: `Completed ${deliverablePrompt}. Internal token ${deliverableSecret}. Billing healthy.`
          }
        }),
        JSON.stringify({ type: "turn.completed" })
      ].join("\n")
    );

    db.prepare(
      `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`
    ).run(MEMBER_STATUSES.idle, created.debug.internal_member_id);
    db.prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_thread_id = ?,
            metadata_json = ?
        WHERE run_id = ?
      `
    ).run(
      MEMBER_STATUSES.idle,
      "codex_cli_exec",
      RUN_BACKEND_STATUSES.idle,
      "thread-deliverable",
      JSON.stringify({
        prompt: deliverablePrompt,
        backend_metadata: { exec_log_path: logPath }
      }),
      created.run_id
    );
    adapter.close();

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    const researcher = payload.teammates.find(
      (teammate) => teammate.teammate_id === "researcher@alpha-team"
    );
    expect(researcher?.result_preview).toContain("Billing healthy.");

    const debugRow = (payload.debug?.runs ?? []).find(
      (row) => row.run_id === created.run_id
    );
    expect(debugRow?.final_message).toContain("Completed");
    expect(debugRow?.final_message).toContain("Billing healthy.");

    // D-02: the surfaced deliverable redacts the run's own prompt + secret tokens.
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("[redacted_prompt]");
    expect(serialized).toContain("[redacted_secret]");
    expect(serialized).not.toContain(deliverablePrompt);
    expect(serialized).not.toContain(deliverableSecret);
  });

  it("relocates a pane-hosted run's deliverable by workspace cwd when rollout_path was never captured at start", () => {
    const stateRoot = createTempStateRoot();
    const codexHome = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    // The run's UNIQUE isolated worktree path. It IS persisted (metadata.workspace_path)
    // and pins the rollout via session_meta.cwd, the same way reconcile relocates it.
    const workspaceCwd = "/workspace/.codex-team/worktrees/sprite-cold-start";
    // The prompt must NOT overlap the deliverable text, or D-02 redaction would
    // rewrite it and the substring assertions below would falsely fail.
    const prompt = "wire up the pane cold-start rollout relocation path";

    // Codex always writes a full rollout transcript at
    // <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl. The FIRST line is a
    // session_meta carrying the worktree cwd; a trailing assistant message + task_complete
    // make this a completed turn with a real deliverable.
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const rolloutDir = path.join(codexHome, "sessions", "2026", "06", "11");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = path.join(
      rolloutDir,
      `rollout-2026-06-11T10-00-00-${sessionId}.jsonl`
    );
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, cwd: workspaceCwd }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "已完成。author=Sprite" }]
          }
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
      ].join("\n")
    );

    const caller = normalizeCallerMetadata(callerMetadata);
    const identity = buildWorkspaceScopedCallerIdentity({ workspaceRoot, caller });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Cold-start relocation diagnostics team",
      identity
    });
    const created = new AgentService({ db, statePath }).createAgent({
      name: "Sprite",
      teamName: "alpha-team",
      prompt,
      description: "Create cold-start relocation Sprite",
      identity
    }) as unknown as ScheduledAgentLike;

    db.prepare(
      `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`
    ).run(MEMBER_STATUSES.idle, created.debug.internal_member_id);
    // Pane-hosted run: backend_metadata carries ONLY pane info — NO rollout_path and
    // NO exec_log_path were captured at start (the cold-start codex wrote session_meta
    // after the bounded startRun poll window). workspace_path IS persisted.
    db.prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            workspace_path = ?,
            metadata_json = ?
        WHERE run_id = ?
      `
    ).run(
      MEMBER_STATUSES.idle,
      "iterm2",
      RUN_BACKEND_STATUSES.idle,
      workspaceCwd,
      JSON.stringify({
        prompt,
        workspace_path: workspaceCwd,
        backend_metadata: {
          pane: {
            mode: "pane",
            backend_type: "iterm2",
            availability_status: "available",
            is_native: true
          }
        }
      }),
      created.run_id
    );
    adapter.close();

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const payload = buildDiagnosticsPayload({
        stateRoot,
        workspaceRoot,
        callerMetadata,
        includeDebug: true,
        targetClaudeTools: TARGET_CLAUDE_TOOLS,
        registeredTools: COMPATIBILITY_TOOLS
      });

      const debugRow = (payload.debug?.runs ?? []).find(
        (row) => row.run_id === created.run_id
      );
      // Without the cwd fallback the deliverable is unreachable (no exec log, no
      // persisted rollout_path) → final_message is null. The relocation recovers it.
      expect(debugRow?.final_message).toContain("已完成");
      expect(debugRow?.final_message).toContain("Sprite");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("preserves observed caller metadata when provided", () => {
    const payload = buildDiagnosticsPayload({
      stateRoot: createTempStateRoot(),
      workspaceRoot: "/workspace",
      callerMetadata: { sessionId: "session-1", clientName: "codex" }
    });

    expect(payload.caller.fallbackUsed).toBe(false);
    expect(payload.caller.callerKey).toBe("codex-team:sessionId:session-1");
    expect(payload.caller.observedMetadata).toEqual({
      sessionId: "session-1",
      clientName: "codex"
    });
  });

  it("reports fallback caller identity while preserving observed request and client metadata", () => {
    const payload = buildDiagnosticsPayload({
      stateRoot: createTempStateRoot(),
      workspaceRoot: "/workspace",
      callerMetadata: { requestId: "req-1", clientName: "codex" }
    });
    const serialized = JSON.stringify(payload);

    expect(payload.caller).toEqual({
      callerKey: FALLBACK_CALLER_KEY,
      fallbackUsed: true,
      observedMetadata: { requestId: "req-1", clientName: "codex" }
    });
    expect(serialized).not.toContain("codex-team:requestId:req-1");
    expect(serialized).not.toContain("codex-team:clientName:codex");
  });

  it("reports fallback active binding for diagnostics after request and client metadata create a team", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const created = createTeamForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata: { requestId: "req-1", clientName: "codex" }
    });

    expect(created.callerKey).toBe(FALLBACK_CALLER_KEY);

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: { requestId: "req-2", clientName: "codex" }
    });
    const serialized = JSON.stringify(payload);

    expect(payload.caller).toEqual({
      callerKey: FALLBACK_CALLER_KEY,
      fallbackUsed: true,
      observedMetadata: { requestId: "req-2", clientName: "codex" }
    });
    expect(payload.state).toMatchObject({
      activeBinding: {
        binding_key: created.bindingKey,
        caller_key: FALLBACK_CALLER_KEY,
        team_name: "alpha-team",
        status: ACTIVE_BINDING_STATUSES.active,
        fallback_used: true
      }
    });
    expect(serialized).not.toContain("codex-team:requestId:req-1");
    expect(serialized).not.toContain("codex-team:requestId:req-2");
    expect(serialized).not.toContain("codex-team:clientName:codex");
  });

  it("reports per-teammate real backend status (OBS-01)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createTeammatesWithRealStatusForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const byTeammateId = Object.fromEntries(
      payload.teammates.map((teammate) => [teammate.teammate_id, teammate])
    );
    const serialized = JSON.stringify(payload.teammates);

    // Lead (role:leader) is excluded; only the five teammates appear.
    expect(payload.teammates).toHaveLength(5);

    expect(byTeammateId["runner@alpha-team"]).toMatchObject({
      display_name: "Runner",
      status: MEMBER_STATUSES.running,
      attached: false,
      needs_review: false
    });
    expect(byTeammateId["reviewer@alpha-team"]).toMatchObject({
      status: MEMBER_STATUSES.idle,
      needs_review: true
    });
    expect(byTeammateId["staley@alpha-team"]).toMatchObject({
      status: MEMBER_STATUSES.stale
    });
    expect(byTeammateId["blocked@alpha-team"]).toMatchObject({
      // scheduled run whose backend never started -> unavailable.
      status: "unavailable"
    });
    expect(byTeammateId["attachy@alpha-team"]).toMatchObject({
      status: MEMBER_STATUSES.running,
      // Persisted available pane metadata derives the attached flag.
      attached: true
    });

    // Every row carries member_id + a concise status; no raw prompt leaks.
    for (const teammate of payload.teammates) {
      expect(typeof teammate.member_id).toBe("string");
      expect(typeof teammate.status).toBe("string");
    }
    expect(serialized).not.toContain(SECRET_OBS01_TEAMMATE_PROMPT);
  });

  it("keeps per-teammate rows free of raw prompt and unsanitized metadata (OBS-01 / D-02)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };

    createTeammatesWithRealStatusForDiagnostics({
      stateRoot,
      workspaceRoot,
      callerMetadata
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const serialized = JSON.stringify(payload.teammates);

    expect(serialized).not.toContain(SECRET_OBS01_TEAMMATE_PROMPT);
    for (const rawKey of [
      "\"prompt\"",
      "\"message\"",
      "\"body\"",
      "\"description\"",
      "\"notes\"",
      "payload_json",
      "transcript"
    ]) {
      expect(serialized).not.toContain(rawKey);
    }
    for (const teammate of payload.teammates) {
      expect(teammate).not.toHaveProperty("prompt");
      expect(teammate).not.toHaveProperty("metadata_json");
      expect(teammate).not.toHaveProperty("description");
    }
  });

  it("finalizes a completed detached run to idle on poll and surfaces its deliverable", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const prompt = "implement the billing summary feature";
    const secret = "SECRET_FINALIZE_LEAK";

    const seeded = seedRunningCodexExecRun({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      name: "Finisher",
      prompt,
      // turn.completed in the log → the detached run finished in the background.
      logLines: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-finisher" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: `Completed ${prompt}. Token ${secret}. Billing summary shipped.`
          }
        }),
        JSON.stringify({ type: "turn.completed" })
      ]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      executionBackend: createCodexExecBackendForDiagnostics(),
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    // The teammate row reflects the freshly finalized status (read AFTER reconcile).
    const finisher = payload.teammates.find(
      (teammate) => teammate.teammate_id === "finisher@alpha-team"
    );
    expect(finisher?.status).toBe(MEMBER_STATUSES.idle);
    expect(finisher?.result_preview).toContain("Billing summary shipped.");

    // Durable state was finalized running → idle (member + run), not left running.
    const status = readRunAndMemberStatus(
      stateRoot,
      workspaceRoot,
      seeded.runId,
      seeded.memberId
    );
    expect(status).toMatchObject({
      runStatus: MEMBER_STATUSES.idle,
      runBackendStatus: RUN_BACKEND_STATUSES.idle,
      memberStatus: MEMBER_STATUSES.idle
    });

    // Exactly one completion event was appended by the finalize-on-poll.
    expect(
      countEventsByType(stateRoot, workspaceRoot, EVENT_TYPES.teammateRunCompleted)
    ).toBe(1);

    // D-02: the surfaced deliverable stays sanitized — prompt + secret redacted.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
    expect(serialized).toContain("[redacted_secret]");
  });

  it("finalizes a crashed/failed detached run to failed with a sanitized reason", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const prompt = "rotate the production credentials";
    const secret = "SECRET_TURN_FAILURE_LEAK";

    const seeded = seedRunningCodexExecRun({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      name: "Boomer",
      prompt,
      // turn.failed in the log → the detached run failed in the background. The
      // error message echoes the prompt + a secret to prove both are redacted.
      logLines: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-boomer" }),
        JSON.stringify({
          type: "turn.failed",
          error: {
            message: `model overloaded while running "${prompt}" with ${secret}`
          }
        })
      ]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      includeDebug: true,
      executionBackend: createCodexExecBackendForDiagnostics(),
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    const boomer = payload.teammates.find(
      (teammate) => teammate.teammate_id === "boomer@alpha-team"
    );
    expect(boomer?.status).toBe(MEMBER_STATUSES.failed);

    const status = readRunAndMemberStatus(
      stateRoot,
      workspaceRoot,
      seeded.runId,
      seeded.memberId
    );
    expect(status).toMatchObject({
      runStatus: MEMBER_STATUSES.failed,
      runBackendStatus: RUN_BACKEND_STATUSES.failed,
      memberStatus: MEMBER_STATUSES.failed
    });

    // The sanitized failure reason surfaces in the debug run row (D-02-safe).
    const debugRow = (payload.debug?.runs ?? []).find(
      (row) => row.run_id === seeded.runId
    );
    expect(debugRow?.last_error).toContain("codex_exec_turn_failed");
    expect(debugRow?.last_error).toContain("[redacted_secret]");
    expect(debugRow?.last_error).toContain("[redacted_prompt]");

    expect(
      countEventsByType(stateRoot, workspaceRoot, EVENT_TYPES.teammateBackendFailed)
    ).toBe(1);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
  });

  it("keeps an alive, still-running detached run running on poll (not stale, not completed)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const prompt = "refactor the retry scheduler";

    const seeded = seedRunningCodexExecRun({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      name: "Livewire",
      prompt,
      // No terminal event yet; the run's pid is alive (this test process), so the
      // backend reconciles to `active` → the run must stay running, not stale.
      logLines: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-livewire" }),
        JSON.stringify({ type: "item.started", item: { type: "agent_message" } })
      ],
      processId: process.pid
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      executionBackend: createCodexExecBackendForDiagnostics(),
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    const livewire = payload.teammates.find(
      (teammate) => teammate.teammate_id === "livewire@alpha-team"
    );
    expect(livewire?.status).toBe(MEMBER_STATUSES.running);

    const status = readRunAndMemberStatus(
      stateRoot,
      workspaceRoot,
      seeded.runId,
      seeded.memberId
    );
    expect(status).toMatchObject({
      runStatus: MEMBER_STATUSES.running,
      runBackendStatus: RUN_BACKEND_STATUSES.running,
      memberStatus: MEMBER_STATUSES.running
    });

    // An active run is neither completed nor marked stale by the diagnostics poll.
    expect(
      countEventsByType(stateRoot, workspaceRoot, EVENT_TYPES.teammateRunCompleted)
    ).toBe(0);
    expect(
      countEventsByType(stateRoot, workspaceRoot, EVENT_TYPES.teammateMarkedStale)
    ).toBe(0);
  });

  it("finalizes a completed detached run exactly once across consecutive polls (idempotent)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const prompt = "summarize the changelog";

    const seeded = seedRunningCodexExecRun({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      name: "Idem",
      prompt,
      logLines: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-idem" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Changelog summarized." }
        }),
        JSON.stringify({ type: "turn.completed" })
      ]
    });

    const runDiagnostics = (): ReturnType<typeof buildDiagnosticsPayload> =>
      buildDiagnosticsPayload({
        stateRoot,
        workspaceRoot,
        callerMetadata,
        executionBackend: createCodexExecBackendForDiagnostics(),
        targetClaudeTools: TARGET_CLAUDE_TOOLS,
        registeredTools: COMPATIBILITY_TOOLS
      });

    // First poll finalizes the run; the second poll sees an already-idle run, so
    // reconcile (which only iterates running runs) does not re-finalize it.
    runDiagnostics();
    const secondPayload = runDiagnostics();

    const idem = secondPayload.teammates.find(
      (teammate) => teammate.teammate_id === "idem@alpha-team"
    );
    expect(idem?.status).toBe(MEMBER_STATUSES.idle);
    expect(idem?.result_preview).toContain("Changelog summarized.");

    const status = readRunAndMemberStatus(
      stateRoot,
      workspaceRoot,
      seeded.runId,
      seeded.memberId
    );
    expect(status.runStatus).toBe(MEMBER_STATUSES.idle);
    expect(status.memberStatus).toBe(MEMBER_STATUSES.idle);

    // Exactly ONE completion event across two consecutive diagnostics calls.
    expect(
      countEventsByType(stateRoot, workspaceRoot, EVENT_TYPES.teammateRunCompleted)
    ).toBe(1);
  });

  it("exposes terminal-context booleans under include_debug matching the injected env (D-02)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";

    // Fake it2 probe: ok only for `it2 session list`.
    const it2RunnerOk = {
      run: (command: string, args: string[]) => {
        const ok = command === "it2" && args.join(" ") === "session list";
        return { ok, stdout: "", stderr: ok ? "" : "no it2", exit_code: ok ? 0 : 1 };
      }
    };

    const itermPayload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      includeDebug: true,
      terminalEnv: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      terminalCommandRunner: it2RunnerOk,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(itermPayload.debug?.terminalContext).toEqual({
      inside_tmux: false,
      in_iterm2: true,
      it2_api_ok: true
    });

    const it2RunnerFail = {
      run: () => ({ ok: false, stdout: "", stderr: "no it2", exit_code: 1 })
    };

    const tmuxPayload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      includeDebug: true,
      terminalEnv: { TMUX: "/tmp/tmux-501/default,1,0" },
      terminalCommandRunner: it2RunnerFail,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(tmuxPayload.debug?.terminalContext).toEqual({
      inside_tmux: true,
      in_iterm2: false,
      it2_api_ok: false
    });

    // D-02: only the three booleans surface — never raw env values or it2 stdout.
    const serialized = JSON.stringify({
      iterm: itermPayload.debug?.terminalContext,
      tmux: tmuxPayload.debug?.terminalContext
    });
    expect(serialized).not.toContain("iTerm.app");
    expect(serialized).not.toContain("w0t0p0");
    expect(serialized).not.toContain("/tmp/tmux-501");
  });

  it("omits the terminal-context block when include_debug is not set", () => {
    const payload = buildDiagnosticsPayload({
      stateRoot: createTempStateRoot(),
      workspaceRoot: "/workspace",
      terminalEnv: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.debug).toBeUndefined();
  });
});

// Phase 17 (UAT): TeamDiagnostics focus filters. The default behavior changed to
// "active team only" — these cover the new default, the opt-outs that restore the
// historical multi-team view, explicit selection, archived opt-in, the bounded
// caps + truncation markers, the teammate filter, and the no-active-team fallback.
interface SeededTeam {
  identity: ReturnType<typeof buildWorkspaceScopedCallerIdentity>;
  teamId: string;
  bindingKey: string;
  callerKey: string;
  members: Record<string, { runId: string; memberId: string }>;
}

function seedFilterTeam(input: {
  stateRoot: string;
  workspaceRoot: string;
  callerMetadata: unknown;
  teamName: string;
  teammates?: string[];
}): SeededTeam {
  const caller = normalizeCallerMetadata(input.callerMetadata);
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot: input.workspaceRoot,
    caller
  });
  const adapter = new DurableStateAdapter({
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot
  });

  try {
    const db = adapter.getDatabase();
    const statePath = adapter.describeStateRoot().stateRoot;
    const created = new TeamService({ db, statePath }).createTeam({
      teamName: input.teamName,
      description: `${input.teamName} focus-filter diagnostics`,
      identity
    });
    const agentService = new AgentService({ db, statePath });
    const members: Record<string, { runId: string; memberId: string }> = {};
    for (const name of input.teammates ?? []) {
      const agent = agentService.createAgent({
        name,
        teamName: created.team_name,
        prompt: `Sensitive ${name} prompt must not appear`,
        description: `Create focus-filter ${name}`,
        identity
      }) as unknown as ScheduledAgentLike;
      members[name] = {
        runId: agent.run_id,
        memberId: agent.debug.internal_member_id
      };
    }

    return {
      identity,
      teamId: created.active_binding.team_id,
      bindingKey: identity.bindingKey,
      callerKey: identity.callerKey,
      members
    };
  } finally {
    adapter.close();
  }
}

function withDiagnosticsDb<T>(
  stateRoot: string,
  workspaceRoot: string,
  fn: (db: ReturnType<DurableStateAdapter["getDatabase"]>) => T
): T {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return fn(adapter.getDatabase());
  } finally {
    adapter.close();
  }
}

function sendDiagnosticsMessages(input: {
  stateRoot: string;
  workspaceRoot: string;
  identity: ReturnType<typeof buildWorkspaceScopedCallerIdentity>;
  teamName: string;
  to: string;
  bodies: string[];
}): void {
  const adapter = new DurableStateAdapter({
    stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot
  });
  try {
    const messageService = new MessageService({
      db: adapter.getDatabase(),
      statePath: adapter.describeStateRoot().stateRoot
    });
    for (const [index, body] of input.bodies.entries()) {
      messageService.sendMessage({
        teamName: input.teamName,
        to: input.to,
        message: body,
        summary: `focus-filter message ${index}`,
        identity: input.identity
      });
    }
  } finally {
    adapter.close();
  }
}

function knownTeamNames(
  payload: ReturnType<typeof buildDiagnosticsPayload>
): string[] {
  return payload.state.status === "durable"
    ? payload.state.knownTeams.map((team) => team.team_name)
    : [];
}

function recentEventsOf(
  payload: ReturnType<typeof buildDiagnosticsPayload>
): unknown[] {
  return payload.state.status === "durable" ? payload.state.recentEvents : [];
}

function teammateIdsOf(
  payload: ReturnType<typeof buildDiagnosticsPayload>
): string[] {
  return payload.teammates.map((teammate) => teammate.teammate_id ?? "");
}

describe("TeamDiagnostics focus filters (Phase 17)", () => {
  it("defaults to the caller's active team only and excludes other workspace teams", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };
    const betaCaller = { sessionId: "beta-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: betaCaller,
      teamName: "Beta Team",
      teammates: ["Outsider"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.scope).toMatchObject({
      mode: "single_team",
      team_name: "alpha-team",
      current_team_only: true,
      include_archived: false,
      include_history: false,
      fallback_reason: null
    });
    expect(knownTeamNames(payload)).toEqual(["alpha-team"]);
    expect(teammateIdsOf(payload)).toContain("builder@alpha-team");
    expect(teammateIdsOf(payload)).not.toContain("outsider@beta-team");
  });

  it("restores multi-team output with current_team_only:false and with include_history:true", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };
    const betaCaller = { sessionId: "beta-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: betaCaller,
      teamName: "Beta Team",
      teammates: ["Outsider"]
    });

    const multi = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      currentTeamOnly: false,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(multi.scope.mode).toBe("multi_team");
    expect(knownTeamNames(multi).sort()).toEqual(["alpha-team", "beta-team"]);
    expect(teammateIdsOf(multi)).toEqual(
      expect.arrayContaining(["builder@alpha-team", "outsider@beta-team"])
    );

    const history = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      includeHistory: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(history.scope.mode).toBe("multi_team");
    expect(knownTeamNames(history).sort()).toEqual(["alpha-team", "beta-team"]);
  });

  it("selects a specific non-active team by team_name", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };
    const betaCaller = { sessionId: "beta-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: betaCaller,
      teamName: "Beta Team",
      teammates: ["Outsider"]
    });

    // alphaCaller is bound to alpha-team, but team_name explicitly selects beta-team.
    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Beta Team",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.scope).toMatchObject({
      mode: "single_team",
      team_name: "beta-team"
    });
    expect(knownTeamNames(payload)).toEqual(["beta-team"]);
    expect(teammateIdsOf(payload)).toEqual(["outsider@beta-team"]);
  });

  it("excludes archived teams by default and includes them under include_archived", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };
    const gammaCaller = { sessionId: "gamma-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    const gamma = seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: gammaCaller,
      teamName: "Gamma Team"
    });
    withDiagnosticsDb(stateRoot, workspaceRoot, (db) => {
      db.prepare(
        `UPDATE ${TABLE_NAMES.teams} SET status = ? WHERE team_id = ?`
      ).run(TEAM_STATUSES.archived, gamma.teamId);
    });

    const byDefault = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      currentTeamOnly: false,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(knownTeamNames(byDefault)).toContain("alpha-team");
    expect(knownTeamNames(byDefault)).not.toContain("gamma-team");

    const withArchived = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      currentTeamOnly: false,
      includeArchived: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(knownTeamNames(withArchived)).toContain("gamma-team");
  });

  it("excludes archived teammates by default and includes them under include_archived", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    const alpha = seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder", "Ghost"]
    });
    withDiagnosticsDb(stateRoot, workspaceRoot, (db) => {
      db.prepare(
        `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`
      ).run(MEMBER_STATUSES.archived, alpha.members.Ghost.memberId);
    });

    const byDefault = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(teammateIdsOf(byDefault)).toContain("builder@alpha-team");
    expect(teammateIdsOf(byDefault)).not.toContain("ghost@alpha-team");

    const withArchived = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      includeArchived: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(teammateIdsOf(withArchived)).toContain("ghost@alpha-team");
  });

  it("caps events and runs to the newest N and marks the truncation", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder", "Helper", "Scout"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      includeDebug: true,
      maxEvents: 1,
      maxRuns: 1,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(recentEventsOf(payload)).toHaveLength(1);
    expect(payload.scope.events_returned).toBe(1);
    expect(payload.scope.events_truncated).toBe(true);
    expect(payload.scope.caps.max_events).toBe(1);

    expect(payload.debug?.runs).toHaveLength(1);
    expect(payload.scope.runs_returned).toBe(1);
    expect(payload.scope.runs_truncated).toBe(true);
    expect(payload.scope.caps.max_runs).toBe(1);
  });

  it("caps messages to the newest N and marks the truncation", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    const alpha = seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    sendDiagnosticsMessages({
      stateRoot,
      workspaceRoot,
      identity: alpha.identity,
      teamName: "alpha-team",
      to: "Builder",
      bodies: ["first body", "second body", "third body"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      maxMessages: 1,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const messageSummary =
      payload.state.status === "durable"
        ? payload.state.messageSummary
        : { total: 0 };

    expect(messageSummary.total).toBe(1);
    expect(payload.scope.messages_matched).toBe(3);
    expect(payload.scope.messages_returned).toBe(1);
    expect(payload.scope.messages_truncated).toBe(true);
    expect(payload.scope.caps.max_messages).toBe(1);
  });

  it("filters the message listing by messages_since", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    const alpha = seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    sendDiagnosticsMessages({
      stateRoot,
      workspaceRoot,
      identity: alpha.identity,
      teamName: "alpha-team",
      to: "Builder",
      bodies: ["old body", "new body"]
    });
    // Pin deterministic timestamps either side of the messages_since boundary.
    withDiagnosticsDb(stateRoot, workspaceRoot, (db) => {
      const rows = db
        .prepare(
          `SELECT message_id FROM ${TABLE_NAMES.messages} ORDER BY rowid ASC`
        )
        .all() as Array<{ message_id: string }>;
      db.prepare(
        `UPDATE ${TABLE_NAMES.messages} SET created_at = ? WHERE message_id = ?`
      ).run("2026-01-01T00:00:00.000Z", rows[0].message_id);
      db.prepare(
        `UPDATE ${TABLE_NAMES.messages} SET created_at = ? WHERE message_id = ?`
      ).run("2026-12-01T00:00:00.000Z", rows[1].message_id);
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      messagesSince: "2026-06-01T00:00:00.000Z",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    const messageSummary =
      payload.state.status === "durable"
        ? payload.state.messageSummary
        : { total: 0 };

    expect(messageSummary.total).toBe(1);
    expect(payload.scope.messages_matched).toBe(1);
    expect(payload.scope.caps.messages_since).toBe("2026-06-01T00:00:00.000Z");
  });

  it("restricts teammate, run, and message detail to one teammate via teammate_id", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    const alpha = seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder", "Helper"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      includeDebug: true,
      teammateId: "builder@alpha-team",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.scope.teammate_id).toBe("builder@alpha-team");
    expect(teammateIdsOf(payload)).toEqual(["builder@alpha-team"]);
    expect(payload.debug?.runs).toHaveLength(1);
    expect(payload.debug?.runs?.[0]?.member_id).toBe(alpha.members.Builder.memberId);
  });

  it("falls back to a compact known-teams list when there is no active team", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };
    const betaCaller = { sessionId: "beta-session", clientName: "codex" };
    // A third caller that never created/joined a team -> no active binding.
    const observerCaller = { sessionId: "observer-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });
    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: betaCaller,
      teamName: "Beta Team",
      teammates: ["Outsider"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: observerCaller,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.scope).toMatchObject({
      mode: "known_teams_fallback",
      team_id: null,
      fallback_reason: "no_active_team"
    });
    // Not blank/misleading: the full team list is offered so the user can pick.
    expect(knownTeamNames(payload).sort()).toEqual(["alpha-team", "beta-team"]);
    // Compact: no per-team detail is dumped while unfocused.
    expect(payload.teammates).toEqual([]);
  });

  it("falls back to known teams when team_name does not match", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace";
    const alphaCaller = { sessionId: "alpha-session", clientName: "codex" };

    seedFilterTeam({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Alpha Team",
      teammates: ["Builder"]
    });

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: alphaCaller,
      teamName: "Nonexistent Team",
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    expect(payload.scope).toMatchObject({
      mode: "known_teams_fallback",
      fallback_reason: "team_name_not_found"
    });
    expect(knownTeamNames(payload)).toEqual(["alpha-team"]);
    expect(payload.teammates).toEqual([]);
  });
});
