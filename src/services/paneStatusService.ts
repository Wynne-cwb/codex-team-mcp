import type Database from "better-sqlite3";

import { TABLE_NAMES } from "../state/schema.js";

export type PaneBackendType = "tmux" | "iterm2";
export type PaneAvailabilityStatus = "available" | "unavailable" | "degraded";

export interface PaneMetadataSummary {
  mode: "pane";
  backend_type: PaneBackendType;
  availability_status: PaneAvailabilityStatus;
  degradation_reason?: string;
  pane_id?: string;
  session_name?: string;
  window_id?: string;
  window_name?: string;
  socket_name?: string;
  attach_command?: string;
  is_native?: boolean;
}

export interface PaneStatusRow {
  run_id: string;
  member_id: string | null;
  teammate_id?: string;
  backend: string | null;
  backend_status: string | null;
  lifecycle_status: string;
  review_status: string | null;
  workspace_path?: string;
  pane: PaneMetadataSummary;
  mode: "pane";
  backend_type: PaneBackendType;
  availability_status: PaneAvailabilityStatus;
  degradation_reason?: string;
  pane_id?: string;
  session_name?: string;
  window_id?: string;
  window_name?: string;
  socket_name?: string;
  attach_command?: string;
  // D-03: in the default (non-debug) summary the full attach_command is withheld
  // and this hint marks panes that have a legitimate attach command available.
  attach_hint?: boolean;
  is_native?: boolean;
}

export interface PaneStatusSummary {
  enabled: boolean;
  total: number;
  attachable: number;
  available: number;
  unavailable: number;
  degraded: number;
  by_backend_type: Record<string, number>;
  by_availability_status: Record<string, number>;
  recent: PaneStatusRow[];
  panes: PaneStatusRow[];
}

interface RunPaneRow {
  run_id: string;
  member_id: string | null;
  backend: string | null;
  backend_status: string | null;
  lifecycle_status: string;
  review_status: string | null;
  workspace_path: string | null;
  metadata_json: string;
  member_metadata_json: string | null;
}

interface ReadPaneStatusSummaryOptions {
  paneModeEnabled?: boolean;
  includeDebug?: boolean;
}

const sensitiveFragments = [
  "prompt",
  "message",
  "body",
  "description",
  "notes",
  "task",
  "payload_json",
  "transcript"
];
const SECRET_TOKEN_PATTERN = /SECRET_[A-Z0-9_]+/gi;
const UNSAFE_ATTACH_METADATA_OMITTED = "unsafe_attach_metadata_omitted";
const POSIX_SINGLE_QUOTE_ESCAPE = "'\\''";

