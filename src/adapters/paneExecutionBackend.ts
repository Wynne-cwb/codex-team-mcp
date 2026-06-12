import {
  type ExecutionBackend,
  type ExecutionBackendActionResult,
  type ExecutionBackendDescription,
  type ExecutionBackendReconcileResult,
  type ExecutionRunContext,
  type ExecutionTrigger,
  ScaffoldExecutionBackend
} from "./execution.js";
import { createCapabilityRankedBackendChain } from "./capabilityRankedBackendChain.js";
import { CodexCliExecutionBackend } from "./codexCliExecutionBackend.js";
import {
  createDefaultPaneBackendRegistry,
  type PaneBackendCommandResult,
  type PaneBackendMetadata,
  type PaneBackendRegistry,
  type PaneLaunchRequest,
  type PaneLaunchResult,
  type PaneReconcileResult,
  type PaneRunMetadata
} from "./paneBackend.js";
import {
  locateRolloutSessionId,
  type RolloutLocateInput,
  type RolloutLocateResult
} from "./codexRolloutLocator.js";
import {
  readRolloutStatus,
  type RolloutStatusInput,
  type RolloutStatusResult
} from "./codexRolloutReader.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  WORK_CLASSIFICATIONS
} from "../state/schema.js";
import type { CodexTeamServerOptions, PaneModeOptions } from "../types.js";

type SandboxMode = "read-only" | "workspace-write";

// Seam types so tests drive session-id capture + rollout reads + the bounded poll
// without a real codex/iTerm2/tmux or real sleeps.
type LocateRolloutFn = (input: RolloutLocateInput) => RolloutLocateResult | null;
type ReadRolloutStatusFn = (input: RolloutStatusInput) => RolloutStatusResult;

// Default bounded wait for codex's first `session_meta` line after the TUI starts
// in the pane. codex writes it within ~1s; we poll a few seconds then return
// WITHOUT a thread_id (reconcile captures it later — never fabricated).
const DEFAULT_SESSION_POLL_INTERVAL_MS = 200;
const DEFAULT_SESSION_POLL_TIMEOUT_MS = 4000;

// Sanitized terminal-failure classes (D-02 safe — no prompt/message/output text).
const PANE_TURN_FAILED = "codex_pane_turn_failed";
const PANE_PROCESS_GONE = "codex_pane_exited_without_completion";

type Phase7ExecutionClaim =
  | "durable_start_resume_supported"
  | "durable_start_only_supported"
  | "attach_status_only"
  | "pane_backend_unavailable";

export interface PaneExecutionCommandBuilder {
  buildStartCommand(context: ExecutionRunContext): readonly string[];
  buildResumeCommand(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): readonly string[];
}

export interface PaneExecutionBackendOptions extends PaneModeOptions {
  paneBackend?: PaneBackendRegistry;
  commandBuilder?: PaneExecutionCommandBuilder;
  executionClaim?: Phase7ExecutionClaim;
  // Pane-hosted full-TUI seams (all optional / defaulted). codex runs natively in
  // the pane with no `--json` stream, so the durable session id is captured from
  // the rollout file by cwd, and turn state + deliverable are read back from it.
  locateRollout?: LocateRolloutFn;
  readRolloutStatus?: ReadRolloutStatusFn;
  sleep?: (ms: number) => void;
  now?: () => number;
  sessionPollIntervalMs?: number;
  sessionPollTimeoutMs?: number;
  sessionsRoot?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_EXECUTION_CLAIM: Phase7ExecutionClaim = "attach_status_only";

const CODEX_SESSION_METADATA_UNAVAILABLE =
  "codex_session_metadata_unavailable";
const PANE_BACKEND_UNAVAILABLE_PREFIX = "pane_backend_unavailable";
const WORKSPACE_ISOLATION_REQUIRED =
  "workspace isolation or review diff is required before pane-backed file-modifying work can start";

export class PaneExecutionBackend implements ExecutionBackend {
  private readonly paneBackend: PaneBackendRegistry;
  private readonly commandBuilder: PaneExecutionCommandBuilder;
  private readonly executionClaim: Phase7ExecutionClaim;
  private readonly locateRollout: LocateRolloutFn;
  private readonly readRolloutStatusFn: ReadRolloutStatusFn;
  private readonly sleep: (ms: number) => void;
  private readonly now: () => number;
  private readonly sessionPollIntervalMs: number;
  private readonly sessionPollTimeoutMs: number;
  private readonly sessionsRoot: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: PaneExecutionBackendOptions = {}) {
    this.paneBackend =
      options.paneBackend ??
      createDefaultPaneBackendRegistry({
        preferredBackend: options.preferredBackend,
        sessionPrefix: options.sessionPrefix
      });
    this.commandBuilder =
      options.commandBuilder ?? createDefaultCommandBuilder(options.codexCommand);
    this.executionClaim = options.executionClaim ?? DEFAULT_EXECUTION_CLAIM;
    this.locateRollout = options.locateRollout ?? locateRolloutSessionId;
    this.readRolloutStatusFn = options.readRolloutStatus ?? readRolloutStatus;
    this.sleep = options.sleep ?? atomicsSleep;
    this.now = options.now ?? Date.now;
    this.sessionPollIntervalMs =
      options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
    this.sessionPollTimeoutMs =
      options.sessionPollTimeoutMs ?? DEFAULT_SESSION_POLL_TIMEOUT_MS;
    this.sessionsRoot = normalizeOptionalText(options.sessionsRoot) ?? undefined;
    this.env = options.env;
  }

