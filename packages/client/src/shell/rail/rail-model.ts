/**
 * The pure helpers behind the live rail and the shared account
 * and task rows — the account row's lines, report rows
 * (time, Chinese label, tone, first line, 在侧聊), the inline task buttons and the section the
 * rail scrolls to. They only present what the server already says; nothing here adds a step.
 * Pure: no react-native, so node:test can import it (apps/mobile/test/shell-rail.test.ts).
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import {
  clockLabel,
  firstLine,
  planProgress,
  showsSteps,
} from "../../../../../packages/domain/src/task-phase.ts";
import { type ReportTone, reportTone, titleWithoutAccount, unconfirmedLine } from "../chat/core.ts";
import { type AccountModel, flagLabel, phaseActions, type TaskEntry } from "../model.ts";
import type { RailSection } from "../nav.tsx";
import {
  incidentWord,
  phaseWords,
  reportLabel,
  reportWords,
  t,
  taskTitleText,
} from "../strings.ts";

// ───────────────────────────── account row ─────────────────────────────

export type FlagTone = "red" | "grey" | "amber";
export interface RowFlag {
  key: string;
  label: string;
  tone: FlagTone;
}

/** The flags printed on an account row (design §4.7). There is no "same account, 2 tasks" flag
 * (decision 4); 跑在默认桌面 belongs to the task row. An open infrastructure
 * incident of one of its tasks is a fact on the row (「模型服务连不上 · 自己在重试」), grey (v0.8
 * ADHD pass: colour only for what needs the owner): the task retries by itself, so it is not in
 * 需要你. The account's flags
 * include the per-site facts only the owner can act on (`flagLabel`). */
export function accountRowFlags(account: Pick<AccountModel, "flags" | "incident">): RowFlag[] {
  return [
    ...account.flags.map((flag) => ({
      key: flag,
      label: flagLabel(flag),
      tone: "red" as const,
    })),
    ...(account.incident
      ? [
          {
            key: "incident",
            label: t.incidents.flag(incidentWord(account.incident.kind)),
            tone: "grey" as const,
          },
        ]
      : []),
  ];
}

/** The 此刻 line's task: its phase, title and how many more live tasks the account has. The
 * title leaves out the 「[account] 」 the chat puts at its start: the row names the account. */
export function nowLine(account: Pick<AccountModel, "now" | "name">): {
  entry: TaskEntry;
  title: string;
  more: string | null;
} | null {
  if (!account.now) return null;
  return {
    entry: account.now.entry,
    title: titleWithoutAccount(account.now.entry.task.title, account.name),
    more: account.now.more > 0 ? t.accountsRail.more(account.now.more) : null,
  };
}

/** What the rail's account row shows (fork, the owner's trim): the name with its light, a
 * problem the owner must see (`accountRowFlags`), 此刻 and 下次. The exit, 共用, the region,
 * the pacing, the desktop state and the reports are in the account's detail. */
export function railAccountRow(
  account: Pick<AccountModel, "name" | "flags" | "incident" | "now" | "next">,
): {
  name: string;
  flags: RowFlag[];
  now: ReturnType<typeof nowLine>;
  next: string | null;
} {
  return {
    name: account.name,
    flags: accountRowFlags(account),
    now: nowLine(account),
    next: account.next?.label ?? null,
  };
}

// ───────────────────────────── reports ─────────────────────────────

// One report-tone rule for the chat, the rail and the task detail (chat/core.ts).
export { type ReportTone, reportTone } from "../chat/core.ts";

export interface ReportLine {
  id: string;
  taskId: string;
  clock: string;
  label: string;
  tone: ReportTone;
  /** The report's first line (its title line, report_to_user), shortened. */
  text: string;
  hasLink: boolean;
  /** 「未确认：…」 for an action report without the item's own address; "" otherwise. */
  unconfirmed: string;
}

export function reportLine(report: ChatReport, now: Date | number): ReportLine {
  return {
    id: report.id,
    taskId: report.taskId,
    clock: clockLabel(report.createdAt, now, phaseWords),
    label: reportLabel(report.title, report.action),
    tone: reportTone(report.title),
    // The same Chinese words as the card (a fixed server text; a provider's quota answer only on
    // the 出问题 outcome, whose text is the task's failure).
    text: reportWords(report.title)(firstLine(report.text, 120)) || taskTitleText(report.taskTitle),
    hasLink: report.links.length > 0,
    unconfirmed: unconfirmedLine(report),
  };
}

