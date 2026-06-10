# Codex Execution Backend Decision

This is the Phase 8 backend **decision record**. It turns the spike evidence in
[`test/fixtures/codex-session-metadata-spike.md`](../test/fixtures/codex-session-metadata-spike.md)
(captured against `codex-cli 0.138.0`) into the backend architecture that
Phase 9-12 will implement. It does **not** implement any execution backend:
the default remains `ScaffoldExecutionBackend` (unsupported), and the
capability-ranked chain, env opt-in, and enriched diagnostics are pinned only by
the RED tests listed under [Relationship to Phase 9-12](#relationship-to-phase-9-12).

No exact Claude parity is claimed. No backend is implemented in Phase 8.

## Lowered qualifying gate

A surface **QUALIFIES** as a standalone execution backend iff BOTH of these hold:

```text
(1) worktree-runnable  -> can run in a caller-specified worktree/workspace directory
                          (maps to ExecutionBackend.capabilities.supportsWorkspaces === true)
(2) persistent ID      -> exposes a durable identifier usable to resume the run
```

OS sandbox / read-only flags are **EXCLUDED** from the gate (D-06). They are
recorded separately as an optional ranking **bonus** and applied best-effort only
when the chosen backend happens to support them — never as an eligibility
condition and never blocking a run. A surface lacking OS sandbox still qualifies.

This lowered gate (worktree-revised D-02/D-03) is what removed the prior
"no qualifying backend → milestone unfinishable" deadlock: worktree isolation is
a generic mechanism every workspace-capable backend can satisfy, so a qualifying
backend is essentially guaranteed.

## Capability matrix

Grounded in the 08-01 spike fixture verdicts. `qualifies` is computed ONLY from
the two gate items; `os_sandbox_bonus` never changes it.

| surface | worktree_runnable | persistent_id | qualifies | os_sandbox_bonus | rank | rationale |
|---------|-------------------|---------------|-----------|------------------|------|-----------|
| codex CLI exec/resume | yes | yes (`thread_id` re-emitted by `exec resume --json`) | yes | yes (`-s,--sandbox` / `codex sandbox`) | 1 | Only surface meeting both gate items with live evidence; durable `thread_id`, `--cd` workspace, robust availability. |
| MCP (`mcp-server`) | unknown | unknown | no | yes (`-c` config) | — | Help advertises no per-session workspace arg or resumable conversation id; not probed with a write turn. Candidate for a later live probe; would rank below CLI. |
| app-server / remote-control | unknown | unknown | no | unknown | — | `[experimental]`; durable session ids + per-session workspace unconfirmed without starting a daemon; stability risk. |
| SDK | n/a | n/a | no | n/a | — | No `@openai/codex-sdk` installed; recorded `not_available` honestly — not a gate failure for the chain. |
| tmux | yes | no | no | n/a | transport | Visibility/attach **transport** only: exposes terminal `pane_id`/`session_name`/`socket_name`, not a durable Codex id. Composes over a runner. |
| iTerm2 | yes | no | no | n/a | transport | Visibility/attach **transport** only (macOS): terminal ids, not a durable Codex id. Composes over a runner. |

tmux and iTerm2 are **visibility transports**, not standalone qualifying
backends: their durable id comes from whatever `codex` process runs inside them.

## Selected backend & ranked chain

**Selected (rank 1): the codex CLI exec/resume backend** — launch via
`codex exec --json` (capturing the `thread.started` `thread_id`) and resume via
`codex exec resume --json <thread_id>`, run inside a caller-specified worktree
directory via `--cd <DIR>`.

The Phase 9-12 architecture is a **pluggable, capability-detection-ranked chain**
over the existing `ExecutionBackend` contract (preserved and extended, never
bypassed):

```text
configured CODEX_TEAM_* opt-in?
  -> no  : ScaffoldExecutionBackend (default, unsupported) — unchanged
  -> yes : CapabilityRankedBackendChain
            -> probe each candidate ExecutionBackend's capabilities (availability + gate)
            -> filter QUALIFYING = capabilities.supportsWorkspaces === true && exposes persistent resume id
            -> rank survivors by: id quality > worktree robustness > availability > OS-sandbox bonus (tiebreak)
            -> select highest-ranked qualifier
            -> none qualify => honest unavailable + remediation + escalate-to-Team-Lead signal
```

Ranking criteria, in order: (a) durable/resumable identifier quality (stable,
re-emitted on resume, parseable), (b) worktree/workspace run robustness,
(c) availability-detection reliability in the current environment, then
(d) OS-sandbox bonus as a tiebreak only. Candidate inclusion/exclusion:

- **codex CLI exec/resume** — INCLUDED, rank 1 (qualifies; best id quality).
- **MCP** — candidate, EXCLUDED for now (gate items unconfirmed); revisit with a
  live probe in a later phase; would rank below CLI even if confirmed.
- **app-server / remote-control** — candidate, EXCLUDED (experimental;
  unconfirmed durable session ids; stability risk).
- **SDK** — EXCLUDED (`not_available`); add if/when installed.
- **tmux / iTerm2** — NOT ranked as runners; composed as optional visibility
  transports over the selected runner.

## Launch / resume strategy

For the rank-1 backend:

- **Launch:** run `codex exec --json` (sentinel/real prompt) with `--cd <worktree dir>`
  for file-modifying work; parse the mixed stdout tolerantly for the
  `thread.started` `thread_id`; persist the durable id + `workspace_path` into the
  existing `runs` columns (`backend_run_id` / `backend_thread_id` /
  `backend_process_id` / `workspace_path`). Capture is sanitized before storage.
- **Resume:** `codex exec resume --json <thread_id>` using the persisted durable
  id; confirm the same `thread_id` re-emits. **Never invent session metadata** —
  resume is lawful only with a real discovered `thread_id`/session id; if none
  exists, degrade honestly (`codex_session_metadata_unavailable`).
- **Reconcile:** map backend state back into member/run/event state without
  exposing raw prompts or message bodies.

## Fallback strategy

The chain falls through in ranked order: if the rank-1 backend is unavailable in
a given environment (e.g. `codex exec --help` does not exit 0), the chain probes
the next candidate and selects the highest-ranked qualifier that is available.
If a higher-ranked backend is present but a probe fails, the failure is recorded
(sanitized) and the chain continues. Visibility transports (tmux/iTerm2) are
layered over whichever runner is selected and never substitute for a runner.

## Configuration flags

The real chain is enabled by explicit `CODEX_TEAM_*` env opt-in; the default
stays `ScaffoldExecutionBackend`. No config file; no silent auto-enable.

- `CODEX_TEAM_EXECUTION` — opt-in enable flag for the capability-ranked chain.
  Unset/`0`/`false`/`off` → default `ScaffoldExecutionBackend` (unsupported).
  `1`/`true`/`enabled` → enable the chain (capability detection then runs).
- `CODEX_TEAM_EXECUTION_BACKEND` — optional explicit selector/override
  (e.g. `auto` for ranked selection, or a specific surface such as
  `codex_cli_exec`); defaults to `auto` when the chain is enabled.

These follow the existing `CODEX_TEAM_PANE_MODE` / `CODEX_TEAM_PANE_BACKEND` /
`CODEX_TEAM_STATE_ROOT` / `CODEX_TEAM_WORKSPACE_ROOT` conventions and are parsed
into `CodexTeamServerOptions` (Phase 9-12), consumed by
`createExecutionBackendFromOptions`.

## OS sandbox (optional best-effort)

OS sandbox / read-only flags are layered ONLY if the chosen backend supports them
(the CLI exec backend does, via `-s, --sandbox` and `codex sandbox`). Per D-06
this is **never a gate** and **never blocking**: a backend without OS sandbox is
still fully eligible and runnable. Worktree isolation — not OS sandbox — is the
required isolation mechanism for file-modifying runs.

## Unsupported-environment remediation

When no backend is available in an environment, the concrete steps are:

1. Enable the opt-in: set `CODEX_TEAM_EXECUTION=1` (the default scaffold is
   intentionally unsupported and will report execution as unavailable).
2. Install/repair a supported surface: ensure `codex` is on `PATH`
   (`codex exec --help` should exit 0) and that `codex exec --json` can emit a
   `thread.started` `thread_id`.
3. Provide a worktree/workspace directory for file-modifying work so the backend
   can run with `--cd`.
4. Optionally set `CODEX_TEAM_EXECUTION_BACKEND` to pin a specific surface.
5. Re-run `TeamDiagnostics` (or the spike runner) to confirm the selected
   backend and observed/missing metadata keys.

OS sandbox availability is NOT part of remediation — its absence never blocks a run.

## Escalation path

When even the lowered gate cannot be met **anywhere** (no surface is both
worktree-runnable and exposes a persistent id), the chain returns an honest
`unavailable` result carrying remediation plus an explicit
**escalate-to-Team-Lead** signal, with the captured spike/diagnostics evidence
and a precise statement of which gate item failed everywhere. It does not spin
indefinitely (D-03). This is the documented **safety net, not the expected
path**: the codex CLI exec/resume backend already qualifies in this environment
(08-01 evidence), so the chain converges on it as rank 1.

## Relationship to Phase 9-12

This decision is the contract Phase 9-12 implement; the RED tests below stay red
until then.

| Phase | Requirements | What this decision provides |
|-------|--------------|------------------------------|
| Phase 9 | EXEC-04, EXEC-05, EXEC-06 | The selected worktree-isolated CLI exec/resume launch + durable-id capture + reconcile strategy. **Worktree is the required isolation mechanism; OS sandbox is optional.** |
| Phase 10 | RESUME-01, RESUME-02, RESUME-03 | Resume via the persisted `thread_id`; honest queued delivery; preserved inbox + sanitized failure metadata. |
| Phase 11 | OBS-01, OBS-02 | True backend state in `TeamDiagnostics`; enriched, sanitized `metadataDiagnostics` (missing source / observed keys / selected backend / remediation). |
| Phase 12 | ISOL-01, ISOL-02 | Worktree isolation delivered this milestone; file-modifying runs blocked without concrete isolation; base revision / changed files / review status / merge guidance under the TL-autonomous-merge model. |

RED tests pinning this contract:

- [`test/backendCapabilityChain.test.ts`](../test/backendCapabilityChain.test.ts) — capability-ranked chain selection (gate = `supportsWorkspaces` + persistent id; sandbox bonus only; no-qualifier remediation/escalate).
- [`test/executionBackendConfig.test.ts`](../test/executionBackendConfig.test.ts) — `CODEX_TEAM_*` env opt-in; default stays scaffold; no silent auto-enable.
- [`test/codexSessionMetadataDiagnostics.test.ts`](../test/codexSessionMetadataDiagnostics.test.ts) — enriched EXEC-03 diagnostics (`missing_metadata_source` / `observed_keys` / `selected_backend` / `remediation`, all sanitized).
