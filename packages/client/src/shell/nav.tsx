/**
 * The shell's navigation state, one place for every surface.
 *   view     "work" (the project workbench, default) or "accounts" (全局账号与代理)
 *   panel    the one panel open at a time (task detail, account detail, settings, …); old detail
 *            sheets that still exist (computer, review, browser, file, mail) open as "legacy"
 *   drawer   the live rail drawer on phone (and which section to scroll to)
 *   composer a one-shot request to prefill the active chat's input and pick its operating account
 *            (「在聊天里派活…」, the empty state's prefill)
 *   receipts the one-line receipt a need card collapses into after the person acted, shared by
 *            the chat and the rail (design §5.4: answered in one place, closed in both)
 * WorkspaceContext.open(detail) from old code is routed here (`routeDetail`), so old cards
 * that call open({ type: "task" }) land on the new task detail.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Section } from "../../../../packages/domain/src";
import type { Detail } from "../workspace";
import { panelAfterViewChange } from "./layout-core";

export type RailSection = "needs" | "accounts" | "tasks" | "reports" | "notes";

export type ShellPanel =
  | { kind: "task"; taskId: string }
  /** One of the project's jobs (「活」). */
  | { kind: "job"; jobId: string }
  | { kind: "account"; environmentId: string }
  /** The space's founder, its order of the projects and what
   * each project gave it. */
  | { kind: "founder" }
  | { kind: "notes" }
  | { kind: "assign"; environmentId: string }
  | { kind: "join" }
  | { kind: "accountEditor"; environmentId?: string }
  | { kind: "newTask"; environmentId?: string | null }
  | { kind: "settings" }
  /** 设置 → 成员, and the operator's 所有空间. */
  | { kind: "members" }
  | { kind: "platform" }
  /** 设置 → 订阅, and a referrer's 介绍人后台. */
  | { kind: "billing" }
  /** A store space's 店铺 page. */
  | { kind: "store" }
  | { kind: "referrer" }
  /** `form` "new" opens the panel with the create form (the column's 「+ 新项目」). */
  | { kind: "projects"; form?: "new" }
  | { kind: "threads" }
  /** Add a credential (preset: its kind, a site and who uses it) or replace
   * parts of one (entryId); and a credential's history (none: the project's whole history). */
  | {
      kind: "credentialEditor";
      entryId?: string;
      preset?: {
        kind: "proxy" | "site_login" | "mailbox";
        site?: string;
        environmentId?: string | null;
      };
      /** The project the credential belongs to (an account of another project, edited from the
       * global accounts page); absent: the current project. */
      projectId?: string | null;
      /** That account's name, when it is not one of the current project's. */
      accountName?: string;
    }
  | { kind: "credentialHistory"; entryId?: string }
  /** An old detail sheet (computer desktop, upstream review, browser, file, mail, event…).
   * `afterClose` runs once the sheet is closed or replaced, however that happens (a desktop
   * opened for a site that needed a code: the AI looks again once the owner is done there). */
  | { kind: "legacy"; detail: Detail; afterClose?: () => void };

/** "credentials" is the current project's credentials page. */
export type ShellView = "work" | "accounts" | "credentials";

export interface ComposerRequest {
  id: number;
  /** Text to put in the input (not sent, unless `send`). */
  text: string;
  /** Said in the chat at once, for the person (a card's quick saying). */
  send?: boolean;
  /** Switch the conversation's operating account first; undefined = leave it. */
  environmentId?: string | null;
}

export interface Receipt {
  text: string;
  /** When the person acted, by this device's clock (the time the receipt line shows). */
  at: string;
  /** The task's `updatedAt` in the server's answer to the act, when it carried one: a need is
   * covered by the receipt when it was raised at or before this, so a client clock running ahead
   * of the server never hides a need raised again after the act. */
  since?: string;
}

