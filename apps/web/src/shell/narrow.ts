/**
 * Phase C (docs/web.md): the web app's phone layout, the width app.css switches at
 * (`@media (max-width: 860px)`): the roster is a drawer, a tab bar sits below, and the member
 * pane and the panels take the whole screen (so nothing under them is on screen).
 */
import { useSyncExternalStore } from "react";

export const narrowQuery = "(max-width: 860px)";

const subscribeNarrow = (change: () => void) => {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const isNarrow = () => window.matchMedia(narrowQuery).matches;

/** The window is at the phone layout's width; follows a resize or a rotation. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, isNarrow);
}
