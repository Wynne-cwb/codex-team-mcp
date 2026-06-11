import { describe, expect, it } from "vitest";

import {
  readRolloutStatus,
  type RolloutReaderFsLike
} from "../src/adapters/codexRolloutReader.js";

// In-memory fs seam returning the whole rollout content (or null when absent).
function memoryFs(files: Record<string, string>): RolloutReaderFsLike {
  return {
    readFile(target: string): string | null {
      return Object.prototype.hasOwnProperty.call(files, target)
        ? files[target]
        : null;
    }
  };
}

const ROLLOUT = "/codex/sessions/2026/06/11/rollout-x.jsonl";

function sessionMeta(): string {
  return JSON.stringify({
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "uuid-1", cwd: "/work/tree/run-a", cli_version: "0.99.0" }
  });
}

function taskStarted(turnId = "turn-1"): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId, started_at: "t" }
  });
}

function taskComplete(lastAgentMessage: string, turnId = "turn-1"): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
      duration_ms: 1234,
      last_agent_message: lastAgentMessage
    }
  });
}

function turnAborted(turnId = "turn-1"): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" }
  });
}

function agentMessageEvent(message: string): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message, phase: "main" }
  });
}

function assistantResponseItem(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }
  });
}

describe("readRolloutStatus", () => {
  it("reports completed + the final assistant deliverable for a finished turn", () => {
    const content = [
      sessionMeta(),
      taskStarted(),
      assistantResponseItem("interim thought"),
      agentMessageEvent("the final answer"),
      taskComplete("the final answer")
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result).toEqual({
      turn_state: "completed",
      deliverable: "the final answer"
    });
  });

  it("reports failed when the last turn was aborted", () => {
    const content = [
      sessionMeta(),
      taskStarted(),
      agentMessageEvent("partial output"),
      turnAborted()
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    // failed turn_state, but the partial assistant text is still surfaced.
    expect(result.turn_state).toBe("failed");
    expect(result.deliverable).toBe("partial output");
  });

  it("reports in_progress when a turn started with no terminal event", () => {
    const content = [sessionMeta(), taskStarted()].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result).toEqual({ turn_state: "in_progress" });
  });

  it("uses the MOST RECENT turn state across multiple turns", () => {
    const content = [
      sessionMeta(),
      taskStarted("turn-1"),
      taskComplete("first answer", "turn-1"),
      taskStarted("turn-2"),
      assistantResponseItem("second answer"),
      taskComplete("second answer", "turn-2")
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result).toEqual({
      turn_state: "completed",
      deliverable: "second answer"
    });
  });

  it("concatenates multiple output_text segments of an assistant response item", () => {
    const content = [
      sessionMeta(),
      taskStarted(),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "part one " },
            { type: "reasoning", text: "ignored" },
            { type: "output_text", text: "part two" }
          ]
        }
      }),
      taskComplete("part one part two")
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result.deliverable).toBe("part one part two");
  });

  it("ignores user/developer messages when choosing the deliverable", () => {
    const content = [
      sessionMeta(),
      taskStarted(),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: "the user prompt" }]
        }
      }),
      agentMessageEvent("assistant reply"),
      taskComplete("assistant reply")
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result.deliverable).toBe("assistant reply");
  });

  it("skips malformed lines without throwing and still recovers turn state", () => {
    const content = [
      sessionMeta(),
      "this is not json {{{",
      taskStarted(),
      "}{ also broken",
      agentMessageEvent("recovered answer"),
      taskComplete("recovered answer"),
      "trailing garbage"
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result).toEqual({
      turn_state: "completed",
      deliverable: "recovered answer"
    });
  });

  it("returns unknown for an empty or whitespace-only rollout", () => {
    expect(
      readRolloutStatus({
        rolloutPath: ROLLOUT,
        fs: memoryFs({ [ROLLOUT]: "" })
      })
    ).toEqual({ turn_state: "unknown" });

    expect(
      readRolloutStatus({
        rolloutPath: ROLLOUT,
        fs: memoryFs({ [ROLLOUT]: "   \n  \n" })
      })
    ).toEqual({ turn_state: "unknown" });
  });

  it("returns unknown when the file cannot be read", () => {
    expect(
      readRolloutStatus({
        rolloutPath: ROLLOUT,
        fs: memoryFs({})
      })
    ).toEqual({ turn_state: "unknown" });
  });

  it("never throws even when the fs seam itself misbehaves", () => {
    const explodingFs: RolloutReaderFsLike = {
      readFile() {
        throw new Error("boom");
      }
    };

    expect(() =>
      readRolloutStatus({ rolloutPath: ROLLOUT, fs: explodingFs })
    ).not.toThrow();
    expect(readRolloutStatus({ rolloutPath: ROLLOUT, fs: explodingFs })).toEqual(
      { turn_state: "unknown" }
    );
  });

  it("reports unknown turn state when only non-turn events are present", () => {
    const content = [
      sessionMeta(),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      JSON.stringify({ type: "turn_context", payload: {}, timestamp: "t" })
    ].join("\n");

    const result = readRolloutStatus({
      rolloutPath: ROLLOUT,
      fs: memoryFs({ [ROLLOUT]: content })
    });

    expect(result).toEqual({ turn_state: "unknown" });
  });
});
