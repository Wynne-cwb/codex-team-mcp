import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ExecutionBackend } from "../adapters/execution.js";
import type { PaneBackendRegistry } from "../adapters/paneBackend.js";
import type { PaneModeOptions } from "../types.js";
import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import { ContextResolver } from "./contextResolver.js";
import {
  LifecycleService,
  type LifecycleBackendResult,
  type LifecycleDeliveryResult,
  type LifecycleMetadataResult,
  type PaneTeardownSummary
} from "./lifecycleService.js";
import { MemberResolver } from "./memberResolver.js";
import type { MemberResolutionResult, ResolvedMember } from "./memberResolver.js";
import { buildInboxNudge } from "./messageInboxService.js";
import {
  EVENT_TYPES,
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  TABLE_NAMES,
  type MessageDeliveryStatus
} from "../state/schema.js";

export interface MessageServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
  // PANE-01 / D-01: forwarded to LifecycleService so a resume (SendMessage) can
  // refresh/attach the visible pane when pane mode is enabled. paneBackend is an
  // injection seam for deterministic tests (CI has no real tmux/iTerm2).
  paneMode?: PaneModeOptions;
  paneBackend?: PaneBackendRegistry;
  // Phase 14 (D-Q2 / BIDIR-06): per-turn proactive-message bound for teammate-role
  // senders. Resolved by the handler from env/options; default 8 when omitted.
  maxProactiveMessagesPerTurn?: number;
}

export interface SendMessageInput {
  teamName?: string;
  from?: string;
  to: string;
  message: unknown;
  summary?: string;
  metadata?: Record<string, unknown>;
  identity: WorkspaceScopedCallerIdentity;
}

export interface PersistResolvedMessageInput {
  teamId: string;
  teamName: string;
  sender: ResolvedMember;
  recipient: ResolvedMember;
  body: unknown;
  summary?: string;
  metadata?: Record<string, unknown>;
  identity: WorkspaceScopedCallerIdentity;
}

export interface MessageParticipant {
  member_id: string;
  display_name: string;
  role: string;
  status: string;
  teammate_id: string;
}

export interface PersistedMessageResult {
  status: MessageDeliveryStatus;
  message_id: string;
  team_name: string;
  sender: MessageParticipant;
  recipient: MessageParticipant;
  recipient_status: string;
  persisted: true;
  delivery_status: MessageDeliveryStatus;
  row_status: typeof MESSAGE_ROW_STATUSES.queued;
  // Phase 10: surfaced when a SendMessage-triggered resume ran a one-shot turn
  // to completion (member finalized to idle).
  turn_completed?: boolean;
  final_status?: "idle";
  // Pane teardown summary, present only when a structured shutdown_request closed
  // the recipient's pane(s). Best-effort and additive: absent on normal messages.
  pane_teardown?: PaneTeardownSummary;
  backend: LifecycleBackendResult;
  lifecycle: LifecycleMetadataResult;
  debug: {
    lifecycle: LifecycleDeliveryResult["debug"];
  };
}

export type SendMessageResult =
  | PersistedMessageResult
  | {
      status:
        | "error"
        | "invalid_sender"
        | "missing_recipient"
        | "recipient_archived"
        | "ambiguous_recipient"
        | "cross_team_recipient";
      error_code: string;
      message?: string;
      team_name?: string;
      persisted: false;
      not_handled_by_team_layer?: true;
    }
  | {
      status: "broadcast_unsupported_in_v1";
      team_name: string;
      persisted: false;
      delivery_status: "broadcast_unsupported_in_v1";
      error_code: "broadcast_unsupported_in_v1";
    };

interface PersistedMessageRow {
  messageId: string;
  deliveryStatus:
    | typeof MESSAGE_DELIVERY_STATUSES.queuedForNextTurn
    | typeof MESSAGE_DELIVERY_STATUSES.queuedWhileIdle;
  createdAt: string;
}

const MESSAGE_SENT_EVENT_TYPE = EVENT_TYPES.messageSent satisfies "message_sent";
const MESSAGE_QUEUED_EVENT_TYPE =
  EVENT_TYPES.messageQueued satisfies "message_queued";
