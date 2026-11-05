// The account facts that come from signing in and
// from the proxy self-check. Plain records (not secrets), kept under the account's derived owner
// (or, for the project's own logins, under the project's owner), so they go with the account
// whichever project it is in, and are removed with it.
import {
  type BrowserCheck,
  type ProxyCheck,
  type SignInPage,
  type SiteSignInFact,
} from "../../../../packages/domain/src/credentials.ts";
import type { Store } from "../db.ts";

export const signInKind = "site-sign-in";
/** A site the owner said he handled on the desktop (他点了「我弄好了」,
 * or a code was typed for it) while its fact asked him to (`needs_code`, `needs_owner`), until a
 * newer fact for the site is recorded. Kept beside the facts, one per site. */
export const ownerHandledKind = "sign-in-owner-handled";
export const proxyCheckKind = "proxy-check";
export const proxyCheckId = "latest";
/** What the run last read on the bot-detection check page, one per
 * account (or project), beside the proxy check. */
export const browserCheckKind = "browser-check";
export const browserCheckId = "latest";

type StoredSignIn = SiteSignInFact & { id: string };
/** The owner said he handled `site` himself: when (`at`), the task owner the recheck came from
 * (`owner`), the account (null: the project's default desktop), and when the dedicated sign-in
 * check for it was started (`checkAt`, null until then: one check each time). */
export interface OwnerHandled {
  id: string;
  site: string;
  at: string;
  owner: string;
  environmentId: string | null;
  checkAt: string | null;
}
/** The statuses the owner answers himself: only he could act on them on the desktop. */
export const ownerHandledStatuses: ReadonlySet<string> = new Set(["needs_code", "needs_owner"]);
/** The sites whose check waits for the owner, as `readSignIns`
 * reports them: a fact only he can act on that he has not said he handled (`ownerHandledAt`).
 * A run leaves them alone (model.ts `waitingForOwnerRule`) until he has. */
export const waitingForOwner = (facts: readonly SiteSignInFact[]) =>
  facts
    .filter((fact) => ownerHandledStatuses.has(fact.status) && !fact.ownerHandledAt)
    .map((fact) => ({ site: fact.site, status: fact.status, since: fact.at }));
/** Whether `handled` still stands for `fact`: the fact still asks the owner and nothing was
 * recorded for the site since he said so. */
export const handledStands = (fact: SiteSignInFact | undefined, handled: OwnerHandled) =>
  !!fact && ownerHandledStatuses.has(fact.status) && fact.at <= handled.at;
/** An owner's handling with no record this long after its check started (or, before any check,
 * after he said so) is unconfirmed: the owner reads 「还没确认上」 instead of 「正在确认」 and can
 * press 我弄好了 again. The record stands either way: only a newer fact for the site ends it. */
export const ownerHandledUnconfirmedMs = 10 * 60 * 1000;
/** Whether the owner's handling `handled` has waited too long for a record (`ownerHandledStale`). */
export const handledStale = (handled: OwnerHandled, now: number) =>
  now - Date.parse(handled.checkAt ?? handled.at) >= ownerHandledUnconfirmedMs;
type StoredCheck = ProxyCheck & { id: string };
type StoredBrowserCheck = BrowserCheck & { id: string };

/** Every site's latest sign-in fact of an account (or the project), by site. A fact the owner
 * said he handled and no newer fact confirmed carries `ownerHandledAt` (the AI is confirming it),
 * and `ownerHandledStale` once that has gone unanswered too long (`handledStale`, as of `now`). */
