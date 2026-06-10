import { describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendDescription
} from "../src/adapters/execution.js";
// RED (Phase 9-12 target): the capability-ranked chain selector does not exist
// yet. Importing it from the not-yet-created module makes this suite fail until
// Phase 9-12 implements it. See docs/backend-decision.md.
import {
  createCapabilityRankedBackendChain,
  selectExecutionBackend
} from "../src/adapters/capabilityRankedBackendChain.js";

interface FakeCandidateOptions {
  name: string;
  supportsWorkspaces: boolean;
  exposesPersistentId: boolean;
  supportsOsSandbox?: boolean;
  available?: boolean;
}

// A fake candidate ExecutionBackend whose capabilities/persistent-id/sandbox can
// be varied to exercise the lowered gate and the ranking bonus.
function fakeCandidate(options: FakeCandidateOptions): ExecutionBackend & {
  spikeMeta: FakeCandidateOptions;
} {
  const description: ExecutionBackendDescription = {
    status: options.available === false ? "unavailable" : "available",
    teammateExecutionImplemented: options.available !== false,
    backend: options.name,
    backend_status: options.available === false ? "not_started" : "running",
    capabilities: {
      canStart: options.available !== false,
      canResume: options.exposesPersistentId,
      canReconcile: true,
      supportsWorkspaces: options.supportsWorkspaces
    }
  };

  return {
    spikeMeta: options,
    describeBackend() {
      return description;
    },
    startRun() {
      return {
        status: "started",
        delivery_status: "backend_start_attempted",
        backend: options.name,
        backend_status: "running",
        thread_id: options.exposesPersistentId ? "thread-fake" : undefined
      };
    },
    resumeRun() {
      return {
        status: options.exposesPersistentId ? "resumed" : "not_resumable",
        delivery_status: options.exposesPersistentId
          ? "backend_resume_attempted"
          : "backend_unavailable",
        backend: options.name,
        backend_status: options.exposesPersistentId ? "running" : "not_started"
      };
    },
    reconcileRun() {
      return {
        status: "unknown",
        backend: options.name,
        backend_status: "unknown"
      };
    }
  };
}

describe("CapabilityRankedBackendChain (RED — Phase 9-12 contract)", () => {
  it("selects a qualifying backend that is worktree-runnable and exposes a persistent resume id", () => {
    const cliExec = fakeCandidate({
      name: "codex_cli_exec",
      supportsWorkspaces: true,
      exposesPersistentId: true,
      supportsOsSandbox: true
    });
    const transportOnly = fakeCandidate({
      name: "tmux",
      supportsWorkspaces: true,
      exposesPersistentId: false
    });

    const chain = createCapabilityRankedBackendChain([transportOnly, cliExec]);
    const selection = selectExecutionBackend(chain);

    expect(selection.status).toBe("selected");
    expect(selection.backend).toBe("codex_cli_exec");
    expect(selection.qualifies).toBe(true);
  });

  it("excludes backends that lack supportsWorkspaces or a persistent id", () => {
    const noWorkspace = fakeCandidate({
      name: "no_workspace",
      supportsWorkspaces: false,
      exposesPersistentId: true,
      supportsOsSandbox: true
    });
    const noPersistentId = fakeCandidate({
      name: "no_persistent_id",
      supportsWorkspaces: true,
      exposesPersistentId: false,
      supportsOsSandbox: true
    });

    const chain = createCapabilityRankedBackendChain([noWorkspace, noPersistentId]);
    const selection = selectExecutionBackend(chain);

    // Neither qualifies even though both support OS sandbox.
    expect(selection.status).toBe("unavailable");
    expect(selection.qualifies).toBe(false);
  });

  it("treats OS sandbox support as a ranking bonus, never an eligibility gate", () => {
    const qualifierNoSandbox = fakeCandidate({
      name: "qualifier_no_sandbox",
      supportsWorkspaces: true,
      exposesPersistentId: true,
      supportsOsSandbox: false
    });
    const nonQualifierWithSandbox = fakeCandidate({
      name: "non_qualifier_sandbox",
      supportsWorkspaces: false,
      exposesPersistentId: true,
      supportsOsSandbox: true
    });

    const chain = createCapabilityRankedBackendChain([
      nonQualifierWithSandbox,
      qualifierNoSandbox
    ]);
    const selection = selectExecutionBackend(chain);

    // A non-sandbox qualifier still ranks above a non-qualifier that has sandbox.
    expect(selection.backend).toBe("qualifier_no_sandbox");
    expect(selection.qualifies).toBe(true);
  });

  it("returns honest unavailable with remediation and an escalate signal when no candidate qualifies", () => {
    const transportA = fakeCandidate({
      name: "tmux",
      supportsWorkspaces: true,
      exposesPersistentId: false
    });
    const transportB = fakeCandidate({
      name: "iterm2",
      supportsWorkspaces: true,
      exposesPersistentId: false
    });

    const chain = createCapabilityRankedBackendChain([transportA, transportB]);
    const selection = selectExecutionBackend(chain);

    expect(selection.status).toBe("unavailable");
    expect(selection.qualifies).toBe(false);
    expect(Array.isArray(selection.remediation)).toBe(true);
    expect(selection.remediation.length).toBeGreaterThan(0);
    expect(selection.escalate_to_team_lead).toBe(true);
  });
});
