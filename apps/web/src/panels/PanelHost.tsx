/**
 * Phase C: the one open panel (ShellNav.panel), drawn by the area that registered its kind. Each
 * area's panels load on first use (their own chunk), so the first screen carries only the frame
 * and the conversation; a skeleton sheet stands in while a chunk loads.
 */

import { useClosePanel } from "@m/shell/layout";
import { type ShellPanel, useShellNav } from "@m/shell/nav";
import { type ComponentType, useEffect, useState } from "react";
import { backClosesPanel } from "../shell/state";
import { useTenancyUi } from "../tenancy-ui";
import { Sheet, Skeleton } from "../ui/primitives";
import type { PanelRegistry } from "./types";

type Kind = ShellPanel["kind"];
type Area = "task" | "accounts" | "credentials" | "pages" | "legacy";

const areaOf: Record<Kind, Area> = {
  task: "task",
  job: "task",
  newTask: "task",
  settings: "task",
  notes: "task",
  founder: "task",
  projects: "task",
  threads: "task",
  account: "accounts",
  assign: "accounts",
  join: "accounts",
  accountEditor: "accounts",
  credentialEditor: "credentials",
  credentialHistory: "credentials",
  members: "pages",
  platform: "pages",
  billing: "pages",
  store: "pages",
  referrer: "pages",
  legacy: "legacy",
};

// The space and business area's panels (成员, 订阅, 店铺, 介绍人, 平台) are the tenancy layer's:
// none without one (tenancy-ui.tsx).
const loaders: Record<Exclude<Area, "pages">, () => Promise<PanelRegistry>> = {
  task: () => import("./task").then((m) => m.taskPanels),
  accounts: () => import("../accounts/panels").then((m) => m.accountPanels),
  credentials: () => import("../credentials/panels").then((m) => m.credentialPanels),
  legacy: () => import("../legacy/panels").then((m) => m.legacyPanels),
};
const loaded: Partial<Record<Area, PanelRegistry>> = {};

function panelKey(panel: ShellPanel): string {
  if (panel.kind === "legacy")
    return `legacy:${panel.detail.type}:${JSON.stringify(panel.detail).slice(0, 200)}`;
  return JSON.stringify(panel);
}

export function PanelHost() {
  const { panel } = useShellNav();
  const close = useClosePanel();
  const { loadPanels } = useTenancyUi();
  const area = panel ? areaOf[panel.kind] : null;
  const [, setReady] = useState(0);
  // The browser's Back over a page (平台管理) closes this panel first (state.ts).
  useEffect(() => (panel ? backClosesPanel(close) : undefined), [panel, close]);
  useEffect(() => {
    if (!area || loaded[area]) return;
    let live = true;
    void (area === "pages" ? loadPanels : loaders[area])().then((registry) => {
      loaded[area] = registry;
      if (live) setReady((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [area, loadPanels]);
  if (!panel || !area) return null;
  const registry = loaded[area];
  if (!registry)
    return (
      <Sheet title="" onClose={close}>
        <Skeleton lines={6} />
      </Sheet>
    );
  const Panel = registry[panel.kind] as
    | ComponentType<{ panel: typeof panel; onClose: () => void }>
    | undefined;
  // Keyed by what it shows, so opening another task or credential starts a fresh panel.
  return Panel ? <Panel key={panelKey(panel)} panel={panel} onClose={close} /> : null;
}