const MESSAGE_SEND_FAILED_EVENT_TYPE =
  EVENT_TYPES.messageSendFailed satisfies "message_send_failed";
const MESSAGE_SEND_UNSUPPORTED_EVENT_TYPE =
  EVENT_TYPES.messageSendUnsupported satisfies "message_send_unsupported";
const QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.queuedForNextTurn satisfies "queued_for_next_turn";
const QUEUED_WHILE_IDLE_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.queuedWhileIdle satisfies "queued_while_idle";
const BACKEND_START_ATTEMPTED_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.backendStartAttempted satisfies "backend_start_attempted";
const BACKEND_RESUME_ATTEMPTED_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.backendResumeAttempted satisfies "backend_resume_attempted";

// Phase 14 (D-Q2 / D-Q5): sanitized error codes for the teammate-only send
// guards. Both are enum identifiers — never derived from caller-supplied text.
const TEAMMATE_PROACTIVE_LIMIT_EXCEEDED = "teammate_proactive_limit_exceeded";
const TEAMMATE_SELF_SEND_REJECTED = "teammate_self_send_rejected";
const TEAMMATE_ROLE = "teammate";
const DEFAULT_MAX_PROACTIVE_MESSAGES_PER_TURN = 8;
// metadata.message_type values that are system lifecycle notices and therefore
// EXEMPT from (and uncounted by) the per-turn proactive bound (D-Q2).
const SYSTEM_LIFECYCLE_NOTICE_TYPES = [
  "resume_failure_notice",
  "lifecycle_completion"
] as const;

export class MessageService {
  constructor(private readonly options: MessageServiceOptions) {}

  sendMessage(input: SendMessageInput): SendMessageResult {
    const resolvedTeam = new ContextResolver(this.options.db).resolveTeam({
      teamName: input.teamName,
      identity: input.identity
    });

    if (!resolvedTeam.ok) {
      return {
        status: "error",
        error_code: resolvedTeam.errorCode,
        message: resolvedTeam.message,
        persisted: false,
        not_handled_by_team_layer: true
      };
    }

    const team = resolvedTeam.team;
    if (input.to.trim() === "*") {
      this.appendMessageSendUnsupportedEvent({
        teamId: team.teamId,
        teamName: team.teamName,
        identity: input.identity,
        errorCode: "broadcast_unsupported_in_v1"
      });

      return {
        status: "broadcast_unsupported_in_v1",
        team_name: team.teamName,
        persisted: false,
        delivery_status: "broadcast_unsupported_in_v1",
        error_code: "broadcast_unsupported_in_v1"
      };
    }

    const memberResolver = new MemberResolver({
      db: this.options.db,
      identity: input.identity
    });
    const sender = memberResolver.resolveMemberReference({
      teamId: team.teamId,
      teamName: team.teamName,
      reference: input.from,
      purpose: "sender",
      identity: input.identity
    });

    if (sender.status !== "resolved") {
      return this.failSend({
        teamId: team.teamId,
        teamName: team.teamName,
        identity: input.identity,
        actorMemberId: null,
        errorCode: "invalid_sender",
        resultStatus: "invalid_sender",
        resolutionStatus: sender.status
      });
    }

    const recipient = memberResolver.resolveMemberReference({
      teamId: team.teamId,
      teamName: team.teamName,
      reference: input.to,
      purpose: "recipient",
      identity: input.identity
    });

    if (recipient.status !== "resolved") {
      const errorCode = recipientResolutionToErrorCode(recipient);

      return this.failSend({
        teamId: team.teamId,
        teamName: team.teamName,
        identity: input.identity,
        actorMemberId: sender.member.member_id,
        errorCode,
        resultStatus: errorCode,
        resolutionStatus: recipient.status
      });
    }

    // Phase 14 (D-Q2 / D-Q5): teammate-only anti-loop guards, enforced AFTER both
    // sender + recipient are resolved and BEFORE persist — so a rejection never
    // writes a messages row, never delivers, and never touches the body (D-02).
    // System lifecycle notices are exempt (the recursion-bounded notice paths must
    // never be throttled) and the TL / absent-role callers are never gated.
    const guardResult = this.enforceTeammateSendGuards({
      teamId: team.teamId,
      teamName: team.teamName,
      sender: sender.member,
      recipient: recipient.member,
      identity: input.identity,
      metadata: input.metadata
    });
    if (guardResult) {
      return guardResult;
    }

    const result = this.persistResolvedMessage({
      teamId: team.teamId,
      teamName: team.teamName,
      sender: sender.member,
      recipient: recipient.member,
      body: normalizeMessageBody(input.message),
      summary: normalizeOptionalText(input.summary) ?? undefined,
      metadata: input.metadata,
      identity: input.identity
    });

    // Best-effort, non-gating pane teardown on a structured shutdown_request.
    // The message itself is ALREADY persisted/queued above (we never skip
    // persistence for shutdowns — the TL may want the audit trail), and member
    // status / resume semantics are deliberately left untouched. Closing the
    // recipient's pane is a pure side effect; any failure is swallowed so the
    // send still returns success exactly as before.
    if (result.persisted && isShutdownRequest(input.message)) {
      try {
        result.pane_teardown = this.createLifecycleService().closePanesForMember(
          team.teamId,
          recipient.member.member_id
        );
      } catch {
        // Swallow: shutdown teardown must never fail the SendMessage.
      }
    }

    return result;
  }

