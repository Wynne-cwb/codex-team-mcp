# Pane Bootstrap Notes

Captured: 2026-06-08T05:46:32Z
Workspace: `/Users/wb.chen/Documents/Project/claude-code-sourcemap-main`
Codex CLI: `codex-cli 0.136.0`

These notes record command-level bootstrap evidence only. They do not record
teammate prompts, message bodies, task text, transcript scrollback, or raw
assistant conversation content.

## CLI help constraints

- `codex --help` exits 0 and lists the interactive CLI, `exec`, `resume`,
  `--cd <DIR>`, `--no-alt-screen`, sandbox flags, and approval flags.
- `codex exec --help` exits 0 and lists `--json`, `--cd <DIR>`,
  `--output-last-message <FILE>`, `--ephemeral`, and the nested
  `codex exec resume` command.
- `codex resume --help` exits 0 and documents
  `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`, plus `--last`,
  `--include-non-interactive`, and `--cd <DIR>`.
- `codex exec resume --help` exits 0 and documents
  `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` with `--json`.

The help output does not list hidden TeamMate flags such as `--agent-id` or
`--team-name`.

## codex exec --json probe

Command run:

```bash
codex exec --json "printf codex-team-pane-bootstrap"
```

Result:

- Exit code: 0.
- The sentinel text `codex-team-pane-bootstrap` appeared in the command
  execution event output and the final agent message.
- Stdout was not pure line-delimited JSON because plugin and skill warning
  lines were interleaved with JSON event objects.
- JSON event objects were present, including `thread.started`,
  `turn.started`, command execution start/completion, agent message, and
  `turn.completed`.
- Durable metadata observed: a `thread_id` value was emitted by the
  `thread.started` object.
- No separate `run_id` or `session_id` field was emitted by the JSON probe.
- The probe produced no tracked workspace changes and no destructive side
  effects were observed.

The JSON-mode probe therefore proves a durable Codex thread identifier is
discoverable for a non-interactive start, but consumers must parse mixed stdout
carefully because warning lines can appear beside JSON events.

## codex --cd attach-safe probe

Command shape under test:

```bash
codex --cd <workspace>
```

Attach-safe capture was run with stdin redirected from `/dev/null` and a
two-second guard in this non-interactive executor environment.

Result:

- Exit code: 1.
- Stderr reported that `TERM` was `dumb` and no terminal was available for the
  interactive TUI confirmation prompt.
- No stdout content and no durable `thread_id`, `session_id`, or `run_id`
  metadata were emitted by this attach-safe probe.
- The command shape is valid according to `codex --help`, and it is expected to
  start an interactive Codex process when run inside a supported terminal or
  pane.

This proves the command can be documented as an attach/start shape, but this
non-TTY probe does not prove durable pane-backed start metadata for the
interactive TUI path.

## codex resume metadata contract

Commands reviewed:

```bash
codex resume
codex resume --help
codex exec resume --help
```

Result:

- `codex resume --help` exits 0 and documents that `codex resume` accepts an
  optional `SESSION_ID`; if omitted, `--last` is required to pick the most recent
  recorded session without the picker.
- `codex resume` without a TTY exited 1 in the same attach-safe guard because
  the interactive TUI could not start when `TERM=dumb` and stdin/stderr were not
  TTYs.
- The JSON-mode start probe exposed a `thread_id`.
- A follow-up non-destructive resume probe using
  `codex exec resume --json <thread_id> "printf codex-team-pane-resume"` exited
  0, emitted the same `thread_id`, and produced the sentinel output
  `codex-team-pane-resume`.
- Phase 7 can lawfully resume a TeamMate only when it has a real discovered
  Codex thread/session identifier. It must not invent session metadata.

## Phase 7 execution claim

durable_start_resume_supported

Allowed production behavior:

- Pane mode may attempt start through a real Codex command only when it captures
  durable metadata from `codex exec --json`, specifically the emitted
  `thread_id`.
- Pane mode may report `backend_start_attempted` only after the start command is
  actually attempted and the resulting metadata is sanitized before storage.
- Pane mode may attempt resume through `codex exec resume --json <thread_id>`
  only when the target run already has a discovered thread/session identifier.
- Pane mode may report `backend_resume_attempted` only after that concrete
  resume command is actually attempted.
- Interactive `codex --cd <workspace>` panes are valid for user-visible attach
  or terminal startup when a real pane provides a TTY, but this probe did not
  prove that interactive TUI startup emits durable resume metadata.
- If a future environment cannot provide the JSON `thread_id` or a valid resume
  path, production code must degrade honestly with `backend_unavailable` or
  degraded pane metadata rather than claiming start/resume support.

Pane controls that send user text must call `SendMessage` and must not
shell-send raw messages into panes.

## Unsupported Claims

- `--agent-id`
- `--team-name`
- `exact Claude tmux/iTerm2 parity`
- `full transcript persistence`

Unsupported behavior:

- Do not claim exact Claude tmux/iTerm2 parity.
- Do not persist full pane transcripts in Phase 7.
- Do not expose user-facing force kill or terminate controls as a Phase 7
  compatibility promise.
- Do not shell-send teammate prompts, message bodies, task text, or user
  messages directly into pane processes; route user text through `SendMessage`.