export async function readSignIns(
  db: Pick<Store, "list">,
  factOwner: string,
  now: number = Date.now(),
): Promise<SiteSignInFact[]> {
  const rows = await db.list<StoredSignIn>(factOwner, signInKind);
  const handled = new Map(
    (await db.list<OwnerHandled>(factOwner, ownerHandledKind)).map((row) => [row.site, row]),
  );
  return rows
    .map(({ id: _, ...fact }): SiteSignInFact => {
      const row = handled.get(fact.site);
      const { ownerHandledAt: _old, ownerHandledStale: _stale, ...plain } = fact;
      if (!row || !handledStands(plain, row)) return plain;
      return {
        ...plain,
        ownerHandledAt: row.at,
        ...(handledStale(row, now) ? { ownerHandledStale: true } : {}),
      };
    })
    .sort((a, b) => a.site.localeCompare(b.site));
}
/** Records a site's fact; the owner's handling of the site it follows is answered by it and goes. */
export async function writeSignIn(db: Store, factOwner: string, fact: SiteSignInFact) {
  const { ownerHandledAt: _, ownerHandledStale: _stale, ...plain } = fact;
  await db.put<StoredSignIn>(factOwner, signInKind, { id: plain.site, ...plain });
  await db.remove(factOwner, ownerHandledKind, plain.site);
}
/** Sets only the page of `site`'s fact (the fact and any
 * owner's handling of it stand). */
export async function writePage(
  db: Pick<Store, "get" | "put">,
  factOwner: string,
  site: string,
  page: SignInPage,
) {
  const row = await db.get<StoredSignIn>(factOwner, signInKind, site);
  if (row) await db.put<StoredSignIn>(factOwner, signInKind, { ...row, page });
}
/** The owner's handlings of an account (or the project) still waiting for a fact. */
export async function readOwnerHandled(db: Pick<Store, "list">, factOwner: string) {
  return db.list<OwnerHandled>(factOwner, ownerHandledKind);
}
export async function readProxyCheck(db: Store, factOwner: string): Promise<ProxyCheck | null> {
  const row = await db.get<StoredCheck>(factOwner, proxyCheckKind, proxyCheckId);
  if (!row) return null;
  const { id: _, ...check } = row;
  return check;
}
export async function writeProxyCheck(db: Store, factOwner: string, check: ProxyCheck) {
  await db.put<StoredCheck>(factOwner, proxyCheckKind, { id: proxyCheckId, ...check });
}
/** Removes the proxy's last check (the account no longer has a proxy). */
export async function removeProxyCheck(db: Store, factOwner: string) {
  await db.remove(factOwner, proxyCheckKind, proxyCheckId);
}
export async function readBrowserCheck(
  db: Pick<Store, "get">,
  factOwner: string,
): Promise<BrowserCheck | null> {
  const row = await db.get<StoredBrowserCheck>(factOwner, browserCheckKind, browserCheckId);
  if (!row) return null;
  const { id: _, ...check } = row;
  return check;
}
export async function writeBrowserCheck(db: Store, factOwner: string, check: BrowserCheck) {
  await db.put<StoredBrowserCheck>(factOwner, browserCheckKind, { id: browserCheckId, ...check });
}
/** Removes one site's sign-in fact (the login no longer serves that account). */
export async function removeSignIn(db: Store, factOwner: string, site: string) {
  await db.remove(factOwner, signInKind, site);
  await db.remove(factOwner, ownerHandledKind, site);
}
/** The sign-ins and the
 * browser check belong to the desktop, so when it is destroyed every site's fact goes back to
 * `pending` (the login stays saved, the new desktop has not signed in) and the browser check
 * and any owner's handling go. The proxy check stays: the proxy is the account's, not the desktop's. */
export async function forgetDesktopSignIns(db: Store, factOwner: string) {
  const at = new Date().toISOString();
  for (const row of await db.list<StoredSignIn>(factOwner, signInKind))
    await db.put<StoredSignIn>(factOwner, signInKind, {
      id: row.id,
      site: row.site,
      status: "pending",
      detail: null,
      at,
      by: { owner: true },
    });
  for (const row of await db.list<{ id: string }>(factOwner, ownerHandledKind))
    await db.remove(factOwner, ownerHandledKind, row.id);
  await db.remove(factOwner, browserCheckKind, browserCheckId);
}
/** Removes every sign-in fact, the proxy check and the browser check (the account is deleted). */
export async function removeFacts(db: Store, factOwner: string) {
  for (const row of await db.list<{ id: string }>(factOwner, signInKind))
    await db.remove(factOwner, signInKind, row.id);
  for (const row of await db.list<{ id: string }>(factOwner, ownerHandledKind))
    await db.remove(factOwner, ownerHandledKind, row.id);
  await db.remove(factOwner, proxyCheckKind, proxyCheckId);
  await db.remove(factOwner, browserCheckKind, browserCheckId);
}
