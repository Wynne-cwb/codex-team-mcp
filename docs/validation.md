# Compatibility Validation

This document records the Phase 7 validation artifact for the Codex Team compatibility contract. It pairs the behavior matrix in [compatibility.md](compatibility.md) with the fixture, tests, pane backend coverage, smoke command, manual checks, and known limitations used as evidence.

## Synthetic Workflow

The fixed workflow fixture is [test/fixtures/synthetic-claude-team-workflow.md](../test/fixtures/synthetic-claude-team-workflow.md). It keeps the workflow Claude Team-oriented while adding only a thin compatibility instruction: use `TeamCreate`, named `Agent`, `SendMessage`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, and `TeamDiagnostics`; if those tools are missing, report `Agent Team compatibility layer unavailable` and do not silently substitute generic subagents.

The MCP-visible walkthrough is implemented in [test/compatibilityWorkflow.test.ts](../test/compatibilityWorkflow.test.ts). The docs and skill contract checks live in [test/docsSkill.test.ts](../test/docsSkill.test.ts).

## Automated Commands

- `npm test -- --run test/compatibilityWorkflow.test.ts test/docsSkill.test.ts`
- `npm test -- --run test/docsSkill.test.ts`
- `npm run build && npm test -- --run && npm run smoke:list-tools`

The smoke command uses [scripts/smoke-list-tools.mjs](../scripts/smoke-list-tools.mjs) to confirm the eight Claude-style compatibility tools plus `TeamDiagnostics` are visible through the stdio MCP server.

Phase 7 pane-mode verification adds these commands:

- `npm test -- --run test/paneBackend.test.ts test/paneExecutionBackend.test.ts test/paneDiagnostics.test.ts test/paneMcp.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run smoke:list-tools`

Phase 12 file-modifying acceptance (worktree isolation + TL merge) adds these commands:

- `npm test -- --run test/worktreeMergeService.test.ts test/lifecycleMerge.test.ts test/workspaceSafetyEnforcement.test.ts`
- `npm test -- --run test/mergeMcp.test.ts test/executionAcceptanceWalkthrough.test.ts test/isolationEnforcement.test.ts`

These run with a fake execution backend + a real temp git worktree/merge, so they are deterministic and do not require real `codex`/`tmux`.

## Coverage

- `TeamCreate` creates durable team state, leader identity, initialized storage, and active binding.
- Named `Agent` creates an addressable TeamMate; unnamed `Agent` stays on the ordinary subagent path.
- `SendMessage` persists explicit messages before backend delivery and exposes queued/backend limitation status.
- `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` exercise team-scoped SQLite task state and history.
- Restart-style reopening proves active binding and task state persistence.
- `TeamDiagnostics` summarizes tool status, durable state, lifecycle/run status, message/task state, reconciliation, and workspace review status.
- [compatibility.md](compatibility.md) classifies each validated behavior as `Supported`, `Approximated`, `Backend-dependent`, or `Unsupported`.
- `test/paneBackend.test.ts` covers tmux/iTerm2 detection, external tmux attach metadata, command failure, and unavailable degradation.
- `test/paneExecutionBackend.test.ts` covers pane-backed `ExecutionBackend` start/resume/reconcile behavior and durable lifecycle metadata integration.
- `test/paneDiagnostics.test.ts` and `test/paneMcp.test.ts` cover pane attach/status output, redaction, `SendMessage` routing, and workspace review visibility.

## Phase 12 File-Modifying Acceptance (D-02)

File-modifying TeamMate work is delivered in this version through an isolated git worktree and merged back into the leader by the TL Agent (`TeamMerge`, see [tool-mapping.md](tool-mapping.md) Merge model). The automated walkthrough [test/executionAcceptanceWalkthrough.test.ts](../test/executionAcceptanceWalkthrough.test.ts) covers the full chain (worktree start → real file write → durable metadata → `SendMessage` resume → `TeamDiagnostics` → TL `TeamMerge` review/merge + O-2 cleanup → conflict path → human-escalation path → unavailable-with-remediation → pane fallback) with a fake backend + real temp git, and [test/isolationEnforcement.test.ts](../test/isolationEnforcement.test.ts) pins ISOL-01/ISOL-02.

**Maintainer real UAT (D-02 proof-first) — required for milestone acceptance, NOT replaced by the automated walkthrough:** on the maintainer machine, run one full file-modifying worktree-isolation path end-to-end with **real `codex`** (`CODEX_TEAM_EXECUTION=1`) + **real git worktree**: `TeamCreate` → `Agent` starts in an isolated worktree → **really write files in the worktree** → capture durable backend metadata → `SendMessage` resume → real `TeamDiagnostics` → **TL reviews the branch diff and really merges back into the leader** (including a conflict the TL resolves autonomously and, where it cannot, escalates to a human). The documented unavailable-with-remediation and pane-fallback paths must also be exercised but do not substitute for this real worktree file-modifying run.

## Manual Checks

- Read [test/fixtures/synthetic-claude-team-workflow.md](../test/fixtures/synthetic-claude-team-workflow.md) and confirm it is a minimal Claude Team-oriented workflow plus thin tool mapping and unavailable-layer behavior, not a Codex-native rewrite.
- Read [compatibility.md](compatibility.md) and confirm every evidence link points to relevant test, source, docs, or planning evidence.
- Confirm concise docs and the compatibility skill link to the dedicated compatibility and validation artifacts without duplicating the full matrix.
- With pane mode enabled and tmux installed, create a TeamMate, copy the reported `tmux -L <socket> attach-session -t <session>` command from `TeamDiagnostics`, run it in a terminal, and confirm the TeamMate pane/session is visible.
- On macOS with iTerm2 available, enable `CODEX_TEAM_PANE_BACKEND=iterm2` and confirm iTerm2 attaches or degrades cleanly; otherwise confirm diagnostics reports the degradation reason while core tools remain usable.
- Confirm pane status and diagnostics show lifecycle, pane attach/status, message counts, task summaries, `pending_review` / `needs_review`, and review hints without raw message bodies or full transcript content.

## Known Limitations

- Default TeamMate execution is backend-dependent; without a configured runner, the default backend reports unsupported execution.
- Running-recipient delivery is queued for the next turn boundary and is not guaranteed mid-turn message injection.
- The compatibility layer does not provide true Claude in-process runtime behavior, AsyncLocalStorage-equivalent context, hidden Claude CLI args, exact Claude tmux/iTerm2 pane parity, or approval-bridge parity.
- Broadcast delivery through `to: "*"` and cross-session bridge delivery are unsupported in this v1 contract.
- Workspace review safety is explicit: file-modifying work must remain isolated or reviewable, and `needs_review` means review is required before work affects the leader workspace.
- Optional pane mode is a backend-dependent pane-style approximation, not exact Claude tmux/iTerm2 pane parity.
- The pane transcript experience is terminal scrollback; Phase 7 does not persist full pane transcripts.
- User text to TeamMates must use `SendMessage`, not direct pane shell input.
- User-facing force kill or terminate controls are outside Phase 7 support.