export interface ShellNav {
  view: ShellView;
  setView: (view: ShellView) => void;
  panel: ShellPanel | null;
  openPanel: (panel: ShellPanel) => void;
  closePanel: () => void;
  /** The account whose desktop 看看 pinned beside the timeline (shown
   * from 1024, layout-core.pinnedDesktop); null when none. */
  pinned: string | null;
  pinDesktop: (environmentId: string) => void;
  unpinDesktop: () => void;
  drawerOpen: boolean;
  /** Opens the phone drawer (no-op on wide layouts) and asks the rail to show `section`. */
  openDrawer: (section?: RailSection) => void;
  closeDrawer: () => void;
  /** The section the rail should scroll to; cleared by the rail once shown. */
  focusSection: RailSection | null;
  clearFocusSection: () => void;
  composer: ComposerRequest | null;
  /** Prefill the active chat's input (and pick its operating account); closes panels and the
   * accounts page so the chat is visible. */
  prefill: (text: string, environmentId?: string | null) => void;
  /** Says `text` in the active chat for the person (a card's 「换个号」), showing
   * the chat; it is a message from him, not an approval. */
  say: (text: string) => void;
  /** The chat calls this once it applied the request with this id. */
  consumeComposer: (id: number) => void;
  receipts: Record<string, Receipt>;
  /** The chat's guidance card 需要你 pointed at (its key); the chat
   * outlines it and scrolls to it. */
  guideFocus: string | null;
  /** Shows the chat (closing panels, the accounts or credentials page and the drawer) and the
   * card with this key. */
  showGuide: (key: string) => void;
  clearGuideFocus: () => void;
  /** Record the receipt of an action on task `taskId` (answer, retry, continue now); `since` is
   * the server's `updatedAt` of the task in its answer to the act. */
  addReceipt: (taskId: string, text: string, since?: string) => void;
}

const NavContext = createContext<ShellNav | null>(null);

export function useShellNav(): ShellNav {
  const value = useContext(NavContext);
  if (!value) throw new Error("Shell navigation is unavailable");
  return value;
}

/** Where an old `open(detail)` call lands in the new shell: a panel, the accounts page
 * (topology), or nowhere (notifications and the ≡ menu are gone, design §7). */
export function routeDetail(detail: Detail): { panel: ShellPanel | null; view?: ShellView } {
  switch (detail.type) {
    case "task":
      return { panel: { kind: "task", taskId: detail.taskId } };
    case "delegate":
      return { panel: { kind: "newTask" } };
    case "topology":
      return { panel: null, view: "accounts" };
    case "notifications":
    case "menu":
      return { panel: null };
    default:
      return { panel: { kind: "legacy", detail } };
  }
}

/** Where an old `navigate(section)` call lands: the old tabs are not mounted (design §7). */
export function railSectionForLegacy(section: Section): RailSection | null {
  switch (section) {
    case "activity":
      return "tasks";
    case "apps":
    case "connections":
      return "notes";
    case "environments":
      return "accounts";
    default:
      return null;
  }
}

// A composer request made just before a project switch (「在聊天里派活…」 on an account of
// another project): the workspace remounts on a switch, so it is carried over here and picked up
// by the next ShellNavProvider.
let carried: Omit<ComposerRequest, "id"> | null = null;
/** Prefill the chat of the project that is about to open (call right before selecting it). */
export function carryComposerAcrossSwitch(text: string, environmentId?: string | null) {
  carried = { text, environmentId };
}
// A panel to open in the project that is about to open (the founder panel's stuck task of
// another project), carried over the remount the same way.
let carriedPanel: ShellPanel | null = null;
/** Open `panel` in the project that is about to open (call right before selecting it). */
export function carryPanelAcrossSwitch(panel: ShellPanel) {
  carriedPanel = panel;
}
// A short notice (toast) saying why the project changed (「已切到未分组：创始人在
// 这里」), carried over the remount and shown by the next workspace.
let carriedNotice = "";
/** Show `text` as a toast in the project that is about to open (call right before selecting it). */
export function carryNoticeAcrossSwitch(text: string) {
  carriedNotice = text;
}
/** The carried notice (the next workspace's first toast); `clearCarriedNotice` once shown. */
export function carriedNoticeText(): string {
  return carriedNotice;
}
export function clearCarriedNotice() {
  carriedNotice = "";
}

