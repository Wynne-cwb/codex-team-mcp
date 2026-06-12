---
name: codex-team-best-practices
description: >-
  Best-practices guide for working inside a codex-team MCP team — for both the
  Team Lead and TeamMates. Use whenever acting as a Team Lead or a TeamMate, or
  whenever the codex-team tools (TeamCreate, TeamDelete, Agent, SendMessage,
  CheckInbox, TeamDiagnostics, TeamMerge, TaskCreate/TaskUpdate/TaskList/TaskGet)
  are available, to use them well: turn-boundary pull-not-push delivery, when to
  check the inbox, isolated-worktree review-before-merge, and coordinating
  without busy-polling or message ping-pong. Also use when a workflow or user
  request refers to Claude Agent Team vocabulary (Team Lead, TeamMate,
  TeamCreate, Agent, SendMessage) in Codex. Task-agnostic — it guides HOW to use
  the team layer, never WHAT to build.
---

# codex-team best practices

This skill teaches how to use the codex-team MCP layer well, for **both** roles —
the Team Lead (TL) and TeamMates. It is task-agnostic: it never tells you what to
build, only how the team layer behaves and how to coordinate without waste.

If a tool string and this skill ever disagree, the **tool description wins** — it
is the channel that actually reaches the model. This skill explains the *why*
behind those descriptions; the canonical mechanics live in
`CANONICAL-PULL-MODEL.md` (single source of truth).

---

## §1 Mental model (read this first — most misunderstood)

Four truths govern everything else. Internalize them and most "it's broken"
panics disappear.

- **Turn-boundary, not sync.** A `SendMessage` is *persisted* immediately to the
  shared SQLite `messages` table, but it is *delivered* only at a turn boundary —
  when the recipient is idle/stopped between turns, never injected mid-turn. A
  running recipient's message is `queued_for_next_turn`; an idle/stopped one is
  `queued_while_idle`. Neither status is an error. **Why:** you cannot interrupt a
  model mid-thought; the only safe seam to hand it new input is between turns.

- **Pull, not push.** The message *body* is never pushed into a model's context.
  Recipients pull full bodies over the reliable MCP/JSON channel via `CheckInbox`.
  The only thing that ever travels toward a live runtime is a SHORT, length-bounded
  nudge (count + sender ids), never the body. **Why:** pushing bodies bloats every
  turn and a long body typed into a pane loses bytes; a short nudge + a reliable
  pull is correct and cheap.

- **The Team Lead has no pane.** The TL is the interactive human-facing session; it
  is not pane-hosted, has no live TUI to inject into, and carries no injected
  preamble. The TL therefore *pulls*: teammate→TL messages are auto-surfaced onto
  codex-team tool results (plus an `inbox_pending` counter on every tool result, and
  an optional `UserPromptSubmit` hook nudge), and the TL re-reads them with
  `CheckInbox`. See §5.

- **A teammate has a pane + an isolated worktree + the shared DB.** A pane-hosted
  teammate that is idle/stopped between turns can be *woken* by injecting one short
  📬 nudge line into its live codex TUI; it then *pulls* the bodies with `CheckInbox`.
  Its file edits land in an isolated worktree, not the leader tree (see §6). All
  members read/write the SAME SQLite state, which is what survives compaction.

**Ceiling (state honestly).** This is still PULL. Surfacing to the TL is bound to
model-driven actions (a user prompt, or any codex-team tool call). There is NO
"message arrives → idle interactive TL wakes immediately" push — that was
investigated and rejected (no MCP server-wake; app-server `turn/start` would re-host
the TL and interrupt a mid-typing human). Resume/inject outcomes are **attempted**,
never a guarantee of mid-turn injection.

---

## §2 Status / signal decoder (normal vs real problem)

Read a status before reacting. These are NORMAL and need no action:

