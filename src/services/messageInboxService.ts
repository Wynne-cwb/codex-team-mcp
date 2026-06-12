import type Database from "better-sqlite3";

import { buildPublicTeamMateId } from "./teamMemberNames.js";
import { MESSAGE_DELIVERY_STATUSES, MESSAGE_ROW_STATUSES, TABLE_NAMES } from "../state/schema.js";

// Phase 16 — pure-DB inbox read-model shared by the turn-boundary delivery drain
// (LifecycleService) and the inbox pull surface (TL auto-surface / CheckInbox,
// built by a later step). D-02: every write here touches ONLY timestamps
// (delivered_at / read_at) + the delivery_status enum — the message body NEVER
// leaves messages.body_json.

// metadata.message_type values that are system lifecycle notices (suppress_resume,
// messageService.ts:151-154). They are EXCLUDED from the pane-nudge (delivery)
// selection so the notice -> resume -> notice loop (D10-3) stays broken; they are
// still surfaced to the TL via the unread (read) selection (they target the leader).
const SUPPRESS_RESUME_MESSAGE_TYPES = [
  "resume_failure_notice",
  "lifecycle_completion"
] as const;

// The delivery_status the claim stamps onto a row whose runtime was nudged. Mirrors
// the lifecycle resume wording — honest "attempted", never implies mid-turn inject.
const BACKEND_RESUME_ATTEMPTED_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.backendResumeAttempted satisfies "backend_resume_attempted";
// Restored on an inject failure so a later drain retries the row.
const QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.queuedForNextTurn satisfies "queued_for_next_turn";
// Terminal delivery state stamped once the recipient has actually PULLED the row
// (claimRead). Resolves the observability bug where delivery_status stayed stuck at
// the push-ATTEMPT value forever even after the message was read.
const DELIVERED_TERMINAL_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.delivered satisfies "delivered";

// Row-status observability values. INSERT keeps `queued`; the claims advance a row
// to `delivered` (delivered_at stamped) then `read` (read_at stamped). These are
// NEVER selection gates — every SELECT keys off delivered_at / read_at — so
// advancing them can not change which rows any query returns.
const QUEUED_ROW_STATUS = MESSAGE_ROW_STATUSES.queued satisfies "queued";
const DELIVERED_ROW_STATUS = MESSAGE_ROW_STATUSES.delivered satisfies "delivered";
const READ_ROW_STATUS = MESSAGE_ROW_STATUSES.read satisfies "read";

// Hard cap on the nudge string so the injected pane payload is provably bounded and
// independent of body size (same contract as the Phase 15 bootstrap fix).
const MAX_NUDGE_LENGTH = 512;
const MAX_NUDGE_SENDERS = 3;

// Sender identity fields carried alongside a pending/unread row so the nudge can name
// the distinct senders (public ids) without a second query. Resolved to a public id
// by inboxSenderPublicId (mirrors memberResolver.resolvePublicId).
export interface InboxSenderInfo {
  sender_member_id: string | null;
  sender_public_teammate_id: string | null;
  sender_public_lead_agent_id: string | null;
  sender_display_name: string | null;
}

export interface PendingInboxRow extends InboxSenderInfo {
  message_id: string;
  rowid: number;
}

export interface UnreadInboxRow extends InboxSenderInfo {
  message_id: string;
  summary: string | null;
  body_json: string;
  metadata_json: string;
  created_at: string;
  read_at: string | null;
  rowid: number;
}

interface SelectUnreadOptions {
  includeRead?: boolean;
  limit?: number;
}

const SENDER_SELECT_COLUMNS = `
  m.message_id AS message_id,
  m.rowid AS rowid,
  m.sender_member_id AS sender_member_id,
  sender.display_name AS sender_display_name,
  json_extract(sender.metadata_json, '$.publicTeammateId') AS sender_public_teammate_id,
  json_extract(sender.metadata_json, '$.publicLeadAgentId') AS sender_public_lead_agent_id
`;

const SUPPRESS_PLACEHOLDERS = SUPPRESS_RESUME_MESSAGE_TYPES.map(() => "?").join(", ");

export class MessageInboxService {
  constructor(private readonly db: Database.Database) {}

