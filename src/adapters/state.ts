import type { MigrationStatus } from "../state/migrations.js";
import {
  DEFAULT_STATE_ROOT,
  type StateRootSource,
  type StateRootWarning
} from "../state/root.js";
import type { TableName } from "../state/schema.js";
import type { ScaffoldStatus } from "../types.js";

export interface RecentStateEvent {
  event_id: string;
  team_id: string | null;
  actor_member_id: string | null;
  workspace_root: string;
  actor_caller_key: string;
  event_type: string;
  error_code: string | null;
  payload_json: string;
  created_at: string;
}

export interface ScaffoldStateRootDescription {
  status: Extract<ScaffoldStatus, "scaffold_only">;
  configuredStateRoot?: string;
  defaultStateRoot: typeof DEFAULT_STATE_ROOT;
  durableStateImplemented: false;
}

export interface DurableStateRootDescription {
  status: "durable";
  configuredStateRoot?: string;
  defaultStateRoot: typeof DEFAULT_STATE_ROOT;
  durableStateImplemented: true;
  workspaceRoot: string;
  stateRoot: string;
  databasePath: string;
  source: StateRootSource;
  migrationStatus: MigrationStatus;
  tableCounts: Record<TableName, number>;
  recentEvents: RecentStateEvent[];
  warnings: StateRootWarning[];
}

export type StateRootDescription =
  | ScaffoldStateRootDescription
  | DurableStateRootDescription;

export interface StateAdapter {
  describeStateRoot(): StateRootDescription;
}

export class ScaffoldStateAdapter implements StateAdapter {
  constructor(private readonly configuredStateRoot?: string) {}

  describeStateRoot(): StateRootDescription {
    return {
      status: "scaffold_only",
      configuredStateRoot: this.configuredStateRoot,
      defaultStateRoot: DEFAULT_STATE_ROOT,
      durableStateImplemented: false
    };
  }
}

export { DurableStateAdapter } from "../state/durableState.js";
