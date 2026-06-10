import {
  type ExecutionBackend,
  type ExecutionBackendActionResult,
  type ExecutionBackendCapabilities,
  type ExecutionBackendDescription,
  type ExecutionBackendReconcileResult,
  type ExecutionRunContext,
  type ExecutionTrigger
} from "./execution.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES
} from "../state/schema.js";

// Stable label used when the chain has no candidates at all. With candidates,
// the rank-1 candidate's own backend name is preferred so the chain never
// reports "none" while unavailable (keeps the env opt-in environment-independent
// and preserves D-04 canStart=false). See docs/backend-decision.md.
const DEFAULT_UNAVAILABLE_BACKEND_LABEL = "codex_cli_exec";

// Mirrors docs/backend-decision.md "Unsupported-environment remediation".
const UNAVAILABLE_REMEDIATION: readonly string[] = [
  "Enable the execution opt-in: set CODEX_TEAM_EXECUTION=1 (the default scaffold backend is intentionally unsupported).",
  "Install or repair a supported surface: ensure `codex` is on PATH so `codex exec --help` exits 0 and `codex exec --json` can emit a thread.started thread_id.",
  "Provide a worktree/workspace directory for file-modifying work so the backend can run with --cd.",
  "Optionally set CODEX_TEAM_EXECUTION_BACKEND to pin a specific surface (for example codex_cli_exec)."
];

const UNAVAILABLE_LIMITATION =
  "No execution backend qualifies (a qualifier must be worktree-runnable and expose a persistent resume id). See remediation and escalate to the Team Lead.";

export interface SelectExecutionBackendResult {
  status: "selected" | "unavailable";
  /** Selected backend name, or the rank-1 candidate name when unavailable. Never "none". */
  backend: string;
  qualifies: boolean;
  /** Non-empty only when unavailable. */
  remediation: string[];
  /** True only when no candidate qualifies anywhere. */
  escalate_to_team_lead: boolean;
}

interface RankedCandidate {
  backend: ExecutionBackend;
  description: ExecutionBackendDescription;
  capabilities: ExecutionBackendCapabilities;
  qualifies: boolean;
  supportsOsSandbox: boolean;
  index: number;
}

/**
 * Capability-detection-ranked chain over the existing ExecutionBackend contract.
 *
 * Gate (lowered, worktree-revised): a candidate QUALIFIES iff it is
 * worktree-runnable (`capabilities.supportsWorkspaces === true`) AND exposes a
 * persistent resume id (`capabilities.canResume === true`). OS sandbox support
 * is a ranking bonus tiebreak only, never an eligibility gate.
 *
 * When >=1 qualifies, describe/start/resume/reconcile delegate to the selected
 * rank-1 qualifier. When none qualify, the chain reports an honest unavailable
 * result (non-"none" rank-1 label, canStart=false) and the selector surfaces
 * remediation + an escalate-to-Team-Lead signal. It never fabricates ids.
 */
export class CapabilityRankedBackendChain implements ExecutionBackend {
  private readonly ranked: RankedCandidate[];
  private readonly selected: RankedCandidate | null;
  private readonly rankOneLabel: string;

  constructor(candidates: ExecutionBackend[]) {
    this.ranked = candidates.map((backend, index) => probeCandidate(backend, index));
    const qualifiers = this.ranked.filter((candidate) => candidate.qualifies);
    this.selected = rankCandidates(qualifiers)[0] ?? null;
    this.rankOneLabel = computeRankOneLabel(this.ranked);
  }

  describeBackend(): ExecutionBackendDescription {
    if (this.selected) {
      return this.selected.backend.describeBackend();
    }

    return {
      status: "unavailable",
      teammateExecutionImplemented: false,
      backend: this.rankOneLabel,
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: false,
        supportsWorkspaces: false,
        supportsOsSandbox: false
      },
      limitation: UNAVAILABLE_LIMITATION
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    if (this.selected) {
      return this.selected.backend.startRun(context);
    }

    return this.unsupportedActionResult();
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    if (this.selected) {
      return this.selected.backend.resumeRun(context, trigger);
    }

    return this.unsupportedActionResult();
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    if (this.selected) {
      return this.selected.backend.reconcileRun(context);
    }

    return {
      status: "unsupported",
      backend: this.rankOneLabel,
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: UNAVAILABLE_LIMITATION
    };
  }

  /** Read-only selection summary consumed by selectExecutionBackend(). */
  selectionSummary(): SelectExecutionBackendResult {
    if (this.selected) {
      return {
        status: "selected",
        backend: this.selected.description.backend,
        qualifies: true,
        remediation: [],
        escalate_to_team_lead: false
      };
    }

    return {
      status: "unavailable",
      backend: this.rankOneLabel,
      qualifies: false,
      remediation: [...UNAVAILABLE_REMEDIATION],
      escalate_to_team_lead: true
    };
  }

  private unsupportedActionResult(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: this.rankOneLabel,
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: UNAVAILABLE_LIMITATION
    };
  }
}

export function createCapabilityRankedBackendChain(
  candidates: ExecutionBackend[]
): CapabilityRankedBackendChain {
  return new CapabilityRankedBackendChain(candidates);
}

export function selectExecutionBackend(
  chain: CapabilityRankedBackendChain
): SelectExecutionBackendResult {
  return chain.selectionSummary();
}

function probeCandidate(
  backend: ExecutionBackend,
  index: number
): RankedCandidate {
  const description = backend.describeBackend();
  const capabilities = description.capabilities;

  return {
    backend,
    description,
    capabilities,
    qualifies:
      capabilities.supportsWorkspaces === true &&
      capabilities.canResume === true,
    supportsOsSandbox: readOsSandboxBonus(capabilities),
    index
  };
}

// Ranking criteria for qualifiers (docs/backend-decision.md): id quality >
// worktree robustness > availability > OS-sandbox bonus tiebreak. Only
// availability and the OS-sandbox bonus are observable from capabilities; the
// remaining order is preserved via the original input index (stable, first
// qualifier wins on ties).
function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    const availabilityDelta =
      Number(b.capabilities.canStart) - Number(a.capabilities.canStart);
    if (availabilityDelta !== 0) {
      return availabilityDelta;
    }

    const sandboxDelta =
      Number(b.supportsOsSandbox) - Number(a.supportsOsSandbox);
    if (sandboxDelta !== 0) {
      return sandboxDelta;
    }

    return a.index - b.index;
  });
}

function computeRankOneLabel(ranked: RankedCandidate[]): string {
  const label = ranked[0]?.description.backend;
  return label && label !== "none" ? label : DEFAULT_UNAVAILABLE_BACKEND_LABEL;
}

function readOsSandboxBonus(
  capabilities: ExecutionBackendCapabilities
): boolean {
  return capabilities.supportsOsSandbox === true;
}
