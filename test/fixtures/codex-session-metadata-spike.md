# Codex Session Metadata Spike

Captured: 2026-06-09T13:13:48Z
Workspace: `/Users/wb.chen/Documents/Project/claude-code-sourcemap-main`
Codex CLI: `codex-cli 0.138.0` (captured via `codex --version`)
Spike runner: `codex-team/scripts/spike-session-metadata.mjs`
Sentinel payloads only: `printf codex-session-metadata-spike-<surface>`

These notes record command-level, sanitized spike evidence only. They do not
record teammate prompts, message bodies, task text, transcript scrollback, or
raw assistant conversation content. Discovered identifiers are recorded by KEY
NAME and FORMAT only; raw id values are redacted (`uuid (redacted)`). `SECRET_*`
tokens and control characters are stripped before anything is recorded (D-05).

The lowered qualifying gate (D-02 / D-03, worktree-revised) is:

```text
(1) worktree-runnable  -> can run in a caller-specified worktree/workspace dir
                          (maps to ExecutionBackend.capabilities.supportsWorkspaces === true)
(2) persistent ID      -> exposes a durable identifier usable to resume the run
```

OS sandbox / read-only flag support is EXCLUDED from the gate and recorded
separately as an optional bonus (D-06). A surface lacking OS sandbox still
qualifies.

## codex CLI exec / exec resume

- availability: **available** (`codex exec --help` exit 0; `codex exec resume --help` exit 0).
- observed durable-id keys: `thread_id` (emitted by the `thread.started` JSON event).
- missing fields: no separate `run_id` / `session_id` key in `--json` mode (the
  `thread_id` is the durable, resumable identifier).
- worktree-runnable evidence: `codex exec` advertises `-C, --cd <DIR>` — runs in
  a caller-specified directory. Gate (1) = **yes**.
- persistent-id evidence: a live, bounded, EXPLICITLY read-only `codex exec
  -s read-only --json --skip-git-repo-check "printf codex-session-metadata-spike-cli"`
  turn emitted a `thread.started` `thread_id` (`uuid (redacted)`); a follow-up
  `codex exec resume -c sandbox_mode="read-only" --json <thread_id> "printf
  codex-session-metadata-spike-cli-resume"` re-emitted the SAME `thread_id`
  (`codex exec resume` has no `-s/--sandbox` flag, so the equivalent
  `sandbox_mode="read-only"` config override enforces read-only there). Read-only
  is flag/config-enforced for defense-in-depth (D-05), not left to the config
  default. Gate (2) = **yes**.
- OS sandbox bonus: `codex exec` advertises `-s, --sandbox <SANDBOX_MODE>` and a
  top-level `codex sandbox` (seatbelt) subcommand exists — bonus = yes (NOT a gate).
- verdict: **qualifies: yes** (anchor / rank 1).

## MCP (mcp-server)

- availability: **available** (`codex mcp --help` exit 0; `codex mcp-server --help` exit 0).
- observed durable-id keys: none on the help surface.
- missing fields: no per-session workspace/cwd argument and no resumable
  conversation/thread id is advertised by `--help`. `codex mcp` manages external
  MCP servers (list/get/add/remove/login/logout); `codex mcp-server` starts Codex
  over stdio. Not probed with a write turn and no server was left running.
- worktree-runnable evidence: no documented per-session workspace arg → unknown.
- persistent-id evidence: not confirmed without a live MCP conversation → unknown.
- OS sandbox bonus: a generic `-c` config override can set sandbox; recorded as bonus.
- verdict: **qualifies: no** (worktree-runnable + persistent-id unconfirmed; would rank below CLI even if confirmed).

## app-server / remote-control

- availability: **available** (`codex app-server --help` exit 0; `codex remote-control --help` exit 0).
- observed durable-id keys: none on the help surface.
- missing fields: durable session ids + per-session workspace are not confirmable
  without starting a daemon. Both subcommands are marked `[experimental]`. The
  daemon was deliberately left unstarted (bounded, no-daemon probe).
- worktree-runnable evidence: not documented at the top help level → unknown.
- persistent-id evidence: not confirmed without a running daemon → unknown.
- OS sandbox bonus: unknown.
- verdict: **qualifies: no** (experimental; stability risk; ranks below CLI).

## SDK

