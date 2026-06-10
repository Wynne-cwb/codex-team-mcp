import type Database from "better-sqlite3";

import {
  ACTIVE_BINDING_STATUSES,
  COMPONENT_NAMES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  MEMBER_STATUSES,
  TABLE_NAMES,
  TEAM_STATUSES
} from "./schema.js";

export interface MigrationDefinition {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

export interface PendingMigration {
  version: number;
  name: string;
}

export interface MigrationStatus {
  status: "up_to_date" | "pending";
  latestVersion: number;
  targetVersion: number;
  appliedMigrations: AppliedMigration[];
  pendingMigrations: PendingMigration[];
}

export interface MigrationRunResult extends MigrationStatus {
  appliedMigrations: AppliedMigration[];
}

const schemaMigrationSql = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.schemaMigrations} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

const quoteList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

const teamStatuses = quoteList(Object.values(TEAM_STATUSES));
const memberStatuses = quoteList(Object.values(MEMBER_STATUSES));
const activeBindingStatuses = quoteList(Object.values(ACTIVE_BINDING_STATUSES));
const componentNames = quoteList(Object.values(COMPONENT_NAMES));

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) {
      return;
    }

    throw error;
  }
}

export const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: "create durable team state tables",
    up(db) {
      // Migration 1 creates schema_migrations, teams, members, active_bindings, component_initializations, messages, tasks, runs, and events.
      db.exec(`
        ${schemaMigrationSql}

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.teams} (
          team_id TEXT PRIMARY KEY,
          canonical_name TEXT NOT NULL,
          requested_name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL CHECK (status IN (${teamStatuses})),
          workspace_root TEXT NOT NULL,
          lead_agent_id TEXT NOT NULL,
          created_by_caller_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT,
          archive_reason TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_workspace_canonical_name
          ON ${TABLE_NAMES.teams}(workspace_root, canonical_name);
        CREATE INDEX IF NOT EXISTS idx_teams_workspace_status
          ON ${TABLE_NAMES.teams}(workspace_root, status);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.members} (
          member_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          agent_type TEXT,
          model_hint TEXT,
          status TEXT NOT NULL CHECK (status IN (${memberStatuses})),
          caller_key TEXT,
          workspace_root TEXT NOT NULL,
          joined_at TEXT NOT NULL,
          archived_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_members_team_role
          ON ${TABLE_NAMES.members}(team_id, role);
        CREATE INDEX IF NOT EXISTS idx_members_team_status
          ON ${TABLE_NAMES.members}(team_id, status);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.activeBindings} (
          binding_key TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          caller_key TEXT NOT NULL,
          team_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${activeBindingStatuses})),
          fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          invalidated_at TEXT,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_bindings_binding_key
          ON ${TABLE_NAMES.activeBindings}(binding_key);
        CREATE INDEX IF NOT EXISTS idx_active_bindings_binding_status
          ON ${TABLE_NAMES.activeBindings}(binding_key, status);
        CREATE INDEX IF NOT EXISTS idx_active_bindings_team_status
          ON ${TABLE_NAMES.activeBindings}(team_id, status);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.componentInitializations} (
          team_id TEXT NOT NULL,
          component TEXT NOT NULL CHECK (component IN (${componentNames})),
          initialized_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (team_id, component),
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.messages} (
          message_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          sender_member_id TEXT,
          recipient_member_id TEXT,
          status TEXT NOT NULL,
          body_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE,
          FOREIGN KEY (sender_member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL,
          FOREIGN KEY (recipient_member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_team_recipient_status
          ON ${TABLE_NAMES.messages}(team_id, recipient_member_id, status);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.tasks} (
          task_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_member_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE,
          FOREIGN KEY (owner_member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_team_status
          ON ${TABLE_NAMES.tasks}(team_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_team_owner
          ON ${TABLE_NAMES.tasks}(team_id, owner_member_id);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.runs} (
          run_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          member_id TEXT,
          status TEXT NOT NULL,
          backend TEXT,
          workspace_path TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE,
          FOREIGN KEY (member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_runs_team_member_status
          ON ${TABLE_NAMES.runs}(team_id, member_id, status);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.events} (
          event_id TEXT PRIMARY KEY,
          team_id TEXT,
          actor_member_id TEXT,
          workspace_root TEXT NOT NULL,
          actor_caller_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          error_code TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE SET NULL,
          FOREIGN KEY (actor_member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_team_created_at
          ON ${TABLE_NAMES.events}(team_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_workspace_actor_created_at
          ON ${TABLE_NAMES.events}(workspace_root, actor_caller_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_event_type_created_at
          ON ${TABLE_NAMES.events}(event_type, created_at);
      `);
    }
  },
  {
    version: 2,
    name: "scope canonical team names by workspace",
    up(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_teams_canonical_name;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_workspace_canonical_name
          ON ${TABLE_NAMES.teams}(workspace_root, canonical_name);
      `);
    }
  },
  {
    version: 3,
    name: "expand message and task coordination state",
    up(db) {
      addColumnIfMissing(db, TABLE_NAMES.messages, "delivery_status", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.messages, "summary", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.messages, "updated_at", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.messages, "read_at", "TEXT");
      addColumnIfMissing(
        db,
        TABLE_NAMES.messages,
        "metadata_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );

      addColumnIfMissing(db, TABLE_NAMES.tasks, "public_task_id", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.tasks, "task_sequence", "INTEGER");
      addColumnIfMissing(db, TABLE_NAMES.tasks, "subject", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.tasks, "active_form", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.tasks, "archived_at", "TEXT");

      db.exec(`
        UPDATE ${TABLE_NAMES.messages}
        SET delivery_status = CASE
          WHEN status IN (
            '${MESSAGE_DELIVERY_STATUSES.queuedForNextTurn}',
            '${MESSAGE_DELIVERY_STATUSES.queuedWhileIdle}'
          )
            THEN status
          ELSE '${MESSAGE_DELIVERY_STATUSES.queuedWhileIdle}'
        END
        WHERE delivery_status IS NULL;

        UPDATE ${TABLE_NAMES.messages}
        SET status = '${MESSAGE_ROW_STATUSES.queued}'
        WHERE status IN (
          '${MESSAGE_DELIVERY_STATUSES.queuedForNextTurn}',
          '${MESSAGE_DELIVERY_STATUSES.queuedWhileIdle}'
        );

        UPDATE ${TABLE_NAMES.messages}
        SET updated_at = created_at
        WHERE updated_at IS NULL;

        UPDATE ${TABLE_NAMES.tasks}
        SET subject = title
        WHERE subject IS NULL;

        WITH numbered AS (
          SELECT
            task_id,
            ROW_NUMBER() OVER (
              PARTITION BY team_id
              ORDER BY created_at, task_id
            ) AS sequence
          FROM ${TABLE_NAMES.tasks}
          WHERE task_sequence IS NULL
            OR public_task_id IS NULL
        )
        UPDATE ${TABLE_NAMES.tasks}
        SET
          task_sequence = COALESCE(
            task_sequence,
            (
              SELECT sequence
              FROM numbered
              WHERE numbered.task_id = ${TABLE_NAMES.tasks}.task_id
            )
          ),
          public_task_id = COALESCE(
            public_task_id,
            'task-' || (
              SELECT sequence
              FROM numbered
              WHERE numbered.task_id = ${TABLE_NAMES.tasks}.task_id
            )
          )
        WHERE task_id IN (SELECT task_id FROM numbered);

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.taskEdges} (
          edge_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          source_task_id TEXT NOT NULL,
          target_task_id TEXT NOT NULL,
          edge_type TEXT NOT NULL CHECK (edge_type = 'blocks'),
          created_at TEXT NOT NULL,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE,
          FOREIGN KEY (source_task_id) REFERENCES ${TABLE_NAMES.tasks}(task_id) ON DELETE CASCADE,
          FOREIGN KEY (target_task_id) REFERENCES ${TABLE_NAMES.tasks}(task_id) ON DELETE CASCADE,
          UNIQUE(team_id, source_task_id, target_task_id, edge_type)
        );

        CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.taskEvents} (
          task_event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          actor_member_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          note TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES ${TABLE_NAMES.tasks}(task_id) ON DELETE CASCADE,
          FOREIGN KEY (team_id) REFERENCES ${TABLE_NAMES.teams}(team_id) ON DELETE CASCADE,
          FOREIGN KEY (actor_member_id) REFERENCES ${TABLE_NAMES.members}(member_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_team_recipient_delivery
          ON ${TABLE_NAMES.messages}(team_id, recipient_member_id, delivery_status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_team_public_task_id
          ON ${TABLE_NAMES.tasks}(team_id, public_task_id);
        CREATE INDEX IF NOT EXISTS idx_task_edges_team_source
          ON ${TABLE_NAMES.taskEdges}(team_id, source_task_id, edge_type);
        CREATE INDEX IF NOT EXISTS idx_task_edges_team_target
          ON ${TABLE_NAMES.taskEdges}(team_id, target_task_id, edge_type);
        CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at
          ON ${TABLE_NAMES.taskEvents}(task_id, created_at);
      `);
    }
  },
  {
    version: 4,
    name: "add lifecycle and isolation metadata",
    up(db) {
      addColumnIfMissing(db, TABLE_NAMES.runs, "backend_status", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "backend_run_id", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "backend_thread_id", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "backend_process_id", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "started_at", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "ended_at", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "last_reconciled_at", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "work_classification", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "isolation_kind", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "base_revision", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "review_status", "TEXT");
      addColumnIfMissing(
        db,
        TABLE_NAMES.runs,
        "changed_files_json",
        "TEXT NOT NULL DEFAULT '[]'"
      );
      addColumnIfMissing(db, TABLE_NAMES.runs, "diff_summary", "TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_runs_team_backend_status
          ON ${TABLE_NAMES.runs}(team_id, backend_status);
        CREATE INDEX IF NOT EXISTS idx_runs_team_review_status
          ON ${TABLE_NAMES.runs}(team_id, review_status);
      `);
    }
  },
  {
    version: 5,
    name: "add resume debounce timestamp",
    up(db) {
      // Phase 10 (D10-4): per-burst resume debounce. The last resume attempt
      // timestamp persists on the run row (sibling of last_reconciled_at, v4)
      // so the debounce window survives MCP process restarts. Idempotent add via
      // addColumnIfMissing — same pattern as the v4 lifecycle time columns.
      addColumnIfMissing(db, TABLE_NAMES.runs, "last_resume_attempt_at", "TEXT");
    }
  },
  {
    version: 6,
    name: "add worktree merge audit metadata",
    up(db) {
      // Phase 12 (D-04 / ISOL-02): auditable TL-driven worktree merge metadata.
      // Idempotent adds (addColumnIfMissing, same pattern as v4/v5) — the
      // review_status column is free TEXT (no CHECK, see v4) so the new
      // merge_conflict/escalated_to_human enum values need no constraint change.
      // Redaction (P5 D-19): only file path names + commit SHA + caller key are
      // stored here — never diff content / prompt / body.
      addColumnIfMissing(db, TABLE_NAMES.runs, "worktree_branch", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "merge_commit", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "merged_at", "TEXT");
      addColumnIfMissing(db, TABLE_NAMES.runs, "merged_by_caller_key", "TEXT");
      addColumnIfMissing(
        db,
        TABLE_NAMES.runs,
        "merge_conflict_files_json",
        "TEXT"
      );
    }
  },
  {
    version: 7,
    name: "add worktree target repo root",
    up(db) {
      // Decouples the coordination/container root from the per-TeamMate TARGET
      // repo. The worktree is branched FROM and merged BACK INTO this repo,
      // which may be a CHILD of a multi-repo container (the container is not
      // itself a repo). Idempotent additive add (addColumnIfMissing, same
      // pattern as v4/v5/v6). Redaction (P5 D-19): a filesystem path like the
      // existing workspace_path — never diff content / prompt / body.
      addColumnIfMissing(db, TABLE_NAMES.runs, "worktree_repo_root", "TEXT");
    }
  }
];

function migrationTableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(TABLE_NAMES.schemaMigrations);

  return row !== undefined;
}

function readAppliedMigrations(db: Database.Database): AppliedMigration[] {
  if (!migrationTableExists(db)) {
    return [];
  }

  return db
    .prepare(
      `
        SELECT version, name, applied_at AS appliedAt
        FROM ${TABLE_NAMES.schemaMigrations}
        ORDER BY version
      `
    )
    .all() as AppliedMigration[];
}

function buildMigrationStatus(appliedMigrations: AppliedMigration[]): MigrationStatus {
  const appliedVersions = new Set(appliedMigrations.map((migration) => migration.version));
  const pendingMigrations = MIGRATIONS.filter(
    (migration) => !appliedVersions.has(migration.version)
  ).map(({ version, name }) => ({ version, name }));
  const latestVersion = appliedMigrations.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0
  );
  const targetVersion = MIGRATIONS.reduce(
    (target, migration) => Math.max(target, migration.version),
    0
  );

  return {
    status: pendingMigrations.length === 0 ? "up_to_date" : "pending",
    latestVersion,
    targetVersion,
    appliedMigrations,
    pendingMigrations
  };
}

export function getMigrationStatus(db: Database.Database): MigrationStatus {
  return buildMigrationStatus(readAppliedMigrations(db));
}

export function runMigrations(db: Database.Database): MigrationRunResult {
  const appliedDuringRun: AppliedMigration[] = [];

  db.transaction(() => {
    db.exec(schemaMigrationSql);
    const appliedVersions = new Set(
      readAppliedMigrations(db).map((migration) => migration.version)
    );

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      migration.up(db);
      const appliedAt = new Date().toISOString();
      db.prepare(
        `
          INSERT INTO ${TABLE_NAMES.schemaMigrations} (version, name, applied_at)
          VALUES (?, ?, ?)
        `
      ).run(migration.version, migration.name, appliedAt);
      appliedDuringRun.push({
        version: migration.version,
        name: migration.name,
        appliedAt
      });
    }
  })();

  const status = getMigrationStatus(db);

  return {
    ...status,
    appliedMigrations: appliedDuringRun
  };
}
