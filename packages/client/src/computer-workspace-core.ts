/**
 * The desktop panel's pure rules, free of React and React Native so the
 * tests load them in node — which control call goes where, when 重建桌面 is offered, and the
 * status line. The hook (computer-workspace-state.ts) re-exports them.
 */
import type { ComputerSnapshot } from "../../../packages/domain/src/computer";
import { t } from "./shell/strings";

/** The desktop's control calls: start, stop, and destroy, which drops the desktop so the next
 * start makes a new one from the current template. */
export type ComputerControl = "start" | "stop" | "destroy";
export const controlPath = (action: ComputerControl) => `/api/computer/${action}`;

/** Whether a desktop exists to rebuild: configured, and the server does not say it was never
 * created (an older server says nothing, and is taken at its status). */
export function desktopExists(snapshot: ComputerSnapshot | undefined): boolean {
  if (!snapshot?.enabled) return false;
  if (snapshot.status !== "running" && snapshot.status !== "stopped") return false;
  return snapshot.created !== false;
}

/** The status line of the workspace card. */
export function workspaceStatusText(snapshot: ComputerSnapshot | undefined): string {
  const c = t.computer;
  if (snapshot?.status === "running") return c.running;
  if (snapshot?.status === "stopped") return snapshot.created === false ? c.notCreated : c.stopped;
  if (snapshot?.status === "unconfigured") return c.unconfigured;
  if (snapshot?.status === "error") return c.attention;
  return c.connecting;
}
