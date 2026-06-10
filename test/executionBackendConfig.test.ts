import { describe, expect, it } from "vitest";

import { ScaffoldExecutionBackend } from "../src/adapters/execution.js";
import { createExecutionBackendFromOptions } from "../src/adapters/paneExecutionBackend.js";

// Env opt-in contract (Phase 9-12 target, pinned RED here).
//
// `CODEX_TEAM_EXECUTION` is the explicit opt-in flag for the capability-ranked
// chain; `CODEX_TEAM_EXECUTION_BACKEND` optionally selects/overrides a backend.
// The default (no opt-in) MUST stay ScaffoldExecutionBackend (unsupported), and
// the real backend must NEVER be silently auto-enabled. See docs/backend-decision.md.
const EXECUTION_OPT_IN_ENV = "CODEX_TEAM_EXECUTION";
const EXECUTION_BACKEND_ENV = "CODEX_TEAM_EXECUTION_BACKEND";

describe("execution backend env opt-in (RED — Phase 9-12 contract)", () => {
  it("defaults to ScaffoldExecutionBackend when no CODEX_TEAM_* opt-in is set", () => {
    // Guard: this currently passes and must keep passing.
    const backend = createExecutionBackendFromOptions({});

    expect(backend).toBeInstanceOf(ScaffoldExecutionBackend);
    expect(backend.describeBackend()).toMatchObject({
      status: "scheduled_only",
      backend: "none",
      teammateExecutionImplemented: false
    });
  });

  it("selects the capability-ranked chain only when the CODEX_TEAM_* execution opt-in is enabled", () => {
    // RED: the `execution` opt-in option is not wired yet, so this still returns
    // the scaffold today. Phase 9-12 turns this green by honoring the opt-in
    // mapped from `CODEX_TEAM_EXECUTION`.
    const backend = createExecutionBackendFromOptions({
      // @ts-expect-error execution opt-in option is a Phase 9-12 addition
      execution: { enabled: true, backend: "auto" }
    });

    expect(EXECUTION_OPT_IN_ENV).toBe("CODEX_TEAM_EXECUTION");
    expect(EXECUTION_BACKEND_ENV).toBe("CODEX_TEAM_EXECUTION_BACKEND");
    expect(backend).not.toBeInstanceOf(ScaffoldExecutionBackend);
    expect(backend.describeBackend().backend).not.toBe("none");
    expect(backend.constructor.name).toBe("CapabilityRankedBackendChain");
  });

  it("never silently auto-enables the real backend", () => {
    // Absent an explicit opt-in, no real backend may be selected (guard).
    const backend = createExecutionBackendFromOptions({});

    expect(backend).toBeInstanceOf(ScaffoldExecutionBackend);
    expect(backend.describeBackend().capabilities.canStart).toBe(false);
  });
});
