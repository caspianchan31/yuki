/**
 * Phase C: the frame's own state, beside ShellNav (shell/nav.tsx, shared with the phone): the
 * platform operator's page, the ⌘K palette, the phone drawer and the member pane. Kept in one
 * small store so the roster, the top bar and the tab bar agree.
 */
import { useSyncExternalStore } from "react";
import { type PlatformTab, pageInHash, writeHash } from "./page-hash";

// The page above the views lives in the address (#platform-codes), and the browser's Back closes
// it: page-hash.ts.
export type { PlatformTab } from "./page-hash";

const atLoad = pageInHash();

export interface FrameState {
  /** The platform operator's page (平台管理) and its tab; null when another page shows. */
  platform: PlatformTab | null;
  /** A field of 平台管理 to focus once it shows (⌘K 重置用户密码 → 空间 → 找用户;
   * ⌘K 生成邀请码 → 邀请码 → 备注); the field clears it. */
  platformFocus: string | null;
  palette: boolean;
  /** What the palette's box starts with (typed words; "" = empty). */
  paletteQuery: string;
  /** The group the palette opened on (更多: the commands; the project crumb: the projects),
   * shown beside the box rather than typed into it; null = everything. */
  paletteGroup: PaletteGroup | null;
  drawer: boolean;
  /** The member pane is open (a wide window opens it by default). */
  pane: boolean;
  /** 详情 was pressed: the pane shows only then (or for a member picked). */
  details: boolean;
  /** An account picked in a row or a face, shown in the pane; null = the conversation's. */
  peek: string | null;
  /** The new-member dialog (shell/NewMember.tsx) is open. */
  newMember: boolean;
  /** The new-group dialog (shell/NewGroup.tsx) is open. */
  newGroup: boolean;
}

export type PaletteGroup = "commands" | "projects" | "accounts" | "tasks" | "spaces";

// The pane starts open only where it docks beside the conversation (on a phone it would cover it).
let state: FrameState = {
  platform: atLoad && "platform" in atLoad ? atLoad.platform : null,
  platformFocus: null,
  palette: false,
  paletteQuery: "",
  paletteGroup: null,
  drawer: false,
  pane: typeof window !== "undefined" && window.innerWidth > 1180,
  details: false,
  peek: null,
  newMember: false,
  newGroup: false,
};
const listeners = new Set<() => void>();

export function setFrame(change: Partial<FrameState>) {
  const next = { ...change };
  // A closed pane forgets that 详情 opened it.
  if (next.pane === false) next.details = false;
  const before = state;
  state = { ...state, ...next };
  if (state.platform !== before.platform) writeHash({ platform: state.platform, progress: false });
  for (const listener of listeners) listener();
}

/** Closes the panel open now (PanelHost sets it while a panel shows; null without one). */
let closeOpenPanel: (() => void) | null = null;
/** PanelHost, while a panel shows: the browser's Back over a page closes the panel first (see
 * below). Returns the unregister. */
export function backClosesPanel(close: () => void): () => void {
  closeOpenPanel = close;
  return () => {
    if (closeOpenPanel === close) closeOpenPanel = null;
  };
}

// The browser's Back and Forward move between a page and what it opened over (page-hash.ts adds
// the entry): the frame follows the address without writing it again. A panel open over the page
// (a phone's full-screen sheet) is what Back closes first: the page stays, its entry is put back,
// and the next Back closes the page.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const page = pageInHash();
    const platform = page && "platform" in page ? page.platform : null;
    if (state.platform === platform) return;
    if (!platform && closeOpenPanel) {
      closeOpenPanel();
      writeHash({ platform: state.platform, progress: false });
      return;
    }
    state = { ...state, platform };
    for (const listener of listeners) listener();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const get = () => state;

export function useFrame(): FrameState {
  return useSyncExternalStore(subscribe, get, get);
}

/** Opens an account in the member pane (rows, faces, the roster, ⌘K). 平台管理 has no
 * pane beside it, so an account picked there leaves it. */
export function peekAccount(environmentId: string) {
  setFrame({ peek: environmentId, pane: true, drawer: false, platform: null });
}

/** Opens a member's profile card (资料卡): on a wide window beside the conversation, on a phone
 * over it. */
export function openMemberCard(environmentId: string) {
  setFrame({ peek: environmentId, pane: true, details: true, drawer: false, platform: null });
}
