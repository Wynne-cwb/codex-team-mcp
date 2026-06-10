import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendDescription,
  ExecutionRunContext
} from "../src/adapters/execution.js";
import { createCodexTeamServer } from "../src/server.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

const SECRET_MERGE_MCP = "SECRET_PHASE12_MERGE_MCP_PROMPT";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let leaderRoot: string;

class FakeWorkspaceBackend implements ExecutionBackend {
  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "codex_cli_exec",
      backend_status: "running",
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true,
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext) {
    return {
      status: "started" as const,
      delivery_status: "backend_start_attempted" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const,
      backend_run_id: "thread-mcp-merge",
      thread_id: "thread-mcp-merge",
      workspace_path: context.workspace_path ?? undefined,
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      turn_completed: true,
      final_backend_status: "idle" as const,
      metadata: { sandbox_mode: "workspace-write" }
    };
  }

  resumeRun() {
    return {
      status: "not_resumable" as const,
      delivery_status: "backend_unavailable" as const,
      backend: "codex_cli_exec",
      backend_status: "not_started" as const,
      last_error: "resume not exercised"
    };
  }

  reconcileRun() {
    return {
      status: "idle" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const
    };
  }
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function createTempGitLeader(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-team-mergemcp-leader-"));
  execGit(root, ["init"]);
  execGit(root, ["config", "user.email", "test@example.com"]);
  execGit(root, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  execGit(root, ["add", "tracked.txt"]);
  execGit(root, ["commit", "-m", "base"]);
  return root;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = "content" in result ? result.content : [];
  const first = content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<
    string,
    unknown
  >;
}

function readLatestRun(): { run_id: string; workspace_path: string } {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot: leaderRoot });
  try {
    const row = adapter
      .getDatabase()
      .prepare(
        `SELECT run_id, workspace_path FROM ${TABLE_NAMES.runs} ORDER BY created_at DESC, run_id DESC LIMIT 1`
      )
      .get() as { run_id: string; workspace_path: string | null };
    return { run_id: row.run_id, workspace_path: String(row.workspace_path) };
  } finally {
    adapter.close();
  }
}

async function createWorktreeTeammate(): Promise<{
  run_id: string;
  workspace_path: string;
}> {
  await callTool("TeamCreate", {
    team_name: "Alpha Team",
    description: "merge MCP test"
  });
  await callTool("Agent", {
    name: "Builder",
    mode: "code",
    prompt: `implement feature ${SECRET_MERGE_MCP}`,
    description: "code implementation"
  });
  return readLatestRun();
}

beforeEach(async () => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-mergemcp-state-"));
  leaderRoot = createTempGitLeader();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "codex-team-merge-test", version: "0.1.0" });
  server = createCodexTeamServer({
    stateRoot,
    workspaceRoot: leaderRoot,
    executionBackend: new FakeWorkspaceBackend()
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(leaderRoot, { recursive: true, force: true });
});

describe("TeamMerge MCP handler", () => {
  it("advertises TeamMerge with an action schema", async () => {
    const tools = await client.listTools();
    const teamMerge = tools.tools.find((entry) => entry.name === "TeamMerge");
    expect(teamMerge).toBeDefined();
    expect(teamMerge?.inputSchema.properties).toMatchObject({
      action: expect.any(Object),
      teammate_id: expect.any(Object),
      run_id: expect.any(Object)
    });
  });

  it("review returns branch, changed files, and conflict preview without diff content", async () => {
    const { run_id, workspace_path } = await createWorktreeTeammate();
    writeFileSync(path.join(workspace_path, "feature.txt"), "secret-impl-line\n");

    const review = await callTool("TeamMerge", { action: "review", run_id });

    expect(review).toMatchObject({ action: "review", status: "reviewed" });
    expect(String(review.branch)).toMatch(/^codex-team\/alpha-team\/builder\//);
    expect(review.changed_files).toContain("feature.txt");
    expect(typeof review.conflict_preview).toBe("boolean");
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("secret-impl-line");
    expect(serialized).not.toContain(SECRET_MERGE_MCP);
    expect(serialized).not.toContain("\"prompt\"");
    expect(serialized).not.toContain("\"description\"");
  });

  it("merge cleanly merges the worktree branch back into the leader and cleans up", async () => {
    const { run_id, workspace_path } = await createWorktreeTeammate();
    writeFileSync(path.join(workspace_path, "feature.txt"), "implemented\n");

    const merge = await callTool("TeamMerge", {
      action: "merge",
      run_id,
      teammate_id: "builder@alpha-team"
    });

    expect(merge).toMatchObject({
      action: "merge",
      status: "merged",
      review_status: "merged",
      cleanup: "removed"
    });
    expect(String(merge.merge_commit)).toMatch(/^[0-9a-f]{7,40}$/);
    expect(existsSync(path.join(leaderRoot, "feature.txt"))).toBe(true);
    expect(JSON.stringify(merge)).not.toContain(SECRET_MERGE_MCP);
  });

  it("merge fails closed on conflict: merge_conflict, leader clean, worktree preserved", async () => {
    const { run_id, workspace_path } = await createWorktreeTeammate();
    writeFileSync(path.join(workspace_path, "tracked.txt"), "worktree change\n");
    writeFileSync(path.join(leaderRoot, "tracked.txt"), "leader change\n");
    execGit(leaderRoot, ["add", "tracked.txt"]);
    execGit(leaderRoot, ["commit", "-m", "leader conflicting change"]);

    const merge = await callTool("TeamMerge", { action: "merge", run_id });

    expect(merge).toMatchObject({
      action: "merge",
      status: "conflict",
      review_status: "merge_conflict"
    });
    expect(merge.conflict_files).toContain("tracked.txt");
    expect(execGit(leaderRoot, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(workspace_path)).toBe(true);
  });

  it("escalate records escalated_to_human and preserves the worktree", async () => {
    const { run_id, workspace_path } = await createWorktreeTeammate();
    writeFileSync(path.join(workspace_path, "feature.txt"), "wip\n");

    const escalate = await callTool("TeamMerge", { action: "escalate", run_id });

    expect(escalate).toMatchObject({
      action: "escalate",
      status: "escalated",
      review_status: "escalated_to_human"
    });
    expect(existsSync(workspace_path)).toBe(true);
  });

  it("rejects a non-isolated target run with a precise error and no side-effects", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "merge MCP non-isolated test"
    });
    await callTool("Agent", {
      name: "Reader",
      mode: "read",
      prompt: "read only inspection",
      description: "read"
    });
    const { run_id } = readLatestRun();

    const merge = await callTool("TeamMerge", { action: "merge", run_id });

    expect(merge).toMatchObject({
      action: "merge",
      status: "error",
      error_code: "merge_target_not_isolated"
    });
  });

  it("returns a precise error when no target run can be resolved", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "merge MCP unresolved test"
    });

    const merge = await callTool("TeamMerge", {
      action: "merge",
      teammate_id: "ghost@alpha-team"
    });

    expect(merge).toMatchObject({
      status: "error",
      error_code: "merge_target_not_found"
    });
  });
});
