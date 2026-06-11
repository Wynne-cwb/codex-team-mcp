# codex-team-mcp

[![npm package](https://img.shields.io/npm/v/codex-team-mcp.svg)](https://www.npmjs.com/package/codex-team-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](package.json)

Unofficial Claude Agent Team compatibility for Codex, packaged as a stdio MCP server.

`codex-team-mcp` exposes Claude-style team tools — `TeamCreate`, `Agent`, `SendMessage`, team-scoped task tools, `TeamDiagnostics`, and `TeamMerge` — to Codex. It gives Team-oriented skills a durable, auditable coordination layer with a real, opt-in execution backend, without modifying Codex CLI internals.

> [!IMPORTANT]
> This is an external compatibility layer, not exact Claude runtime parity. It provides durable team state, addressable TeamMates, persisted messages, team tasks, lifecycle diagnostics, an opt-in real execution backend (worktree-isolated, read **and** write), durable resume, and optional pane visibility. It does **not** provide true Claude in-process execution, guaranteed mid-turn message injection, approval-bridge parity, or exact Claude tmux/iTerm2 panes.

## What it provides

| Capability | Status |
| --- | --- |
| Durable team creation and active-team binding | Supported |
| Addressable TeamMate identities through named `Agent` calls | Supported |
| Explicit persisted `SendMessage` inbox messages | Supported |
| Team-scoped `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | Supported |
| Restart-safe SQLite runtime state | Supported |
| Per-TeamMate real backend status + sanitized debug diagnostics | Supported |
| Read-only / review-only execution (no file writes) | Supported |
| File-modifying execution in an isolated git worktree | Opt-in, backend-dependent |
| TL-driven auditable worktree merge / escalate (`TeamMerge`) | Backend-dependent |
| Durable resume of idle/stopped TeamMates via `SendMessage` | Backend-dependent |
| Optional tmux/iTerm2-style pane visibility over real runs | Backend-dependent |

> [!NOTE]
> The execution backend is **opt-in and off by default**. Without `CODEX_TEAM_EXECUTION=1` the server still creates teams, TeamMates, messages, tasks, and diagnostics, but TeamMates stay `scheduled` with `backend_unavailable` instead of running. This is intentional — the layer never fabricates run/thread IDs or silently starts processes.

## Quickstart

Add the MCP server to your Codex configuration. To enable real, worktree-isolated execution you need the [Codex CLI](https://github.com/openai/codex) on your `PATH` and `CODEX_TEAM_EXECUTION=1`:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"],
      "env": {
        "CODEX_TEAM_EXECUTION": "1",
        "CODEX_TEAM_EXECUTION_BACKEND": "auto",
        "CODEX_TEAM_PANE_MODE": "1",
        "CODEX_TEAM_PANE_BACKEND": "auto"
      }
    }
  }
}
```

For Codex CLI:

```bash
codex mcp add codex-team \
  --env CODEX_TEAM_EXECUTION=1 \
  --env CODEX_TEAM_EXECUTION_BACKEND=auto \
  --env CODEX_TEAM_PANE_MODE=1 \
  --env CODEX_TEAM_PANE_BACKEND=auto \
  -- npx -y codex-team-mcp@latest
```

Reload or restart Codex MCP servers, then confirm the tool inventory includes:

```text
TeamCreate
TeamDelete
Agent
SendMessage
TaskCreate
TaskUpdate
TaskList
TaskGet
TeamDiagnostics
TeamMerge
```

If anything looks off, call `TeamDiagnostics` first. It reports package version, registered tools, state root, active bindings, per-TeamMate lifecycle status, pane metadata, queued messages, task summaries, and workspace review/merge state.

### Minimal mode

If you only want durable team state, messages, tasks, and diagnostics — without attempting real execution or panes — omit the environment variables:

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

Minimal mode creates teams and TeamMate identities, persists messages, and manages tasks, but TeamMates remain `scheduled` with `backend_unavailable` until an execution backend is enabled.

## Configuration

All configuration is through environment variables.

| Variable | Values | Purpose |
| --- | --- | --- |
| `CODEX_TEAM_EXECUTION` | `1` / `true` / `enabled` | Opt in to the real execution backend. Off by default. |
| `CODEX_TEAM_EXECUTION_BACKEND` | `auto` (default), or a backend name (e.g. `codex_cli_exec`) | Pin a specific backend, or let the capability-ranked chain choose. |
| `CODEX_TEAM_PANE_MODE` | `1` / `true` / `enabled` | Enable tmux/iTerm2-style pane visibility over real runs. |
| `CODEX_TEAM_PANE_BACKEND` | `auto` (default) / `tmux` / `iterm2` | Preferred terminal backend (tmux first, then iTerm2). |
| `CODEX_TEAM_PANE_SESSION_PREFIX` | trusted prefix string | Prefix for generated pane sessions. |
| `CODEX_TEAM_CODEX_COMMAND` | command name (default `codex`) | Command used to invoke Codex for pane-backed runs. |
| `CODEX_TEAM_STATE_ROOT` | path | Override the SQLite state directory. |
| `CODEX_TEAM_WORKSPACE_ROOT` | path | Override the resolved workspace root. |

## Tools

| Tool | Purpose |
| --- | --- |
| `TeamCreate` | Creates a durable team, leader identity, and scoped active binding. |
| `TeamDelete` | Archives a team and invalidates active bindings without hard-deleting state. |
| `Agent` | Creates addressable TeamMates such as `builder@alpha-team`; records lifecycle/isolation metadata and attempts backend-dependent start. |
| `SendMessage` | Persists explicit messages before delivery; resumes idle/stopped TeamMates when durable backend metadata exists. |
| `TaskCreate` | Creates team-scoped tasks in SQLite. |
| `TaskUpdate` | Updates task status, owner, notes, metadata, and blockers. |
| `TaskList` | Lists concise task projections by status or owner. |
| `TaskGet` | Reads full task detail and task history. |
| `TeamDiagnostics` | Reports tool, state, per-TeamMate lifecycle, message, task, pane, and workspace review/merge summaries (with a sanitized `include_debug` view). |
| `TeamMerge` | **codex-team extension** — TL-driven `review` / `merge` / `escalate` of an isolated worktree branch back into the leader tree. |

`TeamCreate`, `TeamDelete`, `Agent`, `SendMessage`, and the four task tools mirror Claude Agent Team tools one-to-one. `TeamDiagnostics` and `TeamMerge` are explicit codex-team extensions, not native Claude tools.

## Real execution backend

The execution backend is opt-in. When `CODEX_TEAM_EXECUTION=1` and the Codex CLI is available, a capability-ranked chain selects the safest runnable backend (the `codex_cli_exec` backend uses `codex exec --json` to start a run and capture a durable `thread_id`, and `codex exec resume` to continue it). A backend qualifies only if it can run in a specified worktree directory and expose a persistent identifier.

When the opt-in is set but no backend qualifies (for example the `codex` CLI is missing from `PATH`), `Agent` still persists the team/member/run records and then returns a clear `execution_backend_unavailable` error with remediation — it never reports a fabricated success.

### Model provider authentication (proxy / custom `env_key`)

The `codex_cli_exec` backend runs `codex exec` as a **subprocess that inherits the MCP server's environment**. With Codex's default OpenAI sign-in, nothing extra is needed. But if your `~/.codex/config.toml` selects a custom or proxy `model_provider` that authenticates through an environment variable (its `env_key`), that variable must also reach the codex-team MCP server — otherwise the nested `codex exec` fails and the TeamMate run shows `backend_failed` with the real reason `Missing environment variable: <KEY>` (surfaced in `TeamDiagnostics` `last_error`).

```toml
# Top-level: a custom/proxy provider authenticated via an env var
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://your-proxy.example.com/v1"
env_key = "AM_API_KEY"             # ← Codex reads auth from this env var

# The execution backend spawns `codex exec`, which needs the SAME auth var:
[mcp_servers.codex-team]
command = "npx"
args = ["-y", "codex-team-mcp@latest"]
env_vars = ["AM_API_KEY"]          # forward it from Codex's own env (recommended — no secret in the file)

[mcp_servers.codex-team.env]
CODEX_TEAM_EXECUTION = "1"
CODEX_TEAM_EXECUTION_BACKEND = "auto"
```

> [!IMPORTANT]
> `env_vars` forwards the value from Codex's own environment, so no secret is written into the config file. Codex does **not** expand `${VAR}` inside `config.toml`. If the variable name matches Codex's default secret-exclusion patterns (names containing `KEY`, `TOKEN`, `SECRET`, …) it can be filtered out even when listed in `env_vars`; if `TeamDiagnostics` still reports the variable missing after restarting Codex, either set `shell_environment_policy.ignore_default_excludes = true`, or set the value literally under `[mcp_servers.codex-team.env]` (e.g. `AM_API_KEY = "<value>"`).

### Worktree-isolated file-modifying work

File-modifying TeamMate work is delivered in this version, but only through an **isolated git worktree** on an independent branch:

- Every file-modifying run must run in a required, isolated worktree (recorded base revision); read-only and review-only work needs no isolation.
- A file-modifying run with no concrete isolated worktree is **blocked** and never redirected to the leader tree (`ISOL-01`, fail-closed).
- An OS sandbox, when the backend supports it, is recorded as an optional `sandbox_overlay` on top of the worktree — best-effort and non-gating; its absence never blocks a run.

> [!NOTE]
> Worktree isolation uses real `git worktree`, so the leader workspace **must be a Git repository**. If it is not, an isolated worktree cannot be created and file-modifying runs are blocked (fail-closed) — read-only/review-only work is unaffected. Run codex-team from inside a Git repo (`git init` an empty one if you are just trying it out).

### TL-reviewed merge with `TeamMerge`

When a TeamMate finishes work on its isolated branch, the Team Lead brings it back with `TeamMerge`:

```js
TeamMerge({ "action": "review", "run_id": "<run>" })   // branch, base, changed files, diff summary, conflict preview
TeamMerge({ "action": "merge",  "run_id": "<run>" })   // auditable merge into the leader tree, then worktree cleanup
TeamMerge({ "action": "escalate", "run_id": "<run>" }) // hand an unresolved conflict to a human
```

> [!IMPORTANT]
> `TeamMerge` is an explicit, auditable TL action — never a silent background auto-merge. On a merge conflict the leader tree is rolled back clean and the worktree is preserved for review; unresolved conflicts can be escalated to a human. Reconciliation never auto-merges, and auto-deleting workspaces or dropping queued messages remains prohibited.

## Example workflow

Create a team and an addressable TeamMate:

```js
TeamCreate({ "team_name": "Alpha Team", "description": "Compatibility validation" })

Agent({
  "name": "Builder",
  "mode": "write",
  "prompt": "Add a health-check endpoint and a unit test."
})
```

With execution enabled, the run starts in an isolated worktree, captures durable metadata, and finishes idle. Send it a follow-up — an idle TeamMate with durable metadata is resumed automatically:

```js
SendMessage({
  "to": "Builder",
  "summary": "Follow-up",
  "message": "Also cover the error path in the test."
})
```

Then review and merge the branch back:

```js
TeamMerge({ "action": "review", "run_id": "<run>" })
TeamMerge({ "action": "merge",  "run_id": "<run>" })
```

> [!NOTE]
> Ordinary chat text is not a teammate inbox message. Use `SendMessage` whenever user text should be delivered to a TeamMate.

## Diagnostics and resume

- **Per-TeamMate status:** default `TeamDiagnostics` adds a `teammates[]` row per TeamMate with its real, durable status (`unavailable` / `starting` / `running` / `idle` / `stopped` / `failed` / `stale`) plus `attached` / `needs_review` flags. Rows carry only name + status + flags.
- **Enriched debug:** `TeamDiagnostics({ include_debug: true })` adds sanitized backend capability, durable metadata, the full attach command, and — when a run hit `codex_session_metadata_unavailable` — a `metadataDiagnostics` block (missing source, observed keys, selected backend, remediation). Debug detail is sanitized to key names, enum values, and constant remediation; it never includes raw prompt/output/metadata values.
- **Durable resume:** `SendMessage` to an idle or stopped TeamMate with durable resume metadata triggers an automatic resume (debounced to one attempt per burst). Running recipients are queued for the next turn boundary. A failed resume keeps the inbox message queued and sends the sender a sanitized failure notice — there is no guaranteed mid-turn injection.

## Pane mode

Pane mode adds an optional, backend-dependent visibility layer over real runs. When enabled and a supported terminal backend is available, an `Agent`-started run automatically creates or attaches a visible tmux/iTerm2-style pane and persists its attach metadata. The pane is a visibility approximation — Codex does not run *inside* the pane, and the overlay never changes the run's status, backend, or thread id. If panes are unavailable, the run degrades to an `unavailable` pane marker and core team behavior is untouched.

By default, diagnostics show only an attach hint and session label; the full, copy-pasteable attach command appears under `include_debug`. Idle/stopped panes stay open so scrollback is preserved. Each pane tails the TeamMate's live run log (`tail -f` of the codex exec log), and in iTerm2 the leader stays on the left while TeamMates stack vertically on the right.

### Pane cleanup (teardown)

Panes are closed on two explicit triggers, both best-effort and non-gating (a failed close never fails the originating call): `TeamDelete` closes every pane belonging to that team, and sending a structured `{ "type": "shutdown_request" }` message to a TeamMate (via `SendMessage`) closes that TeamMate's pane. The shutdown message is still persisted/queued as usual — closing the pane is an additional side effect and does not change member status or resume semantics. Closed panes are marked `unavailable` (`degradation_reason: "pane_closed"`) in run metadata.

### iTerm2 pane setup (when running Codex CLI)

The iTerm2 backend detects its terminal context from `TERM_PROGRAM` / `ITERM_SESSION_ID` and stacks TeamMate panes off the leader session. Codex does **not** forward these variables to the MCP server by default, so add them to `env_vars` for the codex-team server in `~/.codex/config.toml` (and `TMUX` / `TMUX_PANE` so the tmux backend can detect a native session too):

```toml
[mcp_servers.codex-team]
env_vars = ["AM_API_KEY", "TERM_PROGRAM", "ITERM_SESSION_ID", "TMUX", "TMUX_PANE"]
```

Without `TERM_PROGRAM` / `ITERM_SESSION_ID`, the iTerm2 backend reports unavailable and pane mode falls back to a detached tmux session (attach-only).

## Runtime state and safety

Runtime state is stored in SQLite outside the conversation transcript. By default the server resolves state under the workspace root at:

```text
.codex-team/state/codex-team.sqlite
```

Override the locations with `CODEX_TEAM_STATE_ROOT` and `CODEX_TEAM_WORKSPACE_ROOT`.

Workspace inspection uses real `git status`/`diff` and fails closed: changed or unverifiable worktrees are marked `needs_review` rather than auto-merged or deleted. Treat `pending_review`, `needs_review`, and `merge_conflict` as review gates, not accepted changes in the Team Lead workspace.

## Local development

```bash
npm install
npm run build
npm test -- --run
npm run smoke:list-tools
npm run pack:dry-run
```

The smoke test starts the built stdio MCP server and verifies all ten compatibility tools are visible.

## Documentation

- [Startup and troubleshooting](docs/startup.md)
- [Claude-to-Codex tool mapping](docs/tool-mapping.md)
- [Compatibility matrix](docs/compatibility.md)
- [Validation evidence](docs/validation.md)
- [Agent Team compatibility skill](skills/agent-team-compatibility/SKILL.md)
