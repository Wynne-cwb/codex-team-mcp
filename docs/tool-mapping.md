# Claude-to-Codex Tool Mapping

The `codex-team-mcp` package exposes Claude-style Agent Team names directly. Codex may namespace MCP tools in its UI, so use `TeamDiagnostics` to inspect the exact loaded names if inventory display differs.

For behavior-level support labels, see the Phase 7 [Compatibility matrix](compatibility.md). For workflow evidence and commands, see the [Validation artifact](validation.md).

| Claude-style name | Codex MCP-visible name | Current status | Full semantics phase | Notes |
|---|---|---|---|---|
| `TeamCreate` | `TeamCreate` | `implemented` | Phase 2 | Creates durable teams, leader identity, initialized component state, and scoped active bindings in SQLite. |
| `TeamDelete` | `TeamDelete` | `implemented` | Phase 2 | Archives durable teams and invalidates active bindings without hard-deleting state. |
| `Agent` | `Agent` | `implemented` | Phase 5 | Creates addressable TeamMates in durable member/run state, records work classification and isolation/review metadata, then attempts backend-dependent start and resume only when the configured backend supports it. |
| `SendMessage` | `SendMessage` | `implemented` | Phase 5 | Persists explicit inbox rows before returning a result. Running recipients are queued for the next turn boundary; scheduled, idle, or stopped recipients may attempt backend start/resume when durable metadata and backend capabilities allow it. |
| `TaskCreate` | `TaskCreate` | `implemented` | Phase 5 | Creates SQLite team-scoped tasks. Owner assignment can notify assignees through `SendMessage` and inherits the same lifecycle/backend delivery behavior. |
| `TaskUpdate` | `TaskUpdate` | `implemented` | Phase 5 | Updates SQLite team-scoped tasks, including status, owner, metadata, notes/history, `task_edges`, and `task_events`. Assignment notifications use the same lifecycle-aware message path. |
| `TaskList` | `TaskList` | `implemented` | Phase 4 | Lists concise team-scoped task projections with status, owner, and unresolved blockers from SQLite state. |
| `TaskGet` | `TaskGet` | `implemented` | Phase 4 | Reads full team-scoped task detail, metadata, dependencies from `task_edges`, and history from `task_events`. |
| `TeamDiagnostics` | `TeamDiagnostics` | `implemented` | Phase 7 | Diagnostic surface for package version, registered mappings, lifecycle/run summaries, pane attach/status, message delivery counts, task summaries, stale reconciliation, workspace review counts, `pending_review` / `needs_review` state, backend-dependent limitations, and caller fallback behavior. |

`SendMessage` is explicit only: ordinary assistant text is not a teammate message. `to: "*"` returns `broadcast_unsupported_in_v1`; broadcast delivery is deferred beyond Phase 5. Call `TeamDiagnostics` when the visible inventory, tool status, lifecycle status, durable message/task summary, workspace review state, or caller metadata behavior is unclear.

Lifecycle behavior is backend-dependent start and resume. The default backend reports unsupported execution and never fakes success. Running TeamMate messages are queued for the next turn boundary rather than delivered mid-turn. File-modifying TeamMate work must be isolated or reviewable before it can affect the leader workspace; changed or unverifiable isolated work is preserved as workspace review state such as `needs_review`.

Phase 7 pane mode is optional and backend-dependent. `TeamDiagnostics` reports pane attach/status, lifecycle/run summaries, message delivery counts, task summaries, and workspace review state; it does not report raw prompts, raw message bodies, task text, or full transcript content. The pane transcript experience is terminal scrollback.

Any user text to a TeamMate must use `SendMessage`, not direct pane shell input. Pane metadata can help attach to a terminal session, but it is not a teammate message transport and it does not add user-facing force kill or terminate controls.

This compatibility layer is not exact Claude runtime parity and is not exact Claude tmux/iTerm2 pane parity. It intentionally avoids claims of true Claude in-process runtime behavior, guaranteed mid-turn injection, hidden Claude CLI args, exact pane parity, or approval-bridge parity.