- availability: **not_available** (no `@openai/codex-sdk` / `@openai/codex` in `node_modules`).
- observed durable-id keys: n/a.
- missing fields: no SDK package present; surface not exercised and no runtime
  dependency was added in Phase 8.
- worktree-runnable evidence: n/a.
- persistent-id evidence: n/a.
- OS sandbox bonus: n/a.
- verdict: **qualifies: no**. Recording `not_available` honestly is NOT a gate
  failure for the chain.

## tmux

- availability: **available** (`tmux -V` exit 0 → tmux 3.6a; not currently inside a tmux session).
- observed durable-id keys: `pane_id`, `session_name`, `socket_name` — terminal
  identifiers only, NOT a durable Codex session id.
- missing fields: no durable Codex `thread_id`/`session_id`/`run_id` is provided
  by tmux itself.
- worktree-runnable evidence: yes (cwd via `new-session` / `split-window`).
- persistent-id evidence: **no** durable Codex id from tmux alone.
- OS sandbox bonus: n/a (tmux is not an OS sandbox).
- verdict: **qualifies: no** — visibility/attach **transport** only; composes
  over a real Codex runner (e.g. codex exec). Not a standalone qualifying backend.

## iTerm2

- availability: **available** (`it2 --version` exit 0 → it2 0.2.3; `TERM_PROGRAM=iTerm.app`).
- observed durable-id keys: `pane_id`, `session_name` — terminal identifiers only.
- missing fields: no durable Codex session id from iTerm2 itself; macOS-only.
- worktree-runnable evidence: yes (cwd via split-pane).
- persistent-id evidence: **no** durable Codex id from iTerm2 alone.
- OS sandbox bonus: n/a.
- verdict: **qualifies: no** — visibility/attach **transport** only; composes
  over a real Codex runner. Not a standalone qualifying backend.

## Lowered gate verdicts

| surface | worktree_runnable | persistent_id | qualifies |
|---------|-------------------|---------------|-----------|
| codex_cli_exec | yes | yes | yes |
| mcp | unknown | unknown | no |
| app_server | unknown | unknown | no |
| sdk | n/a | n/a | no |
| tmux | yes | no | no |
| iterm2 | yes | no | no |

`qualifies` is computed ONLY from the two lowered-gate items
(`worktree_runnable === yes && persistent_id === yes`). OS sandbox support never
contributes to this column.

## OS sandbox (optional bonus)

- `codex exec` supports `-s, --sandbox <SANDBOX_MODE>` and there is a top-level
  `codex sandbox` (seatbelt) subcommand — the CLI exec surface supports the
  optional OS sandbox.
- `codex mcp-server` can set sandbox via a generic `-c` config override.
- tmux / iTerm2 / SDK: not applicable.
- **This is NOT a gate.** Per D-06, OS sandbox / read-only flags are an optional,
  best-effort, ranking-bonus layer only. A surface that lacks OS sandbox still
  qualifies, and OS sandbox never blocks a run.

## Convergence outcome

- `converged_backend`: **codex_cli_exec** (rank 1).
- `escalate_to_team_lead`: **false**.
- Why it ranks first: it is the only surface that meets BOTH lowered-gate items
  with live evidence — worktree-runnable (`--cd`) and a persistent, resumable
  `thread_id` re-emitted by `codex exec resume --json`. It also carries the OS
  sandbox bonus (`--sandbox` / `codex sandbox`), but that bonus did not affect the
  qualify verdict. MCP / app-server are candidate qualifiers pending a deeper
  live probe and would rank below CLI; SDK is `not_available`; tmux / iTerm2 are
  visibility transports, not standalone runners.
- The escalate-to-Team-Lead path was NOT taken: at least one surface qualified.

## Unsupported Claims

- `--agent-id`
- `--team-name`
- `do not invent session metadata`

Unsupported / honesty rules:

- The CLI help output does not list hidden TeamMate flags such as `--agent-id`
  or `--team-name`; Phase 8 does not claim they exist.
- Resume is lawful only with a real discovered `thread_id` / session id —
  **do not invent session metadata**. If a surface yields none, it is recorded
  honestly as not-qualifying rather than fabricated.
- Phase 8 implements no real execution backend; this fixture is spike evidence
  only. The capability-ranked chain, env opt-in, and enriched diagnostics are
  pinned by RED tests for Phase 9-12.
- No exact Claude tmux/iTerm2 parity is claimed.
