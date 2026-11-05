/**
 * The pages the shell can show above its views, named by the tenancy layer (the platform
 * operator's 平台管理 and its tabs). The core knows none: a single-user shell registers nothing,
 * so an address fragment like #platform-codes opens nothing. The multi-tenant layer registers its
 * tabs before the shell's state reads the address (tenancy/web/register-pages.ts is the first
 * thing the web door imports). Pure, so node:test reads it with page-hash.ts.
 */

let known: readonly string[] = [];

/** Names the pages (tabs) the address may open. */
export function registerShellPages(tabs: readonly string[]) {
  known = tabs;
}

/** Whether `tab` is a registered page. */
export function isShellPage(tab: string): boolean {
  return known.includes(tab);
}