/** 「在侧聊：<name>」 when the report went to a side chat; null in the main chat, or when rich
 * threads are off (there is only one conversation then). */
export function sideChatNote(
  report: Pick<ChatReport, "threadId">,
  main: { id: string; enabled: boolean },
  names: ReadonlyMap<string, string | null>,
): string | null {
  if (!main.enabled || main.id === "local" || !report.threadId) return null;
  if (report.threadId === main.id) return null;
  const name = names.get(report.threadId);
  return t.threads.inSide(name?.trim() ? name.trim() : t.threads.untitled);
}

/** A grey dot by the 汇报 title when a shown report has never been seen (no count). */
export function hasUnread(reports: readonly Pick<ChatReport, "readAt">[]): boolean {
  return reports.some((report) => report.readAt === null);
}

/** Side chats of the project (not archived, not the main chat). */
export function sideChatCount(
  threads: readonly { id: string; archived: boolean }[],
  mainId: string,
): number {
  return threads.filter((thread) => !thread.archived && thread.id !== mainId).length;
}

// ───────────────────────────── task row ─────────────────────────────

/**
 * The rail task card's state line (fork, the owner's trim): the phase's label and, where it
 * says when, only that: 「等待中 · 明天 00:00 继续」, 「排期中 · 下次 15:00」, 「运行中 · 第 2/5
 * 步」; a paused task is 「已暂停」 alone (when it would have resumed is in the task detail); an
 * open incident's line while it waits. Never what a run
 * wrote, no count of runs, attempts or waits, no 节奏 mark; the task detail has the rest.
 */
export function railTaskState(
  entry: Pick<TaskEntry, "phase" | "task">,
  now: Date | number,
): {
  label: string;
  detail: string;
} {
  const { phase, task } = entry;
  const clock = (iso: string | undefined) => clockLabel(iso, now, phaseWords);
  const at = clock(phase.at);
  let detail = "";
  if ((phase.key === "wait" || phase.key === "sched") && phase.incident) detail = phase.sub;
  else if (phase.key === "wait" && at) detail = t.tasksRail.resumesAt(at);
  else if (phase.key === "sched" && at) detail = phaseWords.scheduledOnce(at);
  else if (phase.key === "run" && showsSteps(task)) {
    const progress = planProgress(task);
    if (progress.total) detail = phaseWords.step(progress.current, progress.total, "");
  }
  return { label: phase.label, detail };
}

/** One inline button of a task row: a control call, the task panel (改间隔), or 停止重复. */
export type TaskButton =
  | {
      kind: "control";
      op: "pause" | "resume" | "run" | "retry";
      label: string;
      /** 立即继续 inside a wait (records the receipt 「跳过剩余等待」). */
      inWait: boolean;
    }
  | { kind: "panel"; op: "interval"; label: string }
  | { kind: "repeat"; op: "stopRepeat"; label: string };

export function taskButtons(
  entry: Pick<TaskEntry, "phase"> & { task: Pick<TaskEntry["task"], "repeatMinutes"> },
  compact = false,
): TaskButton[] {
  return phaseActions(entry.phase, compact, !!entry.task.repeatMinutes).flatMap(
    (action): TaskButton[] => {
      if (action.op === "interval") return [{ kind: "panel", op: "interval", label: action.label }];
      if (action.op === "stopRepeat")
        return [{ kind: "repeat", op: "stopRepeat", label: action.label }];
      if (action.op === "cancel") return [];
      return [
        {
          kind: "control",
          op: action.op,
          label: action.label,
          inWait: action.op === "run" && entry.phase.key === "wait",
        },
      ];
    },
  );
}

// ───────────────────────────── rail ─────────────────────────────

/** Where the rail scrolls for a section the strip or a legacy link asked for; null while that
 * section has not been laid out yet. A hidden section (需要你 when empty, 账号 without
 * environments) has no height: then the top. */
