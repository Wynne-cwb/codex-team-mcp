import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATE_ROOT,
  STATE_DB_FILENAME,
  resolveStateRoot
} from "../src/state/root.js";

describe("state root resolution", () => {
  it("resolves the default state root under the configured workspace root", () => {
    const resolved = resolveStateRoot({ workspaceRoot: "/repo" });

    expect(DEFAULT_STATE_ROOT).toBe(".codex-team/state");
    expect(STATE_DB_FILENAME).toBe("codex-team.sqlite");
    expect(resolved.stateRoot).toBe(path.resolve("/repo/.codex-team/state"));
    expect(resolved.databasePath).toBe(
      path.resolve("/repo/.codex-team/state/codex-team.sqlite")
    );
    expect(resolved.source).toBe("default");
    expect(resolved.warnings).toEqual([]);
  });

  it("prefers an explicit stateRoot option over workspace defaults and env", () => {
    const resolved = resolveStateRoot({
      stateRoot: "/custom/state",
      workspaceRoot: "/repo",
      env: {
        CODEX_TEAM_STATE_ROOT: "/env/state"
      }
    });

    expect(resolved.stateRoot).toBe(path.resolve("/custom/state"));
    expect(resolved.databasePath).toBe(path.resolve("/custom/state/codex-team.sqlite"));
    expect(resolved.source).toBe("option");
  });

  it("uses CODEX_TEAM_STATE_ROOT when no option override is provided", () => {
    const resolved = resolveStateRoot({
      workspaceRoot: "/repo",
      env: {
        CODEX_TEAM_STATE_ROOT: "/env/state"
      }
    });

    expect(resolved.stateRoot).toBe(path.resolve("/env/state"));
    expect(resolved.databasePath).toBe(path.resolve("/env/state/codex-team.sqlite"));
    expect(resolved.source).toBe("env");
  });

  it("uses CODEX_TEAM_WORKSPACE_ROOT to scope the default state root", () => {
    const resolved = resolveStateRoot({
      env: {
        CODEX_TEAM_WORKSPACE_ROOT: "/workspace/from-env"
      }
    });

    expect(resolved.workspaceRoot).toBe(path.resolve("/workspace/from-env"));
    expect(resolved.stateRoot).toBe(
      path.resolve("/workspace/from-env/.codex-team/state")
    );
    expect(resolved.databasePath).toBe(
      path.resolve("/workspace/from-env/.codex-team/state/codex-team.sqlite")
    );
  });

  it("warns when the workspace root is the dev checkout package dir", () => {
    const resolved = resolveStateRoot({ workspaceRoot: "/repo/codex-team" });

    expect(resolved.stateRoot).toBe(path.resolve("/repo/codex-team/.codex-team/state"));
    const warning = resolved.warnings.find(
      (entry) => entry.code === "state_root_inside_package"
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("CODEX_TEAM_WORKSPACE_ROOT");
    expect(warning?.message).toContain(path.resolve("/repo/codex-team"));
  });

  it("warns when the workspace root is the published/vendored install dir", () => {
    // edon's repro: a `cwd` override pinned process.cwd() to the vendored install
    // dir while CODEX_TEAM_WORKSPACE_ROOT was unset, so the workspace root fell back
    // to `.../codex-team-mcp` — a non-repo dir that blocks file-modifying TeamMates.
    const resolved = resolveStateRoot({
      cwd: "/Users/edon/.codex/vendor/codex-team-mcp"
    });

    expect(resolved.workspaceRoot).toBe(
      path.resolve("/Users/edon/.codex/vendor/codex-team-mcp")
    );
    const warning = resolved.warnings.find(
      (entry) => entry.code === "state_root_inside_package"
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("workspace_isolation_required");
    expect(warning?.message).toContain("codex-team-mcp");
  });

  it("does not warn for an ordinary project workspace root", () => {
    const resolved = resolveStateRoot({ workspaceRoot: "/Users/edon/Projects/learn-basis" });

    expect(resolved.warnings).toEqual([]);
  });
});
