export const FALLBACK_CALLER_KEY = "codex-team:anonymous-local";

export interface NormalizedCallerMetadata {
  callerKey: string;
  observedMetadata: Record<string, string>;
  fallbackUsed: boolean;
}

const OBSERVED_CALLER_METADATA_FIELDS = [
  "sessionId",
  "threadId",
  "requestId",
  "clientName",
  "codexTeamMemberId",
  "codexTeamMemberRole"
] as const;
const DURABLE_CALLER_IDENTITY_FIELDS = ["sessionId", "threadId"] as const;

// Phase 13 (D-Q1 / BIDIR-02): the per-launch `-c` env vars the TL injects into a
// pane-hosted teammate's codex-team MCP. Only member id/role overlay caller
// identity here; the workspace-root env var is consumed solely by resolveStateRoot
// (state/root.ts) to bind the shared DB and is deliberately NOT observed here.
const ENV_MEMBER_IDENTITY_FIELDS = [
  ["codexTeamMemberId", "CODEX_TEAM_MEMBER_ID"],
  ["codexTeamMemberRole", "CODEX_TEAM_MEMBER_ROLE"]
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidateMetadataObjects(extra: unknown): Record<string, unknown>[] {
  if (!isRecord(extra)) {
    return [];
  }

  const candidates: Record<string, unknown>[] = [extra];
  for (const key of ["_meta", "meta", "requestInfo", "clientInfo"]) {
    const nested = extra[key];
    if (isRecord(nested)) {
      candidates.push(nested);
    }
  }

  return candidates;
}

export function normalizeCallerMetadata(
  extra?: unknown,
  env: NodeJS.ProcessEnv = process.env
): NormalizedCallerMetadata {
  const observedMetadata: Record<string, string> = {};

  for (const candidate of candidateMetadataObjects(extra)) {
    for (const field of OBSERVED_CALLER_METADATA_FIELDS) {
      const value = candidate[field];
      if (typeof value === "string" && value.trim().length > 0) {
        observedMetadata[field] = value;
      }
    }
  }

  // Phase 13 (D-Q1): overlay env-derived member id/role AFTER the _meta scan so
  // env OVERRIDES _meta — codex _meta never carries our member ids (RQ1 Finding
  // 5), so the TL-injected env is the authoritative, deterministic source. This
  // runs BEFORE the callerKey computation but only writes observed-only fields,
  // so callerKey/bindingKey (derived solely from DURABLE_CALLER_IDENTITY_FIELDS)
  // are provably unchanged.
  for (const [field, envKey] of ENV_MEMBER_IDENTITY_FIELDS) {
    const value = env[envKey];
    if (typeof value === "string" && value.trim().length > 0) {
      observedMetadata[field] = value.trim();
    }
  }

  const bestField = DURABLE_CALLER_IDENTITY_FIELDS.find((field) => observedMetadata[field]);
  if (!bestField) {
    return {
      callerKey: FALLBACK_CALLER_KEY,
      observedMetadata,
      fallbackUsed: true
    };
  }

  return {
    callerKey: `codex-team:${bestField}:${observedMetadata[bestField]}`,
    observedMetadata,
    fallbackUsed: false
  };
}
