/**
 * Three widths, switched by the window width, no navigation library.
 *   < 768        phone: one column; the live rail slides in from the right as a drawer (88% of
 *                the width, at most 440)
 *   768 – 1099   tablet: chat + docked live rail 340px
 *   ≥ 1100       desktop: chat (at most 760) + live rail 360px
 * (UI v1 phase 1 removed the project column; the pro view, view-mode.ts, brings it back on
 * desktop with the docked rail from tablet up. The simple view switches projects from the
 * header's project ▾, see canSwitchProject.)
 * (v0.8 ADHD pass) Every width shows the 下一步 bar above the chat (NextStepBar).
 * The global accounts page from 1100 (design §3.6): a 地区 column, and the selected account's
 * detail docked on the right (340px) instead of a centred card; phone and tablet keep the card.
 * From 1024 the account detail's 看看 pins that
 * account's desktop beside the timeline (`pin`, `pinWidth`); narrower, 看看 opens the desktop
 * sheet as before.
 * Pure: no react-native, so node:test can import it; layout.ts adds the hook.
 */
import type { AccountModel } from "./model.ts";
import type { ShellPanel, ShellView } from "./nav.tsx";
import type { AccountTableShape } from "./rail/rail-model.ts";

export type LayoutMode = "phone" | "tablet" | "desktop";

export const breakpoints = { tablet: 768, pin: 1024, desktop: 1100 } as const;

export interface Layout {
  mode: LayoutMode;
  width: number;
  /** The pro view is in force (an internal space). */
  pro: boolean;
  /** The project column is shown (pro view, desktop). */
  projectColumn: boolean;
  projectColumnWidth: number;
  /** The live rail is docked beside the conversation (pro view, tablet up). */
  rail: boolean;
  /** The live rail is a slide-in drawer (phone) rather than a docked column. */
  drawer: boolean;
  /** Width of the docked rail, or of the drawer on phone. */
  railWidth: number;
  /** Most the chat column's content grows to. */
  chatMaxWidth: number;
  /** Panels: full-height bottom sheet on phone, centred card from tablet up. */
  panel: "sheet" | "card";
  panelMaxWidth: number;
  /** 看看 pins the account's desktop beside the timeline (from 1024). */
  pin: boolean;
  pinWidth: number;
}

export function layoutMode(width: number): LayoutMode {
  if (width >= breakpoints.desktop) return "desktop";
  if (width >= breakpoints.tablet) return "tablet";
  return "phone";
}

export function layoutFor(width: number, pro = false): Layout {
  const mode = layoutMode(width);
  const wide = pro && mode !== "phone";
  return {
    mode,
    width,
    pro: wide,
    projectColumn: wide && mode === "desktop",
    projectColumnWidth: 220,
    rail: wide,
    // A phone shows the simple view in either: no drawer.
    drawer: false,
    railWidth:
      mode === "phone" ? Math.min(440, Math.round(width * 0.88)) : mode === "tablet" ? 340 : 360,
    chatMaxWidth: 760,
    panel: mode === "phone" ? "sheet" : "card",
    panelMaxWidth: 600,
    pin: width >= breakpoints.pin,
    pinWidth: pinnedDesktopWidth,
  };
}

/** The header's project name opens the project panel (with its ▾) unless the project column
 * is there to switch with (pro view, desktop). */
export function canSwitchProject(input: { projectColumn?: boolean }): boolean {
  return !input.projectColumn;
}

/** Width of the desktop pinned beside the timeline. */
export const pinnedDesktopWidth = 400;

/** The desktop pinned beside the timeline, or null: only on a width that pins, and only while
 * the account is still one of this conversation's (an account moved away or deleted unpins). */
export interface PinnedDesktop {
  environmentId: string;
  name: string;
  accountLabel: string | null;
  running: boolean;
}
export function pinnedDesktop(input: {
  pin: boolean;
  pinned: string | null;
  accounts: readonly Pick<AccountModel, "id" | "name" | "desktop" | "view">[];
}): PinnedDesktop | null {
  if (!input.pin || input.pinned === null) return null;
  const account = input.accounts.find((item) => item.id === input.pinned);
  if (!account) return null;
  return {
    environmentId: account.id,
    name: account.name,
    accountLabel: account.view.accountLabel ?? null,
    running: account.desktop === "running",
  };
}

