/**
 * The action ledger: one row per action a task reports on an account (`account-actions` under
 * the account's derived owner), kept for 30 days. A report that names an action and the site it
 * was taken on adds a row (service.ts `report`); a row without its address waits for the report
 * that confirms it. v1.5 removed the pacing that used to read this ledger (docs/pacing.md was
 * retired): the ledger only tells one action from another and what a run did.
 */
import type { ActionKind } from "../../../../packages/domain/src/environments.ts";
import { actionKindOf } from "../../../../packages/domain/src/environments.ts";

import { legacyAction, legacySite } from "./action-ledger-legacy.ts";

export const accountActionsKind = "account-actions";
/** Ledger rows older than this are removed when a new one is written. */
export const ledgerDays = 30;

/** One reported action on an account (the ledger, `account-actions` under the derived owner):
 * the site and the action the AI named, the address of what it made (when it gave one), the
 * report's links and when. Rows written before the platform-agnostic ledger have no `site`; they
 * read as `legacySite` says. */
export interface AccountAction {
  /** hash(`ledgerKey`). */
  id: string;
  taskId: string;
  /** The (project) owner of the task that reported it. */
  projectOwner: string;
  site?: string;
  action: string;
  permalink?: string | null;
  /** Written by versions before v1.5 (pacing); nothing writes it any more. */
  overCapacity?: boolean;
  links: string[];
  at: string;
  /** The address of what the action was done to, normalised (`normalizeLink`), and
   * the user name it was done to, as the AI reported them. */
  target?: string | null;
  targetUser?: string | null;
  /** Written by versions before v1.5 (jobs, siblings); nothing writes them any more. */
  jobId?: string | null;
  sibling?: { name: string; kind: "interaction" | "same_target" } | null;
  /** Set on the row a report without an address
   * that confirms the action wrote. The same task's report of that action with its address names
   * it in `confirms` (`confirmsRef`), takes the row over (service.ts `ledgerEntry`) and clears
   * this. */
  unconfirmed?: boolean | null;
  /** The card that first reported this row. While the
   * row waits, every later report of the action rewrites that card (service.ts `report`). */
  reportId?: string | null;
  /** Written by versions before v1.5 (the stranger view); nothing writes it any more. */
  stranger?: unknown;
}
/** The site a ledger row is on (a row from before the per-site ledger). */
export const siteOfRow = (row: Pick<AccountAction, "site">) => row.site ?? legacySite;
/** The kind a ledger row counts as: `<site>/<action>`. */
export function kindOfRow(row: Pick<AccountAction, "site" | "action">): ActionKind {
  if (row.site) return actionKindOf(row.site, row.action);
  return actionKindOf(legacySite, legacyAction(row.action));
}
/** The window of `usedLast7Days`, the siblings' recent actions and the chat's recentActions. */
export const recentWindowMs = 7 * 86400000;
/** A reported action whose word is a look, not a deed, is
 * not what the refusal asks for. */
export const lookOnlyPattern =
  /^(explore|exploring|browse|browsing|check|checked|checking|read|reading|look|looked|looking|review|reviewed|research|researched|search|searched|scan|scanned|visit|visited|view|viewed|inspect|inspected|monitor|monitored|observe|observed|patrol|patrolled|watch|watched|survey|surveyed|巡检|浏览|查看|观察)$/i;
export function lookOnly(action: string | undefined | null): boolean {
  return !!action && lookOnlyPattern.test(action.trim());
}
/** The time of the latest action on a ledger, or null. */
export function lastActionOf(rows: Pick<AccountAction, "at">[]): string | null {
  let last: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last === null ? null : new Date(last).toISOString();
}
/** A link as the ledger compares it: https, the host in lower case, no fragment, no trailing
 * slash; the path and query exactly as given. Null for something that is not a URL. No site is
 * known here: two hosts are two hosts. */
export function normalizeLink(link: string): string | null {
  try {
    const url = new URL(link);
    if (!url.hostname) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `https://${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
  } catch {
    return null;
  }
}
/** An address as it tells one item from another on the ledger: `normalizeLink`, with the
 * fragment kept when there is one (fork, report evidence: a reply that only its fragment tells
 * apart, `#comment-2`, and a page a single-page site routes by its fragment, `#/post/9`, are
 * items of their own; keyed without it, two replies under one post were one row and the second
 * went uncounted). A text fragment the browser adds to point at words (`#:~:text=`) is no part
 * of it. `normalizeLink` itself still drops the fragment: comparing what was acted on with what
 * another account made (accounts/operating.ts) reads a thread and its replies as one place. */
export function itemLink(link: string): string | null {
  const base = normalizeLink(link);
  if (!base) return null;
  const fragment = new URL(link).hash.replace(/:~:.*$/, "");
  return fragment && fragment !== "#" ? `${base}${fragment}` : base;
}
/** What tells one recorded action from another (hashed into the ledger row's id): the account,
 * the site, the action, and the address that tells the action apart when the report gave one
 * (`itemLink`; chat-reports.ts `reportEvidence`), else the report's text with its whitespace
 * collapsed. An item's address keys alone (one item is one action, however the sentence reads);
 * what an action without text was done to keys with the sentence (`withText`: two profile edits
 * on the account's page, or the same words for likes on two comments, are two actions). Never a
 * run or resume count, so an action reported again after a resume stays one row. */
export function ledgerKey(
  ledgerOwner: string,
  site: string,
  action: string,
  address: string | undefined,
  text: string,
  withText = false,
) {
  const link = address ? itemLink(address) : null;
  const words = text.trim().replace(/\s+/g, " ");
  return `${ledgerOwner}:${site}:${action}:${link ? (withText ? `${link} ${words}` : link) : words}`;
}
/** The reference a not-confirmed report's
 * answer gives for its ledger row, which the report of the same action with its address names in
 * `confirms`: the start of the row's id (a hash, nothing it says). */
export const confirmsRef = (rowId: string) => rowId.slice(0, 12);