  describeBackend(): ExecutionBackendDescription {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return {
        status: "unavailable",
        teammateExecutionImplemented: false,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        capabilities: {
          canStart: false,
          canResume: false,
          canReconcile: true,
          supportsWorkspaces: true
        },
        limitation: paneBackendUnavailableReason(pane)
      };
    }

    if (this.executionClaim === "attach_status_only") {
      return {
        status: "unavailable",
        teammateExecutionImplemented: false,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        capabilities: {
          canStart: false,
          canResume: false,
          canReconcile: true,
          supportsWorkspaces: true
        },
        limitation: CODEX_SESSION_METADATA_UNAVAILABLE
      };
    }

    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: this.executionClaim === "durable_start_resume_supported",
        canReconcile: true,
        supportsWorkspaces: true,
        // The pane-hosted codex runs under `-s <mode>` just like the detached
        // backend, so it carries the OS-sandbox ranking bonus. This also makes the
        // capability-ranked chain prefer the pane backend (rank-1 by input index)
        // over the detached codex backend on an availability/sandbox tie.
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return unavailableActionResult(backend, pane, paneBackendUnavailableReason(pane));
    }

    if (fileModifyingWorkRequiresIsolation(context)) {
      return unavailableActionResult(
        backend,
        {
          ...pane,
          availability_status: "degraded",
          degradation_reason: WORKSPACE_ISOLATION_REQUIRED
        },
        WORKSPACE_ISOLATION_REQUIRED
      );
    }

    const command = sanitizeCommandArgs(this.commandBuilder.buildStartCommand(context));

    if (this.executionClaim === "attach_status_only") {
      const launch = safeCreatePane(this.paneBackend, context, command);
      return unsupportedAttachOnlyResult(backend, launch.pane);
    }

    // Launch the full codex TUI in a fresh pane. The lifecycle layer puts the
    // DB-derived layout anchors on the context (previousTeammatePaneIds) BEFORE
    // calling startRun, so they flow through to createPane here.
    const startedAtMs = this.now();
    const launch = safeCreatePane(this.paneBackend, context, command);
    if (!launch.ok) {
      return failedActionResult(backend, launch.pane);
    }

    const launchedPane = sanitizePaneMetadata(launch.pane);
    const paneId =
      normalizeOptionalText(launchedPane.pane_id) ??
      normalizeOptionalText(launch.process_id);

    // Capture the durable codex session id from the rollout written into the
    // worktree cwd (bounded poll). Honest degradation: no id -> return started
    // WITHOUT a fabricated thread_id; reconcileRun relocates it later.
    const located = this.captureSession(context, startedAtMs);
    const threadId = located ? normalizeOptionalText(located.session_id) : null;

    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: threadId ?? undefined,
      thread_id: threadId ?? undefined,
      // process_id == pane_id: identifies the live pane AND gives the run durable
      // resume metadata (hasDurableResumeMetadata) even before a session id lands.
      process_id: paneId ?? undefined,
      workspace_path: context.workspace_path ?? undefined,
      started_at: new Date().toISOString(),
      metadata: cleanMetadata({
        pane: launchedPane,
        // Persisted into backend_metadata so diagnostics can read the deliverable
        // from the rollout on demand (mirrors exec_log_path for the detached backend).
        rollout_path: located ? normalizeOptionalText(located.rollout_path) ?? undefined : undefined,
        backend_workspace_cwd: captureCwd(context) ?? undefined
      })
    };
  }

  // Bounded, synchronous poll for codex's `session_meta` line keyed on the run's
  // worktree cwd. Blocks the event loop ONLY for the short session.started window
  // (default ~4s), never the whole task. Best-effort: any locator throw -> null.
  private captureSession(
    context: ExecutionRunContext,
    startedAtMs: number
  ): RolloutLocateResult | null {
    const cwd = captureCwd(context);
    if (!cwd) {
      return null;
    }
    const deadline = this.now() + this.sessionPollTimeoutMs;
    let located = this.safeLocate(cwd, startedAtMs);
    while (!located && this.now() < deadline) {
      this.sleep(this.sessionPollIntervalMs);
      located = this.safeLocate(cwd, startedAtMs);
    }
    return located;
  }

  private safeLocate(
    cwd: string,
    notBeforeMs?: number
  ): RolloutLocateResult | null {
    try {
      return this.locateRollout({
        workspaceCwd: cwd,
        notBeforeMs,
        sessionsRoot: this.sessionsRoot,
        env: this.env
      });
    } catch {
      return null;
    }
  }

  private safeReadRolloutStatus(rolloutPath: string): RolloutStatusResult {
    try {
      return this.readRolloutStatusFn({ rolloutPath });
    } catch {
      return { turn_state: "unknown" };
    }
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return unavailableActionResult(backend, pane, paneBackendUnavailableReason(pane));
    }

    if (this.executionClaim !== "durable_start_resume_supported") {
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
        metadata: {
          pane: {
            ...pane,
            availability_status: "degraded",
            degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
          }
        }
      };
    }

    // Pane-hosted resume = inject a nudge into the teammate's ALREADY-OPEN codex
    // TUI. The live pane is located from the run's persisted pane metadata, which
    // the lifecycle layer threads into the resume context.
    const livePane = extractPaneMetadata(context.metadata);
    const paneId = livePane ? normalizeOptionalText(livePane.pane_id) : null;
    if (!livePane || !paneId || livePane.availability_status !== "available") {
      return notResumableResult(
        backend,
        livePane ?? pane,
        "pane_unavailable_for_resume"
      );
    }

    // The only lawful text the resume layer surfaces is the non-sensitive
    // `summary` (the raw SendMessage body is never threaded through — D-02). No
    // text -> degrade to not_resumable rather than typing noise into the TUI.
    const messageTokens = sanitizeCommandArgs(
      this.commandBuilder.buildResumeCommand(
        context,
        stripUnsafeTriggerFields(trigger)
      )
    );
    if (messageTokens.every((token) => token.trim().length === 0)) {
      return notResumableResult(backend, livePane, "resume_text_unavailable");
    }

    const sent = this.safeSendToPane(livePane, messageTokens);
    if (!sent.ok) {
      return notResumableResult(
        backend,
        {
          ...livePane,
          availability_status: "degraded",
          degradation_reason: sanitizeText(sent.stderr || "pane_send_failed")
        },
        "pane_send_failed"
      );
    }

    const durableThreadId = durableThreadIdFromContext(context) ?? undefined;
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: durableThreadId,
      thread_id: durableThreadId,
      process_id: paneId,
      workspace_path: context.workspace_path ?? undefined,
      metadata: {
        pane: sanitizePaneMetadata(livePane)
      }
    };
  }

  private safeSendToPane(
    pane: PaneRunMetadata["pane"],
    command: readonly string[]
  ): PaneBackendCommandResult {
    try {
      if (!this.paneBackend.sendToPane) {
        return { ok: false, stdout: "", stderr: "send_unsupported", exit_code: 1 };
      }
      return this.paneBackend.sendToPane(pane, command);
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: sanitizeText(
          error instanceof Error ? error.message : String(error)
        ),
        exit_code: 1
      };
    }
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    try {
      const paneResult: PaneReconcileResult =
        this.paneBackend.reconcilePane(context);
      const pane = sanitizePaneMetadata(paneResult.pane);
      const paneAlive = paneResult.status === "active";

      // Relocate the rollout by worktree cwd (or reuse the path persisted at
      // start) and read turn state + deliverable. Never fabricate ids.
      const cwd = captureCwd(context);
      const located = cwd ? this.safeLocate(cwd) : null;
      const rolloutPath =
        (located ? normalizeOptionalText(located.rollout_path) : null) ??
        rolloutPathFromContext(context);
      const rolloutStatus: RolloutStatusResult = rolloutPath
        ? this.safeReadRolloutStatus(rolloutPath)
        : { turn_state: "unknown" };

      const threadId =
        (located ? normalizeOptionalText(located.session_id) : null) ??
        durableThreadIdFromContext(context) ??
        undefined;
      const processId =
        durableProcessIdFromContext(context) ?? pane.pane_id ?? undefined;
      const workspacePath = context.workspace_path ?? undefined;
      const deliverable = normalizeOptionalText(rolloutStatus.deliverable);

      const base = {
        backend: backendName(pane),
        backend_run_id: threadId,
        thread_id: threadId,
        process_id: processId,
        workspace_path: workspacePath
      };

      if (rolloutStatus.turn_state === "completed") {
        return {
          ...base,
          status: "idle",
          backend_status: RUN_BACKEND_STATUSES.idle,
          ended_at: new Date().toISOString(),
          metadata: cleanMetadata({
            pane,
            // RAW deliverable for the in-memory result only — reconciliation
            // never persists reconcile metadata, so no D-02 DB leak. The durable
            // surface (diagnostics) reads + sanitizes it from the rollout itself.
            deliverable: deliverable ?? undefined,
            session_deleted: false
          })
        };
      }

      if (rolloutStatus.turn_state === "failed") {
        return {
          ...base,
          status: "failed",
          backend_status: RUN_BACKEND_STATUSES.failed,
          ended_at: new Date().toISOString(),
          last_error: PANE_TURN_FAILED,
          metadata: { pane, session_deleted: false }
        };
      }

      if (rolloutStatus.turn_state === "in_progress") {
        if (paneAlive) {
          return {
            ...base,
            status: "active",
            backend_status: RUN_BACKEND_STATUSES.running,
            metadata: { pane, session_deleted: false }
          };
        }
        // Pane died with an unfinished turn (closing a pane kills the teammate —
        // accepted) -> failed, never a fabricated completion.
        return {
          ...base,
          status: "failed",
          backend_status: RUN_BACKEND_STATUSES.failed,
          ended_at: new Date().toISOString(),
          last_error: PANE_PROCESS_GONE,
          metadata: { pane, session_deleted: false }
        };
      }

      // Unknown turn state (no rollout yet / unreadable): trust pane liveness.
      if (paneAlive) {
        return {
          ...base,
          status: "active",
          backend_status: RUN_BACKEND_STATUSES.running,
          metadata: { pane, session_deleted: false }
        };
      }
      // Pane not alive and the turn state cannot be confirmed -> reflect the pane
      // reconcile status (stale / unsupported / unknown) without inventing a
      // terminal outcome.
      return {
        ...base,
        status: paneResult.status,
        backend_status: backendStatusFromReconcileStatus(paneResult.status),
        metadata: { pane, session_deleted: false }
      };
    } catch (error) {
      const pane =
        extractPaneMetadata(context.metadata) ??
        ({
          mode: "pane",
          backend_type: "tmux",
          availability_status: "degraded",
          degradation_reason: sanitizeText(
            error instanceof Error ? error.message : String(error)
          )
        } satisfies PaneRunMetadata["pane"]);

      return {
        status: "unknown",
        backend: backendName(pane),
        backend_status: RUN_BACKEND_STATUSES.unknown,
        last_error: pane.degradation_reason,
        metadata: {
          pane,
          session_deleted: false
        }
      };
    }
  }
}

