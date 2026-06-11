import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  locateRolloutSessionId,
  type RolloutFsLike,
  type RolloutStatLike
} from "../src/adapters/codexRolloutLocator.js";

// --- In-memory RolloutFsLike seam ------------------------------------------
//
// Deliberately mirrors the real seam: there is NO whole-file read. The only way
// to obtain content is `readFirstLine`, which returns the first newline-delimited
// segment. This both models the privacy contract and lets us assert exactly
// which files were read.

interface MemFile {
  content: string;
  mtimeMs: number;
}

class MemoryFs implements RolloutFsLike {
  private readonly files = new Map<string, MemFile>();
  private readonly directories = new Set<string>();

  readonly readdirCalls: string[] = [];
  readonly readFirstLineCalls: string[] = [];

  addFile(filePath: string, content: string, mtimeMs: number): void {
    this.files.set(filePath, { content, mtimeMs });
    this.registerAncestors(path.dirname(filePath));
  }

  addDir(dirPath: string): void {
    this.directories.add(dirPath);
    this.registerAncestors(path.dirname(dirPath));
  }

  private registerAncestors(dir: string): void {
    let current = dir;
    for (;;) {
      this.directories.add(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  readdirSync(dir: string): string[] {
    this.readdirCalls.push(dir);
    if (!this.directories.has(dir)) {
      throw new Error(`ENOENT: no such directory ${dir}`);
    }
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (path.dirname(filePath) === dir) {
        names.add(path.basename(filePath));
      }
    }
    for (const dirPath of this.directories) {
      if (dirPath !== dir && path.dirname(dirPath) === dir) {
        names.add(path.basename(dirPath));
      }
    }
    return [...names];
  }

  statSync(target: string): RolloutStatLike {
    const file = this.files.get(target);
    if (file) {
      return {
        mtimeMs: file.mtimeMs,
        isDirectory: () => false,
        isFile: () => true
      };
    }
    if (this.directories.has(target)) {
      return {
        mtimeMs: 0,
        isDirectory: () => true,
        isFile: () => false
      };
    }
    throw new Error(`ENOENT: no such path ${target}`);
  }

  readFirstLine(target: string): string | null {
    this.readFirstLineCalls.push(target);
    const file = this.files.get(target);
    if (!file) {
      return null;
    }
    const newlineIndex = file.content.indexOf("\n");
    return newlineIndex === -1
      ? file.content
      : file.content.slice(0, newlineIndex);
  }
}

const SESSIONS_ROOT = "/codex/sessions";

function rolloutPath(id: string, dateSegments = ["2026", "06", "11"]): string {
  return path.join(
    SESSIONS_ROOT,
    ...dateSegments,
    `rollout-2026-06-11T00-00-00-${id}.jsonl`
  );
}

function sessionMetaLine(
  id: string,
  cwd: string,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-06-11T00:00:00.000Z",
      cwd,
      cli_version: "0.99.0",
      ...overrides
    }
  });
}