  persistResolvedMessage(
    input: PersistResolvedMessageInput
  ): PersistedMessageResult {
    const tx = this.options.db.transaction(
      (transactionInput: PersistResolvedMessageInput): PersistedMessageRow => {
        const createdAt = new Date().toISOString();
        const messageId = `message:${transactionInput.teamId}:${randomUUID()}`;
        const deliveryStatus = deliveryStatusForRecipient(
          transactionInput.recipient.status
        );

        this.options.db
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
            messageId,
            transactionInput.teamId,
            transactionInput.sender.member_id,
            transactionInput.recipient.member_id,
            MESSAGE_ROW_STATUSES.queued,
            deliveryStatus,
            normalizeOptionalText(transactionInput.summary),
            JSON.stringify(transactionInput.body),
            JSON.stringify(transactionInput.metadata ?? {}),
            createdAt,
            createdAt
          );

        this.appendEvent({
          teamId: transactionInput.teamId,
          actorMemberId: transactionInput.sender.member_id,
          identity: transactionInput.identity,
          eventType: MESSAGE_SENT_EVENT_TYPE,
          payload: buildSuccessEventPayload(transactionInput, messageId, deliveryStatus),
          createdAt
        });
        this.appendEvent({
          teamId: transactionInput.teamId,
          actorMemberId: transactionInput.sender.member_id,
          identity: transactionInput.identity,
          eventType: MESSAGE_QUEUED_EVENT_TYPE,
          payload: buildSuccessEventPayload(transactionInput, messageId, deliveryStatus),
          createdAt
        });

        return {
          messageId,
          deliveryStatus,
          createdAt
        };
      }
    );

    const persisted = tx(input);
    // D10-3 recursion guard: a system lifecycle notice never re-triggers resume.
    const inboundIsSystemNotice = isSystemLifecycleNotice(input.metadata);
    // Phase 16 (notify + pull): the pane resume injects ONLY a SHORT, length-bounded
    // inbox nudge — NEVER the full body. A multi-KB body typed into a live TUI is the
    // long-body hazard (15-RCA); instead the recipient pulls the full body over the
    // reliable MCP/JSON channel via CheckInbox. The nudge length is independent of
    // body size (buildInboxNudge). System lifecycle notices suppress resume entirely,
    // so they carry no nudge (delivery_text null) and only ever surfaced a summary.
    const deliveryText = inboundIsSystemNotice
      ? null
      : buildInboxNudge(1, [input.sender.public_id]);
    const lifecycleDelivery =
      this.createLifecycleService().attemptDeliveryAfterPersistence({
        message_id: persisted.messageId,
        team_id: input.teamId,
        team_name: input.teamName,
        sender_member_id: input.sender.member_id,
        recipient_member_id: input.recipient.member_id,
        recipient_status: input.recipient.status,
        teammate_id: input.recipient.public_id,
        summary: input.summary,
        delivery_text: deliveryText,
        task_id: taskIdFromMetadata(input.metadata),
        trigger_kind: triggerKindFromMetadata(input.metadata),
        suppress_resume: inboundIsSystemNotice,
        identity: input.identity
      });

