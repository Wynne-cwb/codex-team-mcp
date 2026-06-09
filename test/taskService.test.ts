import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendActionResult,
  ExecutionBackendDescription,
  ExecutionBackendReconcileResult,
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

const tempRoots: string[] = [];

interface TeamContext {
  identity: WorkspaceScopedCallerIdentity;
  adapter: DurableStateAdapter;
  teamId: string;
}

interface TaskRow {
  task_id: string;
  public_task_id: string;
  team_id: string;
  status: string;
  owner_member_id: string | null;
  subject: string;
  description: string | null;
  active_form: string | null;
  metadata_json: string;
}

interface TaskEdgeRow {
  team_id: string;
  source_task_id: string;
  target_task_id: string;
  edge_type: string;
}

interface TaskEventRow {
  task_id: string;
  event_type: string;
  payload_json: string;
}

interface MessageRow {
  message_id: string;
  team_id: string;
  sender_member_id: string | null;
  recipient_member_id: string | null;
  status: string;
  delivery_status: string;
  body_json: string;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

interface ResumeCall {
  context: ExecutionRunContext;
  trigger: ExecutionTrigger;
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-task-service-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "session-1", threadId: "thread-1" }
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function createTeam(input: {
  workspaceRoot?: string;
  teamName?: string;
  metadata?: unknown;
} = {}): TeamContext {
  const identity = createIdentity(input.workspaceRoot ?? "/workspace/project", input.metadata);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempStateRoot(),
    workspaceRoot: identity.workspaceRoot
  });
  const result = new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  }).createTeam({
    teamName: input.teamName ?? "Alpha Team",
    description: "Task service RED test team",
    identity
  });

  return {
    identity,
    adapter,
    teamId: result.active_binding.team_id
  };
}

function createTaskService(
  adapter: DurableStateAdapter,
  executionBackend?: ExecutionBackend
): TaskService {
  return new TaskService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot,
    executionBackend
  });
}

function createAgentService(adapter: DurableStateAdapter): AgentService {
  return new AgentService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  });
}

function createTeammate(input: {
  context: TeamContext;
  name: string;
  status?: string;
}): string {
  const created = createAgentService(input.context.adapter).createAgent({
    name: input.name,
    teamName: "alpha-team",
    prompt: `Create ${input.name}`,
    description: `Create ${input.name}`,
    identity: input.context.identity
  });

  if (created.status !== "scheduled") {
    throw new Error(`Expected scheduled TeamMate, got ${created.status}`);
  }

  const memberId = created.debug.internal_member_id;
  if (input.status !== undefined) {
    input.context.adapter
      .getDatabase()
      .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
      .run(input.status, memberId);
  }

  return memberId;
}

