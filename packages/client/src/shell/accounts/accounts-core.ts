/**
 * The pure logic of the accounts unit: moves between projects, the account detail's report
 * lines and region line, and the editor's Chinese validation messages. No react-native, no
 * fetch: node:test pins it (apps/mobile/test/shell-accounts.test.ts).
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import { clockLabel, firstLine } from "../../../../../packages/domain/src/task-phase.ts";
import { unconfirmedLine } from "../chat/core.ts";
import { phaseWords, reportLabel, t } from "../strings.ts";

const _record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const _byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// ───────────────────────────── page data ─────────────────────────────

/** The key a project's accounts are kept under ("" = the default project, i.e. unassigned). */
export const projectKey = (projectId: string | null | undefined) => projectId ?? "";

/** `previous` when `next` holds the very same items in the same order, else `next`: a list
 * rebuilt on every poll keeps one identity until its items really change. */
export function sameItemsOr<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && next.every((item, index) => item === previous[index])
    ? previous
    : next;
}

// ───────────────────────────── moves ─────────────────────────────

/** One PATCH /api/environments/:id { projectId } sent with `header`'s project header. */
export interface MoveStep {
  header: string | null;
  projectId: string | null;
}
/** The picker's footnote: 「跨项目移动分两步…」 only for an account already in a project (a move
 * may be two steps); assigning an unassigned account is one step, so it has none. */
export function moveNote(from: string | null): string | null {
  return from !== null ? t.assign.twoSteps : null;
}

/**
 * The requests that move an account (design §3.6, §8.1): to 未分配 = one PATCH with the
 * source project's header; from 未分配 = one PATCH with the target's header; across projects =
 * both, in that order (the server only moves between unassigned and the current project).
 */
export function movePlan(from: string | null, to: string | null): MoveStep[] {
  if (from === to) return [];
  const steps: MoveStep[] = [];
  if (from !== null) steps.push({ header: from, projectId: null });
  if (to !== null) steps.push({ header: to, projectId: to });
  return steps;
}

/** Where the account can go: every live project except the one it is in. */
export function moveTargets<P extends { id: string; deleting?: boolean }>(
  projects: readonly P[],
  from: string | null,
): P[] {
  return projects.filter((project) => project.id !== from && !project.deleting);
}

/** What the result of a move looks like to the person: done, or stuck in 未分配 after the
 * first step (offer 再试 for the second), or failed before anything changed. */
export type MoveOutcome =
  | { state: "done" }
  | { state: "stuck"; error: string }
  | { state: "failed"; error: string };
export async function runMove(
  steps: readonly MoveStep[],
  send: (step: MoveStep) => Promise<unknown>,
  errorText: (error: unknown) => string,
): Promise<MoveOutcome> {
  for (const [index, step] of steps.entries()) {
    try {
      await send(step);
    } catch (error) {
      return index > 0 && steps[index - 1].projectId === null
        ? { state: "stuck", error: errorText(error) }
        : { state: "failed", error: errorText(error) };
    }
  }
  return { state: "done" };
}

/** Where the account is after a move: `to` when done, 未分配 (null) when stuck after the first
 * step, nowhere new (undefined) when nothing changed. */
export function movedTo(outcome: MoveOutcome, to: string | null): string | null | undefined {
  if (outcome.state === "done") return to;
  if (outcome.state === "stuck") return null;
  return undefined;
}

// ───────────────────────────── account detail ─────────────────────────────

export interface ReportLine {
  id: string;
  taskId: string;
  clock: string;
  label: string;
  text: string;
  link: string | null;
  /** 「未确认：…」 for an action report without the item's own address; "" otherwise. */
  unconfirmed: string;
}
/** 最近汇报（这个号）: the newest `count` reports of the account's tasks, as
 * 「14:10 · 回复 · 在 r/IPhoneApps 回复 1 条 ↗」 lines (「未确认：…」 under one without the item's own
 * address). */
