import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { TaskService } from "../src/services/taskService.js";
import { openTeamDatabase } from "../src/state/database.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { getMigrationStatus, MIGRATIONS, runMigrations } from "../src/state/migrations.js";
import {
  COMPONENT_NAMES,
  ERROR_EVENT_TYPES,
  EVENT_TYPES,
  ISOLATION_KINDS,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  TASK_STATUSES,
  WORK_CLASSIFICATIONS
} from "../src/state/schema.js";
import { STATE_DB_FILENAME } from "../src/state/root.js";

const requiredTables = [
  "schema_migrations",
  "teams",
  "members",
  "active_bindings",
  "component_initializations",
  "messages",
  "tasks",
  "task_edges",
  "task_events",
  "runs",
  "events"
];

const expectedComponentNames = ["inbox", "tasks", "runs", "events"];

const expectedRunLifecycleColumns = [
  "backend_status",
  "backend_run_id",
  "backend_thread_id",
  "backend_process_id",
  "started_at",
  "ended_at",
  "last_reconciled_at",
  "last_resume_attempt_at",
  "work_classification",
  "isolation_kind",
  "base_revision",
  "review_status",
  "changed_files_json",
  "diff_summary"
];

// Phase 12 (D-04 / migration v6): TL-driven worktree merge audit columns.
const expectedMergeAuditColumns = [
  "worktree_branch",
  "merge_commit",
  "merged_at",
  "merged_by_caller_key",
  "merge_conflict_files_json"
];

// Migration v7: per-TeamMate TARGET repo root (decouples the coordination root
// from the real repo a worktree is branched from / merged into).
const expectedRepoDecouplingColumns = ["worktree_repo_root"];

const tempRoots: string[] = [];

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-state-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function openMigratedDatabase(stateRoot = createTempStateRoot()): {
  databasePath: string;
  db: Database.Database;
} {
  const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
  const db = openTeamDatabase(databasePath);
  runMigrations(db);
  return { databasePath, db };
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function tableColumns(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(tableName)
    .map((row) => (row as { name: string }).name);
}

function indexSql(db: Database.Database, indexName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { sql: string } | undefined;

  return row?.sql ?? "";
}

function uniqueIndexes(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`SELECT name FROM pragma_index_list(?) WHERE [unique] = 1 ORDER BY name`)
    .all(tableName)
    .map((row) => (row as { name: string }).name);
}

function insertTeam(db: Database.Database, teamId: string, canonicalName: string): void {
  db.prepare(
    `
      INSERT INTO teams (
        team_id,
        canonical_name,
        requested_name,
        description,
        status,
        workspace_root,
        lead_agent_id,
        created_by_caller_key,
        created_at,
        metadata_json
      )
      VALUES (
        @teamId,
        @canonicalName,
        @requestedName,
        @description,
        'active',
        @workspaceRoot,
        @leadAgentId,
        @createdByCallerKey,
        @createdAt,
        '{}'
      )
    `
  ).run({
    teamId,
    canonicalName,
    requestedName: canonicalName,
    description: "Test team",
    workspaceRoot: "/workspace",
    leadAgentId: `team-lead@${canonicalName}`,
    createdByCallerKey: "codex-team:sessionId:test",
    createdAt: "2026-06-03T00:00:00.000Z"
  });
}

function openLegacyVersionOneDatabase(): Database.Database {
  const stateRoot = createTempStateRoot();
  const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
  const db = openTeamDatabase(databasePath);

  MIGRATIONS.find((migration) => migration.version === 1)?.up(db);
  db.exec(`
    DROP INDEX IF EXISTS idx_teams_workspace_canonical_name;
    CREATE UNIQUE INDEX idx_teams_canonical_name
      ON teams(canonical_name);
  `);
  db.prepare(
    `
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'create durable team state tables', '2026-06-03T00:00:00.000Z')
    `
  ).run();

  return db;
}

