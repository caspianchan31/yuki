/**
 * Phase C (docs/web.md): where the web app is served. Production keeps the Expo app at the
 * site root until the owner approves the switch; the new app is served under /next/ for the
 * walk-through (vite build --base /next/). Paths the app reads or writes go through here.
 */
export const base = import.meta.env.BASE_URL;

/** The current path as the app's routes see it: the base taken off ("/next/signup" → "/signup"). */
export function appPath(): string {
  const path = window.location.pathname;
  if (base !== "/" && path.startsWith(base)) return `/${path.slice(base.length)}`;
  if (base !== "/" && `${path}/` === base) return "/";
  return path;
}

/** Back to the app's own root without a reload. */
export function toAppRoot() {
  window.history.replaceState(null, "", base);
}

/** A file from public/ (the mascot), under the base. */
export const asset = (name: string) => `${base}${name}`;
