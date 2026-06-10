import { z } from "zod";

import { canonicalizeTeamName } from "../services/teamNames.js";

const structuredMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shutdown_request"),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("shutdown_response"),
    request_id: z.string(),
    approve: z.boolean(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("plan_approval_response"),
    request_id: z.string(),
    approve: z.boolean(),
    feedback: z.string().optional()
  })
]);

export const optionalCanonicalTeamNameSchema = z
  .string()
  .optional()
  .refine((value) => value === undefined || canCanonicalizeTeamName(value), {
    message: "team_name must include at least one supported character"
  });

function canCanonicalizeTeamName(teamName: string): boolean {
  try {
    canonicalizeTeamName(teamName);
    return true;
  } catch {
    return false;
  }
}

export const teamCreateSchema = {
  team_name: z.string(),
  description: z.string().optional(),
  agent_type: z.string().optional(),
  model: z.string().optional()
};

export const teamDeleteSchema = {
  team_name: z.string().optional(),
  reason: z.string().optional()
};

export const agentSchema = {
  name: z.string().optional(),
  team_name: z.string().optional(),
  mode: z.string().optional(),
  prompt: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  agent_type: z.string().optional(),
  subagent_type: z.string().optional(),
  run_in_background: z.boolean().optional(),
  isolation: z.string().optional(),
  cwd: z.string().optional()
};

export const sendMessageSchema = {
  team_name: z.string().optional(),
  to: z.string(),
  message: z.union([z.string(), structuredMessageSchema]),
  from: z.string().optional(),
  summary: z.string().optional()
};

export const taskCreateSchema = {
  team_name: z.string().optional(),
  title: z.string().optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  active_form: z.string().optional(),
  owner: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
};

export const taskUpdateSchema = {
  team_name: z.string().optional(),
  task_id: z.string().optional(),
  taskId: z.string().optional(),
  subject: z.string().optional(),
  status: z.string().optional(),
  owner: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  active_form: z.string().optional(),
  notes: z.string().optional(),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional()
};

export const taskListSchema = {
  team_name: z.string().optional(),
  status: z.string().optional(),
  owner: z.string().optional()
};

export const taskGetSchema = {
  team_name: z.string().optional(),
  task_id: z.string().optional(),
  taskId: z.string().optional()
};

export const diagnosticsSchema = {
  include_debug: z.boolean().optional()
};

// Phase 12 (D-04): codex-team extension tool. TL-driven review / merge / escalate
// of an isolated worktree branch. Target run is resolved by run_id, else by
// teammate_id / member_id (most recent worktree run).
export const teamMergeSchema = {
  action: z.enum(["review", "merge", "escalate"]),
  teammate_id: z.string().optional(),
  member_id: z.string().optional(),
  run_id: z.string().optional(),
  team_name: z.string().optional()
};