function openLegacyVersionTwoDatabase(): Database.Database {
  const stateRoot = createTempStateRoot();
  const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
  const db = openTeamDatabase(databasePath);

  db.exec("BEGIN");
  try {
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 2)) {
      migration.up(db);
      db.prepare(
        `
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `
      ).run(migration.version, migration.name, "2026-06-03T00:00:00.000Z");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  insertTeam(db, "team-v2-id", "version-two");
  db.prepare(
    `
      INSERT INTO members (
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
  ).run(
    "leader:team-v2-id",
    "team-v2-id",
    "Team Lead",
    "leader",
    "active",
    "/workspace",
    "2026-06-03T00:00:00.000Z",
    "{}"
  );
  db.prepare(
    `
      INSERT INTO messages (
        message_id,
        team_id,
        sender_member_id,
        recipient_member_id,
        status,
        body_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "message-v2-id",
    "team-v2-id",
    "leader:team-v2-id",
    "leader:team-v2-id",
    "queued_while_idle",
    '{"text":"preserve me"}',
    "2026-06-03T00:00:01.000Z"
  );
  db.prepare(
    `
      INSERT INTO tasks (
        task_id,
        team_id,
        status,
        owner_member_id,
        title,
        description,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "task:team-v2-id:1",
    "team-v2-id",
    "pending",
    "leader:team-v2-id",
    "Preserve me",
    "Version 2 task",
    '{"priority":"high"}',
    "2026-06-03T00:00:02.000Z",
    "2026-06-03T00:00:02.000Z"
  );
  db.prepare(
    `
      INSERT INTO runs (
        run_id,
        team_id,
        member_id,
        status,
        backend,
        workspace_path,
        metadata_json,
        created_at,
        updated_at,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "run:team-v2-id:1",
    "team-v2-id",
    "leader:team-v2-id",
    "scheduled",
    "none",
    null,
    '{"phase":"legacy-v2"}',
    "2026-06-03T00:00:03.000Z",
    "2026-06-03T00:00:03.000Z",
    null
  );

  return db;
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("SQLite durable store", () => {
  it("exports the required schema constants", () => {
    expect(Object.values(TABLE_NAMES).sort()).toEqual([...requiredTables].sort());
    expect(TABLE_NAMES.taskEdges).toBe("task_edges");
    expect(TABLE_NAMES.taskEvents).toBe("task_events");
    expect(Object.values(COMPONENT_NAMES).sort()).toEqual(
      [...expectedComponentNames].sort()
    );
    expect(EVENT_TYPES.toolValidationFailed).toBe("tool_validation_failed");
    expect(EVENT_TYPES.resolverError).toBe("resolver_error");
    expect(EVENT_TYPES.teammateCreated).toBe("teammate_created");
    expect(EVENT_TYPES.teammateRunScheduled).toBe("teammate_run_scheduled");
    expect(EVENT_TYPES.teammateCreationRejected).toBe(
      "teammate_creation_rejected"
    );
    expect(MESSAGE_ROW_STATUSES.queued).toBe("queued");
    expect(MESSAGE_DELIVERY_STATUSES.queuedForNextTurn).toBe(
      "queued_for_next_turn"
    );
    expect(MESSAGE_DELIVERY_STATUSES.queuedWhileIdle).toBe("queued_while_idle");
    expect(MESSAGE_DELIVERY_STATUSES.backendStartAttempted).toBe(
      "backend_start_attempted"
    );
    expect(MESSAGE_DELIVERY_STATUSES.backendResumeAttempted).toBe(
      "backend_resume_attempted"
    );
    expect(MESSAGE_DELIVERY_STATUSES.backendUnavailable).toBe(
      "backend_unavailable"
    );
    expect(MESSAGE_DELIVERY_STATUSES.backendFailed).toBe("backend_failed");
    expect(MESSAGE_DELIVERY_STATUSES.recipientStale).toBe("recipient_stale");
    expect(RUN_BACKEND_STATUSES.notStarted).toBe("not_started");
    expect(RUN_BACKEND_STATUSES.running).toBe("running");
    expect(RUN_BACKEND_STATUSES.stale).toBe("stale");
    expect(WORK_CLASSIFICATIONS.readOnly).toBe("read_only");
    expect(WORK_CLASSIFICATIONS.reviewOnly).toBe("review_only");
    expect(WORK_CLASSIFICATIONS.artifactWriting).toBe("artifact_writing");
    expect(WORK_CLASSIFICATIONS.codeImplementation).toBe("code_implementation");
    expect(ISOLATION_KINDS.none).toBe("none");
    expect(ISOLATION_KINDS.declaredOutputPath).toBe("declared_output_path");
    expect(ISOLATION_KINDS.gitWorktree).toBe("git_worktree");
    expect(ISOLATION_KINDS.reviewDiff).toBe("review_diff");
    expect(RUN_REVIEW_STATUSES.none).toBe("none");
    expect(RUN_REVIEW_STATUSES.pendingReview).toBe("pending_review");
    expect(RUN_REVIEW_STATUSES.needsReview).toBe("needs_review");
    expect(RUN_REVIEW_STATUSES.preserved).toBe("preserved");
    expect(TASK_STATUSES.pending).toBe("pending");
    expect(TASK_STATUSES.inProgress).toBe("in_progress");
    expect(TASK_STATUSES.completed).toBe("completed");
    expect(Object.values(TASK_STATUSES)).not.toContain("deleted");
    expect(EVENT_TYPES.messageSent).toBe("message_sent");
    expect(EVENT_TYPES.messageQueued).toBe("message_queued");
    expect(EVENT_TYPES.messageSendFailed).toBe("message_send_failed");
    expect(EVENT_TYPES.messageSendUnsupported).toBe("message_send_unsupported");
    expect(EVENT_TYPES.taskCreated).toBe("task_created");
    expect(EVENT_TYPES.taskUpdated).toBe("task_updated");
    expect(EVENT_TYPES.taskAssigned).toBe("task_assigned");
    expect(EVENT_TYPES.taskNoteAdded).toBe("task_note_added");
    expect(EVENT_TYPES.taskMetadataUpdated).toBe("task_metadata_updated");
    expect(EVENT_TYPES.taskDependencyUpdated).toBe("task_dependency_updated");
    expect(EVENT_TYPES.taskUpdateFailed).toBe("task_update_failed");
    expect(EVENT_TYPES.teammateLifecycleTransition).toBe(
      "teammate_lifecycle_transition"
    );
    expect(EVENT_TYPES.teammateBackendStartAttempted).toBe(
      "teammate_backend_start_attempted"
    );
    expect(EVENT_TYPES.teammateBackendResumeAttempted).toBe(
      "teammate_backend_resume_attempted"
    );
    expect(EVENT_TYPES.teammateBackendFailed).toBe("teammate_backend_failed");
    expect(EVENT_TYPES.teammateReconciled).toBe("teammate_reconciled");
    expect(EVENT_TYPES.teammateMarkedStale).toBe("teammate_marked_stale");
    expect(EVENT_TYPES.workspaceIsolationCreated).toBe(
      "workspace_isolation_created"
    );
    expect(EVENT_TYPES.workspaceReviewRequired).toBe("workspace_review_required");
    expect(ERROR_EVENT_TYPES.toolValidationFailed).toBe("tool_validation_failed");
    expect(ERROR_EVENT_TYPES.resolverError).toBe("resolver_error");
  });

  it("opens the configured database path and applies the initial migration", () => {
    const stateRoot = createTempStateRoot();
    const databasePath = path.join(stateRoot, STATE_DB_FILENAME);

    expect(existsSync(databasePath)).toBe(false);
    const db = openTeamDatabase(databasePath);
    const result = runMigrations(db);

    expect(existsSync(databasePath)).toBe(true);
    expect(result.appliedMigrations.map((migration) => migration.version)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(requiredTables));
    expect(tableNames(db)).toEqual(expect.arrayContaining(["task_edges", "task_events"]));
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRunLifecycleColumns)
    );
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 1").get()
    ).toMatchObject({ name: expect.any(String) });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 3").get()
    ).toMatchObject({
      name: expect.stringContaining("expand message and task coordination state")
    });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 4").get()
    ).toMatchObject({
      name: expect.stringContaining("add lifecycle and isolation metadata")
    });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 6").get()
    ).toMatchObject({
      name: expect.stringContaining("add worktree merge audit metadata")
    });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 7").get()
    ).toMatchObject({
      name: expect.stringContaining("add worktree target repo root")
    });
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedMergeAuditColumns)
    );
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRepoDecouplingColumns)
    );

    db.close();
  });

  it("adds version 6 worktree merge audit metadata idempotently", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toContain(6);

    const stateRoot = createTempStateRoot();
    const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
    const db = openTeamDatabase(databasePath);
    runMigrations(db);

    expect(getMigrationStatus(db)).toMatchObject({
      status: "up_to_date",
      targetVersion: 8,
      latestVersion: 8
    });
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedMergeAuditColumns)
    );

    // Idempotent: a second migration run applies nothing and never throws.
    const secondRun = runMigrations(db);
    expect(secondRun.appliedMigrations).toEqual([]);
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedMergeAuditColumns)
    );

    db.close();
  });

  it("adds version 7 worktree target repo root idempotently", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toContain(7);

    const stateRoot = createTempStateRoot();
    const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
    const db = openTeamDatabase(databasePath);
    runMigrations(db);

    expect(getMigrationStatus(db)).toMatchObject({
      status: "up_to_date",
      targetVersion: 8,
      latestVersion: 8
    });
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRepoDecouplingColumns)
    );

    // Idempotent: a second migration run applies nothing and never throws, and
    // the v7 column is preserved (no data loss).
    const secondRun = runMigrations(db);
    expect(secondRun.appliedMigrations).toEqual([]);
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRepoDecouplingColumns)
    );

    db.close();
  });

  it("upgrades an existing v6 database to v7 without data loss", () => {
    const stateRoot = createTempStateRoot();
    const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
    const db = openTeamDatabase(databasePath);

    // Apply only v1..v6 (simulate an existing pre-decoupling database) and seed a
    // team + run row so we can prove the additive upgrade preserves data.
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
      migration.up(db);
      db.prepare(
        `
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `
      ).run(migration.version, migration.name, "2026-06-10T00:00:00.000Z");
    }
    expect(getMigrationStatus(db)).toMatchObject({ latestVersion: 6 });
    expect(tableColumns(db, TABLE_NAMES.runs)).not.toContain("worktree_repo_root");

    insertTeam(db, "team-v6-upgrade", "v6-upgrade");
    db.prepare(
      `
        INSERT INTO runs (run_id, team_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      "run-v6-upgrade",
      "team-v6-upgrade",
      "scheduled",
      "2026-06-10T00:00:00.000Z",
      "2026-06-10T00:00:00.000Z"
    );

    const upgrade = runMigrations(db);
    expect(upgrade.appliedMigrations.map((migration) => migration.version)).toEqual([
      7,
      8
    ]);
    expect(getMigrationStatus(db)).toMatchObject({
      status: "up_to_date",
      latestVersion: 8,
      targetVersion: 8
    });
    expect(tableColumns(db, TABLE_NAMES.runs)).toContain("worktree_repo_root");
    // No data loss: the seeded run survived, the new column defaults to NULL.
    expect(
      db.prepare("SELECT worktree_repo_root FROM runs WHERE run_id = ?").get(
        "run-v6-upgrade"
      )
    ).toMatchObject({ worktree_repo_root: null });

    db.close();
  });

  it("creates required unique constraints and message task event indexes", () => {
    const { db } = openMigratedDatabase();

    expect(uniqueIndexes(db, "teams")).toContain(
      "idx_teams_workspace_canonical_name"
    );
    expect(uniqueIndexes(db, "teams")).not.toContain("idx_teams_canonical_name");
    expect(indexSql(db, "idx_teams_workspace_canonical_name")).toContain(
      "teams(workspace_root, canonical_name)"
    );
    expect(uniqueIndexes(db, "active_bindings")).toContain(
      "idx_active_bindings_binding_key"
    );
    expect(indexSql(db, "idx_events_team_created_at")).toContain(
      "events(team_id, created_at)"
    );
    expect(indexSql(db, "idx_events_workspace_actor_created_at")).toContain(
      "events(workspace_root, actor_caller_key, created_at)"
    );
    expect(indexSql(db, "idx_messages_team_recipient_delivery")).toContain(
      "messages(team_id, recipient_member_id, delivery_status"
    );
    expect(indexSql(db, "idx_tasks_team_public_task_id")).toContain(
      "tasks(team_id, public_task_id)"
    );
    expect(indexSql(db, "idx_task_edges_team_source")).toContain(
      "task_edges(team_id, source_task_id"
    );
    expect(indexSql(db, "idx_task_edges_team_target")).toContain(
      "task_edges(team_id, target_task_id"
    );
    expect(indexSql(db, "idx_task_events_task_created_at")).toContain(
      "task_events(task_id, created_at)"
    );
    expect(indexSql(db, "idx_runs_team_backend_status")).toContain(
      "runs(team_id, backend_status)"
    );
    expect(indexSql(db, "idx_runs_team_review_status")).toContain(
      "runs(team_id, review_status)"
    );

    db.close();
  });

  it("migrates version 1 databases away from global canonical-name uniqueness", () => {
    const db = openLegacyVersionOneDatabase();

    const result = runMigrations(db);

    expect(result.appliedMigrations.map((migration) => migration.version)).toEqual([
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]);
    expect(uniqueIndexes(db, "teams")).toContain(
      "idx_teams_workspace_canonical_name"
    );
    expect(uniqueIndexes(db, "teams")).not.toContain("idx_teams_canonical_name");
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRunLifecycleColumns)
    );

    db.close();
  });

  it("migrates version 2 databases to version 4 while preserving message, task, and run rows", () => {
    const db = openLegacyVersionTwoDatabase();

    const result = runMigrations(db);

    expect(result.appliedMigrations.map((migration) => migration.version)).toEqual([
      3,
      4,
      5,
      6,
      7,
      8
    ]);
    expect(result.appliedMigrations[0]?.name).toContain(
      "expand message and task coordination state"
    );
    expect(result.appliedMigrations[1]?.name).toContain(
      "add lifecycle and isolation metadata"
    );
    expect(
      db.prepare("SELECT canonical_name FROM teams WHERE team_id = ?").get(
        "team-v2-id"
      )
    ).toMatchObject({ canonical_name: "version-two" });
    expect(
      db.prepare("SELECT display_name FROM members WHERE member_id = ?").get(
        "leader:team-v2-id"
      )
    ).toMatchObject({ display_name: "Team Lead" });
    expect(
      db
        .prepare(
          `
            SELECT message_id, status, delivery_status
            FROM messages
            WHERE message_id = ?
          `
        )
        .get("message-v2-id")
    ).toMatchObject({
      message_id: "message-v2-id",
      status: "queued",
      delivery_status: "queued_while_idle"
    });
    expect(
      db
        .prepare(
          `
            SELECT task_id, task_sequence, public_task_id
            FROM tasks
            WHERE task_id = ?
          `
        )
        .get("task:team-v2-id:1")
    ).toMatchObject({
      task_id: "task:team-v2-id:1",
      task_sequence: 1,
      public_task_id: "task-1"
    });
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace",
      caller: normalizeCallerMetadata({ sessionId: "migration-test" })
    });
    const taskResult = new TaskService({
      db,
      statePath: "/state"
    }).getTask({
      teamName: "version-two",
      task_id: "task-1",
      identity
    });
    expect(taskResult).toMatchObject({
      status: "found",
      task: {
        task_id: "task:team-v2-id:1",
        public_task_id: "task-1"
      }
    });
    expect(tableNames(db)).toEqual(expect.arrayContaining(["task_edges", "task_events"]));
    expect(tableColumns(db, TABLE_NAMES.runs)).toEqual(
      expect.arrayContaining(expectedRunLifecycleColumns)
    );
    expect(
      db
        .prepare(
          `
            SELECT run_id, backend_run_id, backend_thread_id, backend_process_id, changed_files_json
            FROM runs
            WHERE run_id = ?
          `
        )
        .get("run:team-v2-id:1")
    ).toMatchObject({
      run_id: "run:team-v2-id:1",
      backend_run_id: null,
      backend_thread_id: null,
      backend_process_id: null,
      changed_files_json: "[]"
    });

    db.close();
  });

  it("configures WAL, foreign keys, and busy timeout", () => {
    const { db } = openMigratedDatabase();

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);

    db.close();
  });

  it("allows team-scoped lifecycle events and teamless error events", () => {
    const { db } = openMigratedDatabase();
    insertTeam(db, "team-alpha-id", "alpha");

    db.prepare(
      `
        INSERT INTO events (
          event_id,
          team_id,
          workspace_root,
          actor_caller_key,
          event_type,
          error_code,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "event-team-created",
      "team-alpha-id",
      "/workspace",
      "codex-team:sessionId:test",
      "team_created",
      null,
      '{"source":"test"}',
      "2026-06-03T00:00:01.000Z"
    );

    db.prepare(
      `
        INSERT INTO events (
          event_id,
          team_id,
          workspace_root,
          actor_caller_key,
          event_type,
          error_code,
          payload_json,
          created_at
        )
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "event-teamless-validation-error",
      "/workspace",
      "codex-team:sessionId:test",
      ERROR_EVENT_TYPES.toolValidationFailed,
      "missing_team_name",
      '{"field":"team_name"}',
      "2026-06-03T00:00:02.000Z"
    );

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM events WHERE team_id IS NOT NULL").get()
    ).toMatchObject({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT event_type, error_code FROM events WHERE team_id IS NULL LIMIT 1"
        )
        .get()
    ).toMatchObject({
      event_type: "tool_validation_failed",
      error_code: "missing_team_name"
    });

    db.close();
  });

  it("is idempotent and preserves rows across reopen", () => {
    const stateRoot = createTempStateRoot();
    const first = openMigratedDatabase(stateRoot);
    insertTeam(first.db, "team-persisted-id", "persisted");

    const secondRun = runMigrations(first.db);
    expect(secondRun.appliedMigrations).toEqual([]);
    first.db.close();

    const reopened = openMigratedDatabase(stateRoot);
    expect(
      reopened.db.prepare("SELECT canonical_name FROM teams WHERE team_id = ?").get(
        "team-persisted-id"
      )
    ).toMatchObject({ canonical_name: "persisted" });
    expect(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
    ).toMatchObject({ count: 8 });

    reopened.db.close();
  });
});

describe("DurableStateAdapter", () => {
  it("reports resolved state root, migration status, table counts, and recent events", () => {
    const stateRoot = createTempStateRoot();
    const adapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: "/workspace"
    });

    const db = adapter.getDatabase();
    insertTeam(db, "team-diagnostics-id", "diagnostics");
    db.prepare(
      `
        INSERT INTO events (
          event_id,
          team_id,
          workspace_root,
          actor_caller_key,
          event_type,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "event-diagnostics",
      "team-diagnostics-id",
      "/workspace",
      "codex-team:sessionId:test",
      "team_created",
      "{}",
      "2026-06-03T00:00:03.000Z"
    );

    const description = adapter.describeStateRoot();

    expect(description.durableStateImplemented).toBe(true);
    expect(description.configuredStateRoot).toBe(stateRoot);
    expect(description.stateRoot).toBe(stateRoot);
    expect(description.databasePath).toBe(path.join(stateRoot, STATE_DB_FILENAME));
    expect(description.migrationStatus).toMatchObject({
      status: "up_to_date",
      latestVersion: 8,
      targetVersion: 8,
      pendingMigrations: []
    });
    expect(description.tableCounts).toMatchObject({
      teams: 1,
      members: 0,
      active_bindings: 0,
      component_initializations: 0,
      messages: 0,
      tasks: 0,
      task_edges: 0,
      task_events: 0,
      runs: 0,
      events: 1
    });
    expect(description.recentEvents).toEqual([
      expect.objectContaining({
        event_id: "event-diagnostics",
        team_id: "team-diagnostics-id",
        event_type: "team_created"
      })
    ]);
    expect(description.warnings).toEqual([]);

    adapter.close();
    expect(() => adapter.getDatabase().prepare("SELECT 1").get()).toThrow();
  });

  it("reopens existing durable state and reports preserved table counts", () => {
    const stateRoot = createTempStateRoot();
    const firstAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: "/workspace"
    });

    insertTeam(firstAdapter.getDatabase(), "team-reopened-id", "reopened");
    firstAdapter.close();

    const reopenedAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: "/workspace"
    });
    const description = reopenedAdapter.describeStateRoot();

    expect(description.migrationStatus.status).toBe("up_to_date");
    expect(description.tableCounts.teams).toBe(1);
    expect(description.tableCounts.schema_migrations).toBe(8);
    expect(description.tableCounts.task_edges).toBe(0);
    expect(description.tableCounts.task_events).toBe(0);

    reopenedAdapter.close();
  });
});
