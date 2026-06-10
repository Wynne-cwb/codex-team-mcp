# Codex MCP Startup

## MCP Server Configuration

Use the published package through `npx`:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"]
    }
  }
}
```

For local development, build the package first:

```bash
npm install
npm run build
```

Then configure Codex with an absolute path to the built stdio entrypoint:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-team-mcp/dist/index.js"
      ]
    }
  }
}
```

After build, the package bin points at the same local entrypoint:

```text
dist/index.js
```

## Optional Pane Mode

Pane mode is an optional, backend-dependent pane-style approximation. It does not change `TeamCreate`, `Agent`, `SendMessage`, task, lifecycle, or workspace safety semantics, and it is not exact Claude tmux/iTerm2 pane parity.

Enable pane mode through MCP server environment variables:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": [
        "-y",
        "codex-team-mcp@latest"
      ],
      "env": {
        "CODEX_TEAM_PANE_MODE": "1",
        "CODEX_TEAM_PANE_BACKEND": "auto",
        "CODEX_TEAM_PANE_SESSION_PREFIX": "codex-team",
        "CODEX_TEAM_CODEX_COMMAND": "codex"
      }
    }
  }
}
```

Supported pane configuration values:

```text
CODEX_TEAM_PANE_MODE=1
CODEX_TEAM_PANE_BACKEND=auto|tmux|iterm2
CODEX_TEAM_PANE_SESSION_PREFIX=<prefix>
CODEX_TEAM_CODEX_COMMAND=<path-or-command>
```

| Variable | Values | Purpose |
|---|---|---|
| `CODEX_TEAM_PANE_MODE` | `1` | Enables pane mode. Use `CODEX_TEAM_PANE_MODE=1` when you want pane attach/status metadata. |
| `CODEX_TEAM_PANE_BACKEND` | `auto`, `tmux`, `iterm2` | Selects the terminal backend. `auto` tries tmux first, then iTerm2 when available. |
| `CODEX_TEAM_PANE_SESSION_PREFIX` | `<prefix>` | Prefix for generated external tmux sessions. Treat this as a trusted config value, not user text. |
| `CODEX_TEAM_CODEX_COMMAND` | `<path-or-command>` | Command used to start or resume Codex in pane-backed runs. |

When tmux is available, pane mode prefers tmux first. If the leader is outside tmux, Codex Team can create an external tmux session and report an attach command through `TeamDiagnostics`. The attach command shape is:

```bash
tmux -L <socket> attach-session -t <session>
```

The placeholders are reported metadata; do not build attach commands from untrusted teammate names or message text. The pane transcript experience is terminal scrollback. Codex Team does not persist full pane transcripts, raw prompts, raw message bodies, or task text in diagnostics or planning summaries. By default `TeamDiagnostics` shows only an `attach_hint` plus session/backend labels; the full, copy-pasteable attach command is exposed only under `include_debug`.

If tmux/iTerm2 or durable Codex start/resume metadata is unavailable, core Agent Team tools continue to work through the standard event-driven lifecycle. `TeamDiagnostics` reports the pane degradation reason. Lifecycle actions return `backend_unavailable` or degraded pane metadata instead of pretending a pane-backed TeamMate started.

### Automatic pane visibility over real runs (Phase 11)

When pane mode is enabled **and** a supported terminal backend is available, a real `Agent`-started run (see the execution backend below) automatically creates/attaches a visible pane and persists its attach metadata — backend type, pane/session/window/socket ids, attach command, and availability status — into the run's durable backend metadata for later diagnostics and resume. No extra start/attach step is needed (D-01).

The pane is an **optional visibility layer over the real run, not exact parity** (Codex is not run inside the pane). It is best-effort and purely additive: it never changes the run's `status` / `backend_status` / `thread_id`. If the terminal backend is unavailable or pane creation fails, the run degrades to an `unavailable`/`degraded` pane marker only — durable team/member/run/message/task/event state is untouched and core team tools keep working (PANE-02).

When a run goes idle or stopped, its pane is **kept open** so scrollback stays available; you close it manually (D-04). Panes/sessions therefore accumulate over time — an intentional tradeoff favoring scrollback over automatic cleanup — and there is no user-facing force-kill/terminate control. Pane-backed file-modifying work still goes through the same worktree-isolation / review gate; the pane does not bypass it.

`TeamDiagnostics` then reports each TeamMate's real, durable backend status through the default `teammates[]` array (`unavailable`/`starting`/`running`/`idle`/`stopped`/`failed`/`stale` plus `attached`/`needs_review` flags). `attached` is true once a run has an available pane persisted.

See [validation.md](validation.md) for the validation evidence and known limits.

## Optional Execution Backend (opt-in)

A real, worktree-isolated `codex_cli_exec` execution backend is available behind an
explicit environment opt-in. It is **never silently auto-enabled**: with no opt-in
the default stays the unsupported `ScaffoldExecutionBackend`.

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"],
      "env": {
        "CODEX_TEAM_EXECUTION": "1",
        "CODEX_TEAM_EXECUTION_BACKEND": "auto"
      }
    }
  }
}
```

| Variable | Values | Purpose |
|---|---|---|
| `CODEX_TEAM_EXECUTION` | `1` / `true` / `enabled` | Enables the capability-ranked execution chain. Unset/`0`/`false`/`off` keeps the unsupported scaffold. |
| `CODEX_TEAM_EXECUTION_BACKEND` | `auto`, `codex_cli_exec` | Optional selector/override; defaults to `auto` (ranked selection) when the chain is enabled. |