| Signal | Meaning | Action |
|---|---|---|
| `queued_for_next_turn` | recipient is running; will be delivered at its next turn boundary | none — wait |
| `queued_while_idle` | recipient is idle/stopped; queued for when it next runs | none — it will be nudged |
| `pending_review` / `needs_review` | teammate file work is isolated, awaiting your review/merge | review then `TeamMerge` (§6) |
| `inbox_pending: N` (N>0) | you have N unread messages | `CheckInbox` (§5 / §9) |
| 📬 nudge line | mail exists | `CheckInbox` — the nudge is a doorbell, not the body |
| `delivered` (drain) | the recipient's pane was nudged | not "read" — the body is read only on pull |

These signal a REAL problem worth investigating (see `references/troubleshooting.md`):

| Signal | Meaning |
|---|---|
| `backend_unavailable` / unsupported execution | no real runner configured — work did NOT execute; do NOT treat as success |
| `cross_team_recipient` (rejected) | you addressed a member outside your team — fix the recipient |
| `resume_failure_notice` | a wake attempt failed; the message is never dropped, a later drain retries |
| `changed_files` empty/stale | captured at teardown; an in-flight run may not have it yet |
| tools missing entirely | the codex-team layer is not loaded — see `references/troubleshooting.md` |

---

## Vocabulary mapping (Claude Agent Team → codex-team)

If an instruction or user request uses Claude Agent Team vocabulary, map it onto
the codex-team MCP tools. Do not silently substitute generic subagents for the
team tools:

| Claude vocabulary | codex-team |
|---|---|
| Team Lead | the interactive session that calls `TeamCreate` and owns the team |
| TeamMate | a named `Agent` member created with team context (addressable) |
| `TeamCreate` | `TeamCreate` (durable team + leader identity, scoped active binding) |
| `Agent` (named, in a team) | creates a durable addressable TeamMate |
| `Agent` (no name) | stays an ordinary subagent path — NOT a team member |
| `SendMessage` | persisted teammate message (NOT ordinary assistant text) |
| Task tools | team-scoped `TaskCreate/Update/List/Get` over SQLite |

`TeamMerge`, `CheckInbox`, and `TeamDiagnostics` are codex-team extensions (no native
Claude equivalent). If the tools are absent entirely, report it and follow the repair
path in `references/troubleshooting.md` — never fake a team with plain subagents.

---

## Team Lead (§3–§7)

### §3 When to use a team (default: DON'T over-engineer)

Default question: **"is a plain subagent enough? If yes, DON'T use codex-team."**
A one-shot, fire-and-forget task that returns a result and is done does not need a
team — a subagent is cheaper and simpler.

Reach for codex-team only when you need ANY of these **5 anchors**:

1. **Persistent addressable** — the worker must survive compaction and stay
   addressable by a stable id across turns/sessions.
2. **Bidirectional / ongoing coordination** — you will send follow-ups and receive
   replies over time, not just collect one result.
3. **Peer↔peer messaging** — workers need to talk to each other, not only to you.
4. **Isolated worktree + merge-review gate** — file-modifying work must be reviewed
   before it touches the leader tree (§6).
5. **Visible lifecycle** — you want resume/stop/pane visibility into the worker.

**User-request override:** if the user explicitly asks for a team / teammates, just
use codex-team. Explicit intent overrides the don't-over-engineer default — do not
argue them out of it.

### §4 Creating teammates (self-contained prompts)

A teammate does **not** inherit your context, your conversation, or your open files.
It starts fresh. Therefore every `Agent` prompt must be **self-contained**:

- State the goal, the relevant paths, and the acceptance criteria explicitly.
- Include any decision/constraint the teammate needs — it cannot see your chat.
- Name the deliverable and how to report it (via `SendMessage` back to you — §8).
- Give it a `name` so it is addressable; an unnamed `Agent` is just a subagent.

A vague prompt produces a teammate that guesses. Spend the tokens up front.

### §5 Coordinating without waste (the pull discipline)

You (the TL) have **no pane** and no injected preamble, so you *pull*. The layer
makes this nearly free — you do not need to busy-poll:

- **`inbox_pending: N`** rides on EVERY codex-team tool result (computed after any
  auto-surface in that same call). N>0 means you have unread mail.