export function createExecutionBackendFromOptions(
  options: CodexTeamServerOptions
): ExecutionBackend {
  if (options.executionBackend) {
    return options.executionBackend;
  }

  // Explicit CODEX_TEAM_EXECUTION opt-in -> the capability-ranked chain over the
  // real backend candidates. Never silently auto-enabled; the default stays the
  // unsupported ScaffoldExecutionBackend.
  if (options.execution?.enabled === true) {
    return createCapabilityRankedBackendChain(
      buildExecutionCandidates(options.execution.backend, options.paneMode)
    );
  }

  // Pure pane-mode (execution opt-in OFF): panes are a VISIBILITY overlay only,
  // never an executor. Keep the scaffold (attach/status-only) claim so this path
  // does NOT silently start real pane-hosted execution — that requires the
  // execution opt-in above.
  if (options.paneMode?.enabled === true) {
    return new PaneExecutionBackend(options.paneMode);
  }

  return new ScaffoldExecutionBackend();
}

function buildExecutionCandidates(
  backend?: string,
  paneMode?: PaneModeOptions
): ExecutionBackend[] {
  const candidates: ExecutionBackend[] = [];

  // When pane mode is also enabled, the pane-hosted full-TUI backend is the
  // rank-1 candidate: it runs the teammate's codex as a real interactive TUI in
  // a new pane and is selected whenever a pane backend (iTerm2/tmux) is present.
  // It claims durable start+resume so the capability-ranked chain treats it as a
  // qualifier; when no pane backend is available it reports unavailable and the
  // chain falls back to the detached codex backend below.
  if (paneMode?.enabled === true) {
    candidates.push(
      new PaneExecutionBackend({
        ...paneMode,
        executionClaim: "durable_start_resume_supported"
      })
    );
  }

  // The detached codex CLI exec/resume backend is the always-present fallback
  // (and the only candidate when pane mode is off). The `backend` selector is
  // retained for forward-compat; today every value resolves to this candidate.
  void backend?.trim().toLowerCase();
  candidates.push(new CodexCliExecutionBackend());

  return candidates;
}