/** What the account detail's 看看 does: pin the desktop beside the timeline (wide), unpin it when
 * it is the one pinned, or open the desktop sheet (narrow; and always for the owner's step, so
 * the AI's picture and the step stay above the desktop as before). */
export function lookAction(input: {
  pin: boolean;
  pinned: string | null;
  environmentId: string;
}): "pin" | "unpin" | "sheet" {
  return input.pinned === input.environmentId ? "unpin" : "pin";
}

/** Width of the account detail docked on the accounts page (desktop), like the tablet rail: from
 * 1100 the table beside it keeps every column (tight ones, rail-model), a classic scrollbar
 * included. */
export const accountsDetailWidth = 340;

/** The accounts page is a table with 地区 and a docked detail (desktop only). */
export function accountsSplit(mode: LayoutMode): boolean {
  return mode === "desktop";
}

/** The accounts page's content: at most 1040 wide, 14 px side padding. */
export const accountsPage = { maxWidth: 1040, padding: 14 } as const;

/** The row width the accounts page gives its table at window `width` (the page fills the window
 * below the header): the page less the docked detail and its border, at most 1040, less the side
 * padding. A classic scrollbar takes up to 17 px more. */
export function accountsTableWidth(width: number, docked: boolean): number {
  const page = width - (docked ? accountsDetailWidth + 1 : 0);
  return Math.min(accountsPage.maxWidth, page) - 2 * accountsPage.padding;
}

/** The table's columns: 地区 on desktop; the row actions give way to a docked detail. */
export function accountsTableShape(mode: LayoutMode, docked: boolean): AccountTableShape {
  return { region: accountsSplit(mode), act: !docked };
}

/**
 * The account whose detail is docked on the accounts page, or null: its own panel on the
 * desktop accounts page, and still the same account while a card opened from that detail sits
 * over the page (移到… / 分配到…, 编辑, 打开桌面), so closing the card leaves the detail in place.
 */
export function dockedAccountId(input: {
  mode: LayoutMode;
  view: ShellView;
  panel: ShellPanel | null;
}): string | null {
  const { panel } = input;
  if (!panel || input.view !== "accounts" || !accountsSplit(input.mode)) return null;
  switch (panel.kind) {
    case "account":
    case "assign":
      return panel.environmentId;
    case "accountEditor":
      return panel.environmentId ?? null;
    case "legacy":
      return panel.detail.type === "computer" ? (panel.detail.environment?.id ?? null) : null;
    default:
      return null;
  }
}

/**
 * What closing the open panel leaves open: the docked account detail when the panel is a card
 * opened over it (移到… / 分配到…, 编辑, 打开桌面), so the card's ✕, Escape and scrim close the
 * card only and the detail stays beside the table; otherwise nothing (the panel just closes).
 */
export function panelAfterClose(input: {
  mode: LayoutMode;
  view: ShellView;
  panel: ShellPanel | null;
}): ShellPanel | null {
  const id = dockedAccountId(input);
  if (id === null || input.panel?.kind === "account") return null;
  return { kind: "account", environmentId: id };
}

/**
 * What switching between the workbench and the accounts page leaves open: nothing. A panel
 * belongs to the view it was opened on; the docked account detail in particular would otherwise
 * reappear as a card over the chat after 「← 返回」.
 */
export function panelAfterViewChange(input: {
  from: ShellView;
  to: ShellView;
  panel: ShellPanel | null;
}): ShellPanel | null {
  return input.from === input.to ? input.panel : null;
}

/** A card sits over the docked account detail: the detail leaves Escape to that card. */
export function dockCovered(input: {
  mode: LayoutMode;
  view: ShellView;
  panel: ShellPanel | null;
}): boolean {
  return panelAfterClose(input) !== null;
}

/** The panel host leaves the open panel to the accounts page: it is the docked detail. */
export function panelDocked(input: {
  mode: LayoutMode;
  view: ShellView;
  panel: ShellPanel | null;
}): boolean {
  return input.panel?.kind === "account" && dockedAccountId(input) !== null;
}
