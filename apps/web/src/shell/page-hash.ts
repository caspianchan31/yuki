/**
 * Phase C: the page above the shell's views lives in the address, a bare token and nothing else,
 * so a reload (or a bookmark) opens it again: 平台管理 with its tab (#platform-codes) or 进度汇报
 * (#progress). Any other page clears it; an address fragment that is none of these (a password
 * reset link's token, /reset#…) is never read as a page or rewritten. A page opening over none
 * adds a history entry, so the browser's Back closes it (state.ts follows Back and Forward); one
 * closing in the app goes back over the entry the app added, also after a reload (the entry keeps
 * its mark in history.state), so no dead entry is left for Back. A page the address opened (a
 * bookmark, a typed address) has no mark: closing it replaces the address, and Back leaves the
 * app as it would have. Pure (no alias imports), so node:test reads it
 * (apps/mobile/test/shell-progress.test.ts); state.ts keeps the frame.
 */

import { isShellPage } from "./shell-pages.ts";

/** A tab of the tenancy layer's page (平台管理); the names are registered (shell-pages.ts). */
export type PlatformTab = string;

const hashPrefix = "#platform-";
const progressHash = "#progress";
export type PageInHash = { platform: PlatformTab } | { progress: true } | null;
/** The page an address fragment names. */
export function pageOfHash(hash: string): PageInHash {
  if (hash === progressHash) return { progress: true };
  if (!hash.startsWith(hashPrefix)) return null;
  const tab = hash.slice(hashPrefix.length);
  return isShellPage(tab) ? { platform: tab } : null;
}
/** The fragment for a page: "" for none. */
export function hashOfPage(page: { platform: PlatformTab | null; progress: boolean }): string {
  return page.platform ? `${hashPrefix}${page.platform}` : page.progress ? progressHash : "";
}
/** The page this address names now (none outside a browser). */
export const pageInHash = (): PageInHash =>
  typeof window === "undefined" ? null : pageOfHash(window.location.hash);
/** How the address follows a page (`next`, its fragment) from `hash`: "push" for a page opening
 * over none (Back closes it), "back" for a page closing on an entry the app added over its own
 * page-less one (`added`: no dead entry left for Back), "replace" otherwise (one page for
 * another, or a page the address opened); null when there is nothing to change (a fragment that
 * is not a page's stays). */
export function hashMove(
  hash: string,
  next: string,
  added: boolean,
): "push" | "back" | "replace" | null {
  if (hash === next || (!next && !pageOfHash(hash))) return null;
  if (!pageOfHash(hash)) return "push";
  return !next && added ? "back" : "replace";
}

// An entry the app pushed over its own page-less entry carries this mark in history.state, which
// a reload keeps (the browser keeps the entries' state, and the one behind is still the app's).
// A page opened by its address has none: the entry behind it may be another site.
const markKey = "openmusePage";
/** Whether the entry `held` (history.state) was pushed by the app, by this load or one before. */
export const pushedByApp = (held: unknown) =>
  !!held && typeof held === "object" && !!(held as Record<string, unknown>)[markKey];

/** Puts the page in the address (see `hashMove`). */
export function writeHash(page: { platform: PlatformTab | null; progress: boolean }) {
  if (typeof window === "undefined") return;
  const { history, location } = window;
  const next = hashOfPage(page);
  const held: unknown = history.state;
  const move = hashMove(location.hash, next, pushedByApp(held));
  if (!move) return;
  const url = `${location.pathname}${location.search}${next}`;
  try {
    if (move === "back") history.back();
    else if (move === "push") {
      const base = held && typeof held === "object" ? held : {};
      history.pushState({ ...base, [markKey]: true }, "", url);
    } else history.replaceState(held, "", url);
  } catch {
    // An address that cannot change: the page still opens, a reload leaves it.
  }
}
