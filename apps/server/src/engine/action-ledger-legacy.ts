// How ledger rows written before the ledger was per site are read. They were all about one site;
// this module is the only place that names it, so the ledger itself never does.
export const legacySite = "reddit.com";
/** The action an old ledger row counts as: a reply was counted as a comment. */
export const legacyAction = (action: string) => (action === "reply" ? "comment" : action);
