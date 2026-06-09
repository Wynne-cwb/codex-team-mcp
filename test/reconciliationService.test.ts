import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  createPaneBackendRegistry,
  type PaneBackendCommandRunner
} from "../src/adapters/paneBackend.js";
import { PaneExecutionBackend } from "../src/adapters/paneExecutionBackend.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { ReconciliationService } from "../src/services/reconciliationService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  EVENT_TYPES,
  ISOLATION_KINDS,
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  WORK_CLASSIFICATIONS
} from "../src/state/schema.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";

const tempRoots: string[] = [];
const adapters: DurableStateAdapter[] = [];
const SECRET_PHASE5_RECONCILE = "SECRET_PHASE5_RECONCILE";
const ORDINARY_PHASE5_RECONCILE_PROMPT = "review billing module and remove stale retries";

interface ReconciliationContext {
  adapter: DurableStateAdapter;
  db: Database.Database;
  identity: WorkspaceScopedCallerIdentity;
  teamId: string;
  teamName: string;
}

interface RunRow {
  run_id: string;
  member_id: string | null;
  status: string;
  backend_status: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  review_status: string | null;
  changed_files_json: string;
  diff_summary: string | null;
  last_error: string | null;
}

interface MemberRow {
  member_id: string;
  status: string;
}

interface EventRow {
  event_type: string;
  payload_json: string;
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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

function createContext(): ReconciliationContext {
  const workspaceRoot = createTempRoot("codex-team-reconcile-workspace-");
  const identity = createIdentity(workspaceRoot);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempRoot("codex-team-reconcile-state-"),
    workspaceRoot: identity.workspaceRoot
  });
  adapters.push(adapter);
  const team = new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  }).createTeam({
    teamName: "Alpha Team",
    description: "Reconciliation test team",
    identity
  });

  return {
    adapter,
    db: adapter.getDatabase(),
    identity,
    teamId: team.active_binding.team_id,
    teamName: team.team_name
  };
}

function createService(
  context: ReconciliationContext,
  executionBackend?: ExecutionBackend
): ReconciliationService {
  return new ReconciliationService({
    db: context.db,
    statePath: context.adapter.describeStateRoot().stateRoot,
    executionBackend
  });
}

