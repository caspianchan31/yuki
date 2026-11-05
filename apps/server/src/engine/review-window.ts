// A review waits for the owner. One of a chat-started task has no expiry; a background one expires
// unsent after `backgroundReviewMs` (v1.4; it used to be sent when nobody declined). Called by the
// worker for a task waiting on its review.
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import { reviewExpired } from "../actions.ts";
import type { Store } from "../db.ts";

/** The review `actionId` once its time has ended: expired. Null while it is open or when it was
 * already decided. */
export async function settleDueReview(
  db: Store,
  owner: string,
  actionId: string,
  now: number,
): Promise<ActionProposal | null> {
  const action = await db.get<ActionProposal>(owner, "actions", actionId);
  if (action?.status !== "awaiting_review") return null;
  if (!reviewExpired(action, now)) return null;
  const expired = await db.compareAndSwap<ActionProposal>(
    owner,
    "actions",
    actionId,
    { status: "awaiting_review", expiresAt: action.expiresAt },
    { status: "expired" },
  );
  return expired ?? (await db.get<ActionProposal>(owner, "actions", actionId));
}

/** The owner's standing word on a kind of action, for one account or the project:
 * `always` sends at once, `ask` waits for an approval. Kept under the project's scope. */
export const reviewRulesKind = "review-rules";
export interface ReviewRule {
  /** `<account id or "project">:<action kind>`. */
  id: string;
  mode: "always" | "ask";
  at: string;
}
export const reviewRuleId = (environmentId: string | null, kind: string) =>
  `${environmentId ?? "project"}:${kind}`;
/** The kind a rule is kept for. An app's call is one app's one tool (v1.4): 总是允许 on a Notion
 * page edit never lets a GitHub write through. */
export const ruleKindOf = (action: Pick<ActionProposal, "kind" | "data">) => {
  if (action.kind !== "app.call") return action.kind;
  const data = action.data as { app: string; tool: string };
  return `app.call:${data.app}__${data.tool}`;
};
/** The rule that applies: the account's own, else the project's. */
export async function reviewRuleFor(
  db: Store,
  scope: string,
  environmentId: string | null,
  kind: string,
): Promise<ReviewRule | null> {
  if (environmentId) {
    const own = await db.get<ReviewRule>(scope, reviewRulesKind, reviewRuleId(environmentId, kind));
    if (own) return own;
  }
  return db.get<ReviewRule>(scope, reviewRulesKind, reviewRuleId(null, kind));
}