    // D10-3: proactively notify the original sender of an idle/stopped resume
    // failure (sanitized, best-effort, recursion-guarded). Merged/debounced
    // messages have backend_action "not_attempted" and never notify, so a burst
    // yields at most one notice (D10-3 × D10-4 alignment).
    const isResumeFailure =
      (input.recipient.status === MEMBER_STATUSES.idle ||
        input.recipient.status === MEMBER_STATUSES.stopped) &&
      lifecycleDelivery.debug.backend_action === "resume_attempted" &&
      (lifecycleDelivery.delivery_status ===
        MESSAGE_DELIVERY_STATUSES.backendUnavailable ||
        lifecycleDelivery.delivery_status ===
          MESSAGE_DELIVERY_STATUSES.backendFailed);

    if (
      isResumeFailure &&
      !inboundIsSystemNotice &&
      input.sender.member_id !== input.recipient.member_id
    ) {
      this.notifySenderOfResumeFailure({
        teamName: input.teamName,
        failedRecipient: input.recipient,
        originalSender: input.sender,
        errorCode: lifecycleDelivery.error_code ?? lifecycleDelivery.delivery_status,
        identity: input.identity
      });
    }

    // D10-3: notify the lead when a SendMessage-triggered resume ran a one-shot
    // turn to completion (mirrors the create-path D-03 completion notification;
    // distinct trigger source, so no duplication with AgentService).
    if (lifecycleDelivery.turn_completed === true && !inboundIsSystemNotice) {
      this.notifyLeadOfResumeCompletion({
        teamName: input.teamName,
        resumedTeammate: input.recipient,
        runId: lifecycleDelivery.debug.run_id,
        identity: input.identity
      });
    }