export function extractPaneMetadata(
  metadata: Record<string, unknown> | undefined
): PaneRunMetadata["pane"] | null {
  if (!metadata) {
    return null;
  }

  const backendMetadata = metadata.backend_metadata;
  if (isRecord(backendMetadata) && isPaneMetadata(backendMetadata.pane)) {
    return sanitizePaneMetadata(backendMetadata.pane);
  }

  if (isPaneMetadata(metadata.pane)) {
    return sanitizePaneMetadata(metadata.pane);
  }

  return null;
}

// Behavior contract prepended to every pane-hosted teammate's codex prompt.
// Encodes the "做法 1" escalation closed loop: the teammate runs autonomously
// (approvals are already auto-skipped via `-a never`) and, instead of blocking on
// anything only a human can decide, writes that question into its reply and ends
// the turn. The Team Lead reads it, relays it to the human user, and sends the
// answer back (delivered into this same pane via resumeRun -> sendToPane), letting
// the teammate continue. Kept short so it never crowds out the actual task.
export const TEAMMATE_PREAMBLE =
  "You are an autonomous teammate. Approvals are auto-skipped — do not stop to wait for approval; keep working through your assigned task. " +
  "If you hit something only the human user can decide (product direction, scope, a clarification, or an irreversible action), clearly write that question into your reply and end your turn — do not block waiting. The Team Lead will relay it to the human user and send the answer back so you can continue. " +
  "You can message teammates directly — find them with TeamDiagnostics. When you message a peer or the Team Lead, send one focused message and end your turn; do not keep replying back and forth. " +
  "When you see a 📬 inbox nudge in your pane (e.g. \"N new message(s) — run CheckInbox to read\"), call the CheckInbox tool to read the full message bodies; the nudge itself is only a short notification. " +
  "Keep your output focused on the task you were assigned.";

