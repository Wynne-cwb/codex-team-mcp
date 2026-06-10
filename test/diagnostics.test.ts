import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDiagnosticsPayload } from "../src/diagnostics.js";
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
  TASK_STATUSES
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
        latestVersion: 6,
        targetVersion: 6,
        pendingMigrations: []
      },
      tableCounts: {
        schema_migrations: 6,
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
    expect(payload.reconciliationSummary).toMatchObject({
      teams: 1,
      runningRunsChecked: 1,
      staleRunsMarked: 1,
      reviewNeededWorkspaces: 1,
      workspaceInspectionFailures: 1,
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
});
