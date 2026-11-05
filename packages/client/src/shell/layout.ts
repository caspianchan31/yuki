/**
 * The layout hook. The breakpoints and the Layout shape are in
 * layout-core.ts (pure, tested).
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useWindowWidth } from "../platform-env";
import { type Layout, layoutFor, panelAfterClose } from "./layout-core";
import { useShellNav } from "./nav";
import { getProView, subscribeProView } from "./view-mode";

export type { Layout, LayoutMode } from "./layout-core";
export { breakpoints, layoutFor, layoutMode } from "./layout-core";

/** The current layout; re-renders when the window crosses a breakpoint or resizes. */
export function useLayoutMode(): Layout {
  const width = useWindowWidth();
  const pro = useSyncExternalStore(subscribeProView, getProView, getProView);
  return useMemo(() => layoutFor(width, pro), [width, pro]);
}

/**
 * Closes the open panel. A card opened over the desktop accounts page's docked account detail
 * (移到… / 分配到…, 编辑, 打开桌面) goes back to that detail instead of closing it too (design
 * §3.6); every other panel just closes. Stable across panel changes (it reads the latest state),
 * so the old WorkspaceContext that hands it out as close() is not rebuilt on every panel.
 */
export function useClosePanel(): () => void {
  const { mode } = useLayoutMode();
  const { view, panel, openPanel, closePanel } = useShellNav();
  const latest = useRef({ mode, view, panel });
  latest.current = { mode, view, panel };
  return useCallback(() => {
    const next = panelAfterClose(latest.current);
    if (next) openPanel(next);
    else closePanel();
  }, [openPanel, closePanel]);
}