  // Pending-nudge rows for a recipient: not yet delivered and NOT a system
  // lifecycle notice (suppress_resume). FIFO by rowid — the same monotonic ordering
  // the anti-loop counter trusts. SELECTION GATE = `delivered_at IS NULL` ONLY (the
  // single source of truth). The previous `status = 'queued'` predicate was
  // load-bearing only while `queued` was the lone status; dropping it keeps the
  // pending set IDENTICAL (a row only leaves `queued` together with delivered_at
  // being stamped, or via claimRead which never touches delivered_at) AND lets a
  // compensating un-stamp (uncompensateDelivered/unmarkDelivered nulls delivered_at)
  // correctly re-surface the row for retry.
  selectPendingForRecipient(
    teamId: string,
    recipientMemberId: string
  ): PendingInboxRow[] {
    return this.db
      .prepare(
        `
          SELECT ${SENDER_SELECT_COLUMNS}
          FROM ${TABLE_NAMES.messages} m
          LEFT JOIN ${TABLE_NAMES.members} sender
            ON sender.member_id = m.sender_member_id
          WHERE m.team_id = ?
            AND m.recipient_member_id = ?
            AND m.delivered_at IS NULL
            AND (
              json_extract(m.metadata_json, '$.message_type') IS NULL
              OR json_extract(m.metadata_json, '$.message_type') NOT IN (${SUPPRESS_PLACEHOLDERS})
            )
          ORDER BY m.rowid ASC
        `
      )
      .all(teamId, recipientMemberId, ...SUPPRESS_RESUME_MESSAGE_TYPES) as PendingInboxRow[];
  }

  // Unread (or full history) rows addressed to a member, oldest-first. Used by the
  // TL auto-surface + CheckInbox pull. System lifecycle notices ARE included here
  // (they target the leader and must be surfaced).
  //
  // SELECTION GATE = `read_at IS NULL` ONLY (the single source of truth). The
  // previous hard `status = 'queued'` predicate is DROPPED on purpose: once
  // claimDelivered advances a delivered-but-unread row to status='delivered', a
  // `status='queued'` filter would silently EXCLUDE it and CheckInbox / the TL
  // surface would drop a real, never-read message (release blocker). Gating purely
  // on read_at keeps the unread set IDENTICAL to before (`queued` was the only
  // status, so the predicate was always satisfied) while staying correct as the
  // status column converges.
  selectUnreadForMember(
    teamId: string,
    recipientMemberId: string,
    options: SelectUnreadOptions = {}
  ): UnreadInboxRow[] {
    const includeRead = options.includeRead === true;
    const limit = normalizeLimit(options.limit);
    const readPredicate = includeRead ? "" : "AND m.read_at IS NULL";

    return this.db
      .prepare(
        `
          SELECT ${SENDER_SELECT_COLUMNS},
            m.summary AS summary,
            m.body_json AS body_json,
            m.metadata_json AS metadata_json,
            m.created_at AS created_at,
            m.read_at AS read_at
          FROM ${TABLE_NAMES.messages} m
          LEFT JOIN ${TABLE_NAMES.members} sender
            ON sender.member_id = m.sender_member_id
          WHERE m.team_id = ?
            AND m.recipient_member_id = ?
            ${readPredicate}
          ORDER BY m.rowid ASC
          LIMIT ?
        `
      )
      .all(teamId, recipientMemberId, limit) as UnreadInboxRow[];
  }

  // Atomically claim the pending-nudge rows for a recipient: in a single
  // BEGIN IMMEDIATE write txn, SELECT the pending set then conditionally stamp
  // delivered_at + delivery_status ONLY on rows still NULL. Returns just the rows
  // THIS txn actually flipped — a concurrent drain on the shared WAL DB claims zero
  // and injects nothing (no duplicate nudge, no double delivery).
  claimDelivered(
    teamId: string,
    recipientMemberId: string,
    isoTime: string
  ): PendingInboxRow[] {
    const txn = this.db.transaction((): PendingInboxRow[] => {
      const pending = this.selectPendingForRecipient(teamId, recipientMemberId);
      if (pending.length === 0) {
        return [];
      }

      const claimed: PendingInboxRow[] = [];
      // Advance status -> 'delivered' alongside delivered_at (observability: the row
      // is now delivered, not still 'queued'). delivery_status stays the honest
      // push-ATTEMPT wording (backend_resume_attempted) here; it only converges to
      // the terminal 'delivered' once the recipient actually PULLS the row
      // (claimRead). Gated by delivered_at IS NULL, so status only flips on the same
      // rows that were genuinely queued+undelivered — selection is unaffected.
      const stamp = this.db.prepare(
        `
          UPDATE ${TABLE_NAMES.messages}
          SET delivered_at = ?,
              status = '${DELIVERED_ROW_STATUS}',
              delivery_status = '${BACKEND_RESUME_ATTEMPTED_DELIVERY_STATUS}'
          WHERE message_id = ?
            AND delivered_at IS NULL
        `
      );
      for (const row of pending) {
        const result = stamp.run(isoTime, row.message_id);
        if (result.changes > 0) {
          claimed.push(row);
        }
      }
      return claimed;
    });

    // BEGIN IMMEDIATE: take the write lock up-front so two concurrent drains
    // serialize on the claim rather than racing the conditional UPDATE.
    return runImmediate(txn);
  }

