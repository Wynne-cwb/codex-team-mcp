import { createHash } from "node:crypto";
import path from "node:path";

import type { NormalizedCallerMetadata } from "../context/caller.js";

export interface WorkspaceScopedCallerIdentity {
  workspaceRoot: string;
  callerKey: string;
  bindingKey: string;
  fallbackUsed: boolean;
  observedMetadata: Record<string, string>;
}

export interface BuildWorkspaceScopedCallerIdentityInput {
  workspaceRoot: string;
  caller: NormalizedCallerMetadata;
}

export function buildWorkspaceScopedCallerIdentity(
  input: BuildWorkspaceScopedCallerIdentityInput
): WorkspaceScopedCallerIdentity {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const workspaceHash = createHash("sha256").update(workspaceRoot).digest("hex");

  return {
    workspaceRoot,
    callerKey: input.caller.callerKey,
    bindingKey: `workspace:${workspaceHash}|caller:${input.caller.callerKey}`,
    fallbackUsed: input.caller.fallbackUsed,
    observedMetadata: { ...input.caller.observedMetadata }
  };
}