function insertTeammate(input: {
  db: Database.Database;
  teamId: string;
  workspaceRoot: string;
  memberId: string;
  displayName?: string;
  status?: string;
}): void {
  input.db
    .prepare(
      `
        INSERT INTO ${TABLE_NAMES.members} (
          member_id,
          team_id,
          display_name,
          role,
          status,
          workspace_root,
          joined_at,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.memberId,
      input.teamId,
      input.displayName ?? "Builder",
      "teammate",
      input.status ?? MEMBER_STATUSES.scheduled,
      input.workspaceRoot,
      "2026-06-05T00:00:00.000Z",
      JSON.stringify({ publicTeammateId: `${input.memberId}@alpha-team` })
    );
}

function insertRun(input: {
  db: Database.Database;
  teamId: string;
  memberId: string | null;
  runId: string;
  status?: string;
  workspacePath?: string | null;
  baseRevision?: string | null;
  reviewStatus?: string | null;
  backendRunId?: string | null;
  backendThreadId?: string | null;
  backendProcessId?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  input.db
    .prepare(
      `
        INSERT INTO ${TABLE_NAMES.runs} (
          run_id,
          team_id,
          member_id,
          status,
          backend,
          workspace_path,
          metadata_json,
          created_at,
          updated_at,
          last_error,
          backend_status,
          backend_run_id,
          backend_thread_id,
          backend_process_id,
          work_classification,
          isolation_kind,
          base_revision,
          review_status,
          changed_files_json,
          diff_summary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.runId,
      input.teamId,
      input.memberId,
      input.status ?? MEMBER_STATUSES.scheduled,
      "fake-backend",
      input.workspacePath ?? null,
      JSON.stringify({ prompt_present: true, ...(input.metadata ?? {}) }),
      "2026-06-05T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
      null,
      RUN_BACKEND_STATUSES.running,
      input.backendRunId === undefined ? `backend:${input.runId}` : input.backendRunId,
      input.backendThreadId === undefined
        ? `thread:${input.runId}`
        : input.backendThreadId,
      input.backendProcessId === undefined
        ? `process:${input.runId}`
        : input.backendProcessId,
      WORK_CLASSIFICATIONS.codeImplementation,
      ISOLATION_KINDS.gitWorktree,
      input.baseRevision ?? null,
      input.reviewStatus ?? null,
      JSON.stringify([]),
      null
    );
}

function insertQueuedMessage(input: {
  db: Database.Database;
  teamId: string;
  senderMemberId: string | null;
  recipientMemberId: string | null;
  messageId: string;
}): void {
  input.db
    .prepare(
      `
        INSERT INTO ${TABLE_NAMES.messages} (
          message_id,
          team_id,
          sender_member_id,
          recipient_member_id,
          status,
          delivery_status,
          summary,
          body_json,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.messageId,
      input.teamId,
      input.senderMemberId,
      input.recipientMemberId,
      MESSAGE_ROW_STATUSES.queued,
      MESSAGE_DELIVERY_STATUSES.queuedWhileIdle,
      "Queued summary",
      JSON.stringify({ text: SECRET_PHASE5_RECONCILE }),
      JSON.stringify({}),
      "2026-06-05T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z"
    );
}

function readRun(db: Database.Database, runId: string): RunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} WHERE run_id = ?`)
    .get(runId) as RunRow;
}

function readMember(db: Database.Database, memberId: string): MemberRow {
  return db
    .prepare(`SELECT member_id, status FROM ${TABLE_NAMES.members} WHERE member_id = ?`)
    .get(memberId) as MemberRow;
}

function rowCount(db: Database.Database, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

function eventRows(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `
        SELECT event_type, payload_json
        FROM ${TABLE_NAMES.events}
        ORDER BY created_at, event_id
      `
    )
    .all() as EventRow[];
}

function createTempGitWorkspace(): { workspacePath: string; baseRevision: string } {
  const workspacePath = createTempRoot("codex-team-reconcile-git-");
  execGit(workspacePath, ["init"]);
  execGit(workspacePath, ["config", "user.email", "test@example.com"]);
  execGit(workspacePath, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(workspacePath, "tracked.txt"), "base\n");
  execGit(workspacePath, ["add", "tracked.txt"]);
  execGit(workspacePath, ["commit", "-m", "base"]);
  const baseRevision = execGit(workspacePath, ["rev-parse", "HEAD"]).trim();
  writeFileSync(path.join(workspacePath, "tracked.txt"), "changed\n");

  return { workspacePath, baseRevision };
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

class FakeReconcileBackend implements ExecutionBackend {
  readonly reconcileCalls: ExecutionRunContext[] = [];

  constructor(private readonly result: ExecutionBackendReconcileResult) {}

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: this.result.backend,
      backend_status: this.result.backend_status,
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        supportsWorkspaces: false
      }
    };
  }

  startRun(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: this.result.backend,
      backend_status: RUN_BACKEND_STATUSES.notStarted
    };
  }

  resumeRun(_context: ExecutionRunContext, _trigger: ExecutionTrigger) {
    return this.startRun();
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    this.reconcileCalls.push(context);
    return this.result;
  }
}

class ThrowingReconcileBackend implements ExecutionBackend {
  readonly reconcileCalls: ExecutionRunContext[] = [];

