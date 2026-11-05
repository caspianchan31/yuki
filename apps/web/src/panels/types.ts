/**
 * Phase C: how the shell opens panels. Every area registers the panels it draws, by the kind of
 * ShellPanel (shell/nav.tsx); PanelHost shows the one open. A panel gets the open panel's value
 * and a close function (useClosePanel: back to the docked account detail when it sat over one).
 */

import type { ShellPanel } from "@m/shell/nav";
import type { ComponentType } from "react";

export type PanelOf<K extends ShellPanel["kind"]> = Extract<ShellPanel, { kind: K }>;
export type PanelProps<K extends ShellPanel["kind"]> = { panel: PanelOf<K>; onClose: () => void };
export type PanelRegistry = { [K in ShellPanel["kind"]]?: ComponentType<PanelProps<K>> };
