/**
 * On a wide window, the desktop an account is using
 * right now shows small beside the timeline by itself, without 看看: an account of this project
 * whose desktop is running and that has a task running on it. Nothing shows while a desktop is
 * pinned (看看 already shows one, large) or when no account is at work. Pure, for node:test.
 */
import type { AccountModel, TaskEntry } from "../model";

export interface DesktopPreview {
  environmentId: string;
  name: string;
  /** What it is doing: the running task's title. */
  doing: string;
}

export function desktopPreview(input: {
  pin: boolean;
  pinned: string | null;
  accounts: readonly Pick<AccountModel, "id" | "name" | "desktop">[];
  entries: readonly Pick<TaskEntry, "task" | "phase" | "environmentId">[];
}): DesktopPreview | null {
  if (!input.pin || input.pinned !== null) return null;
  // The latest started run on a running desktop: the account at work now.
  const runs = input.entries
    .filter((entry) => entry.phase.key === "run" && !entry.phase.stalled && entry.environmentId)
    .sort((a, b) => String(b.task.updatedAt ?? "").localeCompare(String(a.task.updatedAt ?? "")));
  for (const entry of runs) {
    const account = input.accounts.find((item) => item.id === entry.environmentId);
    if (account && account.desktop === "running")
      return { environmentId: account.id, name: account.name, doing: entry.task.title };
  }
  return null;
}

/** v1.2: the open member's screen in her detail rail, while her desktop is running a task. */
export function memberScreen(
  account: Pick<AccountModel, "id" | "name" | "desktop"> | null,
  entries: readonly Pick<TaskEntry, "task" | "phase" | "environmentId">[],
): DesktopPreview | null {
  if (!account || account.desktop !== "running") return null;
  const run = entries
    .filter(
      (entry) =>
        entry.environmentId === account.id && entry.phase.key === "run" && !entry.phase.stalled,
    )
    .sort((a, b) =>
      String(b.task.updatedAt ?? "").localeCompare(String(a.task.updatedAt ?? "")),
    )[0];
  if (!run) return null;
  return { environmentId: account.id, name: account.name, doing: run.task.title };
}