    return {
      status: lifecycleDelivery.delivery_status,
      message_id: persisted.messageId,
      team_name: input.teamName,
      sender: memberToParticipant(input.sender),
      recipient: memberToParticipant(input.recipient),
      recipient_status: input.recipient.status,
      persisted: true,
      delivery_status: lifecycleDelivery.delivery_status,
      row_status: lifecycleDelivery.message_row_status,
      turn_completed: lifecycleDelivery.turn_completed,
      final_status: lifecycleDelivery.final_status,
      backend: lifecycleDelivery.backend,
      lifecycle: lifecycleDelivery.lifecycle,
      debug: {
        lifecycle: lifecycleDelivery.debug
      }
    };
  }

  private createLifecycleService(): LifecycleService {
    return new LifecycleService({
      db: this.options.db,
      statePath: this.options.statePath,
      executionBackend: this.options.executionBackend,
      paneMode: this.options.paneMode,
      paneBackend: this.options.paneBackend
    });
  }

  // Phase 14 (D-Q2 / D-Q5): the teammate-only send guards. Returns a rejection
  // SendMessageResult to short-circuit BEFORE persist, or null to proceed. The
  // gate keys on the env-derived caller role ("teammate") — matching the Phase-13
  // capability boundary — so the TL and every absent-role/pre-Phase-13 caller is
  // never throttled. System lifecycle notices are exempt so the recursion-bounded
  // notice paths (resume_failure_notice / lifecycle_completion) are never blocked.
  // Self-send is checked first, then the per-turn proactive bound.
  private enforceTeammateSendGuards(input: {
    teamId: string;
    teamName: string;
    sender: ResolvedMember;
    recipient: ResolvedMember;
    identity: WorkspaceScopedCallerIdentity;
    metadata: Record<string, unknown> | undefined;
  }): SendMessageResult | null {
    if (input.identity.observedMetadata.codexTeamMemberRole !== TEAMMATE_ROLE) {
      return null;
    }
    if (isSystemLifecycleNotice(input.metadata)) {
      return null;
    }

    if (input.recipient.member_id === input.sender.member_id) {
      this.appendTeammateGuardRejectionEvent({
        teamId: input.teamId,
        teamName: input.teamName,
        identity: input.identity,
        actorMemberId: input.sender.member_id,
        errorCode: TEAMMATE_SELF_SEND_REJECTED,
        payload: { reason: "teammate_self_send" }
      });
      return {
        status: "error",
        error_code: TEAMMATE_SELF_SEND_REJECTED,
        team_name: input.teamName,
        persisted: false
      };
    }

    const limit = this.effectiveMaxProactiveMessagesPerTurn();
    const sentThisTurn = this.countProactiveSendsThisTurn(
      input.teamId,
      input.sender.member_id
    );
    if (sentThisTurn >= limit) {
      this.appendTeammateGuardRejectionEvent({
        teamId: input.teamId,
        teamName: input.teamName,
        identity: input.identity,
        actorMemberId: input.sender.member_id,
        errorCode: TEAMMATE_PROACTIVE_LIMIT_EXCEEDED,
        payload: { reason: "teammate_proactive_limit_per_turn", limit }
      });
      return {
        status: "error",
        error_code: TEAMMATE_PROACTIVE_LIMIT_EXCEEDED,
        team_name: input.teamName,
        persisted: false
      };
    }

    return null;
  }

  private effectiveMaxProactiveMessagesPerTurn(): number {
    const configured = this.options.maxProactiveMessagesPerTurn;
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return DEFAULT_MAX_PROACTIVE_MESSAGES_PER_TURN;
    }
    return Math.max(1, Math.floor(configured));
  }

  // Per-turn proactive count, DERIVED purely from messages.rowid ordering (D-Q2) —
  // NO Date.now, NO timer, NO migration. A pane-hosted teammate is woken exactly
  // once per turn by an inbound message, so the turn boundary is the rowid of the
  // most-recently-persisted inbound message TO the sender; the count is the
  // sender's outbound rows after that boundary, EXCLUDING system lifecycle notices.
  // The json_extract NULL handling is explicit: a plain message (no message_type)
  // yields NULL and MUST be counted (NOT IN alone would drop it). A stale/absent
  // boundary can only INFLATE the count (throttle sooner), never under-throttle.
  private countProactiveSendsThisTurn(
    teamId: string,
    senderMemberId: string
  ): number {
    const noticeTypePlaceholders = SYSTEM_LIFECYCLE_NOTICE_TYPES.map(() => "?").join(
      ", "
    );
    const boundaryRow = this.options.db
      .prepare(
        `
          SELECT MAX(rowid) AS boundary_rowid
          FROM ${TABLE_NAMES.messages}
          WHERE team_id = ? AND recipient_member_id = ?
        `
      )
      .get(teamId, senderMemberId) as { boundary_rowid: number | null };
    const boundaryRowid = boundaryRow?.boundary_rowid ?? 0;

    const countRow = this.options.db
      .prepare(
        `
          SELECT COUNT(*) AS sent_this_turn
          FROM ${TABLE_NAMES.messages}
          WHERE team_id = ?
            AND sender_member_id = ?
            AND rowid > ?
            AND (
              json_extract(metadata_json, '$.message_type') IS NULL
              OR json_extract(metadata_json, '$.message_type') NOT IN (${noticeTypePlaceholders})
            )
        `
      )
      .get(
        teamId,
        senderMemberId,
        boundaryRowid,
        ...SYSTEM_LIFECYCLE_NOTICE_TYPES
      ) as { sent_this_turn: number };

    return countRow?.sent_this_turn ?? 0;
  }

  // Sanitized message_send_failed event for a teammate guard rejection (D-02): the
  // payload carries only identifiers + an enum reason (+ the limit for the bound) —
  // never any body / prompt / summary text. The rejection runs before persist, so
  // no body is ever touched.
  private appendTeammateGuardRejectionEvent(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
    actorMemberId: string | null;
    errorCode: string;
    payload: Record<string, unknown>;
  }): void {
    this.appendEvent({
      teamId: input.teamId,
      actorMemberId: input.actorMemberId,
      identity: input.identity,
      eventType: MESSAGE_SEND_FAILED_EVENT_TYPE,
      errorCode: input.errorCode,
      payload: {
        team_name: input.teamName,
        error_code: input.errorCode,
        persisted: false,
        ...input.payload
      },
      createdAt: new Date().toISOString()
    });
  }

  // D10-3 resume-failure notice. The failed recipient sends a SANITIZED system
  // message back to the original sender: only teammate_id + error_code + a
  // constant remediation template — NEVER the original prompt/message body. The
  // notice carries message_type "resume_failure_notice", so the recursion gate
  // (LifecycleService.attemptDeliveryAfterPersistence + suppress_resume) ensures
  // it only queues and never re-triggers resume. Best-effort: a notify failure
  // must never corrupt the already-persisted message/state.
  private notifySenderOfResumeFailure(input: {
    teamName: string;
    failedRecipient: ResolvedMember;
    originalSender: ResolvedMember;
    errorCode: string;
    identity: WorkspaceScopedCallerIdentity;
  }): void {
    try {
      this.sendMessage({
        teamName: input.teamName,
        from: input.failedRecipient.public_id,
        to: input.originalSender.public_id,
        message: buildResumeFailureBody(
          input.failedRecipient.public_id,
          input.errorCode
        ),
        summary: `resume failed for ${input.failedRecipient.public_id}`,
        metadata: {
          message_type: "resume_failure_notice",
          teammate_id: input.failedRecipient.public_id,
          error_code: input.errorCode
        },
        identity: input.identity
      });
    } catch {
      // Best-effort only.
    }
  }

  // D10-3: SendMessage-triggered resume completion -> notify the lead, mirroring
  // the create-path D-03 completion notification (constant sanitized body,
  // best-effort). The notice is a system lifecycle_completion, so the recursion
  // gate keeps it queue-only.
  private notifyLeadOfResumeCompletion(input: {
    teamName: string;
    resumedTeammate: ResolvedMember;
    runId?: string;
    identity: WorkspaceScopedCallerIdentity;
  }): void {
    try {
      this.sendMessage({
        teamName: input.teamName,
        from: input.resumedTeammate.public_id,
        to: `team-lead@${input.teamName}`,
        message: `TeamMate ${input.resumedTeammate.public_id} completed its turn.`,
        summary: `${input.resumedTeammate.public_id} completed its turn`,
        metadata: {
          message_type: "lifecycle_completion",
          teammate_id: input.resumedTeammate.public_id,
          run_id: input.runId
        },
        identity: input.identity
      });
    } catch {
      // Best-effort only.
    }
  }

  private failSend(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
    actorMemberId: string | null;
    errorCode: string;
    resultStatus:
      | "invalid_sender"
      | "missing_recipient"
      | "recipient_archived"
      | "ambiguous_recipient"
      | "cross_team_recipient";
    resolutionStatus: MemberResolutionResult["status"];
  }): SendMessageResult {
    this.appendMessageSendFailedEvent(input);

    return {
      status: input.resultStatus,
      error_code: input.errorCode,
      team_name: input.teamName,
      persisted: false
    };
  }

  private appendMessageSendFailedEvent(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
    actorMemberId: string | null;
    errorCode: string;
    resolutionStatus: MemberResolutionResult["status"];
  }): void {
    this.appendEvent({
      teamId: input.teamId,
      actorMemberId: input.actorMemberId,
      identity: input.identity,
      eventType: MESSAGE_SEND_FAILED_EVENT_TYPE,
      errorCode: input.errorCode,
      payload: {
        team_name: input.teamName,
        error_code: input.errorCode,
        resolution_status: input.resolutionStatus,
        persisted: false
      },
      createdAt: new Date().toISOString()
    });
  }

  private appendMessageSendUnsupportedEvent(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
    errorCode: "broadcast_unsupported_in_v1";
  }): void {
    this.appendEvent({
      teamId: input.teamId,
      actorMemberId: null,
      identity: input.identity,
      eventType: MESSAGE_SEND_UNSUPPORTED_EVENT_TYPE,
      errorCode: input.errorCode,
      payload: {
        team_name: input.teamName,
        error_code: input.errorCode,
        persisted: false
      },
      createdAt: new Date().toISOString()
    });
  }

  private appendEvent(input: {
    teamId: string;
    actorMemberId: string | null;
    identity: WorkspaceScopedCallerIdentity;
    eventType: string;
    errorCode?: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.events} (
            event_id,
            team_id,
            actor_member_id,
            workspace_root,
            actor_caller_key,
            event_type,
            error_code,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        randomUUID(),
        input.teamId,
        input.actorMemberId,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        input.eventType,
        input.errorCode ?? null,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }
}

