import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ExecutionBackend } from "../adapters/execution.js";
import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import {
  ContextResolver,
  type ResolvedTeamContext
} from "./contextResolver.js";
import { MemberResolver, type ResolvedMember } from "./memberResolver.js";
import { MessageService, type PersistedMessageResult } from "./messageService.js";
import { buildPublicTeamMateId } from "./teamMemberNames.js";
import { EVENT_TYPES, TABLE_NAMES, TASK_STATUSES } from "../state/schema.js";

export interface TaskServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
}

export interface TaskCreateInput {
  teamName?: string;
  subject?: string;
  title?: string;
  description?: string;
  activeForm?: string;
  active_form?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  identity: WorkspaceScopedCallerIdentity;
}

export interface TaskUpdateInput {
  teamName?: string;
  taskId?: string;
  task_id?: string;
  status?: string;
  subject?: string;
  title?: string;
  description?: string;
  activeForm?: string;
  active_form?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  notes?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  identity: WorkspaceScopedCallerIdentity;
}

export interface TaskListInput {
  teamName?: string;
  status?: string;
  owner?: string;
  identity: WorkspaceScopedCallerIdentity;
}

export interface TaskGetInput {
  teamName?: string;
  taskId?: string;
  task_id?: string;
  identity: WorkspaceScopedCallerIdentity;
}

export type TaskServiceResult =
  | {
      status: "error";
      error_code: string;
      message?: string;
      persisted?: false;
      not_handled_by_team_layer?: true;
    }
  | {
      status:
        | "task_not_found"
        | "task_id_required"
        | "invalid_owner"
        | "invalid_task_status"
        | "invalid_task_dependency"
        | "task_deleted_status_not_supported";
      error_code: string;
      task_id?: string;
      persisted: false;
    };

interface TaskRow {
  taskId: string;
  publicTaskId: string;
  teamId: string;
  taskSequence: number;
  status: string;
  ownerMemberId: string | null;
  title: string;
  subject: string;
  description: string | null;
  activeForm: string | null;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  ownerDisplayName: string | null;
  ownerRole: string | null;
  ownerStatus: string | null;
  ownerMetadataJson: string | null;
}

interface CreatedTaskRecord {
  row: TaskRow;
  owner: ResolvedMember | null;
  assignmentNotification?: PersistedMessageResult;
}

interface SequenceRow {
  nextSequence: number;
}

interface PublicTaskIdRow {
  publicTaskId: string;
}

interface TaskEventRow {
  task_event_id: string;
  event_type: string;
  payload_json: string;
  note: string | null;
  created_at: string;
  actor_member_id: string | null;
}

const TASK_CREATED_EVENT_TYPE = EVENT_TYPES.taskCreated satisfies "task_created";
const TASK_UPDATED_EVENT_TYPE = EVENT_TYPES.taskUpdated satisfies "task_updated";
const TASK_ASSIGNED_EVENT_TYPE = EVENT_TYPES.taskAssigned satisfies "task_assigned";
const TASK_NOTE_ADDED_EVENT_TYPE =
  EVENT_TYPES.taskNoteAdded satisfies "task_note_added";
const TASK_METADATA_UPDATED_EVENT_TYPE =
  EVENT_TYPES.taskMetadataUpdated satisfies "task_metadata_updated";
const TASK_DEPENDENCY_UPDATED_EVENT_TYPE =
  EVENT_TYPES.taskDependencyUpdated satisfies "task_dependency_updated";
const TASK_UPDATE_FAILED_EVENT_TYPE =
  EVENT_TYPES.taskUpdateFailed satisfies "task_update_failed";