export function ShellNavProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<ShellView>("work");
  const [panel, setPanel] = useState<ShellPanel | null>(() => {
    const next = carriedPanel;
    carriedPanel = null;
    return next;
  });
  // A panel's afterClose runs when it stops being the open panel.
  const shownPanel = useRef<ShellPanel | null>(null);
  useEffect(() => {
    const before = shownPanel.current;
    shownPanel.current = panel;
    if (before && before !== panel && before.kind === "legacy") before.afterClose?.();
  }, [panel]);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Every view change goes through here, so no caller can leave a panel of the other view open.
  const setView = useCallback((next: ShellView) => {
    const from = viewRef.current;
    if (from !== next)
      setPanel((current) => panelAfterViewChange({ from, to: next, panel: current }));
    viewRef.current = next;
    setViewState(next);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusSection, setFocusSection] = useState<RailSection | null>(null);
  const [composer, setComposer] = useState<ComposerRequest | null>(() => {
    const next = carried;
    carried = null;
    return next ? { id: Date.now(), ...next } : null;
  });
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const openPanel = useCallback((next: ShellPanel) => setPanel(next), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const [pinned, setPinned] = useState<string | null>(null);
  const pinDesktop = useCallback((environmentId: string) => setPinned(environmentId), []);
  const unpinDesktop = useCallback(() => setPinned(null), []);
  const openDrawer = useCallback((section?: RailSection) => {
    setDrawerOpen(true);
    setFocusSection(section ?? null);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const clearFocusSection = useCallback(() => setFocusSection(null), []);
  const prefill = useCallback((text: string, environmentId?: string | null) => {
    setPanel(null);
    setDrawerOpen(false);
    setView("work");
    setComposer({ id: Date.now(), text, environmentId });
  }, []);
  const say = useCallback((text: string) => {
    setPanel(null);
    setDrawerOpen(false);
    setView("work");
    setComposer({ id: Date.now(), text, send: true });
  }, []);
  const [guideFocus, setGuideFocus] = useState<string | null>(null);
  const showGuide = useCallback(
    (key: string) => {
      setPanel(null);
      setDrawerOpen(false);
      setView("work");
      setGuideFocus(key);
    },
    [setView],
  );
  const clearGuideFocus = useCallback(() => setGuideFocus(null), []);
  const consumeComposer = useCallback(
    (id: number) => setComposer((current) => (current?.id === id ? null : current)),
    [],
  );
  const addReceipt = useCallback(
    (taskId: string, text: string, since?: string) =>
      setReceipts((current) => ({
        ...current,
        [taskId]: { text, at: new Date().toISOString(), ...(since ? { since } : {}) },
      })),
    [],
  );
  const value = useMemo<ShellNav>(
    () => ({
      view,
      setView,
      panel,
      openPanel,
      closePanel,
      pinned,
      pinDesktop,
      unpinDesktop,
      drawerOpen,
      openDrawer,
      closeDrawer,
      focusSection,
      clearFocusSection,
      composer,
      prefill,
      say,
      consumeComposer,
      receipts,
      addReceipt,
      guideFocus,
      showGuide,
      clearGuideFocus,
    }),
    [
      guideFocus,
      showGuide,
      clearGuideFocus,
      view,
      panel,
      openPanel,
      closePanel,
      pinned,
      pinDesktop,
      unpinDesktop,
      drawerOpen,
      openDrawer,
      closeDrawer,
      focusSection,
      clearFocusSection,
      composer,
      prefill,
      say,
      consumeComposer,
      receipts,
      addReceipt,
    ],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