// Phase 13 (D-Q3): TOML basic string for a `-c` value. Escape `\` then `"` and
// wrap in double quotes. Control chars are already stripped by sanitizeText in
// startRun's sanitizeCommandArgs, so only these two need escaping here.
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// One per-launch `-c` override as TWO raw argv tokens. Targets the codex-team MCP
// child's env block via `mcp_servers.codex-team.env.<KEY>` so `-c` both adds and
// overrides the shared global block value for this launch only.
function envOverride(key: string, value: string): [string, string] {
  return ["-c", `mcp_servers.codex-team.env.${key}=${tomlBasicString(value)}`];
}

function createDefaultCommandBuilder(
  codexCommand: string | undefined
): PaneExecutionCommandBuilder {
  const command = normalizeOptionalText(codexCommand) ?? "codex";
  return {
    // Full interactive codex TUI (NOT `codex exec`): `-C <worktree>` pins the cwd,
    // `-a never` skips approvals so the teammate runs autonomously, `-s <mode>`
    // applies the sandbox by work classification. The isolated worktree is the
    // safety boundary. The prompt is the positional task, prefixed with the
    // autonomous-teammate behavior contract (TEAMMATE_PREAMBLE) so the teammate
    // escalates human-only questions instead of blocking; omitted entirely when no
    // prompt is present so codex opens a blank interactive TUI (no bare preamble).
    buildStartCommand(context) {
      const workspacePath = normalizeOptionalText(context.workspace_path);
      const mode = sandboxModeForClassification(context.work_classification);
      const prompt = promptFromContext(context);
      const positionalPrompt = prompt
        ? `${TEAMMATE_PREAMBLE}\n\n${prompt}`
        : null;
      // Phase 13 (SC1 / BIDIR-01 / D-Q3): per-launch `-c` env overrides bind this
      // teammate's co-located codex-team MCP to the TL container DB (WORKSPACE_ROOT
      // = container root, NOT the worktree) and self-identify it (MEMBER_ID/ROLE).
      // RAW tokens only — paneBackend.buildTailCommandString single-quotes each
      // token for `sh -c`, so we must NOT pre-shell-quote; the inner value is a TOML
      // basic string (KEY="value"). Deterministic order: WORKSPACE_ROOT, MEMBER_ID,
      // MEMBER_ROLE. Resume never re-injects (buildResumeCommand is unchanged).
      const envTokens: string[] = [];
      const workspaceRoot = normalizeOptionalText(context.workspace_root);
      if (workspaceRoot) {
        envTokens.push(...envOverride("CODEX_TEAM_WORKSPACE_ROOT", workspaceRoot));
      }
      const memberId = normalizeOptionalText(context.member_id);
      if (memberId) {
        // Role is meaningless without identity — only emitted alongside MEMBER_ID.
        envTokens.push(...envOverride("CODEX_TEAM_MEMBER_ID", memberId));
        envTokens.push(...envOverride("CODEX_TEAM_MEMBER_ROLE", "teammate"));
      }
      return [
        command,
        ...(workspacePath ? ["-C", workspacePath] : []),
        "-a",
        "never",
        "-s",
        mode,
        ...envTokens,
        ...(positionalPrompt ? [positionalPrompt] : [])
      ];
    },
    // Resume nudge text for the live TUI. Phase 16 (notify + pull): this is a SHORT,
    // length-bounded inbox nudge (the drain / message-arrival path threads it as
    // resume_delivery_text) — NEVER the full body, which would be an unbounded
    // terminal write (the long-body hazard). Falls back to the non-sensitive
    // `summary`. Empty when absent -> resumeRun degrades to not_resumable.
    buildResumeCommand(context) {
      const text = resumeTextFromContext(context);
      return text ? [text] : [];
    }
  };
}

