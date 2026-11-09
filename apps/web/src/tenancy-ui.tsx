/**
 * The web side of the tenancy port (client logic: packages/client/src/tenancy-client.tsx): the
 * slots the shell reads to show what a multi-tenant deployment adds. The core default is a single
 * user: the gate passes through, there are no public routes (the core shows its own sign-in), no
 * space crumb, no operator page, no extra palette items, no billing banners.
 * The multi-tenant layer fills every slot (tenancy/web); apps/web/src/main.tsx is the one place
 * the web imports it, and hands it to TenancyUiProvider. Nothing else in the core imports tenancy/.
 */

import { t } from "@m/shell/strings";
import { type ClientTenancy, ClientTenancyContext, singleUserTenancy } from "@m/tenancy-client";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import type { PanelRegistry } from "./panels/types";
import type { PaletteGroup } from "./shell/state";

/** One line of the ⌘K palette. */
export interface PaletteItem {
  key: string;
  group: PaletteGroup;
  label: string;
  /** v1.6 搜对话内容: the label with the words found marked (a search hit). */
  parts?: { before: string; match: string; after: string };
  hint?: string;
  run: () => void;
}

/** One row of the banner slot. */
export interface BannerItem {
  key: string;
  tone: "red" | "amber" | "grey";
  text: string;
  action?: { text: string; run: () => void };
}

export interface TenancyUi extends ClientTenancy {
  /** Wraps everything below the sign-in: the multi-tenant layer opens a space here. */
  Gate: ComponentType<{ token: string; children: ReactNode }>;
  /** Pages a visitor sees before signing in (官网, sign-up, an invite, a reset link). `children`
   * draws the sign-in and the app after it, given the username a reset link just named. */
  PublicRoutes: ComponentType<{
    fallback: ReactNode;
    children: (context: { signInAs: string }) => ReactNode;
  }>;
  /** The top bar's first crumb (the space's name and its menu). */
  Crumb: ComponentType;
  /** Commands and space switches the palette adds. */
  usePaletteItems: () => { commands: PaletteItem[]; spaces: PaletteItem[] };
  /** The roster footer's entry above 设置 (the operator's 平台管理). */
  RosterEntry: ComponentType<{ on: boolean; onOpen: (tab: string) => void }>;
  /** The 设置 sheet's row for the space (members, plan, referrer). */
  SettingsSpace: ComponentType<{ live: boolean }>;
  /** 「空间：名字 ▾」 in the projects panel. */
  SpaceSwitch: ComponentType;
  /** The page behind the frame's `platform` tab (the operator's 平台管理). */
  PlatformPage: ComponentType<{ tab: string }>;
  /** Banners the tenancy layer adds: a read-only space, a trial ending. */
  useBanners: () => { readOnly: BannerItem | null; ending: BannerItem | null };
  /** The panels of the space and business area (成员, 订阅, 店铺, 介绍人, 平台). */
  loadPanels: () => Promise<PanelRegistry>;
  /** A refused sign-in's registration status, drawn under the form. */
  RegistrationCard: ComponentType<{ view: object }>;
}

const nothing = () => null;
const noItems = { commands: [], spaces: [] };
const noBanners = { readOnly: null, ending: null };

export const singleUserUi: TenancyUi = {
  ...singleUserTenancy,
  Gate: ({ children }) => <>{children}</>,
  PublicRoutes: ({ children }) => <>{children({ signInAs: "" })}</>,
  Crumb: () => (
    <span className="crumb-anchor">
      <span className="crumb">{t.app.name}</span>
    </span>
  ),
  usePaletteItems: () => noItems,
  RosterEntry: nothing,
  SettingsSpace: nothing,
  SpaceSwitch: nothing,
  PlatformPage: nothing,
  useBanners: () => noBanners,
  loadPanels: async () => ({}),
  RegistrationCard: nothing,
};

const TenancyUiContext = createContext<TenancyUi>(singleUserUi);

/** The web's one door hands the multi-tenant implementation in here (main.tsx). */
export function TenancyUiProvider({ value, children }: { value: TenancyUi; children: ReactNode }) {
  return (
    <ClientTenancyContext.Provider value={value}>
      <TenancyUiContext.Provider value={value}>{children}</TenancyUiContext.Provider>
    </ClientTenancyContext.Provider>
  );
}

export function useTenancyUi(): TenancyUi {
  return useContext(TenancyUiContext);
}
