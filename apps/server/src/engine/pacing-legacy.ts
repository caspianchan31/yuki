// How records written before the ledger, the caps and the
// profiles were per site are read. They were all about one site; this module is the only place
// that names it, so the pacing itself never does.
export const legacySite = "reddit.com";
/** The cap fields of that time and the action each one capped. */
export const legacyCapFields = [
  ["maxCommentsPerDay", "comment"],
  ["maxPostsPerDay", "post"],
] as const;
/** The action an old ledger row counts as: a reply was counted as a comment. */
export const legacyAction = (action: string) => (action === "reply" ? "comment" : action);
/** The one profile record of that time. */
export const legacyProfileId = "profile";
export interface LegacyProfile {
  id: string;
  karma: number;
  createdUtc: number;
  recordedAt: string;
}
export const isLegacyProfile = (row: { id: string }): row is LegacyProfile =>
  row.id === legacyProfileId && "karma" in row;
/** Its facts, under the names the site gave them. */
export const legacyProfileFacts = (row: LegacyProfile) => ({
  karma: row.karma,
  created_utc: row.createdUtc,
});