function safeCreatePane(
  paneBackend: PaneBackendRegistry,
  context: ExecutionRunContext,
  command: readonly string[]
): PaneLaunchResult {
  try {
    // Forward the whole context (incl. the lifecycle-supplied
    // previousTeammatePaneIds layout anchors) to createPane.
    return paneBackend.createPane(context as PaneLaunchRequest, command);
  } catch (error) {
    return {
      ok: false,
      pane: {
        mode: "pane",
        backend_type: "tmux",
        availability_status: "degraded",
        degradation_reason: sanitizeText(
          error instanceof Error ? error.message : String(error)
        )
      }
    };
  }
}

function unavailableActionResult(
  backend: string,
  pane: PaneRunMetadata["pane"],
  reason: string
): ExecutionBackendActionResult {
  return {
    status: "unsupported",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    backend,
    backend_status: RUN_BACKEND_STATUSES.notStarted,
    last_error: sanitizeText(reason),
    metadata: {
      pane: sanitizePaneMetadata(pane)
    }
  };
}

function unsupportedAttachOnlyResult(
  backend: string,
  pane: PaneRunMetadata["pane"]
): ExecutionBackendActionResult {
  return {
    status: "unsupported",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    backend,
    backend_status: RUN_BACKEND_STATUSES.notStarted,
    last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
    metadata: {
      pane: {
        ...sanitizePaneMetadata(pane),
        availability_status: "degraded",
        degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
      }
    }
  };
}