Behavior when enabled:

- A capability-ranked chain probes candidate backends and selects the highest-ranked
  qualifier (a qualifier must be worktree-runnable and expose a persistent resume id).
  OS sandbox support is a ranking bonus only, never an eligibility gate. The rank-1
  surface is the codex CLI exec/resume backend (`codex exec --json` / `codex exec resume --json`).
- `Agent` with a prompt runs an **immediate one-shot turn** (D-06). File-modifying work
  runs inside an **isolated git worktree** on an independent branch (recorded base
  revision); the **worktree is the required isolation mechanism** and writes never touch
  the leader working tree. If an isolated worktree cannot be created, the run is **blocked**
  (`workspace_isolation_required`), never redirected to the leader tree. OS sandbox
  (`-s read-only` / `-s workspace-write`) is layered best-effort only.
- On completion the TeamMate appends a sanitized `teammate_run_completed` event, **notifies
  the team-lead** via the standard message path (which simply queues — no resume loop),
  and lands in **`idle`** (resumable). Output is **not stored** (lifecycle-only): only
  exit/status, timestamps, durable ids, and sanitized error classes are persisted.
- If the opted-in backend is unavailable on this machine, `Agent` still persists the
  team/member/run records and returns an explicit, actionable `execution_backend_unavailable`
  error with remediation — it never fakes a backend run or fabricates ids.

`SendMessage`-triggered resume (Phase 10) and enriched, per-TeamMate execution
diagnostics with automatic pane visibility (Phase 11) are now delivered. This is not
exact Claude in-process runtime parity.

### File-modifying worktree merge flow (Phase 12, D-04)

File-modifying TeamMate work is delivered in this version, isolated in a git worktree.
After the TeamMate finishes, the **TL Agent reviews the branch diff and merges it back
into the leader working tree** through the `TeamMerge` tool (`action: review`/`merge`/
`escalate`):

- `review` returns the branch, base revision, changed file names, a diff summary, and a
  conflict preview — never diff content.
- `merge` performs an auditable `--no-ff` merge; on success it cleans up the now-merged
  worktree (O-2, only when clean). On a conflict it **fails closed** (rolls the leader
  back clean with `git merge --abort`) and **preserves the worktree** for resolution.
- `escalate` hands an unresolved conflict to a human, preserving the worktree with no
  destructive action.

This is **TL autonomous merge + human fallback** and intentionally overrides Phase 5
D-15's no-auto-merge part, but it is an explicit, auditable TL action — **never a silent
background auto-merge**. Auto-deleting workspaces, dropping queued messages, and
reconciliation-driven auto-merge all remain prohibited.

**Maintainer real UAT (D-02):** milestone acceptance requires running one full
file-modifying worktree path on the maintainer machine with real `codex` + real git
(write files in the worktree, then have the TL really merge back into the leader,
including a conflict and a human escalation). See [validation.md](validation.md). The
automated walkthrough does not replace this real run.

## Troubleshooting

1. For local development, run `npm install && npm run build` from the package directory.
2. Confirm `dist/index.js` exists.
3. Reload or restart Codex MCP servers after changing config.
4. Inspect the live tool inventory and confirm the eight compatibility tools plus `TeamDiagnostics` are visible.
5. Call `TeamDiagnostics` to inspect package version, registered mappings, durable state summaries, lifecycle/run status, pane attach/status, workspace review state, reconciliation summaries, and caller metadata fallback behavior.

## Runtime State

Durable teams, active bindings, TeamMate lifecycle/run rows, persisted messages, and team-scoped tasks are implemented through SQLite runtime state. `SendMessage` stores explicit inbox rows before returning delivery outcomes, and task tools read and write team-scoped task rows, `task_edges`, and `task_events`.

Phase 5 supports backend-dependent start and resume through an execution backend contract. The default backend reports unsupported execution; it does not fabricate TeamMate runs, backend IDs, thread IDs, process IDs, or workspace paths. Running TeamMate messages are queued for the next turn boundary, not injected mid-turn.

Workspace safety is explicit: file-modifying TeamMate work requires an isolated workspace or reviewable diff artifact before backend start. Reconciliation and `TeamDiagnostics` surface workspace review state, including `needs_review`, without deleting workspaces, merging diffs, or dropping queued messages.

Optional pane mode adds backend-dependent terminal panes and attach/status metadata. It is a pane-style approximation backed by terminal scrollback and `TeamDiagnostics`, not exact Claude tmux/iTerm2 pane parity. When enabled with a supported backend, a real `Agent`-started run automatically creates/attaches a visible pane over the real run and persists its attach metadata; the overlay is best-effort and additive (it never alters the run's status/backend/thread id), degrades to an `unavailable`/`degraded` marker when the backend is missing or fails, and keeps idle/stopped panes open (D-04). `TeamDiagnostics` reports each TeamMate's real backend status in a `teammates[]` array. Any user text to a TeamMate must still use `SendMessage`; direct pane shell input is not the Agent Team message path.

This is not exact Claude runtime parity. Codex external emulation cannot promise true Claude in-process runtime behavior, guaranteed mid-turn message injection, exact pane parity, or approval-bridge parity. Broadcast delivery, cross-session bridge delivery, full transcript persistence, browser dashboard UI, and user-facing force kill or terminate controls remain outside Phase 7 support.

## Compatibility And Validation

Read the Phase 7 [Compatibility matrix](compatibility.md) for behavior-level support labels and [Validation artifact](validation.md) for the synthetic workflow, pane commands, coverage, manual checks, and known limits.