const TASK_STATUS_UPDATED_TASK_EVENT_TYPE = "task_status_updated";
const TASK_OWNER_UPDATED_TASK_EVENT_TYPE = "task_owner_updated";

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  createTask(input: TaskCreateInput) {
    const resolvedTeam = this.resolveTeam(input.teamName, input.identity);
    if (!resolvedTeam.ok) {
      return resolvedTeam.result;
    }

    const subject = normalizeOptionalText(input.subject ?? input.title);
    if (!subject) {
      this.appendGlobalTaskEvent({
        team: resolvedTeam.team,
        identity: input.identity,
        actorMemberId: null,
        eventType: EVENT_TYPES.taskUpdateFailed,
        errorCode: "task_subject_required",
        payload: {
          team_name: resolvedTeam.team.teamName,
          error_code: "task_subject_required",
          persisted: false
        }
      });

      return {
        status: "error",
        error_code: "task_subject_required",
        persisted: false
      };
    }

    const owner = this.resolveOwnerIfPresent({
      team: resolvedTeam.team,
      owner: input.owner,
      identity: input.identity
    });
    if (owner.status !== "ok") {
      return owner.result;
    }

    const sender = owner.member
      ? this.resolveAssignmentSender({
          team: resolvedTeam.team,
          identity: input.identity
        })
      : null;
    if (sender?.status === "error") {
      return sender.result;
    }

    const tx = this.options.db.transaction(
      (transactionInput: {
        team: ResolvedTeamContext;
        subject: string;
        input: TaskCreateInput;
        owner: ResolvedMember | null;
        sender: ResolvedMember | null;
      }): CreatedTaskRecord => {
        const row = this.insertTask(transactionInput);
        this.appendTaskEvent({
          team: transactionInput.team,
          taskId: row.taskId,
          actorMemberId: null,
          eventType: TASK_CREATED_EVENT_TYPE,
          note: null,
          payload: {
            task_id: row.taskId,
            public_task_id: row.publicTaskId,
            subject: row.subject,
            status: row.status
          }
        });
        this.appendGlobalTaskEvent({
          team: transactionInput.team,
          identity: transactionInput.input.identity,
          actorMemberId: null,
          eventType: TASK_CREATED_EVENT_TYPE,
          payload: {
            task_id: row.taskId,
            public_task_id: row.publicTaskId,
            subject: row.subject,
            status: row.status
          }
        });

        const assignmentNotification =
          transactionInput.owner && transactionInput.sender
            ? this.persistAssignmentNotification({
                team: transactionInput.team,
                identity: transactionInput.input.identity,
                task: row,
                sender: transactionInput.sender,
                owner: transactionInput.owner,
                createdAt: row.createdAt
              })
            : undefined;

        return {
          row,
          owner: transactionInput.owner,
          assignmentNotification
        };
      }
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const created = tx({
          team: resolvedTeam.team,
          subject,
          input,
          owner: owner.member,
          sender: sender?.member ?? null
        });
        const detail = this.buildTaskDetail(created.row, resolvedTeam.team.teamName);

        return {
          status: "created",
          team_name: resolvedTeam.team.teamName,
          task_id: created.row.taskId,
          public_task_id: created.row.publicTaskId,
          task: detail,
          assignment_notification: created.assignmentNotification
        };
      } catch (error) {
        if (attempt < 3 && isUniqueTaskAllocationError(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new Error("Task sequence allocation failed after retries.");
  }

  updateTask(input: TaskUpdateInput) {
    const resolvedTeam = this.resolveTeam(input.teamName, input.identity);
    if (!resolvedTeam.ok) {
      return resolvedTeam.result;
    }

    const existing = this.resolveTaskReference({
      team: resolvedTeam.team,
      taskReference: input.taskId ?? input.task_id
    });
    if (!existing.ok) {
      return existing.result;
    }

    if (input.status === "deleted") {
      this.appendGlobalTaskEvent({
        team: resolvedTeam.team,
        identity: input.identity,
        actorMemberId: null,
        eventType: TASK_UPDATE_FAILED_EVENT_TYPE,
        errorCode: "task_deleted_status_not_supported",
        payload: {
          task_id: existing.row.taskId,
          public_task_id: existing.row.publicTaskId,
          error_code: "task_deleted_status_not_supported",
          persisted: false
        }
      });

      return {
        status: "task_deleted_status_not_supported",
        error_code: "task_deleted_status_not_supported",
        task_id: existing.row.taskId,
        persisted: false
      };
    }

    const nextStatus = normalizeOptionalText(input.status);
    if (nextStatus && !isTaskStatus(nextStatus)) {
      this.appendGlobalTaskEvent({
        team: resolvedTeam.team,
        identity: input.identity,
        actorMemberId: null,
        eventType: TASK_UPDATE_FAILED_EVENT_TYPE,
        errorCode: "invalid_task_status",
        payload: {
          task_id: existing.row.taskId,
          public_task_id: existing.row.publicTaskId,
          error_code: "invalid_task_status",
          persisted: false
        }
      });

      return {
        status: "invalid_task_status",
        error_code: "invalid_task_status",
        task_id: existing.row.taskId,
        persisted: false
      };
    }

    const ownerWasProvided = Object.prototype.hasOwnProperty.call(input, "owner");
    const owner = ownerWasProvided
      ? this.resolveOwnerIfPresent({
          team: resolvedTeam.team,
          owner: input.owner,
          identity: input.identity
        })
      : ({ status: "ok", member: null } as const);
    if (owner.status !== "ok") {
      return owner.result;
    }

    const ownerChanged =
      ownerWasProvided && owner.member?.member_id !== existing.row.ownerMemberId;
    const sender = ownerChanged
      ? this.resolveAssignmentSender({
          team: resolvedTeam.team,
          identity: input.identity
        })
      : null;
    if (sender?.status === "error") {
      return sender.result;
    }

    const edgeChanges = this.resolveEdgeReferences({
      team: resolvedTeam.team,
      task: existing.row,
      addBlocks: input.addBlocks,
      addBlockedBy: input.addBlockedBy
    });
    if (!edgeChanges.ok) {
      return edgeChanges.result;
    }

    if (
      edgeChanges.result.blocks.includes(existing.row.taskId) ||
      edgeChanges.result.blockedBy.includes(existing.row.taskId)
    ) {
      this.appendGlobalTaskEvent({
        team: resolvedTeam.team,
        identity: input.identity,
        actorMemberId: null,
        eventType: TASK_UPDATE_FAILED_EVENT_TYPE,
        errorCode: "invalid_task_dependency",
        payload: {
          task_id: existing.row.taskId,
          public_task_id: existing.row.publicTaskId,
          error_code: "invalid_task_dependency",
          persisted: false
        }
      });

      return {
        status: "invalid_task_dependency",
        error_code: "invalid_task_dependency",
        task_id: existing.row.taskId,
        persisted: false
      };
    }

    const note = normalizeOptionalText(input.notes);
    const nextSubject = normalizeOptionalText(input.subject ?? input.title);
    const nextDescription = Object.prototype.hasOwnProperty.call(input, "description")
      ? normalizeOptionalText(input.description)
      : existing.row.description;
    const nextActiveForm = Object.prototype.hasOwnProperty.call(input, "activeForm") ||
      Object.prototype.hasOwnProperty.call(input, "active_form")
      ? normalizeOptionalText(input.activeForm ?? input.active_form)
      : existing.row.activeForm;
    const metadataWasProvided = input.metadata !== undefined;
    const nextMetadata = metadataWasProvided
      ? mergeMetadata(parseJsonObject(existing.row.metadataJson), input.metadata ?? {})
      : parseJsonObject(existing.row.metadataJson);

    const tx = this.options.db.transaction(
      (transactionInput: {
        team: ResolvedTeamContext;
        task: TaskRow;
        identity: WorkspaceScopedCallerIdentity;
        note: string | null;
        edgeChanges: ResolvedEdgeChanges;
        nextStatus: string | null;
        nextSubject: string | null;
        nextDescription: string | null;
        nextActiveForm: string | null;
        nextMetadata: Record<string, unknown>;
        metadataWasProvided: boolean;
        ownerWasProvided: boolean;
        owner: ResolvedMember | null;
        ownerChanged: boolean;
        sender: ResolvedMember | null;
      }): { assignmentNotification?: PersistedMessageResult } => {
        const createdAt = nextIsoTimestamp();
        let changedEdges = 0;
        const finalStatus = transactionInput.nextStatus ?? transactionInput.task.status;
        const finalSubject =
          transactionInput.nextSubject ?? transactionInput.task.subject;
        const finalOwnerMemberId = transactionInput.ownerWasProvided
          ? transactionInput.owner?.member_id ?? null
          : transactionInput.task.ownerMemberId;

        for (const targetTaskId of transactionInput.edgeChanges.blocks) {
          changedEdges += this.insertTaskEdge({
            teamId: transactionInput.team.teamId,
            sourceTaskId: transactionInput.task.taskId,
            targetTaskId,
            createdAt
          });
        }

        for (const sourceTaskId of transactionInput.edgeChanges.blockedBy) {
          changedEdges += this.insertTaskEdge({
            teamId: transactionInput.team.teamId,
            sourceTaskId,
            targetTaskId: transactionInput.task.taskId,
            createdAt
          });
        }

        this.options.db
          .prepare(
            `
              UPDATE ${TABLE_NAMES.tasks}
              SET
                status = ?,
                owner_member_id = ?,
                title = ?,
                subject = ?,
                description = ?,
                active_form = ?,
                metadata_json = ?,
                updated_at = ?
              WHERE task_id = ?
            `
          )
          .run(
            finalStatus,
            finalOwnerMemberId,
            finalSubject,
            finalSubject,
            transactionInput.nextDescription,
            transactionInput.nextActiveForm,
            JSON.stringify(transactionInput.nextMetadata),
            createdAt,
            transactionInput.task.taskId
          );

        if (
          transactionInput.nextStatus &&
          transactionInput.nextStatus !== transactionInput.task.status
        ) {
          this.appendTaskEvent({
            team: transactionInput.team,
            taskId: transactionInput.task.taskId,
            actorMemberId: null,
            eventType: TASK_STATUS_UPDATED_TASK_EVENT_TYPE,
            note: null,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              from: transactionInput.task.status,
              to: transactionInput.nextStatus
            },
            createdAt
          });
        }

        let assignmentNotification: PersistedMessageResult | undefined;
        if (
          transactionInput.ownerChanged &&
          transactionInput.owner &&
          transactionInput.sender
        ) {
          this.appendTaskEvent({
            team: transactionInput.team,
            taskId: transactionInput.task.taskId,
            actorMemberId: transactionInput.sender.member_id,
            eventType: TASK_OWNER_UPDATED_TASK_EVENT_TYPE,
            note: null,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              owner_member_id: transactionInput.owner.member_id
            },
            createdAt
          });
          assignmentNotification = this.persistAssignmentNotification({
            team: transactionInput.team,
            identity: transactionInput.identity,
            task: {
              ...transactionInput.task,
              subject: finalSubject,
              title: finalSubject,
              ownerMemberId: transactionInput.owner.member_id,
              updatedAt: createdAt
            },
            sender: transactionInput.sender,
            owner: transactionInput.owner,
            createdAt
          });
        }

        if (transactionInput.metadataWasProvided) {
          this.appendTaskEvent({
            team: transactionInput.team,
            taskId: transactionInput.task.taskId,
            actorMemberId: null,
            eventType: TASK_METADATA_UPDATED_EVENT_TYPE,
            note: null,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              metadata_keys: Object.keys(transactionInput.nextMetadata)
            },
            createdAt
          });
          this.appendGlobalTaskEvent({
            team: transactionInput.team,
            identity: transactionInput.identity,
            actorMemberId: null,
            eventType: TASK_METADATA_UPDATED_EVENT_TYPE,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              metadata_keys: Object.keys(transactionInput.nextMetadata)
            },
            createdAt
          });
        }

        if (transactionInput.note) {
          this.appendTaskEvent({
            team: transactionInput.team,
            taskId: transactionInput.task.taskId,
            actorMemberId: null,
            eventType: TASK_NOTE_ADDED_EVENT_TYPE,
            note: transactionInput.note,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              note: transactionInput.note
            },
            createdAt
          });
        }

        if (changedEdges > 0) {
          this.appendTaskEvent({
            team: transactionInput.team,
            taskId: transactionInput.task.taskId,
            actorMemberId: null,
            eventType: TASK_DEPENDENCY_UPDATED_EVENT_TYPE,
            note: null,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              addBlocks: transactionInput.edgeChanges.blockPublicIds,
              addBlockedBy: transactionInput.edgeChanges.blockedByPublicIds
            },
            createdAt
          });
          this.appendGlobalTaskEvent({
            team: transactionInput.team,
            identity: transactionInput.identity,
            actorMemberId: null,
            eventType: TASK_DEPENDENCY_UPDATED_EVENT_TYPE,
            payload: {
              task_id: transactionInput.task.taskId,
              public_task_id: transactionInput.task.publicTaskId,
              addBlocks: transactionInput.edgeChanges.blockPublicIds,
              addBlockedBy: transactionInput.edgeChanges.blockedByPublicIds
            },
            createdAt
          });
        }

        this.appendGlobalTaskEvent({
          team: transactionInput.team,
          identity: transactionInput.identity,
          actorMemberId: null,
          eventType: TASK_UPDATED_EVENT_TYPE,
          payload: {
            task_id: transactionInput.task.taskId,
            public_task_id: transactionInput.task.publicTaskId,
            changed: {
              status:
                transactionInput.nextStatus !== null &&
                transactionInput.nextStatus !== transactionInput.task.status,
              owner: transactionInput.ownerChanged,
              subject: transactionInput.nextSubject !== null,
              description: transactionInput.nextDescription !== transactionInput.task.description,
              active_form: transactionInput.nextActiveForm !== transactionInput.task.activeForm,
              metadata: transactionInput.metadataWasProvided,
              notes: transactionInput.note !== null,
              dependencies: changedEdges > 0
            }
          },
          createdAt
        });

        return { assignmentNotification };
      }
    );

    const updateResult = tx({
      team: resolvedTeam.team,
      task: existing.row,
      identity: input.identity,
      note,
      edgeChanges: edgeChanges.result,
      nextStatus,
      nextSubject,
      nextDescription,
      nextActiveForm,
      nextMetadata,
      metadataWasProvided,
      ownerWasProvided,
      owner: owner.member,
      ownerChanged,
      sender: sender?.member ?? null
    });

    const updated = this.findTaskByInternalId(
      resolvedTeam.team.teamId,
      existing.row.taskId
    );
    if (!updated) {
      return {
        status: "task_not_found",
        error_code: "task_not_found",
        persisted: false
      };
    }

    return {
      status: "updated",
      team_name: resolvedTeam.team.teamName,
      task_id: updated.taskId,
      public_task_id: updated.publicTaskId,
      dependencies: this.readDependencies(updated.taskId),
      task: this.buildTaskDetail(updated, resolvedTeam.team.teamName),
      assignment_notification: updateResult.assignmentNotification
    };
  }

  listTasks(input: TaskListInput) {
    const resolvedTeam = this.resolveTeam(input.teamName, input.identity);
    if (!resolvedTeam.ok) {
      return resolvedTeam.result;
    }

    const owner = this.resolveOwnerIfPresent({
      team: resolvedTeam.team,
      owner: input.owner,
      identity: input.identity
    });
    if (owner.status !== "ok") {
      return owner.result;
    }

    const rows = this.findTasks({
      teamId: resolvedTeam.team.teamId,
      status: normalizeOptionalText(input.status),
      ownerMemberId: owner.member?.member_id ?? null
    });

    return {
      status: "listed",
      team_name: resolvedTeam.team.teamName,
      tasks: rows.map((row) => ({
        task_id: row.publicTaskId,
        public_task_id: row.publicTaskId,
        internal_task_id: row.taskId,
        subject: row.subject,
        status: row.status,
        owner: buildOwner(row, resolvedTeam.team.teamName),
        unresolved_blockers: this.readUnresolvedBlockers(row.taskId)
      }))
    };
  }

  getTask(input: TaskGetInput) {
    const resolvedTeam = this.resolveTeam(input.teamName, input.identity);
    if (!resolvedTeam.ok) {
      return resolvedTeam.result;
    }

    const existing = this.resolveTaskReference({
      team: resolvedTeam.team,
      taskReference: input.taskId ?? input.task_id
    });
    if (!existing.ok) {
      return existing.result;
    }

    return {
      status: "found",
      team_name: resolvedTeam.team.teamName,
      task: this.buildTaskDetail(existing.row, resolvedTeam.team.teamName)
    };
  }

  private resolveTeam(teamName: string | undefined, identity: WorkspaceScopedCallerIdentity):
    | {
        ok: true;
        team: ResolvedTeamContext;
      }
    | {
        ok: false;
        result: TaskServiceResult;
      } {
    const resolvedTeam = new ContextResolver(this.options.db).resolveTeam({
      teamName,
      identity
    });

    if (!resolvedTeam.ok) {
      return {
        ok: false,
        result: {
          status: "error",
          error_code: resolvedTeam.errorCode,
          message: resolvedTeam.message,
          persisted: false,
          not_handled_by_team_layer: true
        }
      };
    }

    return { ok: true, team: resolvedTeam.team };
  }

  private resolveOwnerIfPresent(input: {
    team: ResolvedTeamContext;
    owner?: string;
    identity: WorkspaceScopedCallerIdentity;
  }):
    | {
        status: "ok";
        member: ResolvedMember | null;
      }
    | {
        status: "error";
        result: TaskServiceResult;
      } {
    const owner = normalizeOptionalText(input.owner);
    if (!owner) {
      return { status: "ok", member: null };
    }

    const result = new MemberResolver({
      db: this.options.db,
      identity: input.identity
    }).resolveMemberReference({
      teamId: input.team.teamId,
      teamName: input.team.teamName,
      reference: owner,
      purpose: "owner",
      identity: input.identity
    });

    if (result.status === "resolved") {
      return { status: "ok", member: result.member };
    }

    this.appendGlobalTaskEvent({
      team: input.team,
      identity: input.identity,
      actorMemberId: null,
      eventType: EVENT_TYPES.taskUpdateFailed,
      errorCode: result.error_code ?? "invalid_owner",
      payload: {
        team_name: input.team.teamName,
        error_code: result.error_code ?? "invalid_owner",
        owner_resolution_status: result.status,
        persisted: false
      }
    });

    return {
      status: "error",
      result: {
        status: "invalid_owner",
        error_code: result.error_code ?? "invalid_owner",
        persisted: false
      }
    };
  }

  private insertTask(input: {
    team: ResolvedTeamContext;
    subject: string;
    input: TaskCreateInput;
    owner: ResolvedMember | null;
  }): TaskRow {
    const createdAt = nextIsoTimestamp();
    const sequenceRow = this.options.db
      .prepare(
        `
          SELECT COALESCE(MAX(task_sequence), 0) + 1 AS nextSequence
          FROM ${TABLE_NAMES.tasks}
          WHERE team_id = ?
        `
      )
      .get(input.team.teamId) as SequenceRow | undefined;
    const sequence = sequenceRow?.nextSequence ?? 1;
    const taskId = `task:${input.team.teamId}:${sequence}`;
    const publicTaskId = `task-${sequence}`;
    const activeForm = normalizeOptionalText(
      input.input.activeForm ?? input.input.active_form
    );

    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.tasks} (
            task_id,
            team_id,
            status,
            owner_member_id,
            title,
            subject,
            description,
            active_form,
            metadata_json,
            public_task_id,
            task_sequence,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        taskId,
        input.team.teamId,
        TASK_STATUSES.pending,
        input.owner?.member_id ?? null,
        input.subject,
        input.subject,
        normalizeOptionalText(input.input.description),
        activeForm,
        JSON.stringify(input.input.metadata ?? {}),
        publicTaskId,
        sequence,
        createdAt,
        createdAt
      );

    const row = this.findTaskByInternalId(input.team.teamId, taskId);
    if (!row) {
      throw new Error("Inserted task row could not be read back.");
    }

    return row;
  }

  private resolveTaskReference(input: {
    team: ResolvedTeamContext;
    taskReference?: string;
  }):
    | {
        ok: true;
        row: TaskRow;
      }
    | {
        ok: false;
        result: TaskServiceResult;
      } {
    const reference = normalizeOptionalText(input.taskReference);
    if (!reference) {
      return {
        ok: false,
        result: {
          status: "task_id_required",
          error_code: "task_id_required",
          persisted: false
        }
      };
    }

    const row = reference.startsWith("task:")
      ? this.findTaskByInternalId(input.team.teamId, reference)
      : this.findTaskByPublicId(input.team.teamId, reference);

    if (!row) {
      return {
        ok: false,
        result: {
          status: "task_not_found",
          error_code: "task_not_found",
          task_id: reference,
          persisted: false
        }
      };
    }

    return { ok: true, row };
  }

  private findTaskByInternalId(teamId: string, taskId: string): TaskRow | undefined {
    return this.selectTaskRows(
      `
        WHERE tasks.team_id = ?
          AND tasks.task_id = ?
        LIMIT 1
      `,
      [teamId, taskId]
    )[0];
  }

  private findTaskByPublicId(
    teamId: string,
    publicTaskId: string
  ): TaskRow | undefined {
    return this.selectTaskRows(
      `
        WHERE tasks.team_id = ?
          AND tasks.public_task_id = ?
        LIMIT 1
      `,
      [teamId, publicTaskId]
    )[0];
  }

  private findTasks(input: {
    teamId: string;
    status: string | null;
    ownerMemberId: string | null;
  }): TaskRow[] {
    const clauses = ["tasks.team_id = ?"];
    const values: unknown[] = [input.teamId];

    if (input.status) {
      clauses.push("tasks.status = ?");
      values.push(input.status);
    }

    if (input.ownerMemberId) {
      clauses.push("tasks.owner_member_id = ?");
      values.push(input.ownerMemberId);
    }

    return this.selectTaskRows(
      `
        WHERE ${clauses.join(" AND ")}
        ORDER BY tasks.task_sequence, tasks.created_at, tasks.task_id
      `,
      values
    );
  }

  private selectTaskRows(whereSql: string, values: unknown[]): TaskRow[] {
    return this.options.db
      .prepare(
        `
          SELECT
            tasks.task_id AS taskId,
            tasks.public_task_id AS publicTaskId,
            tasks.team_id AS teamId,
            tasks.task_sequence AS taskSequence,
            tasks.status,
            tasks.owner_member_id AS ownerMemberId,
            tasks.title,
            tasks.subject,
            tasks.description,
            tasks.active_form AS activeForm,
            tasks.metadata_json AS metadataJson,
            tasks.created_at AS createdAt,
            tasks.updated_at AS updatedAt,
            owner.display_name AS ownerDisplayName,
            owner.role AS ownerRole,
            owner.status AS ownerStatus,
            owner.metadata_json AS ownerMetadataJson
          FROM ${TABLE_NAMES.tasks} AS tasks
          LEFT JOIN ${TABLE_NAMES.members} AS owner
            ON owner.member_id = tasks.owner_member_id
          ${whereSql}
        `
      )
      .all(...values) as TaskRow[];
  }

  private resolveEdgeReferences(input: {
    team: ResolvedTeamContext;
    task: TaskRow;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }):
    | {
        ok: true;
        result: ResolvedEdgeChanges;
      }
    | {
        ok: false;
        result: TaskServiceResult;
      } {
    const blocks = this.resolveTaskReferences(input.team, input.addBlocks);
    if (!blocks.ok) {
      return blocks;
    }

    const blockedBy = this.resolveTaskReferences(input.team, input.addBlockedBy);
    if (!blockedBy.ok) {
      return blockedBy;
    }

    return {
      ok: true,
      result: {
        blocks: blocks.rows.map((row) => row.taskId),
        blockedBy: blockedBy.rows.map((row) => row.taskId),
        blockPublicIds: blocks.rows.map((row) => row.publicTaskId),
        blockedByPublicIds: blockedBy.rows.map((row) => row.publicTaskId)
      }
    };
  }

  private resolveTaskReferences(
    team: ResolvedTeamContext,
    references: string[] | undefined
  ):
    | {
        ok: true;
        rows: TaskRow[];
      }
    | {
        ok: false;
        result: TaskServiceResult;
      } {
    const rows: TaskRow[] = [];
    for (const reference of references ?? []) {
      const resolved = this.resolveTaskReference({ team, taskReference: reference });
      if (!resolved.ok) {
        return resolved;
      }
      rows.push(resolved.row);
    }

    return { ok: true, rows };
  }

  private insertTaskEdge(input: {
    teamId: string;
    sourceTaskId: string;
    targetTaskId: string;
    createdAt: string;
  }): number {
    const result = this.options.db
      .prepare(
        `
          INSERT OR IGNORE INTO ${TABLE_NAMES.taskEdges} (
            edge_id,
            team_id,
            source_task_id,
            target_task_id,
            edge_type,
            created_at
          )
          VALUES (?, ?, ?, ?, 'blocks', ?)
        `
      )
      .run(
        randomUUID(),
        input.teamId,
        input.sourceTaskId,
        input.targetTaskId,
        input.createdAt
      );

    return result.changes;
  }

  private readDependencies(taskId: string): {
    blocks: string[];
    blockedBy: string[];
  } {
    return {
      blocks: this.readPublicTaskIdsForEdges("source_task_id", taskId),
      blockedBy: this.readPublicTaskIdsForEdges("target_task_id", taskId)
    };
  }

  private readPublicTaskIdsForEdges(
    edgeColumn: "source_task_id" | "target_task_id",
    taskId: string
  ): string[] {
    const taskColumn = edgeColumn === "source_task_id" ? "target_task_id" : "source_task_id";

    return (
      this.options.db
        .prepare(
          `
            SELECT linked.public_task_id AS publicTaskId
            FROM ${TABLE_NAMES.taskEdges} AS edges
            JOIN ${TABLE_NAMES.tasks} AS linked
              ON linked.task_id = edges.${taskColumn}
            WHERE edges.${edgeColumn} = ?
              AND edges.edge_type = 'blocks'
            ORDER BY linked.task_sequence, linked.public_task_id
          `
        )
        .all(taskId) as PublicTaskIdRow[]
    ).map((row) => row.publicTaskId);
  }

  private readUnresolvedBlockers(taskId: string): string[] {
    return (
      this.options.db
        .prepare(
          `
            SELECT source.public_task_id AS publicTaskId
            FROM ${TABLE_NAMES.taskEdges} AS edges
            JOIN ${TABLE_NAMES.tasks} AS source
              ON source.task_id = edges.source_task_id
            WHERE edges.target_task_id = ?
              AND edges.edge_type = 'blocks'
              AND source.status != ?
            ORDER BY source.task_sequence, source.public_task_id
          `
        )
        .all(taskId, TASK_STATUSES.completed) as PublicTaskIdRow[]
    ).map((row) => row.publicTaskId);
  }

  private readHistory(taskId: string): TaskEventRow[] {
    return this.options.db
      .prepare(
        `
          SELECT
            task_event_id,
            event_type,
            payload_json,
            note,
            created_at,
            actor_member_id
          FROM ${TABLE_NAMES.taskEvents}
          WHERE task_id = ?
          ORDER BY created_at, task_event_id
        `
      )
      .all(taskId) as TaskEventRow[];
  }

  private buildTaskDetail(row: TaskRow, teamName: string) {
    const history = this.readHistory(row.taskId).map((event) => ({
      task_event_id: event.task_event_id,
      event_type: event.event_type,
      payload: parseJsonObject(event.payload_json),
      note: event.note,
      created_at: event.created_at,
      actor_member_id: event.actor_member_id
    }));

    return {
      task_id: row.taskId,
      public_task_id: row.publicTaskId,
      subject: row.subject,
      title: row.title,
      status: row.status,
      owner: buildOwner(row, teamName),
      description: row.description,
      activeForm: row.activeForm,
      active_form: row.activeForm,
      metadata: parseJsonObject(row.metadataJson),
      dependencies: this.readDependencies(row.taskId),
      history,
      events: history
    };
  }

  private appendTaskEvent(input: {
    team: ResolvedTeamContext;
    taskId: string;
    actorMemberId: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    note: string | null;
    createdAt?: string;
  }): void {
    const createdAt = input.createdAt ?? nextIsoTimestamp();

    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.taskEvents} (
            task_event_id,
            task_id,
            team_id,
            actor_member_id,
            event_type,
            payload_json,
            note,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        randomUUID(),
        input.taskId,
        input.team.teamId,
        input.actorMemberId,
        input.eventType,
        JSON.stringify(input.payload),
        input.note,
        createdAt
      );
  }

  private resolveAssignmentSender(input: {
    team: ResolvedTeamContext;
    identity: WorkspaceScopedCallerIdentity;
  }):
    | {
        status: "ok";
        member: ResolvedMember;
      }
    | {
        status: "error";
        result: TaskServiceResult;
      } {
    const result = new MemberResolver({
      db: this.options.db,
      identity: input.identity
    }).resolveMemberReference({
      teamId: input.team.teamId,
      teamName: input.team.teamName,
      purpose: "sender",
      identity: input.identity
    });

    if (result.status === "resolved") {
      return { status: "ok", member: result.member };
    }

    this.appendGlobalTaskEvent({
      team: input.team,
      identity: input.identity,
      actorMemberId: null,
      eventType: TASK_UPDATE_FAILED_EVENT_TYPE,
      errorCode: "assignment_sender_not_found",
      payload: {
        team_name: input.team.teamName,
        error_code: "assignment_sender_not_found",
        sender_resolution_status: result.status,
        persisted: false
      }
    });

    return {
      status: "error",
      result: {
        status: "error",
        error_code: "assignment_sender_not_found",
        persisted: false
      }
    };
  }

  private persistAssignmentNotification(input: {
    team: ResolvedTeamContext;
    identity: WorkspaceScopedCallerIdentity;
    task: TaskRow;
    sender: ResolvedMember;
    owner: ResolvedMember;
    createdAt: string;
  }): PersistedMessageResult {
    this.appendTaskEvent({
      team: input.team,
      taskId: input.task.taskId,
      actorMemberId: input.sender.member_id,
      eventType: TASK_ASSIGNED_EVENT_TYPE,
      note: null,
      payload: {
        task_id: input.task.taskId,
        public_task_id: input.task.publicTaskId,
        owner_member_id: input.owner.member_id
      },
      createdAt: input.createdAt
    });
    this.appendGlobalTaskEvent({
      team: input.team,
      identity: input.identity,
      actorMemberId: input.sender.member_id,
      eventType: TASK_ASSIGNED_EVENT_TYPE,
      payload: {
        task_id: input.task.taskId,
        public_task_id: input.task.publicTaskId,
        owner_member_id: input.owner.member_id
      },
      createdAt: input.createdAt
    });

    return new MessageService({
      db: this.options.db,
      statePath: this.options.statePath,
      executionBackend: this.options.executionBackend
    }).persistResolvedMessage({
      teamId: input.team.teamId,
      teamName: input.team.teamName,
      sender: input.sender,
      recipient: input.owner,
      body: {
        type: "task_assignment",
        task_id: input.task.taskId,
        public_task_id: input.task.publicTaskId,
        subject: input.task.subject,
        assigned_by_member_id: input.sender.member_id
      },
      summary: `Task assigned: ${input.task.subject}`,
      metadata: {
        task_id: input.task.taskId,
        public_task_id: input.task.publicTaskId,
        message_type: "task_assignment"
      },
      identity: input.identity
    });
  }

  private appendGlobalTaskEvent(input: {
    team: ResolvedTeamContext;
    identity: WorkspaceScopedCallerIdentity;
    actorMemberId: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    errorCode?: string;
    createdAt?: string;
  }): void {
    const createdAt = input.createdAt ?? nextIsoTimestamp();

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
        input.team.teamId,
        input.actorMemberId,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        input.eventType,
        input.errorCode ?? null,
        JSON.stringify(input.payload),
        createdAt
      );
  }
}