  // Compensating un-stamp after an inject failure: restore delivered_at = NULL,
  // status = queued and delivery_status = queued_for_next_turn so a later drain
  // retries the rows. Reverting status keeps it consistent with delivered_at (the
  // row is pending again). Only rows this drain actually claimed are passed in.
  uncompensateDelivered(messageIds: readonly string[]): void {
    if (messageIds.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `
        UPDATE ${TABLE_NAMES.messages}
        SET delivered_at = NULL,
            status = '${QUEUED_ROW_STATUS}',
            delivery_status = '${QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS}'
        WHERE message_id = ?
      `
    );
    const txn = this.db.transaction(() => {
      for (const messageId of messageIds) {
        stmt.run(messageId);
      }
    });
    txn();
  }

  // Mark a single already-resumed message delivered WITHOUT touching status /
  // delivery_status. The message-arrival idle-resume path stamps delivered_at so the
  // post-turn drain never re-nudges that row; status deliberately STAYS 'queued'
  // until the recipient actually PULLS it (claimRead), which is when it converges to
  // 'read'/'delivered'. (Only the turn-boundary drain claimDelivered advances status
  // to 'delivered' — the synchronous send path leaves the row queued-but-delivered,
  // the long-standing contract.) Conditional on delivered_at IS NULL so it never
  // clobbers a concurrent claim.
  markDelivered(messageId: string, isoTime: string): void {
    this.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.messages}
          SET delivered_at = ?
          WHERE message_id = ?
            AND delivered_at IS NULL
        `
      )
      .run(isoTime, messageId);
  }

  // Reset the delivered_at marker for a single message (message-arrival path, when
  // the resume that was about to deliver it failed). status is left as-is (markDelivered
  // never advanced it off 'queued'); delivery_status is left as the lifecycle reported it.
  unmarkDelivered(messageId: string): void {
    this.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.messages}
          SET delivered_at = NULL
          WHERE message_id = ?
        `
      )
      .run(messageId);
  }

  // Atomically claim-and-stamp read_at for the unread rows addressed to a member
  // (TL auto-surface + non-peek CheckInbox, next step). Returns the rows flipped to
  // read by THIS txn so concurrent callers cannot double-surface.
  claimRead(
    teamId: string,
    recipientMemberId: string,
    isoTime: string,
    options: SelectUnreadOptions = {}
  ): UnreadInboxRow[] {
    const txn = this.db.transaction((): UnreadInboxRow[] => {
      const unread = this.selectUnreadForMember(teamId, recipientMemberId, {
        ...options,
        // The claim only flips currently-unread rows; include_read is a read concern.
        includeRead: false
      });
      if (unread.length === 0) {
        return [];
      }

      const claimed: UnreadInboxRow[] = [];
      // Converge the row to its TERMINAL observability state: status -> 'read' and
      // delivery_status -> 'delivered' (the recipient has now actually pulled it, so
      // delivery_status must no longer be stuck at a push-attempt value like
      // backend_resume_attempted / backend_unavailable / queued_while_idle). Gated by
      // read_at IS NULL — the timestamp remains the selection source of truth, so
      // these status writes never change which rows any query returns.
      const stamp = this.db.prepare(
        `
          UPDATE ${TABLE_NAMES.messages}
          SET read_at = ?,
              status = '${READ_ROW_STATUS}',
              delivery_status = '${DELIVERED_TERMINAL_DELIVERY_STATUS}'
          WHERE message_id = ?
            AND read_at IS NULL
        `
      );
      for (const row of unread) {
        const result = stamp.run(isoTime, row.message_id);
        if (result.changes > 0) {
          claimed.push({ ...row, read_at: isoTime });
        }
      }
      return claimed;
    });

    return runImmediate(txn);
  }
}