export function focusOffset(
  section: RailSection,
  offsets: Partial<Record<RailSection, { y: number; height: number }>>,
): number | null {
  const box = offsets[section];
  if (!box) return section === "needs" ? 0 : null;
  if (box.height <= 0) return 0;
  return Math.max(0, box.y);
}

/** The project brief's save line: 「已保存 · 更新于 14:46」 right after a save, else the time. */
export function briefStatus(
  updatedAt: string | null,
  justSaved: boolean,
  now: Date | number,
): string {
  const clock = updatedAt ? clockLabel(updatedAt, now, phaseWords) : "";
  const updated = clock ? t.notes.briefUpdated(clock) : "";
  if (justSaved) return [t.notes.briefSaved, updated].filter(Boolean).join(t.common.sep);
  return updated;
}

/** Which optional columns the accounts page table has: 地区 from 1100 (design §3.6), and the
 * trailing actions (详情 / 分配到…) unless the selected account's detail is docked beside it. */
export interface AccountTableShape {
  region: boolean;
  act: boolean;
}
export const defaultTableShape: AccountTableShape = { region: false, act: true };

/** The least widths of the table's flexible columns (they share what is left by flexGrow). */
export interface AccountTableMins {
  name: number;
  meta: number;
  now: number;
  pace: number;
  region: number;
}

/**
 * The table's column widths. `roomy` is the prototype's grid (.gacc from 900) for the page with
 * its actions column; beside the docked detail (no actions) the columns are `tight`, so the
 * table keeps every column, 地区 included, from 1100 with the detail open (design §3.6): long
 * names, titles and zones are cut short there, and the docked detail shows them whole. The exit
 * keeps its full width (an address is not cut). `padding` is the row's own side padding.
 */
export const accountTableColumnWidths = {
  light: 10,
  desk: 64,
  act: 84,
  gap: 10,
  padding: 8,
  roomy: { name: 150, meta: 150, now: 170, pace: 170, region: 110 },
  tight: { name: 110, meta: 150, now: 104, pace: 104, region: 96 },
} as const satisfies Record<string, number | AccountTableMins>;

/** Which least widths a table of this shape uses: tight beside the docked detail. */
export function accountTableMins(shape: AccountTableShape = defaultTableShape): AccountTableMins {
  return shape.act ? accountTableColumnWidths.roomy : accountTableColumnWidths.tight;
}

/** The least row width a table of this shape needs: every column at its least width, the gaps
 * between them and the row's padding. */
export function accountTableColumnsWidth(shape: AccountTableShape = defaultTableShape): number {
  const { light, desk, act, gap, padding } = accountTableColumnWidths;
  const mins = accountTableMins(shape);
  const columns = [
    light,
    mins.name,
    mins.meta,
    desk,
    mins.now,
    mins.pace,
    ...(shape.region ? [mins.region] : []),
    ...(shape.act ? [act] : []),
  ];
  return columns.reduce((sum, width) => sum + width, 0) + gap * (columns.length - 1) + padding;
}

/** The accounts page table becomes real columns once a row is wide enough for every column at
 * its least width (no column ever spills into the next): 866 with the actions column (the
 * prototype's grid, a table from an app frame of about 900), 986 with 地区 as well, and 706
 * beside the docked detail (tight columns, 地区, no actions). */
export function accountTableMinWidth(shape: AccountTableShape = defaultTableShape): number {
  return accountTableColumnsWidth(shape);
}

/** The 地区 cell (design §3.6): the account's locale and time zone, from its environment
 * view; 没设 for a part that is not set, one 没设 when neither is. */
export function regionLines(account: Pick<AccountModel, "locale" | "timezone">): string[] {
  if (!account.locale && !account.timezone) return [t.accountDetail.notSet];
  return [account.locale ?? t.accountDetail.notSet, account.timezone ?? t.accountDetail.notSet];
}

/** The 地区 line of a stacked accounts-page row (a table too narrow for its columns): the same
 * locale and time zone on one line, 「en-US · America/Los_Angeles」; null when the page has no
 * 地区 (below 1100). */
export function stackedRegionLine(
  account: Pick<AccountModel, "locale" | "timezone">,
  shape: AccountTableShape = defaultTableShape,
): string | null {
  return shape.region ? regionLines(account).join(t.common.sep) : null;
}
