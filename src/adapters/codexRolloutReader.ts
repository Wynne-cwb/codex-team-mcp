import { readFileSync } from "node:fs";

// Reads turn state + the latest assistant deliverable out of a codex rollout
// transcript. Companion to codexRolloutLocator: the locator pins the rollout file
// for a pane-hosted run (full codex TUI, no `--json` event stream), and this
// reader extracts the run's progress + output from that file.
//
// Native-TUI rollout schema (verified read-only against real rollouts — only the
// `type` / `payload.type` envelope was inspected, never the conversation text):
//   - first line: {type:"session_meta", payload:{id, cwd, ...}}
//   - {type:"event_msg", payload:{type:"task_started", turn_id, ...}}    turn begins
//   - {type:"event_msg", payload:{type:"task_complete", last_agent_message, ...}}  turn done
//   - {type:"event_msg", payload:{type:"turn_aborted", reason, ...}}     turn aborted/failed
//   - {type:"event_msg", payload:{type:"agent_message", message, ...}}   assistant text
//   - {type:"response_item", payload:{type:"message", role:"assistant",
//        content:[{type:"output_text", text}]}}                         assistant text
//
// turn_state is derived from the LAST of {task_started, task_complete,
// turn_aborted} seen (the most recent turn wins): task_complete -> completed,
// turn_aborted -> failed, a trailing task_started with no terminal -> in_progress.
// No relevant events -> unknown.
//
// deliverable is the MOST RECENT assistant message text (from any of the three
// assistant-bearing shapes above). This mirrors the detached backend's
// extractCodexDeliverable contract: the RAW text is returned and the surface
// layer (diagnostics) is responsible for D-02 sanitize/redact/bound.
//
// Contract: best-effort and injectable. It NEVER throws — any failure (missing
// file, unreadable, malformed JSON, absent fields) yields {turn_state:"unknown"}.

export type RolloutTurnState =
  | "completed"
  | "failed"
  | "in_progress"
  | "unknown";

export interface RolloutReaderFsLike {
  // Returns the whole rollout content, or null when it cannot be read. Unlike the
  // locator's first-line-only seam, the reader legitimately needs the transcript
  // to extract turn state + the final assistant message.
  readFile(target: string): string | null;
}

export interface RolloutStatusInput {
  rolloutPath: string;
  fs?: RolloutReaderFsLike;
}

export interface RolloutStatusResult {
  turn_state: RolloutTurnState;
  deliverable?: string;
}

const UNKNOWN: RolloutStatusResult = { turn_state: "unknown" };

export function readRolloutStatus(
  input: RolloutStatusInput
): RolloutStatusResult {
  try {
    const fs = input.fs ?? defaultRolloutReaderFs;
    const content = fs.readFile(input.rolloutPath);
    if (!content) {
      return UNKNOWN;
    }

    let turnState: RolloutTurnState = "unknown";
    let deliverable: string | null = null;

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Malformed / partial line — skip, never throw.
        continue;
      }
      if (!isRecord(event)) {
        continue;
      }

      const payload = isRecord(event.payload) ? event.payload : null;

      if (event.type === "event_msg" && payload) {
        const payloadType = payload.type;
        if (payloadType === "task_started") {
          turnState = "in_progress";
        } else if (payloadType === "task_complete") {
          turnState = "completed";
          const last = optionalText(payload.last_agent_message);
          if (last) {
            deliverable = last;
          }
        } else if (payloadType === "turn_aborted") {
          turnState = "failed";
        } else if (payloadType === "agent_message") {
          const message = optionalText(payload.message);
          if (message) {
            deliverable = message;
          }
        }
        continue;
      }

      if (event.type === "response_item" && payload) {
        if (payload.type === "message" && payload.role === "assistant") {
          const text = assistantMessageText(payload.content);
          if (text) {
            deliverable = text;
          }
        }
        continue;
      }
    }

    return deliverable !== null
      ? { turn_state: turnState, deliverable }
      : { turn_state: turnState };
  } catch {
    return UNKNOWN;
  }
}

// Concatenates the `output_text` segments of an assistant message's content
// array (in order). Returns null when there is no usable text.
function assistantMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (
      isRecord(item) &&
      item.type === "output_text" &&
      typeof item.text === "string" &&
      item.text.length > 0
    ) {
      parts.push(item.text);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  const joined = parts.join("");
  return joined.length > 0 ? joined : null;
}

const defaultRolloutReaderFs: RolloutReaderFsLike = {
  readFile(target: string): string | null {
    try {
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}