export function readPaneStatusSummary(
  db: Database.Database,
  workspaceRoot: string,
  options: ReadPaneStatusSummaryOptions = {}
): PaneStatusSummary {
  const rows = db
    .prepare(
      `
        SELECT
          runs.run_id,
          runs.member_id,
          runs.backend,
          runs.backend_status,
          runs.status AS lifecycle_status,
          runs.review_status,
          runs.workspace_path,
          runs.metadata_json,
          members.metadata_json AS member_metadata_json
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        LEFT JOIN ${TABLE_NAMES.members} AS members
          ON members.member_id = runs.member_id
        WHERE teams.workspace_root = ?
        ORDER BY runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot) as RunPaneRow[];

  const allPanes = rows
    .map(toPaneStatusRow)
    .filter((row): row is PaneStatusRow => row !== null);
  // D-03: "attachable" stays defined by whether a legitimate (safety-filtered)
  // attach_command exists — computed BEFORE the default-mode split withholds it.
  const attachable = allPanes.filter((row) => Boolean(row.attach_command)).length;
  // Default output keeps only an attach hint + session/backend labels; the full,
  // copy-pasteable attach_command moves behind include_debug.
  const panes =
    options.includeDebug === true
      ? allPanes
      : allPanes.map(withDefaultAttachHint);
  const recent = panes.slice(0, 10);
  const byBackendType = countBy(panes, (row) => row.backend_type);
  const byAvailabilityStatus = countBy(panes, (row) => row.availability_status);

  return {
    enabled: options.paneModeEnabled === true || panes.length > 0,
    total: panes.length,
    attachable,
    available: byAvailabilityStatus.available ?? 0,
    unavailable: byAvailabilityStatus.unavailable ?? 0,
    degraded: byAvailabilityStatus.degraded ?? 0,
    by_backend_type: byBackendType,
    by_availability_status: byAvailabilityStatus,
    recent,
    panes: recent
  };
}

// D-03 default/debug split: strip the full attach_command (top-level field and
// the nested `pane` object) and replace it with an attach_hint flag, keeping the
// backend/session labels. Applied only in the default (non-debug) summary.
function withDefaultAttachHint(row: PaneStatusRow): PaneStatusRow {
  if (!row.attach_command) {
    return row;
  }

  const { attach_command: _omitRow, ...rest } = row;
  const { attach_command: _omitPane, ...paneRest } = row.pane;

  return {
    ...rest,
    pane: paneRest,
    attach_hint: true
  };
}

function toPaneStatusRow(row: RunPaneRow): PaneStatusRow | null {
  const runMetadata = parseJsonObject(row.metadata_json);
  const backendMetadata = runMetadata.backend_metadata;
  const paneMetadata =
    isRecord(backendMetadata) && isRecord(backendMetadata.pane)
      ? sanitizePaneMetadata(backendMetadata.pane)
      : isRecord(runMetadata.pane)
        ? sanitizePaneMetadata(runMetadata.pane)
        : null;

  if (!paneMetadata) {
    return null;
  }

  const workspacePath = normalizeOptionalText(row.workspace_path) ?? undefined;
  const memberMetadata = parseJsonObject(row.member_metadata_json);
  const teammateId = normalizeOptionalText(memberMetadata.publicTeammateId);

  return {
    run_id: row.run_id,
    member_id: row.member_id,
    ...(teammateId ? { teammate_id: teammateId } : {}),
    backend: row.backend,
    backend_status: row.backend_status,
    lifecycle_status: row.lifecycle_status,
    review_status: row.review_status,
    ...(workspacePath ? { workspace_path: workspacePath } : {}),
    pane: paneMetadata,
    ...paneMetadata
  };
}

function sanitizePaneMetadata(
  metadata: Record<string, unknown>
): PaneMetadataSummary | null {
  const backendType = sanitizeBackendType(metadata.backend_type);
  const availabilityStatus = sanitizeAvailabilityStatus(metadata.availability_status);

  if (!backendType || !availabilityStatus) {
    return null;
  }

  const degradationReason = optionalTextField(
    "degradation_reason",
    metadata.degradation_reason
  );
  const attachCommand = optionalAttachCommandField(metadata.attach_command);
  if (attachCommand.omitted) {
    degradationReason.degradation_reason = [
      degradationReason.degradation_reason,
      UNSAFE_ATTACH_METADATA_OMITTED
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("; ");
  }

  return {
    mode: "pane",
    backend_type: backendType,
    availability_status: availabilityStatus,
    ...degradationReason,
    ...optionalTextField("pane_id", metadata.pane_id),
    ...optionalTextField("session_name", metadata.session_name),
    ...optionalTextField("window_id", metadata.window_id),
    ...optionalTextField("window_name", metadata.window_name),
    ...optionalTextField("socket_name", metadata.socket_name),
    ...attachCommand.field,
    ...(typeof metadata.is_native === "boolean"
      ? { is_native: metadata.is_native }
      : {})
  };
}

function optionalTextField(
  key: keyof PaneMetadataSummary,
  value: unknown
): Partial<PaneMetadataSummary> {
  if (containsSensitiveFragment(key) || typeof value !== "string") {
    return {};
  }

  const sanitized = sanitizeOperationalText(value);
  if (!sanitized || containsSensitiveFragment(sanitized)) {
    return {};
  }

  return { [key]: sanitized } as Partial<PaneMetadataSummary>;
}

function optionalAttachCommandField(value: unknown): {
  field: Partial<PaneMetadataSummary>;
  omitted: boolean;
} {
  const field = optionalTextField("attach_command", value);
  if (!field.attach_command) {
    return { field, omitted: false };
  }

  if (
    hasAttachCommandControlSeparator(field.attach_command) ||
    hasUnquotedAttachMetacharacters(field.attach_command)
  ) {
    return { field: {}, omitted: true };
  }

  return { field, omitted: false };
}

function sanitizeBackendType(value: unknown): PaneBackendType | null {
  if (containsSensitiveString(value)) {
    return null;
  }

  return value === "tmux" || value === "iterm2" ? value : null;
}

function sanitizeAvailabilityStatus(value: unknown): PaneAvailabilityStatus | null {
  if (containsSensitiveString(value)) {
    return null;
  }

  if (value === "available" || value === "unavailable" || value === "degraded") {
    return value;
  }

  return null;
}

function containsSensitiveString(value: unknown): boolean {
  return typeof value === "string" && containsSensitiveFragment(value);
}

function containsSensitiveFragment(value: string): boolean {
  const normalized = value.toLowerCase();
  return sensitiveFragments.some((fragment) => normalized.includes(fragment));
}

function sanitizeOperationalText(value: string): string | null {
  const sanitized = value
    .replace(SECRET_TOKEN_PATTERN, "[redacted_secret]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();

  return sanitized ? sanitized : null;
}

function hasAttachCommandControlSeparator(value: string): boolean {
  return /[\r\n\t]/.test(value);
}

function hasUnquotedAttachMetacharacters(value: string): boolean {
  let inSingleQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (
      inSingleQuote &&
      value.slice(index, index + POSIX_SINGLE_QUOTE_ESCAPE.length) ===
        POSIX_SINGLE_QUOTE_ESCAPE
    ) {
      index += POSIX_SINGLE_QUOTE_ESCAPE.length - 1;
      continue;
    }
    if (char === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) {
      continue;
    }
    if (
      char === ";" ||
      char === "|" ||
      char === "`" ||
      char === "<" ||
      char === ">"
    ) {
      return true;
    }
    if (char === "&" && next === "&") {
      return true;
    }
    if (char === "$" && next === "(") {
      return true;
    }
  }

  return false;
}

function countBy<T>(
  values: readonly T[],
  getKey: (value: T) => string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = getKey(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = sanitizeOperationalText(value);
  return sanitized ? sanitized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
