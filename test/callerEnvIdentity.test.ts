import { describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";

// Phase 13 (D-Q1 / BIDIR-02): the co-located teammate MCP derives its member
// id/role from process.env (injected per-launch by the TL via `-c`) into
// observedMetadata, WITHOUT ever changing callerKey/bindingKey (those stay on the
// durable session/thread fields). A fake `env` is injected so the real
// process.env is never mutated.
describe("normalizeCallerMetadata env-derived member identity (Phase 13)", () => {
  it("merges CODEX_TEAM_MEMBER_ID/ROLE into observedMetadata without changing callerKey", () => {
    const result = normalizeCallerMetadata(
      { sessionId: "s1" },
      {
        CODEX_TEAM_MEMBER_ID: "teammate:alpha:builder",
        CODEX_TEAM_MEMBER_ROLE: "teammate"
      }
    );

    expect(result.observedMetadata.codexTeamMemberId).toBe("teammate:alpha:builder");
    expect(result.observedMetadata.codexTeamMemberRole).toBe("teammate");
    // callerKey stays derived purely from the durable session field.
    expect(result.callerKey).toBe("codex-team:sessionId:s1");
    expect(result.fallbackUsed).toBe(false);
  });

  it("lets env OVERRIDE the _meta-scanned member id/role", () => {
    const result = normalizeCallerMetadata(
      {
        sessionId: "s1",
        _meta: {
          codexTeamMemberId: "from-meta",
          codexTeamMemberRole: "leader"
        }
      },
      {
        CODEX_TEAM_MEMBER_ID: "from-env",
        CODEX_TEAM_MEMBER_ROLE: "teammate"
      }
    );

    expect(result.observedMetadata.codexTeamMemberId).toBe("from-env");
    expect(result.observedMetadata.codexTeamMemberRole).toBe("teammate");
    expect(result.callerKey).toBe("codex-team:sessionId:s1");
  });

  it("ignores blank / whitespace-only env member values", () => {
    const result = normalizeCallerMetadata(
      {
        sessionId: "s1",
        _meta: { codexTeamMemberId: "from-meta" }
      },
      {
        CODEX_TEAM_MEMBER_ID: "   ",
        CODEX_TEAM_MEMBER_ROLE: ""
      }
    );

    // Blank env does not override the _meta value, and a blank role is not added.
    expect(result.observedMetadata.codexTeamMemberId).toBe("from-meta");
    expect(result.observedMetadata).not.toHaveProperty("codexTeamMemberRole");
  });

  it("trims env-derived member id/role values", () => {
    const result = normalizeCallerMetadata(
      { sessionId: "s1" },
      {
        CODEX_TEAM_MEMBER_ID: "  teammate:alpha:builder  ",
        CODEX_TEAM_MEMBER_ROLE: " teammate "
      }
    );

    expect(result.observedMetadata.codexTeamMemberId).toBe("teammate:alpha:builder");
    expect(result.observedMetadata.codexTeamMemberRole).toBe("teammate");
  });

  it("is a no-op when the member env vars are ABSENT (backward-compat, D-Q5)", () => {
    const withEnv = normalizeCallerMetadata({ sessionId: "s1" }, {});
    const baseline = normalizeCallerMetadata({ sessionId: "s1" });

    expect(withEnv.observedMetadata).not.toHaveProperty("codexTeamMemberId");
    expect(withEnv.observedMetadata).not.toHaveProperty("codexTeamMemberRole");
    // Identical to the no-env-arg call: callerKey, fallbackUsed, observedMetadata.
    expect(withEnv).toEqual(baseline);
    expect(withEnv.callerKey).toBe("codex-team:sessionId:s1");
    expect(withEnv.fallbackUsed).toBe(false);
  });

  it("never reads CODEX_TEAM_WORKSPACE_ROOT into observedMetadata", () => {
    const result = normalizeCallerMetadata(
      { sessionId: "s1" },
      {
        CODEX_TEAM_WORKSPACE_ROOT: "/container/root",
        CODEX_TEAM_MEMBER_ID: "teammate:alpha:builder",
        CODEX_TEAM_MEMBER_ROLE: "teammate"
      }
    );

    expect(result.observedMetadata).not.toHaveProperty("codexTeamWorkspaceRoot");
    expect(JSON.stringify(result.observedMetadata)).not.toContain("/container/root");
  });
});
