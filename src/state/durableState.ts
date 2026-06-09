import type Database from "better-sqlite3";

import type {
  RecentStateEvent,
  StateAdapter,
  StateRootDescription
} from "../adapters/state.js";
import { openTeamDatabase } from "./database.js";
import { getMigrationStatus, runMigrations } from "./migrations.js";
import { TABLE_NAMES, type TableName } from "./schema.js";
import { resolveStateRoot, type ResolveStateRootOptions } from "./root.js";

export interface DurableStateAdapterOptions extends ResolveStateRootOptions {
  recentEventLimit?: number;
}

interface CountRow {
  count: number;
}

const countableTables = Object.values(TABLE_NAMES);

function countRows(db: Database.Database, tableName: TableName): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as
    | CountRow
    | undefined;

  return row?.count ?? 0;
}

function readRecentEvents(
  db: Database.Database,
  limit: number
): RecentStateEvent[] {
  return db
    .prepare(
      `
        SELECT
          event_id,
          team_id,
          actor_member_id,
          workspace_root,
          actor_caller_key,
          event_type,
          error_code,
          payload_json,
          created_at
        FROM ${TABLE_NAMES.events}
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?
      `
    )
    .all(limit) as RecentStateEvent[];
}

export class DurableStateAdapter implements StateAdapter {
  private readonly resolvedStateRoot;
  private readonly db: Database.Database;
  private readonly recentEventLimit: number;

  constructor(private readonly options: DurableStateAdapterOptions = {}) {
    this.resolvedStateRoot = resolveStateRoot(options);
    this.db = openTeamDatabase(this.resolvedStateRoot.databasePath);
    this.recentEventLimit = options.recentEventLimit ?? 10;
    runMigrations(this.db);
  }

  describeStateRoot(): StateRootDescription {
    const tableCounts = Object.fromEntries(
      countableTables.map((tableName) => [tableName, countRows(this.db, tableName)])
    ) as Record<TableName, number>;
    const migrationStatus = getMigrationStatus(this.db);
    const recentEvents = readRecentEvents(this.db, this.recentEventLimit);

    return {
      status: "durable",
      configuredStateRoot:
        this.options.stateRoot ??
        this.options.env?.CODEX_TEAM_STATE_ROOT ??
        process.env.CODEX_TEAM_STATE_ROOT,
      defaultStateRoot: this.resolvedStateRoot.defaultStateRoot,
      durableStateImplemented: true,
      workspaceRoot: this.resolvedStateRoot.workspaceRoot,
      stateRoot: this.resolvedStateRoot.stateRoot,
      databasePath: this.resolvedStateRoot.databasePath,
      source: this.resolvedStateRoot.source,
      migrationStatus,
      tableCounts,
      recentEvents,
      warnings: this.resolvedStateRoot.warnings
    };
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