function failedActionResult(
  backend: string,
  pane: PaneRunMetadata["pane"]
): ExecutionBackendActionResult {
  return {
    status: "backend_failed",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
    backend,
    backend_status: RUN_BACKEND_STATUSES.failed,
    last_error: pane.degradation_reason ?? "pane_backend_failed",
    metadata: {
      pane: {
        ...sanitizePaneMetadata(pane),
        availability_status:
          pane.availability_status === "unavailable" ? "unavailable" : "degraded"
      }
    }
  };
}

// Graceful resume degradation: the live pane is gone / unreachable / there is no
// lawful nudge text. Never throws, never fabricates a session id — the lifecycle
// surfaces not_resumable to the lead.
function notResumableResult(
  backend: string,
  pane: PaneRunMetadata["pane"],
  reason: string
): ExecutionBackendActionResult {
  const sanitizedPane = sanitizePaneMetadata(pane);
  return {
    status: "not_resumable",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    backend,
    backend_status: RUN_BACKEND_STATUSES.notStarted,
    last_error: sanitizeText(reason),
    metadata: {
      pane: {
        ...sanitizedPane,
        availability_status:
          sanitizedPane.availability_status === "available"
            ? "degraded"
            : sanitizedPane.availability_status,
        degradation_reason:
          sanitizedPane.degradation_reason ?? sanitizeText(reason)
      }
    }
  };
}

function paneBackendUnavailableReason(pane: PaneRunMetadata["pane"]): string {
  const reason = pane.degradation_reason ?? "no pane backend is available";
  return `${PANE_BACKEND_UNAVAILABLE_PREFIX}:${sanitizeText(reason)}`;
}

// Worktree cwd a run's codex rollout is keyed on: the explicit workspace_path
// (when `-C` was passed) else the workspace_root the pane opened in.
function captureCwd(context: ExecutionRunContext): string | null {
  return (
    normalizeOptionalText(context.workspace_path) ??
    normalizeOptionalText(context.workspace_root)
  );
}

// The rollout path persisted at start (backend_metadata.rollout_path), used by
// reconcile as a fallback when relocation by cwd misses.
function rolloutPathFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "rollout_path") ??
    stringFromNestedMetadata(context.metadata, "backend_metadata", "rollout_path")
  );
}

function sandboxModeForClassification(
  classification: string | null | undefined
): SandboxMode {
  if (
    classification === WORK_CLASSIFICATIONS.codeImplementation ||
    classification === WORK_CLASSIFICATIONS.artifactWriting
  ) {
    return "workspace-write";
  }
  return "read-only";
}

function promptFromContext(context: ExecutionRunContext): string | null {
  return stringFromMetadata(context.metadata, "prompt");
}

// Resume nudge text injected into the live TUI. Phase 16 (notify + pull):
// `resume_delivery_text` now carries the SHORT, length-bounded inbox NUDGE (count +
// distinct senders), NOT the full body — the recipient pulls bodies over MCP/JSON via
// CheckInbox. Falls back to the non-sensitive `summary` when no nudge was supplied
// (e.g. system lifecycle notices, which only carry a summary).
//
// D-02: `resume_delivery_text` lives ONLY on the in-memory resume context
// (lifecycle buildResumeContextMetadata -> resumeRun -> sendToPane). It is NEVER
// written back into runs.metadata_json, events, or diagnostics — resumeRun's
// returned actionResult.metadata carries only `{ pane }`. The full message body is
// lawfully stored in the `messages` table and never rides the resume context at all.
function resumeTextFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "resume_delivery_text") ??
    stringFromMetadata(context.metadata, "summary")
  );
}

function cleanMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  );
}

// Synchronous sleep that briefly blocks only the calling turn for the bounded
// session-id poll. Atomics.wait on a never-notified slot waits out the interval.
function atomicsSleep(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function fileModifyingWorkRequiresIsolation(context: ExecutionRunContext): boolean {
  if (
    context.work_classification !== WORK_CLASSIFICATIONS.codeImplementation &&
    context.work_classification !== WORK_CLASSIFICATIONS.artifactWriting
  ) {
    return false;
  }

  return (
    context.isolation_kind !== "git_worktree" &&
    context.isolation_kind !== "review_diff" &&
    context.isolation_kind !== "declared_output_path"
  );
}

function durableThreadIdFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "backend_thread_id") ??
    stringFromMetadata(context.metadata, "thread_id") ??
    stringFromMetadata(context.metadata, "backend_run_id") ??
    stringFromNestedMetadata(context.metadata, "backend_metadata", "thread_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_thread_id"
    )
  );
}

function durableProcessIdFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "backend_process_id") ??
    stringFromMetadata(context.metadata, "process_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_process_id"
    )
  );
}

function stringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!metadata) {
    return null;
  }

  return normalizeOptionalText(metadata[key]);
}

function stringFromNestedMetadata(
  metadata: Record<string, unknown> | undefined,
  containerKey: string,
  key: string
): string | null {
  if (!metadata || !isRecord(metadata[containerKey])) {
    return null;
  }

  return normalizeOptionalText(metadata[containerKey][key]);
}

function stripUnsafeTriggerFields(trigger: ExecutionTrigger): ExecutionTrigger {
  return {
    kind: trigger.kind,
    occurred_at: trigger.occurred_at,
    reason: trigger.reason
  };
}

function sanitizeCommandArgs(args: readonly string[]): string[] {
  return args.map((arg) => sanitizeText(arg));
}

function sanitizePaneMetadata(pane: PaneBackendMetadata): PaneRunMetadata["pane"] {
  return {
    mode: "pane",
    backend_type:
      pane.backend_type === "iterm2" || pane.backend_type === "tmux"
        ? pane.backend_type
        : "tmux",
    availability_status:
      pane.availability_status === "available" ||
      pane.availability_status === "unavailable" ||
      pane.availability_status === "degraded"
        ? pane.availability_status
        : "degraded",
    degradation_reason: normalizeOptionalText(pane.degradation_reason) ?? undefined,
    pane_id: normalizeOptionalText(pane.pane_id) ?? undefined,
    session_name: normalizeOptionalText(pane.session_name) ?? undefined,
    window_name: normalizeOptionalText(pane.window_name) ?? undefined,
    socket_name: normalizeOptionalText(pane.socket_name) ?? undefined,
    attach_command: normalizeOptionalText(pane.attach_command) ?? undefined,
    is_native: pane.is_native
  };
}

function backendName(pane: PaneRunMetadata["pane"]): string {
  return pane.backend_type;
}

function backendStatusFromReconcileStatus(
  status: ExecutionBackendReconcileResult["status"]
) {
  if (status === "active") {
    return RUN_BACKEND_STATUSES.running;
  }
  if (status === "idle") {
    return RUN_BACKEND_STATUSES.idle;
  }
  if (status === "stopped" || status === "unsupported") {
    return RUN_BACKEND_STATUSES.notStarted;
  }
  if (status === "failed") {
    return RUN_BACKEND_STATUSES.failed;
  }
  if (status === "stale") {
    return RUN_BACKEND_STATUSES.stale;
  }

  return RUN_BACKEND_STATUSES.unknown;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = sanitizeText(value).trim();
  return sanitized ? sanitized : null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaneMetadata(value: unknown): value is PaneBackendMetadata {
  return (
    isRecord(value) &&
    value.mode === "pane" &&
    (value.backend_type === "tmux" || value.backend_type === "iterm2") &&
    (value.availability_status === "available" ||
      value.availability_status === "unavailable" ||
      value.availability_status === "degraded")
  );
}
