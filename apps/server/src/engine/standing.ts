// The facts a standing task's
// runs get about their own plan and what they actually did, from the ledger. A task on a project's
// default desktop has no account, so its actions go on the project's own ledger (its scope, each
// row with the task's id): before, it wrote none, and a task that never acted looked like one
// that had nothing to report.
import {
  type AgentTask,
  type OperatingPlan,
  operatingPlanOf,
} from "../../../../packages/domain/src/agent.ts";
import {
  isStandingTask,
  type RecentAction,
  recentActionsShown,
  type StandingActivity,
} from "../../../../packages/domain/src/standing.ts";
import { readPlan } from "../accounts/records.ts";
import type { Store } from "../db.ts";
import { envOwner, isEnvironmentId, scopeOfOwner } from "../environments.ts";
import {
  type AccountAction,
  accountActionsKind,
  confirmsRef,
  kindOfRow,
  recentWindowMs,
} from "./pacing.ts";

/** The ledger of a project's default desktop: the project's own scope. */
export const defaultDesktopLedger = (owner: string) => scopeOfOwner(owner);
/** The account a task is bound to, as its ledger owner; null on the default desktop. */
function accountLedgerOf(owner: string, task: Pick<AgentTask, "input">) {
  const environmentId = task.input?.environmentId;
  return typeof environmentId === "string" && isEnvironmentId(environmentId)
    ? envOwner(owner, environmentId)
    : null;
}
/** Where a task's reported actions are recorded: its account's ledger; for a standing task on the
 * project's default desktop, the project's own (`defaultDesktopLedger`); null for any other task
 * on the default desktop, whose reports record no action. */
export function actionLedgerOf(owner: string, task: Pick<AgentTask, "input" | "state">) {
  return (
    accountLedgerOf(owner, task) ?? (isStandingTask(task) ? defaultDesktopLedger(owner) : null)
  );
}
/** The ledger rows that are a task's own doing: an account's whole ledger (its plan is the
 * account's, whatever task acted); on the default desktop, the rows this task wrote. */
export async function ownActions(
  db: Store,
  owner: string,
  task: Pick<AgentTask, "id" | "input" | "state">,
) {
  const account = accountLedgerOf(owner, task);
  const ledger = account ?? actionLedgerOf(owner, task);
  if (!ledger) return [];
  const rows = await db.list<AccountAction>(ledger, accountActionsKind);
  return account ? rows : rows.filter((row) => row.taskId === task.id);
}
/** What a standing task's plan says about its pace and what it actually did (null for any other
 * task): the plan is the account's own when it runs on one (else the task's), the actions its
 * ledger's (`ownActions`). Read for every run's data (`planAndActions`) and by the owner's
 * screens (`standingBehind`). */
export async function standingActivity(
  db: Store,
  owner: string,
  task: Pick<AgentTask, "id" | "input" | "state">,
  now = new Date(),
): Promise<StandingActivity | null> {
  if (!isStandingTask(task)) return null;
  const account = accountLedgerOf(owner, task);
  const plan: Pick<OperatingPlan, "pace" | "setAt"> | null =
    (account ? await readPlan(db, account) : null) ?? operatingPlanOf(task.state);
  const since = now.getTime() - recentWindowMs;
  const actionsLast7Days: Record<string, number> = {};
  let unconfirmedLast7Days = 0;
  let lastActionAt: string | null = null;
  const recent: RecentAction[] = [];
  for (const row of await ownActions(db, owner, task)) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    if (!lastActionAt || at > Date.parse(lastActionAt)) lastActionAt = row.at;
    if (at < since) continue;
    const kind = kindOfRow(row);
    actionsLast7Days[kind] = (actionsLast7Days[kind] ?? 0) + 1;
    if (row.unconfirmed) unconfirmedLast7Days += 1;
    recent.push({
      site: row.site ?? null,
      action: row.action,
      target: row.target ?? null,
      permalink: row.permalink ?? null,
      at: row.at,
      ...(row.stranger ? { stranger: row.stranger } : {}),
      ...(row.unconfirmed
        ? { unconfirmed: { confirms: confirmsRef(row.id), links: (row.links ?? []).slice(0, 3) } }
        : {}),
    });
  }
  // Newest first: what was just done is what the next choice must steer around.
  recent.sort((a, b) => b.at.localeCompare(a.at));
  return {
    planPace: plan?.pace?.trim() || null,
    planSetAt: plan?.setAt ?? null,
    actionsLast7Days,
    unconfirmedLast7Days,
    lastActionAt,
    recentActions: recent.slice(0, recentActionsShown),
  };
}
