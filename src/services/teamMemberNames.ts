export function canonicalizeTeamMateName(name: string): string {
  const canonicalName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!canonicalName) {
    throw new Error("TeamMate name must include at least one supported character.");
  }

  return canonicalName;
}

export function normalizeTeamMateDisplayName(name: string): string {
  const displayName = name.trim();
  if (!displayName) {
    throw new Error("TeamMate name must include a display name.");
  }

  return displayName;
}

export function buildPublicTeamMateId(
  canonicalName: string,
  teamName: string
): string {
  return `${canonicalName}@${teamName}`;
}

export function buildInternalTeamMateMemberId(
  teamId: string,
  canonicalName: string
): string {
  return `teammate:${teamId}:${canonicalName}`;
}