function setResumableRun(input: {
  db: Database.Database;
  memberId: string;
  status: string;
}): void {
  input.db
    .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
    .run(input.status, input.memberId);
  input.db
    .prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_run_id = ?,
            backend_thread_id = ?,
            backend_process_id = ?,
            work_classification = ?,
            isolation_kind = ?,
            review_status = ?,
            updated_at = ?
        WHERE member_id = ?
      `
    )
    .run(
      input.status,
      "fake-backend",
      RUN_BACKEND_STATUSES.stopped,
      `backend-run:${input.memberId}`,
      `thread:${input.memberId}`,
      `process:${input.memberId}`,
      "read_only",
      "none",
      "none",
      new Date().toISOString(),
      input.memberId
    );
}

class FakeResumeBackend implements ExecutionBackend {
  readonly resumeCalls: ResumeCall[] = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.idle,
      capabilities: {
        canStart: false,
        canResume: true,
        canReconcile: false,
        supportsWorkspaces: false
      }
    };
  }

  startRun(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: "start unsupported in fake resume backend"
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    this.resumeCalls.push({ context, trigger });
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: "task-backend-run-resumed",
      thread_id: "task-thread-resumed",
      process_id: "task-process-resumed",
      started_at: "2026-06-05T00:00:00.000Z"
    };
  }

  reconcileRun(): ExecutionBackendReconcileResult {
    return {
      status: "unsupported",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.unknown
    };
  }
}

function tasks(db: Database.Database): TaskRow[] {
  return db
    .prepare(
      `
        SELECT
          task_id,
          public_task_id,
          team_id,
          status,
          owner_member_id,
          subject,
          description,
          active_form,
          metadata_json
        FROM ${TABLE_NAMES.tasks}
        ORDER BY created_at, task_id
      `
    )
    .all() as TaskRow[];
}

function taskEdges(db: Database.Database): TaskEdgeRow[] {
  return db
    .prepare(
      `
        SELECT team_id, source_task_id, target_task_id, edge_type
        FROM task_edges
        ORDER BY source_task_id, target_task_id, edge_type
      `
    )
    .all() as TaskEdgeRow[];
}

function taskEvents(db: Database.Database): TaskEventRow[] {
  return db
    .prepare(
      `
        SELECT task_id, event_type, payload_json
        FROM task_events
        ORDER BY created_at, task_event_id
      `
    )
    .all() as TaskEventRow[];
}

function messages(db: Database.Database): MessageRow[] {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.messages} ORDER BY created_at, message_id`)
    .all() as MessageRow[];
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `
        SELECT event_type, error_code, payload_json
        FROM ${TABLE_NAMES.events}
        ORDER BY created_at, event_id
      `
    )
    .all() as EventRow[];
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("TaskService", () => {
  it("creates pending team-scoped tasks with internal and public IDs", () => {
    const context = createTeam();

    const result = createTaskService(context.adapter).createTask({
      teamName: "alpha-team",
      subject: "Draft Phase 4 task plan",
      description: "Create durable task state",
      activeForm: "Drafting Phase 4 task plan",
      metadata: { priority: "high" },
      identity: context.identity
    });

    // Contract: task:<team_id>:<sequence> is the durable primary key shape.
    expect(result).toMatchObject({
      status: "created",
      team_name: "alpha-team",
      task_id: `task:${context.teamId}:1`,
      public_task_id: "task-1",
      task: {
        task_id: `task:${context.teamId}:1`,
        public_task_id: "task-1",
        subject: "Draft Phase 4 task plan",
        status: "pending"
      }
    });
    expect(tasks(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        task_id: `task:${context.teamId}:1`,
        public_task_id: "task-1",
        team_id: context.teamId,
        status: "pending",
        subject: "Draft Phase 4 task plan",
        description: "Create durable task state",
        active_form: "Drafting Phase 4 task plan"
      })
    ]);

    context.adapter.close();
  });

  it("creates task assignment notifications through the persisted message path", () => {
    const context = createTeam();
    const builderMemberId = createTeammate({
      context,
      name: "Builder",
      status: MEMBER_STATUSES.idle
    });

    const result = createTaskService(context.adapter).createTask({
      teamName: "alpha-team",
      subject: "Implement assignment notification",
      owner: "Builder",
      metadata: { source: "assignment notifications" },
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "created",
      task_id: `task:${context.teamId}:1`,
      assignment_notification: {
        persisted: true,
        recipient: {
          member_id: builderMemberId,
          teammate_id: "builder@alpha-team"
        },
        delivery_status: "backend_unavailable",
        row_status: "queued",
        message_id: expect.stringMatching(/^message:/)
      }
    });
    expect(messages(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        recipient_member_id: builderMemberId,
        status: "queued",
        delivery_status: "queued_while_idle"
      })
    ]);
    expect(JSON.parse(messages(context.adapter.getDatabase())[0]?.body_json ?? "{}")).toMatchObject({
      type: "task_assignment",
      task_id: `task:${context.teamId}:1`,
      public_task_id: "task-1"
    });

    context.adapter.close();
  });

  it("task assignment notification triggers backend resume through MessageService", () => {
    const context = createTeam();
    const builderMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRun({
      db: context.adapter.getDatabase(),
      memberId: builderMemberId,
      status: MEMBER_STATUSES.stopped
    });
    const backend = new FakeResumeBackend();

    const result = createTaskService(context.adapter, backend).createTask({
      teamName: "alpha-team",
      subject: "Resume assignment owner",
      owner: "Builder",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "created",
      task_id: `task:${context.teamId}:1`,
      assignment_notification: {
        persisted: true,
        delivery_status: "backend_resume_attempted",
        row_status: "queued",
        recipient: {
          member_id: builderMemberId,
          teammate_id: "builder@alpha-team"
        },
        backend: {
          backend: "fake-backend",
          backend_run_id: "task-backend-run-resumed"
        }
      }
    });
    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0]?.trigger).toMatchObject({
      kind: "task_assignment",
      message_id: result.assignment_notification?.message_id,
      task_id: result.task_id
    });
    expect(messages(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        recipient_member_id: builderMemberId,
        status: "queued",
        delivery_status: "queued_while_idle"
      })
    ]);

    context.adapter.close();
  });

  it("updates status owner description activeForm metadata and notes atomically", () => {
    const context = createTeam();
    const builderMemberId = createTeammate({ context, name: "Builder" });
    const service = createTaskService(context.adapter);
    service.createTask({
      teamName: "alpha-team",
      subject: "Original subject",
      metadata: { keep: "yes" },
      identity: context.identity
    });

    const result = service.updateTask({
      teamName: "alpha-team",
      taskId: "task-1",
      status: "in_progress",
      owner: "Builder",
      description: "Updated durable description",
      activeForm: "Updating durable task",
      metadata: { priority: "high" },
      notes: "Started work on the task",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "updated",
      task_id: `task:${context.teamId}:1`,
      task: {
        status: "in_progress",
        owner: {
          member_id: builderMemberId,
          teammate_id: "builder@alpha-team"
        },
        description: "Updated durable description",
        activeForm: "Updating durable task",
        metadata: {
          keep: "yes",
          priority: "high"
        }
      }
    });
    expect(tasks(context.adapter.getDatabase())[0]).toMatchObject({
      task_id: `task:${context.teamId}:1`,
      status: "in_progress",
      owner_member_id: builderMemberId,
      description: "Updated durable description",
      active_form: "Updating durable task"
    });
    expect(taskEvents(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "task_status_updated" }),
        expect.objectContaining({ event_type: "task_owner_updated" }),
        expect.objectContaining({ event_type: "task_note_added" })
      ])
    );

    context.adapter.close();
  });

  it("rejects status deleted with task_deleted_status_not_supported", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    service.createTask({
      teamName: "alpha-team",
      subject: "Do not delete",
      identity: context.identity
    });

    const result = service.updateTask({
      teamName: "alpha-team",
      taskId: "task-1",
      status: "deleted",
      notes: "Deletion is intentionally unsupported",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "task_deleted_status_not_supported",
      persisted: false,
      task_id: `task:${context.teamId}:1`
    });
    expect(tasks(context.adapter.getDatabase())[0]).toMatchObject({
      status: "pending"
    });
    expect(events(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "task_update_failed",
          error_code: "task_deleted_status_not_supported",
          payload_json: expect.stringContaining("task_deleted_status_not_supported")
        })
      ])
    );

    context.adapter.close();
  });

  it("merges metadata and deletes keys whose update value is null", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    service.createTask({
      teamName: "alpha-team",
      subject: "Metadata task",
      metadata: {
        keep: "yes",
        remove: "soon",
        priority: "medium"
      },
      identity: context.identity
    });

    const result = service.updateTask({
      teamName: "alpha-team",
      taskId: "task-1",
      metadata: {
        remove: null,
        priority: "high"
      },
      identity: context.identity
    });

    expect(result.task.metadata).toEqual({
      keep: "yes",
      priority: "high"
    });
    expect(JSON.parse(tasks(context.adapter.getDatabase())[0]?.metadata_json ?? "{}")).toEqual({
      keep: "yes",
      priority: "high"
    });

    context.adapter.close();
  });

  it("appends notes to task_events without replacing description", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    service.createTask({
      teamName: "alpha-team",
      subject: "Notes task",
      description: "Stable task description",
      identity: context.identity
    });

    service.updateTask({
      teamName: "alpha-team",
      taskId: "task-1",
      notes: "First note",
      identity: context.identity
    });
    service.updateTask({
      teamName: "alpha-team",
      task_id: "task-1",
      notes: "Second note",
      identity: context.identity
    });

    expect(tasks(context.adapter.getDatabase())[0]).toMatchObject({
      description: "Stable task description"
    });
    const noteEvents = taskEvents(context.adapter.getDatabase()).filter(
      (event) => event.event_type === "task_note_added"
    );
    expect(noteEvents).toHaveLength(2);
    expect(noteEvents.map((event) => JSON.parse(event.payload_json).note)).toEqual([
      "First note",
      "Second note"
    ]);

    context.adapter.close();
  });

  it("maintains task_edges for addBlocks and addBlockedBy", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    const source = service.createTask({
      teamName: "alpha-team",
      subject: "Source task",
      identity: context.identity
    });
    const blocked = service.createTask({
      teamName: "alpha-team",
      subject: "Blocked task",
      identity: context.identity
    });
    const blocker = service.createTask({
      teamName: "alpha-team",
      subject: "Blocker task",
      identity: context.identity
    });

    const result = service.updateTask({
      teamName: "alpha-team",
      taskId: source.public_task_id,
      addBlocks: [blocked.public_task_id],
      addBlockedBy: [blocker.public_task_id],
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "updated",
      dependencies: {
        blocks: [blocked.public_task_id],
        blockedBy: [blocker.public_task_id]
      }
    });
    expect(taskEdges(context.adapter.getDatabase())).toEqual([
      {
        team_id: context.teamId,
        source_task_id: source.task_id,
        target_task_id: blocked.task_id,
        edge_type: "blocks"
      },
      {
        team_id: context.teamId,
        source_task_id: blocker.task_id,
        target_task_id: source.task_id,
        edge_type: "blocks"
      }
    ]);

    context.adapter.close();
  });

  it("rejects self-referential task dependencies without mutation", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    const task = service.createTask({
      teamName: "alpha-team",
      subject: "Self dependency candidate",
      identity: context.identity
    });

    const blocksSelf = service.updateTask({
      teamName: "alpha-team",
      taskId: task.public_task_id,
      addBlocks: [task.public_task_id],
      identity: context.identity
    });
    const blockedBySelf = service.updateTask({
      teamName: "alpha-team",
      taskId: task.public_task_id,
      addBlockedBy: [task.task_id],
      identity: context.identity
    });

    expect(blocksSelf).toMatchObject({
      status: "invalid_task_dependency",
      error_code: "invalid_task_dependency",
      task_id: task.task_id,
      persisted: false
    });
    expect(blockedBySelf).toMatchObject({
      status: "invalid_task_dependency",
      error_code: "invalid_task_dependency",
      task_id: task.task_id,
      persisted: false
    });
    expect(taskEdges(context.adapter.getDatabase())).toEqual([]);
    expect(events(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "task_update_failed",
          error_code: "invalid_task_dependency",
          payload_json: expect.stringContaining("invalid_task_dependency")
        })
      ])
    );

    context.adapter.close();
  });

  it("lists concise projections with status owner and unresolved blockers", () => {
    const context = createTeam();
    createTeammate({ context, name: "Builder" });
    const service = createTaskService(context.adapter);
    const blocked = service.createTask({
      teamName: "alpha-team",
      subject: "Blocked implementation",
      owner: "Builder",
      identity: context.identity
    });
    const blocker = service.createTask({
      teamName: "alpha-team",
      subject: "Finish design",
      identity: context.identity
    });
    service.updateTask({
      teamName: "alpha-team",
      taskId: blocked.public_task_id,
      addBlockedBy: [blocker.public_task_id],
      identity: context.identity
    });

    const result = service.listTasks({
      teamName: "alpha-team",
      status: "pending",
      owner: "Builder",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "listed",
      team_name: "alpha-team",
      tasks: [
        {
          task_id: blocked.public_task_id,
          subject: "Blocked implementation",
          status: "pending",
          owner: {
            teammate_id: "builder@alpha-team"
          },
          unresolved_blockers: [blocker.public_task_id]
        }
      ]
    });
    expect(JSON.stringify(result.tasks[0])).not.toContain("metadata_json");

    context.adapter.close();
  });

  it("gets full task detail with metadata dependencies and history", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    const task = service.createTask({
      teamName: "alpha-team",
      subject: "Full detail task",
      metadata: { priority: "high" },
      identity: context.identity
    });
    const blocker = service.createTask({
      teamName: "alpha-team",
      subject: "Dependency",
      identity: context.identity
    });
    service.updateTask({
      teamName: "alpha-team",
      taskId: task.public_task_id,
      addBlockedBy: [blocker.public_task_id],
      notes: "Full detail note",
      identity: context.identity
    });

    const result = service.getTask({
      teamName: "alpha-team",
      task_id: task.task_id,
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "found",
      task: {
        task_id: task.task_id,
        public_task_id: task.public_task_id,
        metadata: { priority: "high" },
        dependencies: {
          blockedBy: [blocker.public_task_id]
        },
        history: expect.arrayContaining([
          expect.objectContaining({ event_type: "task_note_added" })
        ])
      }
    });

    context.adapter.close();
  });

  it("rejects invalid owners and cross-team task IDs without mutation", () => {
    const context = createTeam();
    const other = createTeam({
      workspaceRoot: context.identity.workspaceRoot,
      teamName: "Beta Team",
      metadata: { sessionId: "other-team" }
    });
    const service = createTaskService(context.adapter);
    const otherService = createTaskService(other.adapter);
    const local = service.createTask({
      teamName: "alpha-team",
      subject: "Local task",
      identity: context.identity
    });
    const remote = otherService.createTask({
      teamName: "beta-team",
      subject: "Remote task",
      identity: other.identity
    });

    const invalidOwner = service.updateTask({
      teamName: "alpha-team",
      taskId: local.public_task_id,
      owner: "Ghost",
      identity: context.identity
    });
    const crossTeam = service.updateTask({
      teamName: "alpha-team",
      taskId: remote.task_id,
      status: "completed",
      identity: context.identity
    });

    expect(invalidOwner).toMatchObject({
      status: "invalid_owner",
      persisted: false
    });
    expect(crossTeam).toMatchObject({
      status: "task_not_found",
      persisted: false
    });
    expect(tasks(context.adapter.getDatabase())[0]).toMatchObject({
      task_id: local.task_id,
      status: "pending",
      owner_member_id: null
    });
    expect(tasks(other.adapter.getDatabase())[0]).toMatchObject({
      task_id: remote.task_id,
      status: "pending"
    });

    context.adapter.close();
    other.adapter.close();
  });

  it("never falls back to a session-scoped task list", () => {
    const context = createTeam();
    const service = createTaskService(context.adapter);
    service.createTask({
      teamName: "alpha-team",
      subject: "Team-scoped only",
      identity: context.identity
    });
    const unboundIdentity = createIdentity(context.identity.workspaceRoot, {
      sessionId: "unbound-session"
    });

    const result = service.listTasks({
      identity: unboundIdentity
    });

    expect(result).toMatchObject({
      status: "error",
      error_code: "no_active_team"
    });
    expect(JSON.stringify(result)).not.toContain("session-scoped");
    expect(JSON.stringify(result)).not.toContain("session_task_list");

    context.adapter.close();
  });
});