function recipientResolutionToErrorCode(
  result: Exclude<MemberResolutionResult, { status: "resolved" }>
):
  | "missing_recipient"
  | "recipient_archived"
  | "ambiguous_recipient"
  | "cross_team_recipient" {
  if (result.status === "archived") {
    return "recipient_archived";
  }

  if (result.status === "ambiguous") {
    return "ambiguous_recipient";
  }

  if (result.status === "cross_team") {
    return "cross_team_recipient";
  }

  return "missing_recipient";
}

function deliveryStatusForRecipient(
  status: string
):
  | typeof MESSAGE_DELIVERY_STATUSES.queuedForNextTurn
  | typeof MESSAGE_DELIVERY_STATUSES.queuedWhileIdle {
  if (status === MEMBER_STATUSES.running) {
    return QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS;
  }

  return QUEUED_WHILE_IDLE_DELIVERY_STATUS;
}

function normalizeMessageBody(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      type: "text",
      text: value
    };
  }

  return value ?? {};
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function taskIdFromMetadata(
  metadata: Record<string, unknown> | undefined
): string | null {
  const taskId = metadata?.task_id;
  return typeof taskId === "string" ? normalizeOptionalText(taskId) : null;
}

function triggerKindFromMetadata(
  metadata: Record<string, unknown> | undefined
): "message" | "task_assignment" {
  return metadata?.message_type === "task_assignment"
    ? "task_assignment"
    : "message";
}

