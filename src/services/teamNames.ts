export function canonicalizeTeamName(teamName: string): string {
  const canonicalName = teamName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!canonicalName) {
    throw new Error("Team name must include at least one supported character.");
  }

  return canonicalName;
}
