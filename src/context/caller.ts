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

export function normalizeCallerMetadata(extra?: unknown): NormalizedCallerMetadata {
  const observedMetadata: Record<string, string> = {};

  for (const candidate of candidateMetadataObjects(extra)) {
    for (const field of OBSERVED_CALLER_METADATA_FIELDS) {
      const value = candidate[field];
      if (typeof value === "string" && value.trim().length > 0) {
        observedMetadata[field] = value;
      }
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