interface ResolvedEdgeChanges {
  blocks: string[];
  blockedBy: string[];
  blockPublicIds: string[];
  blockedByPublicIds: string[];
}

let lastTimestampMs = 0;

function nextIsoTimestamp(): string {
  const now = Date.now();
  const next = now <= lastTimestampMs ? lastTimestampMs + 1 : now;
  lastTimestampMs = next;
  return new Date(next).toISOString();
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isUniqueTaskAllocationError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function isTaskStatus(value: string): boolean {
  return (Object.values(TASK_STATUSES) as string[]).includes(value);
}

function mergeMetadata(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function buildOwner(row: TaskRow, teamName: string) {
  if (!row.ownerMemberId) {
    return null;
  }

  return {
    member_id: row.ownerMemberId,
    display_name: row.ownerDisplayName,
    role: row.ownerRole,
    status: row.ownerStatus,
    teammate_id: resolveOwnerPublicId(row, teamName)
  };
}

function resolveOwnerPublicId(row: TaskRow, teamName: string): string {
  const metadata = parseJsonObject(row.ownerMetadataJson);
  const publicTeammateId = metadata.publicTeammateId;
  if (typeof publicTeammateId === "string") {
    return publicTeammateId;
  }

  const publicLeadAgentId = metadata.publicLeadAgentId;
  if (typeof publicLeadAgentId === "string") {
    return publicLeadAgentId;
  }

  if (row.ownerMemberId?.startsWith("leader:")) {
    return `team-lead@${teamName}`;
  }

  const canonicalName = row.ownerMemberId?.split(":").at(-1) ?? row.ownerDisplayName ?? "member";
  return buildPublicTeamMateId(canonicalName, teamName);
}
