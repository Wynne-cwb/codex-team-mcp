# Delivery model (codex-team)

> **Pull details track Item 1 / `CANONICAL-PULL-MODEL.md`.** This file is the
> long-form explainer of how messages move and how the Team Lead pulls them. The
> canonical mechanics (exact statuses, the `inbox_pending` field, the size-aware
> auto-surface thresholds, the `UserPromptSubmit` hook contract) live in
> `CANONICAL-PULL-MODEL.md`. If that doc and this one ever disagree, the canonical
> doc wins; this explainer is updated to match.

## TOC

- [1. The shared SQLite inbox](#1-the-shared-sqlite-inbox)
- [2. Turn-boundary delivery (never mid-turn steer)](#2-turn-boundary-delivery-never-mid-turn-steer)
- [3. Notify + pull (the nudge is a doorbell)](#3-notify--pull-the-nudge-is-a-doorbell)
- [4. How the Team Lead pulls (asymmetry)](#4-how-the-team-lead-pulls-asymmetry)
- [5. Never-dropped + resume failure](#5-never-dropped--resume-failure)
- [6. Debounce, batching, ordering](#6-debounce-batching-ordering)

---

## 1. The shared SQLite inbox

Every member — the Team Lead and every TeamMate — reads and writes the SAME SQLite
state (`messages` table). Delivery is **recipient-keyed and sender-agnostic**: a row
is addressed to a `recipient_member_id`, and selection keys purely off timestamps
(`delivered_at IS NULL` for the pending-nudge set, `read_at IS NULL` for the unread
set). The body lives in `messages.body_json` and never leaves it except as a lawful
pull to its intended recipient.

This shared store is what survives compaction and restarts: coordination state is not
in any one transcript.

## 2. Turn-boundary delivery (never mid-turn steer)

**Turn-boundary, not sync.** A `SendMessage` is *persisted* immediately, but it is
*delivered* only at a turn boundary — when the recipient is idle/stopped between
turns, never injected mid-turn.

- A **running** recipient's message is `queued_for_next_turn`.
- An **idle/stopped** recipient's message is `queued_while_idle`.

Neither is an error. You cannot safely interrupt a model mid-thought; the only seam to
hand it new input is between turns. A running recipient has NOT reached a turn boundary
yet — the message waits for it.

## 3. Notify + pull (the nudge is a doorbell)

**Pull, not push.** The message *body* is never pushed into a model's context.
Recipients pull full bodies over the reliable MCP/JSON channel via `CheckInbox`. The
only thing that travels toward a live runtime is a SHORT, length-bounded nudge — count
+ a capped list of sender ids — never the body.

For a pane-hosted teammate, the nudge is a single `📬 N new message(s) … run CheckInbox
to read.` line injected into its live TUI (`resumeRun` → `sendToPane`). It is the sole
generated nudge string, hard-capped to 512 chars and newline-stripped, so the pane
payload is provably bounded and **body-size-independent**. Why notify+pull and not push
the body: a long body typed into a pane loses bytes (the byte-loss problem); a short
doorbell + a reliable JSON pull is correct and cheap.

The teammate, on seeing the 📬 line, calls `CheckInbox` and reads the full bodies.

## 4. How the Team Lead pulls (asymmetry)

> This section is **coupled to Item 1** — it describes the implemented pull path, so
> its pull details track Item 1 / `CANONICAL-PULL-MODEL.md`. If the hook / auto-surface
> / `inbox_pending` mechanics change, update this in lockstep with the canonical doc.

The Team Lead is **asymmetric** to a teammate: it is the interactive, human-facing
session, it has **no pane** to inject a nudge into, and it carries **no injected
preamble**. So the TL cannot be woken; it *pulls*. The implemented path:

1. **`inbox_pending: N`** is attached at the top level of EVERY codex-team tool result
   — a non-negative integer count of the leader's own unread mail, always present
   (including `0`) so the TL can trust the field. It is computed from the POST-claim
   state in the same call, so it never disagrees with the `inbox` block shown there.

2. **Auto-surface.** When the TL calls any codex-team tool, the shared post-processor
   claims the leader's unread rows (atomic `BEGIN IMMEDIATE`, stamps `read_at` only)
   and appends an `inbox` block to the JSON result. It is **size-aware**:
   - **Full-body inline** when the claimed batch is small/short (≤5 messages AND
     ≤8 KiB total body) — one-shot, no second call needed.
   - **Compact digest** when either bound is exceeded — each row carries `from`,
     `summary`, `created_at`, `message_id`, and a `preview` (first 200 chars), but no
     full body. The TL pulls full bodies on demand with `CheckInbox(include_read)`.
   This keeps a large backlog from bloating every tool result.

3. **Optional `UserPromptSubmit` hook (repo artifact, not installed).** A read-only
   script (`hooks/userPromptSubmit-inbox-nudge.mjs`) counts the leader's unread mail
   and, only when N>0, injects `📬 You have N new teammate message(s) — call CheckInbox
   before responding.` on the same turn the TL submits a prompt. It is the **primary
   home** of the TL anti-speculative-poll guidance. See `hooks/README.md` to wire it up.

**The pull discipline:** do not speculatively call `CheckInbox`. You are nudged when
mail arrives (`inbox_pending` on every tool result; the 📬 line each turn you prompt).
Call `CheckInbox` only when `inbox_pending > 0`, when you see the 📬 nudge, or at a
natural checkpoint — never on a loop.

**Ceiling.** Surfacing to the TL is bound to model-driven actions (a user prompt, or
any codex-team tool call). There is NO "message arrives → idle interactive TL wakes
immediately" push — that was investigated and rejected (no MCP server-wake; app-server
`turn/start` would re-host the TL and interrupt a mid-typing human).

## 5. Never-dropped + resume failure

A message is **never dropped**. If a wake/inject attempt fails, the row is restored to
`queued_for_next_turn` (its `delivered_at` un-stamped) so a later drain retries it, and
a `resume_failure_notice` is surfaced to the leader. Outcomes of a wake are reported
with the honest word **attempted** — a stamped `delivered` means the recipient's pane
was nudged, NOT that the body was read. The body is "read" only when the recipient
actually pulls it (`read_at` stamped), the single selection gate for "unread".

## 6. Debounce, batching, ordering

- **Ordering:** messages are delivered/surfaced oldest-first (FIFO by row order), so a
  pull returns them in send order.
- **Resume debounce:** waking a pane is bounded by a ~10s resume debounce and is
  at-most-once per claimed batch, so a burst of messages does not thrash the pane.
- **Per-turn cap:** the drain claims a bounded batch per turn; the rest surface on the
  next boundary. Concurrent drains on the shared WAL DB serialize on the atomic claim,
  so no message is double-delivered and no duplicate nudge is sent.