describe("locateRolloutSessionId", () => {
  it("returns the session id and path for a single matching cwd", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const file = rolloutPath("uuid-a");
    fs.addFile(file, sessionMetaLine("uuid-a", cwd), 1_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({ session_id: "uuid-a", rollout_path: file });
  });

  it("ignores rollouts whose cwd does not match", () => {
    const fs = new MemoryFs();
    const targetCwd = "/work/tree/run-a";
    const matchFile = rolloutPath("uuid-match");

    fs.addFile(
      rolloutPath("uuid-other-1"),
      sessionMetaLine("uuid-other-1", "/work/tree/run-b"),
      5_000
    );
    fs.addFile(matchFile, sessionMetaLine("uuid-match", targetCwd), 3_000);
    fs.addFile(
      rolloutPath("uuid-other-2"),
      sessionMetaLine("uuid-other-2", "/somewhere/else"),
      9_000
    );

    const result = locateRolloutSessionId({
      workspaceCwd: targetCwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({
      session_id: "uuid-match",
      rollout_path: matchFile
    });
  });

  it("returns the newest match when several rollouts share the cwd", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const newest = rolloutPath("uuid-newest");

    fs.addFile(rolloutPath("uuid-old"), sessionMetaLine("uuid-old", cwd), 1_000);
    fs.addFile(newest, sessionMetaLine("uuid-newest", cwd), 8_000);
    fs.addFile(rolloutPath("uuid-mid"), sessionMetaLine("uuid-mid", cwd), 4_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({
      session_id: "uuid-newest",
      rollout_path: newest
    });
  });

  it("normalizes cwd before comparing (trailing-slash / relative segments)", () => {
    const fs = new MemoryFs();
    const file = rolloutPath("uuid-norm");
    fs.addFile(
      file,
      sessionMetaLine("uuid-norm", "/work/tree/run-a/../run-a"),
      2_000
    );

    const result = locateRolloutSessionId({
      workspaceCwd: "/work/tree/run-a/",
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({ session_id: "uuid-norm", rollout_path: file });
  });

  it("filters out rollouts older than notBeforeMs", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const recent = rolloutPath("uuid-recent");

    fs.addFile(rolloutPath("uuid-stale"), sessionMetaLine("uuid-stale", cwd), 1_000);
    fs.addFile(recent, sessionMetaLine("uuid-recent", cwd), 6_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      notBeforeMs: 5_000,
      fs
    });

    expect(result).toEqual({
      session_id: "uuid-recent",
      rollout_path: recent
    });
  });

  it("returns null when the only matching rollout predates notBeforeMs", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    fs.addFile(rolloutPath("uuid-stale"), sessionMetaLine("uuid-stale", cwd), 1_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      notBeforeMs: 5_000,
      fs
    });

    expect(result).toBeNull();
  });

  it("skips malformed first lines without throwing and returns null", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";

    // First line is not JSON.
    fs.addFile(rolloutPath("uuid-garbage"), "this is not json {{{", 7_000);
    // First line is valid JSON but not a session_meta record.
    fs.addFile(
      rolloutPath("uuid-wrong-type"),
      JSON.stringify({ type: "response_item", payload: { id: "x", cwd } }),
      6_000
    );
    // session_meta but payload missing cwd.
    fs.addFile(
      rolloutPath("uuid-no-cwd"),
      sessionMetaLine("uuid-no-cwd", cwd, { cwd: undefined }),
      5_000
    );
    // session_meta but payload missing id.
    fs.addFile(
      rolloutPath("uuid-no-id"),
      sessionMetaLine("uuid-no-id", cwd, { id: undefined }),
      4_000
    );

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toBeNull();
  });

  it("recovers a valid rollout even when sibling rollouts are malformed", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const good = rolloutPath("uuid-good");

    fs.addFile(rolloutPath("uuid-garbage"), "}{ not json", 9_000);
    fs.addFile(good, sessionMetaLine("uuid-good", cwd), 8_000);
    fs.addFile(
      rolloutPath("uuid-wrong-type"),
      JSON.stringify({ type: "turn.completed" }),
      7_000
    );

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({ session_id: "uuid-good", rollout_path: good });
  });

  it("returns null when the sessions root does not exist", () => {
    const fs = new MemoryFs(); // nothing registered

    const result = locateRolloutSessionId({
      workspaceCwd: "/work/tree/run-a",
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toBeNull();
    // It still attempted to read the configured root.
    expect(fs.readdirCalls).toContain(SESSIONS_ROOT);
  });

  it("returns null when the sessions root is empty", () => {
    const fs = new MemoryFs();
    fs.addDir(SESSIONS_ROOT);

    const result = locateRolloutSessionId({
      workspaceCwd: "/work/tree/run-a",
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toBeNull();
  });

  it("only reads the first line — trailing garbage never breaks parsing", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const file = rolloutPath("uuid-firstline");

    const content = [
      sessionMetaLine("uuid-firstline", cwd),
      "this line is deliberately not valid json {{{",
      JSON.stringify({ secret: "do-not-read-the-transcript" }),
      "more trailing garbage"
    ].join("\n");
    fs.addFile(file, content, 3_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    // Parsing succeeds purely from the first line, proving the transcript body
    // is never consulted.
    expect(result).toEqual({
      session_id: "uuid-firstline",
      rollout_path: file
    });
    // The locator went through the first-line seam (the only read API available).
    expect(fs.readFirstLineCalls).toContain(file);
  });

  it("skips future-dated rollouts using the injected clock", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const present = rolloutPath("uuid-present");

    fs.addFile(rolloutPath("uuid-future"), sessionMetaLine("uuid-future", cwd), 9_000);
    fs.addFile(present, sessionMetaLine("uuid-present", cwd), 2_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs,
      now: () => 5_000
    });

    expect(result).toEqual({
      session_id: "uuid-present",
      rollout_path: present
    });
  });

  it("descends the YYYY/MM/DD layout to find nested rollouts", () => {
    const fs = new MemoryFs();
    const cwd = "/work/tree/run-a";
    const nested = rolloutPath("uuid-nested", ["2025", "12", "31"]);
    fs.addFile(nested, sessionMetaLine("uuid-nested", cwd), 4_000);

    const result = locateRolloutSessionId({
      workspaceCwd: cwd,
      sessionsRoot: SESSIONS_ROOT,
      fs
    });

    expect(result).toEqual({ session_id: "uuid-nested", rollout_path: nested });
  });

  it("resolves the default sessions root from CODEX_HOME", () => {
    const fs = new MemoryFs(); // empty: forces a readdir on the resolved root

    const result = locateRolloutSessionId({
      workspaceCwd: "/work/tree/run-a",
      env: { CODEX_HOME: "/custom/codex/home" } as NodeJS.ProcessEnv,
      fs
    });

    expect(result).toBeNull();
    expect(fs.readdirCalls).toContain(
      path.join("/custom/codex/home", "sessions")
    );
  });

  it("falls back to ~/.codex/sessions when CODEX_HOME is unset", () => {
    const fs = new MemoryFs(); // empty: forces a readdir on the resolved root

    const result = locateRolloutSessionId({
      workspaceCwd: "/work/tree/run-a",
      env: {} as NodeJS.ProcessEnv,
      fs
    });

    expect(result).toBeNull();
    expect(fs.readdirCalls).toContain(
      path.join(os.homedir(), ".codex", "sessions")
    );
  });

  it("never throws even when the filesystem seam itself misbehaves", () => {
    const explodingFs: RolloutFsLike = {
      readdirSync() {
        throw new Error("boom");
      },
      statSync() {
        throw new Error("boom");
      },
      readFirstLine() {
        throw new Error("boom");
      }
    };

    expect(() =>
      locateRolloutSessionId({
        workspaceCwd: "/work/tree/run-a",
        sessionsRoot: SESSIONS_ROOT,
        fs: explodingFs
      })
    ).not.toThrow();

    expect(
      locateRolloutSessionId({
        workspaceCwd: "/work/tree/run-a",
        sessionsRoot: SESSIONS_ROOT,
        fs: explodingFs
      })
    ).toBeNull();
  });
});