// The inbox envelope message shape shared by the TL auto-surface (registry.ts) and
// the CheckInbox tool (inboxHandler.ts). `from` is the sender's public id (mirrors
// SendMessage references); `body` is the full text pulled byte-exact from
// messages.body_json — the lawful delivery to its intended recipient (D-02 safe).
export interface InboxEnvelopeMessage {
  message_id: string;
  from: string | null;
  summary: string | null;
  body: string;
  created_at: string;
  read_at: string | null;
}

// Extract the human-readable body text from messages.body_json (the normalized
// {type:"text",text} shape, messageService.ts:810-819). Falls back to the raw JSON
// string for any other shape so no content is silently dropped. Read-only on
// body_json — never persisted anywhere new.
export function extractInboxBodyText(bodyJson: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return (parsed as { text: string }).text;
    }
  } catch {
    // Not JSON / unexpected shape — fall through to the raw string.
  }
  return bodyJson;
}

// Shape an unread/history row into the inbox envelope message. Shared so the TL
// auto-surface and CheckInbox produce identical message objects.
export function toInboxEnvelopeMessage(
  row: UnreadInboxRow,
  teamName: string
): InboxEnvelopeMessage {
  return {
    message_id: row.message_id,
    from: inboxSenderPublicId(row, teamName),
    summary: row.summary,
    body: extractInboxBodyText(row.body_json),
    created_at: row.created_at,
    read_at: row.read_at
  };
}

// Resolve a sender row's public id, mirroring memberResolver.resolvePublicId so the
// nudge names senders exactly as SendMessage references do.
export function inboxSenderPublicId(
  sender: InboxSenderInfo,
  teamName: string
): string | null {
  if (sender.sender_public_teammate_id) {
    return sender.sender_public_teammate_id;
  }
  if (sender.sender_public_lead_agent_id) {
    return sender.sender_public_lead_agent_id;
  }
  if (!sender.sender_member_id) {
    return null;
  }
  if (sender.sender_member_id.startsWith("leader:")) {
    return `team-lead@${teamName}`;
  }
  const canonicalName = sender.sender_member_id.split(":").at(-1);
  return buildPublicTeamMateId(canonicalName ?? sender.sender_display_name ?? "teammate", teamName);
}

// Build the SHORT, single-line, length-bounded inbox nudge. Its length depends ONLY
// on the count + a capped list of sender public ids — NEVER on the message body
// (notify + pull: the body is pulled over MCP/JSON via CheckInbox). The result is
// hard-capped to MAX_NUDGE_LENGTH and stripped of newlines so the pane payload is
// provably bounded and submits as a single line.
export function buildInboxNudge(
  count: number,
  senderPublicIds: ReadonlyArray<string | null | undefined>
): string {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const distinct: string[] = [];
  for (const raw of senderPublicIds) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length > 0 && !distinct.includes(value)) {
      distinct.push(value);
    }
  }
  const shown = distinct.slice(0, MAX_NUDGE_SENDERS);
  const overflow = distinct.length > shown.length;
  const sendersPart =
    shown.length > 0 ? ` from ${shown.join(", ")}${overflow ? ", …" : ""}` : "";
  const noun = safeCount === 1 ? "message" : "messages";
  const nudge = `📬 ${safeCount} new ${noun}${sendersPart} — run CheckInbox to read.`;
  // Strip any stray newlines (bounded single line) and hard-cap the length.
  const singleLine = nudge.replace(/[\r\n]+/g, " ");
  return singleLine.length > MAX_NUDGE_LENGTH
    ? singleLine.slice(0, MAX_NUDGE_LENGTH)
    : singleLine;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return 50;
  }
  return Math.min(Math.floor(limit), 500);
}

// better-sqlite3 transactions run DEFERRED by default; the conditional claim needs
// the write lock taken up-front (BEGIN IMMEDIATE) so concurrent drains serialize.
function runImmediate<T>(txn: { immediate: () => T }): T {
  return txn.immediate();
}