// A structured shutdown request: an object body whose `type` is
// "shutdown_request". The notification helper paths (resume_failure_notice /
// lifecycle_completion) carry a string/template body, so they can never match
// this — confirmed: their bodies are plain strings, not {type:"shutdown_request"}.
function isShutdownRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).type === "shutdown_request"
  );
}

// System lifecycle notices (Phase 10): these are MessageService-generated and
// must never trigger a backend resume (recursion guard, D10-3).
function isSystemLifecycleNotice(
  metadata: Record<string, unknown> | undefined
): boolean {
  const messageType = metadata?.message_type;
  return (
    typeof messageType === "string" &&
    (SYSTEM_LIFECYCLE_NOTICE_TYPES as readonly string[]).includes(messageType)
  );
}

// Constant sanitized remediation template (D10-3). Interpolates ONLY the
// teammate_id (identifier) and error_code (honest-set enum) — never the original
// prompt / message body / any secret. Remediation wording mirrors
// agentService EXECUTION_BACKEND_UNAVAILABLE_MESSAGE.
function buildResumeFailureBody(teammateId: string, errorCode: string): string {
  return (
    `Resume failed for TeamMate ${teammateId} (error_code: ${errorCode}). ` +
    "Your message is preserved in the inbox (still queued) and will be delivered " +
    "when the run next starts. Remediation: ensure CODEX_TEAM_EXECUTION=1, make " +
    "sure `codex` is on PATH (codex exec --help should exit 0), and confirm durable " +
    "resume metadata (backend_run_id / thread_id / process_id) exists for the run."
  );
}

function memberToParticipant(member: ResolvedMember): MessageParticipant {
  return {
    member_id: member.member_id,
    display_name: member.display_name,
    role: member.role,
    status: member.status,
    teammate_id: member.public_id
  };
}

function buildSuccessEventPayload(
  input: PersistResolvedMessageInput,
  messageId: string,
  deliveryStatus:
    | typeof MESSAGE_DELIVERY_STATUSES.queuedForNextTurn
    | typeof MESSAGE_DELIVERY_STATUSES.queuedWhileIdle
): Record<string, unknown> {
  return {
    message_id: messageId,
    team_name: input.teamName,
    sender_member_id: input.sender.member_id,
    recipient_member_id: input.recipient.member_id,
    recipient_status: input.recipient.status,
    delivery_status: deliveryStatus
  };
}
