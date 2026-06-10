import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { PaneExecutionBackend } from "../src/adapters/paneExecutionBackend.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";

const tempRoots: string[] = [];
const SECRET_DIAGNOSTICS_PROMPT = "SECRET_METADATA_DIAGNOSTICS_PROMPT";

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-metadata-diagnostics-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function seedPaneModeState(stateRoot: string, workspaceRoot: string): void {
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "session-1", clientName: "codex" })
  });
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });

  try {
    const statePath = adapter.describeStateRoot().stateRoot;
    new TeamService({ db: adapter.getDatabase(), statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Metadata diagnostics team",
      identity
    });
    // A scheduled teammate against the default pane backend reproduces the
    // codex_session_metadata_unavailable path that the enriched diagnostics
    // block must explain.
    new AgentService({
      db: adapter.getDatabase(),
      statePath,
      executionBackend: new PaneExecutionBackend({
        paneBackend: {
          describeAvailability() {
            return {
              mode: "pane",
              backend_type: "tmux",
              availability_status: "available",
              pane_id: "%3",
              session_name: "codex-team-alpha-team",
              is_native: false
            };
          },
          createPane() {
            return {
              ok: true,
              pane: {
                mode: "pane",
                backend_type: "tmux",
                availability_status: "available",
                pane_id: "%3",
                session_name: "codex-team-alpha-team",
                is_native: false
              }
            };
          },
          resumePane() {
            return {
              ok: true,
              pane: {
                mode: "pane",
                backend_type: "tmux",
                availability_status: "available",
                is_native: false
              }
            };
          },
          reconcilePane() {
            return {
              status: "active",
              pane: {
                mode: "pane",
                backend_type: "tmux",
                availability_status: "available",
                is_native: false
              },
              deleted: false
            };
          }
        }
      })
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "read",
      prompt: SECRET_DIAGNOSTICS_PROMPT,
      description: "Metadata diagnostics read-only teammate",
      identity
    });
  } finally {
    adapter.close();
  }
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// RED (Phase 9-11 target): buildDiagnosticsPayload does not yet expose a
// `metadataDiagnostics` block. These assertions fail until Phase 9-11 implements
// the enriched, sanitized EXEC-03 diagnostics. See docs/backend-decision.md.
describe("codex_session_metadata_unavailable enriched diagnostics (RED — Phase 9-11)", () => {
  function buildPayload() {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/metadata-diagnostics";
    seedPaneModeState(stateRoot, workspaceRoot);

    return buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: { sessionId: "session-1", clientName: "codex" },
      paneMode: { enabled: true },
      includeDebug: true
    }) as unknown as {
      metadataDiagnostics?: {
        missing_metadata_source?: unknown;
        observed_keys?: unknown;
        selected_backend?: unknown;
        remediation?: unknown;
      };
    };
  }

  it("reports the missing metadata source for codex_session_metadata_unavailable", () => {
    const payload = buildPayload();

    expect(payload.metadataDiagnostics).toBeDefined();
    expect(typeof payload.metadataDiagnostics?.missing_metadata_source).toBe("string");
    expect(String(payload.metadataDiagnostics?.missing_metadata_source)).toMatch(
      /thread|session|durable|codex/i
    );
  });

  it("reports observed metadata keys", () => {
    const payload = buildPayload();
    const observed = payload.metadataDiagnostics?.observed_keys;

    expect(Array.isArray(observed)).toBe(true);
    expect((observed as string[]).length).toBeGreaterThan(0);
    // Observed keys must be sanitized backend/pane keys, never raw content.
    const serializedObserved = JSON.stringify(observed);
    expect(serializedObserved).not.toContain(SECRET_DIAGNOSTICS_PROMPT);
  });

  it("reports the selected backend", () => {
    const payload = buildPayload();

    expect(typeof payload.metadataDiagnostics?.selected_backend).toBe("string");
  });

  it("reports concrete remediation steps", () => {
    const payload = buildPayload();
    const remediation = payload.metadataDiagnostics?.remediation;

    expect(Array.isArray(remediation)).toBe(true);
    expect((remediation as string[]).length).toBeGreaterThan(0);
  });

  it("keeps diagnostics sanitized", () => {
    const payload = buildPayload();
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(SECRET_DIAGNOSTICS_PROMPT);
    for (const rawKey of [
      "\"prompt\"",
      "\"message\"",
      "\"body\"",
      "\"description\"",
      "\"notes\"",
      "payload_json",
      "transcript"
    ]) {
      expect(serialized).not.toContain(rawKey);
    }
  });
});