- **Auto-surface:** when you call any codex-team tool, unread teammate→TL messages
  are claimed and appended as an `inbox` block on the result — full bodies for a
  small batch, a compact digest (sender + summary + preview + `message_id`) for a
  large one. For a digest, pull full bodies with `CheckInbox(include_read)`.
- **Optional `UserPromptSubmit` hook:** if installed (see `hooks/README.md`), a
  short `📬 You have N new teammate message(s)` line is injected on the same turn you
  submit a prompt, so you handle mail while responding.

**Do not speculatively poll `CheckInbox`.** You are nudged when mail arrives
(`inbox_pending` on every tool result; the 📬 line each turn you prompt). Call
`CheckInbox` only when `inbox_pending > 0`, when you see a 📬 nudge, or at a natural
checkpoint — never on a loop. Polling burns turns for nothing.

See `references/delivery-model.md` for the full pull-path narrative (it tracks the
implemented mechanism; pull details track `CANONICAL-PULL-MODEL.md`).

### §6 Isolation & the merge gate

File-modifying teammate work runs in an **isolated git worktree** (or a reviewable
diff), NOT in your leader tree. It does not affect your working tree until you review
and merge it. Treat `pending_review` / `needs_review` as **gates, not done**:

1. The teammate finishes; its run is marked review-pending with `changed_files`.
2. You inspect the diff (`TeamMerge` action `review`, or read the worktree).
3. You merge with `TeamMerge` (action `merge`) — auditable and explicit, never a
   silent background auto-merge. On conflict the leader is rolled back clean and the
   worktree is preserved; unresolved conflicts can be `escalate`d to a human.

**Why:** concurrent teammate edits could corrupt or surprise your tree. The gate
keeps you the single reviewer of what lands.

### §7 Shutdown discipline

Teams and members are durable — clean up when work is done so stale members don't
linger and so `TeamDiagnostics` stays readable. Stop teammates you no longer need;
archive the team with `TeamDelete` once the work is complete. Idle/stopped panes stay
open by design (so scrollback survives) — that is not a leak, but do delete the team
when you are truly finished.

---

## TeamMate (§8–§10)

### §8 You are isolated — report via SendMessage

You run in your own pane and isolated worktree. The Team Lead cannot see your screen
or your files until you report. So:

- **Report progress and results with `SendMessage`** to the TL (or a peer) — ordinary
  assistant text in your pane is NOT a teammate message and the TL will never see it.
- Your file edits stay in your worktree behind the merge gate (§6); say what you
  changed in your message so the TL knows what to review.
- If you hit something only the human can decide (scope, product direction, an
  irreversible action), write that question into your reply and **end your turn** —
  do not block waiting. The TL relays it to the human and sends the answer back.

### §9 Inbox discipline (📬 → CheckInbox)

When you see a **📬 inbox nudge** in your pane, it is only a short doorbell — the body
is NOT in the nudge. Call **`CheckInbox`** to pull the full message bodies over
MCP/JSON. Read them, act, then continue. Do not ignore the nudge, and do not try to
reconstruct the message from the nudge text.

### §10 Comms norms

- **Send one focused message and end your turn.** Do not keep replying back and forth
  — message ping-pong wastes turns and tokens. Say what you need in one message.
- **Reach peers directly.** You can message other teammates, not just the TL. Find
  them on the roster via `TeamDiagnostics` (it lists team members and their ids).
- Keep messages tight: state the ask/result, reference paths/ids, and stop.

---

## References (progressive disclosure)

- `references/delivery-model.md` — the full delivery/pull-path narrative (shared
  SQLite inbox, turn-boundary drain, notify+pull nudge, TL asymmetry, debounce, the
  `inbox_pending` + auto-surface + hook mechanics). Pull details track Item 1 /
  `CANONICAL-PULL-MODEL.md`.
- `references/troubleshooting.md` — repair paths: layer unavailable, teammate never
  replied, message stuck `queued`, `changed_files` empty/stale, backend unsupported ≠
  success, cross-team reject, and how to read `TeamDiagnostics`.

There is intentionally **no** tool-reference doc — the MCP tool `description` fields
are the canonical per-tool guidance and the channel that actually reaches the model.