  constructor(
    private readonly errorMessage = `fake reconcile threw ${SECRET_PHASE5_RECONCILE}`
  ) {}

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        supportsWorkspaces: false
      }
    };
  }

  startRun(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.notStarted
    };
  }

  resumeRun(_context: ExecutionRunContext, _trigger: ExecutionTrigger) {
    return this.startRun();
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    this.reconcileCalls.push(context);
    throw new Error(this.errorMessage);
  }
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    adapter.close();
  }

  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("ReconciliationService.reconcileWorkspace", () => {
  it("marks running runs stale when backend cannot confirm activity", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:builder",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:builder",
      runId: "run:builder",
      status: MEMBER_STATUSES.running
    });
    const backend = new FakeReconcileBackend({
      status: "unknown",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.unknown,
      last_error: "backend could not confirm activity"
    });

    const summary = createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });

    expect(summary).toMatchObject({
      runningRunsChecked: 1,
      staleRunsMarked: 1
    });
    expect(backend.reconcileCalls).toHaveLength(1);
    expect(readRun(context.db, "run:builder")).toMatchObject({
      status: MEMBER_STATUSES.stale,
      backend_status: RUN_BACKEND_STATUSES.unknown
    });
    expect(readMember(context.db, "teammate:builder")).toMatchObject({
      status: MEMBER_STATUSES.stale
    });
    expect(eventRows(context.db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: EVENT_TYPES.teammateReconciled }),
        expect.objectContaining({ event_type: EVENT_TYPES.teammateMarkedStale })
      ])
    );
  });

  it("marks running pane run stale when stored metadata points to a missing live tmux pane", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:pane",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:pane",
      runId: "run:pane",
      status: MEMBER_STATUSES.running,
      metadata: {
        backend_metadata: {
          pane: {
            mode: "pane",
            backend_type: "tmux",
            availability_status: "available",
            pane_id: "%42",
            session_name: "codex-team-alpha-team",
            socket_name: "codex-team-alpha-team-run-pane"
          }
        }
      }
    });
    insertQueuedMessage({
      db: context.db,
      teamId: context.teamId,
      senderMemberId: null,
      recipientMemberId: "teammate:pane",
      messageId: "message:pane"
    });
    const beforeMessages = rowCount(context.db, TABLE_NAMES.messages);
    const commandRunner: PaneBackendCommandRunner & {
      calls: Array<{ command: string; args: string[] }>;
    } = {
      calls: [],
      run(command, args) {
        this.calls.push({ command, args });
        const key = [command, ...args].join(" ");
        if (key === "tmux -V") {
          return { ok: true, stdout: "tmux 3.6a\n", stderr: "", exit_code: 0 };
        }
        if (
          key ===
          "tmux -L codex-team-alpha-team-run-pane list-panes -a -F #{pane_id}"
        ) {
          return { ok: true, stdout: "%99\n", stderr: "", exit_code: 0 };
        }

        return {
          ok: false,
          stdout: "",
          stderr: "unexpected command",
          exit_code: 1
        };
      }
    };
    const paneBackend = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: {},
      commandRunner
    });
    const executionBackend = new PaneExecutionBackend({ paneBackend });

    const summary = createService(context, executionBackend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });

    expect(summary).toMatchObject({
      runningRunsChecked: 1,
      staleRunsMarked: 1
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "tmux",
          args: ["-V"]
        }),
        expect.objectContaining({
          command: "tmux",
          args: [
            "-L",
            "codex-team-alpha-team-run-pane",
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}"
          ]
        })
      ])
    );
    expect(readRun(context.db, "run:pane")).toMatchObject({
      status: MEMBER_STATUSES.stale,
      backend_status: RUN_BACKEND_STATUSES.stale
    });
    expect(readMember(context.db, "teammate:pane")).toMatchObject({
      status: MEMBER_STATUSES.stale
    });
    expect(rowCount(context.db, TABLE_NAMES.messages)).toBe(beforeMessages);
  });

  it("reports orphaned queued messages without deleting them", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:archived",
      status: MEMBER_STATUSES.archived
    });
    insertQueuedMessage({
      db: context.db,
      teamId: context.teamId,
      senderMemberId: null,
      recipientMemberId: "teammate:archived",
      messageId: "message:orphaned"
    });
    const beforeMessages = rowCount(context.db, TABLE_NAMES.messages);

    const summary = createService(context).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot
    });

    expect(summary.orphanedQueuedMessages).toBe(1);
    expect(rowCount(context.db, TABLE_NAMES.messages)).toBe(beforeMessages);
  });

  it("reports missing run and member links", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:missing-run"
    });
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:orphaned-run"
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:orphaned-run",
      runId: "run:orphaned",
      status: MEMBER_STATUSES.stopped
    });
    context.db
      .prepare(`DELETE FROM ${TABLE_NAMES.members} WHERE member_id = ?`)
      .run("teammate:orphaned-run");

    const summary = createService(context).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot
    });

    expect(summary.missingRunLinks).toBe(1);
    expect(summary.orphanedRuns).toBe(1);
  });

  it("reports review-needed isolated workspaces without merging or deleting", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:review"
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:review",
      runId: "run:review",
      status: MEMBER_STATUSES.stopped,
      reviewStatus: RUN_REVIEW_STATUSES.needsReview
    });
    const beforeRuns = rowCount(context.db, TABLE_NAMES.runs);
    const beforeMembers = rowCount(context.db, TABLE_NAMES.members);

    const summary = createService(context).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot
    });

    expect(summary.reviewNeededWorkspaces).toBe(1);
    expect(rowCount(context.db, TABLE_NAMES.runs)).toBe(beforeRuns);
    expect(rowCount(context.db, TABLE_NAMES.members)).toBe(beforeMembers);
  });

  it("inspects temp git workspace changes and records changed files", () => {
    const context = createContext();
    const workspace = createTempGitWorkspace();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:git"
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:git",
      runId: "run:git",
      status: MEMBER_STATUSES.stopped,
      workspacePath: workspace.workspacePath,
      baseRevision: workspace.baseRevision,
      reviewStatus: RUN_REVIEW_STATUSES.pendingReview
    });

    const summary = createService(context).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot
    });
    const run = readRun(context.db, "run:git");
    const changedFiles = JSON.parse(run.changed_files_json) as string[];

    expect(summary.inspectedWorkspaces).toBe(1);
    expect(summary.reviewNeededWorkspaces).toBe(1);
    expect(run.review_status).toBe(RUN_REVIEW_STATUSES.needsReview);
    expect(changedFiles).toContain("tracked.txt");
    expect(run.changed_files_json).toContain("tracked.txt");
    expect(existsSync(workspace.workspacePath)).toBe(true);
  });

  it("preserves workspace and marks needs_review when git inspection fails", () => {
    const context = createContext();
    const workspacePath = createTempRoot("codex-team-reconcile-not-git-");
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:bad-git"
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:bad-git",
      runId: "run:bad-git",
      status: MEMBER_STATUSES.stopped,
      workspacePath,
      baseRevision: "base-revision"
    });

    const summary = createService(context).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot
    });
    const run = readRun(context.db, "run:bad-git");

    expect(summary.workspaceInspectionFailures).toBe(1);
    expect(summary.reviewNeededWorkspaces).toBe(1);
    expect(run.review_status).toBe(RUN_REVIEW_STATUSES.needsReview);
    expect(run.last_error).toContain("git status --short failed");
    expect(existsSync(workspacePath)).toBe(true);
  });

  it("does not leak SECRET_PHASE5_RECONCILE in reconciliation events", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:secret",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:secret",
      runId: "run:secret",
      status: MEMBER_STATUSES.running
    });
    const backend = new FakeReconcileBackend({
      status: "stale",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.stale,
      last_error: `backend saw ${SECRET_PHASE5_RECONCILE}`
    });

    createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });
    const serializedEvents = JSON.stringify(eventRows(context.db));

    expect(serializedEvents).not.toContain(SECRET_PHASE5_RECONCILE);
    expect(serializedEvents).toContain("[redacted_secret]");
  });

  it("redacts ordinary prompt text from returned reconciliation failures", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:prompt",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:prompt",
      runId: "run:prompt",
      status: MEMBER_STATUSES.running,
      metadata: {
        prompt: ORDINARY_PHASE5_RECONCILE_PROMPT
      }
    });
    const backend = new FakeReconcileBackend({
      status: "stale",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.stale,
      last_error: `backend repeated ${ORDINARY_PHASE5_RECONCILE_PROMPT}`
    });

    createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });
    const run = readRun(context.db, "run:prompt");
    const serializedEvents = JSON.stringify(eventRows(context.db));

    expect(run.last_error).not.toContain(ORDINARY_PHASE5_RECONCILE_PROMPT);
    expect(run.last_error).toContain("[redacted_prompt]");
    expect(serializedEvents).not.toContain(ORDINARY_PHASE5_RECONCILE_PROMPT);
    expect(serializedEvents).toContain("[redacted_prompt]");
  });

  it("passes metadata_json backend identifiers to reconciliation", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:metadata",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:metadata",
      runId: "run:metadata",
      status: MEMBER_STATUSES.running,
      backendRunId: null,
      backendThreadId: null,
      backendProcessId: null,
      metadata: {
        backend_run_id: "metadata-run",
        backend_thread_id: "metadata-thread",
        backend_process_id: "metadata-process"
      }
    });
    const backend = new FakeReconcileBackend({
      status: "active",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.running
    });

    createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });

    expect(backend.reconcileCalls).toHaveLength(1);
    expect(backend.reconcileCalls[0]?.metadata).toMatchObject({
      backend_run_id: "metadata-run",
      backend_thread_id: "metadata-thread",
      backend_process_id: "metadata-process"
    });
  });

  it("prefers run column backend identifiers over metadata_json during reconciliation", () => {
    const context = createContext();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:columns",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:columns",
      runId: "run:columns",
      status: MEMBER_STATUSES.running,
      backendRunId: "column-run",
      backendThreadId: "column-thread",
      backendProcessId: "column-process",
      metadata: {
        backend_run_id: "metadata-run",
        backend_thread_id: "metadata-thread",
        backend_process_id: "metadata-process"
      }
    });
    const backend = new FakeReconcileBackend({
      status: "active",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.running
    });

    createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });

    expect(backend.reconcileCalls).toHaveLength(1);
    expect(backend.reconcileCalls[0]?.metadata).toMatchObject({
      backend_run_id: "column-run",
      backend_thread_id: "column-thread",
      backend_process_id: "column-process"
    });
  });

  it("converts thrown backend reconcile into stale state", () => {
    const context = createContext();
    const workspace = createTempGitWorkspace();
    insertTeammate({
      db: context.db,
      teamId: context.teamId,
      workspaceRoot: context.identity.workspaceRoot,
      memberId: "teammate:throwing",
      status: MEMBER_STATUSES.running
    });
    insertRun({
      db: context.db,
      teamId: context.teamId,
      memberId: "teammate:throwing",
      runId: "run:throwing",
      status: MEMBER_STATUSES.running,
      workspacePath: workspace.workspacePath,
      baseRevision: workspace.baseRevision,
      reviewStatus: RUN_REVIEW_STATUSES.pendingReview,
      metadata: {
        prompt: ORDINARY_PHASE5_RECONCILE_PROMPT
      }
    });
    insertQueuedMessage({
      db: context.db,
      teamId: context.teamId,
      senderMemberId: null,
      recipientMemberId: "teammate:throwing",
      messageId: "message:throwing"
    });
    const backend = new ThrowingReconcileBackend(
      `fake reconcile threw ${SECRET_PHASE5_RECONCILE} and ${ORDINARY_PHASE5_RECONCILE_PROMPT}`
    );

    const summary = createService(context, backend).reconcileWorkspace({
      workspaceRoot: context.identity.workspaceRoot,
      actorCallerKey: context.identity.callerKey
    });

    expect(summary).toMatchObject({
      runningRunsChecked: 1,
      staleRunsMarked: 1,
      orphanedQueuedMessages: 0
    });
    expect(backend.reconcileCalls).toHaveLength(1);
    expect(rowCount(context.db, TABLE_NAMES.messages)).toBe(1);
    const run = readRun(context.db, "run:throwing");
    expect(run).toMatchObject({
      status: MEMBER_STATUSES.stale,
      backend_status: RUN_BACKEND_STATUSES.failed,
      workspace_path: workspace.workspacePath
    });
    expect(run.last_error).not.toContain(SECRET_PHASE5_RECONCILE);
    expect(run.last_error).not.toContain(ORDINARY_PHASE5_RECONCILE_PROMPT);
    expect(run.last_error).toContain("[redacted_prompt]");
    expect(readMember(context.db, "teammate:throwing")).toMatchObject({
      status: MEMBER_STATUSES.stale
    });
    const serializedEvents = JSON.stringify(eventRows(context.db));
    expect(serializedEvents).not.toContain(SECRET_PHASE5_RECONCILE);
    expect(serializedEvents).not.toContain(ORDINARY_PHASE5_RECONCILE_PROMPT);
    expect(serializedEvents).toContain("[redacted_secret]");
    expect(serializedEvents).toContain("[redacted_prompt]");
    expect(existsSync(workspace.workspacePath)).toBe(true);
  });
});