export function accountReportLines(
  reports: readonly ChatReport[],
  taskIds: ReadonlySet<string>,
  now: Date | number,
  count = 3,
): ReportLine[] {
  return reports
    .filter((report) => taskIds.has(report.taskId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, count)
    .map((report) => ({
      id: report.id,
      taskId: report.taskId,
      clock: clockLabel(report.createdAt, now, phaseWords),
      label: reportLabel(report.title, report.action),
      text: firstLine(report.text, 80),
      link: report.links[0] ?? null,
      unconfirmed: unconfirmedLine(report),
    }));
}

/** The account detail's 地区 line in plain words: 「en-US · America/Los_Angeles」, 「还没设（时区和
 * 语言用桌面默认的）」 when neither is set, 「语言没设」 / 「时区没设」 for the one missing. */
export function regionLine(account: { locale: string | null; timezone: string | null }): string {
  const d = t.accountDetail;
  if (!account.locale && !account.timezone) return d.regionUnset;
  return `${account.locale ?? d.localeUnset}${t.common.sep}${account.timezone ?? d.timezoneUnset}`;
}

/** The delete confirmation is typed exactly (spaces around it ignored). */
export const deleteConfirmed = (typed: string, name: string) =>
  !!name && typed.trim() === name.trim();

// ───────────────────────────── editor messages ─────────────────────────────

/** environmentPayload()'s English validation messages, in the shell's words; anything else (a
 * server message) is shown as it is. */
export function editorError(message: string): string {
  const e = t.accountEditor;
  if (message === "Name is required" || message === "Name can't be cleared")
    return t.accountEditor.nameRequired;
  let match = /^Name must be at most (\d+) characters$/.exec(message);
  if (match) return e.nameTooLong(Number(match[1]));
  match = /^Name "(.*)" is reserved/.exec(message);
  if (match) return e.nameReserved(match[1]);
  match = /^Account label must be at most (\d+) characters$/.exec(message);
  if (match) return e.labelTooLong(Number(match[1]));
  match = /^Unknown time zone "(.*)"/.exec(message);
  if (match) return e.unknownTimezone(match[1]);
  match = /^Unknown language "(.*)"/.exec(message);
  if (match) return e.unknownLocale(match[1]);
  return message;
}

/** The edit value for a prefilled field (environments-screen's `diff`): unchanged, cleared
 * (null) or replaced. */
export const editValue = (typed: string, saved: string | null): string | null | undefined =>
  typed.trim() === (saved ?? "") ? undefined : typed.trim() ? typed : null;

// ───────────────────────────── account desktop sheet ─────────────────────────────

export type ComputerTab = "Browser" | "Desktop" | "Terminal" | "Files";
/**
 * The computer sheet's tabs (design §3.5, §7): an account's desktop (inside an EnvironmentScope)
 * shows only Desktop and Terminal, and a remembered Browser or Files tab opens on Desktop there;
 * the default desktop keeps all four. Desktop is listed only while the desktop runs (`desktop`
 * undefined = not known yet), and a remembered Desktop tab falls back to Terminal while it is off.
 */
export function computerTabs(
  scoped: boolean,
  desktop: boolean | undefined,
  tab: ComputerTab,
): { shown: ComputerTab; tabs: readonly ComputerTab[] } {
  if (scoped)
    return {
      shown: tab === "Terminal" || desktop === false ? "Terminal" : "Desktop",
      tabs: desktop ? ["Desktop", "Terminal"] : ["Terminal"],
    };
  return {
    shown: desktop === false && tab === "Desktop" ? "Terminal" : tab,
    tabs: desktop ? ["Browser", "Desktop", "Terminal", "Files"] : ["Browser", "Terminal", "Files"],
  };
}

/**
 * The project to read an account in, from this project's topology. The
 * topology lists this project's accounts only (projects are isolated), so an account in no
 * project, the founder above all, is not in it: then 未分组 (the default project, where the
 * unassigned accounts are its own) is asked; from 未分组 itself, a miss is gone (undefined).
 */
export function projectToRead(
  found: { projectId: string | null } | undefined,
  current: string | null,
): string | null | undefined {
  if (found) return found.projectId;
  return current === null ? undefined : null;
}
