// v1.2: the chat's right rail. Duty is the persona's own words. A routine is a live standing
// loop or a task that repeats; a finished task is not one.
import type { AgentTask } from "../../../../../packages/domain/src/agent.ts";
import {
  type Routine,
  type RoutineRun,
  type RoutineTrigger,
  routineHistoryMax,
  routineTriggerSchema,
  routineWhenLine,
} from "../../../../../packages/domain/src/routines.ts";
import { isStandingTask } from "../../../../../packages/domain/src/standing.ts";
import { rhythmLabel, taskEnvironmentId } from "../../../../../packages/domain/src/task-phase.ts";
import { nextClockRun } from "../../../../../packages/domain/src/template-setup.ts";
import { t } from "../strings.ts";

const ended = new Set(["succeeded", "cancelled"]);

export interface DetailRoutine {
  id: string;
  title: string;
  /** How often it wakes; "" when it has no interval of its own. */
  when: string;
  /** Paused or failed reads as off. */
  on: boolean;
  /** 试跑 only while it is waiting for the next run. A run already going cannot be started again. */
  ready: boolean;
  /** v1.4: a routine made with a trigger (修改 and 最近运行 are for these). */
  routine: Routine | null;
  /** v1.4: 修改 only between runs. */
  editable: boolean;
  /** The instruction (the task's prompt), for the 修改 form. */
  prompt: string;
}

type RoutineTask = Pick<
  AgentTask,
  "id" | "title" | "status" | "repeatMinutes" | "input" | "state"
> & {
  prompt?: string;
  routine?: Routine | null;
};

/** The schedule as it was written (`什么时候：每天 7:30`), else the interval in words. A routine
 * with a trigger says its trigger. */
function statedWhen(task: RoutineTask): string {
  if (task.routine?.trigger) return routineWhenLine(task.routine.trigger);
  const written = task.prompt
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("什么时候："))
    ?.slice("什么时候：".length)
    .trim();
  if (written) return written;
  return typeof task.repeatMinutes === "number" && task.repeatMinutes > 0
    ? rhythmLabel(task.repeatMinutes)
    : "";
}

export function memberRoutines(tasks: readonly RoutineTask[]): DetailRoutine[] {
  return tasks
    .filter((task) => {
      if (ended.has(task.status)) return false;
      const repeats = typeof task.repeatMinutes === "number" && task.repeatMinutes > 0;
      return repeats || isStandingTask(task);
    })
    .map((task) => ({
      id: task.id,
      title: task.title,
      when: statedWhen(task),
      on: task.status !== "paused" && task.status !== "failed",
      ready: task.status === "scheduled",
      routine: task.routine?.trigger ? task.routine : null,
      editable: !!task.routine?.trigger && editableStatuses.has(task.status),
      prompt: task.prompt ?? "",
    }));
}

/** v1.4 (docs/routines.md「Yuki's own routines」): Yuki's routines are the hall's own, the ones that
 * run on no member's account (a member's are on her card). Only routines made with a trigger: a
 * one-off task, or a plain repeating one, is not shown as a routine she keeps. */
export function yukiRoutines(tasks: readonly RoutineTask[]): DetailRoutine[] {
  return memberRoutines(
    tasks.filter((task) => taskEnvironmentId(task) === null && !!task.routine?.trigger),
  );
}

const editableStatuses = new Set(["scheduled", "paused", "failed", "succeeded"]);

/** v1.4: why a run happened, in the person's words. */
export function routineCauseLabel(cause: string): string {
  if (cause === "test") return "测试";
  if (cause.startsWith("mail:")) return "新邮件";
  return "按时";
}

export interface RoutineRunRow {
  key: string;
  startedAt: string;
  ok: boolean;
  /** 「按时 · 成功」, 「测试 · 失败」. */
  label: string;
  summary: string;
}

/** 最近运行: three while closed, up to twenty when expanded; `more` is what 展开 would add. */
export function routineRunRows(
  history: readonly RoutineRun[] | undefined,
  expanded: boolean,
  closed = 3,
): { rows: RoutineRunRow[]; more: number } {
  const all = (history ?? []).slice(0, routineHistoryMax);
  const shown = expanded ? all : all.slice(0, closed);
  return {
    rows: shown.map((run, index) => ({
      key: `${run.startedAt}\n${index}`,
      startedAt: run.startedAt,
      ok: run.status === "succeeded",
      label: `${routineCauseLabel(run.cause)} · ${run.status === "succeeded" ? "成功" : "失败"}`,
      summary: run.summary,
    })),
    more: all.length - shown.length,
  };
}

/** The 修改 form's fields, all text as typed. */
export interface RoutineDraft {
  name: string;
  instruction: string;
  type: RoutineTrigger["type"];
  minutes: string;
  at: string;
  /** 0 = Sunday, as the server counts. */
  days: number[];
  from: string;
  subjectHas: string;
}

export function routineDraftOf(task: {
  title: string;
  prompt?: string;
  routine: Routine;
}): RoutineDraft {
  const trigger = task.routine.trigger;
  return {
    name: task.title,
    instruction: task.prompt ?? "",
    type: trigger.type,
    minutes: trigger.type === "every" ? String(trigger.minutes) : "30",
    at: trigger.type === "daily" || trigger.type === "weekly" ? trigger.at : "09:00",
    days: trigger.type === "weekly" ? [...trigger.days] : [1],
    from: trigger.type === "mail" ? (trigger.from ?? "") : "",
    subjectHas: trigger.type === "mail" ? (trigger.subjectHas ?? "") : "",
  };
}

function draftTrigger(draft: RoutineDraft): { trigger: RoutineTrigger } | { error: string } {
  const raw =
    draft.type === "every"
      ? { type: "every", minutes: Number(draft.minutes) }
      : draft.type === "daily"
        ? { type: "daily", at: draft.at }
        : draft.type === "weekly"
          ? { type: "weekly", at: draft.at, days: [...draft.days].sort((a, b) => a - b) }
          : {
              type: "mail",
              ...(draft.from.trim() ? { from: draft.from.trim() } : {}),
              ...(draft.subjectHas.trim() ? { subjectHas: draft.subjectHas.trim() } : {}),
            };
  const parsed = routineTriggerSchema.safeParse(raw);
  if (parsed.success) return { trigger: parsed.data };
  if (draft.type === "every") return { error: "间隔填 1 到 10080 分钟" };
  if (draft.type === "weekly" && draft.days.length === 0) return { error: "至少选一天" };
  return { error: "时间写成 09:00 这样" };
}

/** What the form sends (only what changed), or the sentence that says what to fix. */
export function routineDraftBody(
  draft: RoutineDraft,
  original: RoutineDraft,
): { body: Record<string, unknown> } | { error: string } {
  const name = draft.name.trim();
  const instruction = draft.instruction.trim();
  if (!name) return { error: "名称不能空" };
  if (!instruction) return { error: "要做什么不能空" };
  const next = draftTrigger(draft);
  if ("error" in next) return next;
  const before = draftTrigger(original);
  const changed =
    "error" in before || JSON.stringify(before.trigger) !== JSON.stringify(next.trigger);
  const body = {
    ...(name !== original.name.trim() ? { name } : {}),
    ...(instruction !== original.instruction.trim() ? { instruction } : {}),
    ...(changed ? { trigger: next.trigger } : {}),
  };
  return Object.keys(body).length ? { body } : { error: "没有改动" };
}

/** A repeating task that has never run and has no wake time will wait for its written clock
 * once the account has a time zone. The instant, or null when it still runs as soon as it can. */
export function queuedClockWake(
  task: {
    status: string;
    nextRunAt?: string | null;
    runs?: number;
    resumes?: number;
    prompt?: string;
  },
  timezone: string | null | undefined,
  now = new Date(),
): string | null {
  if (task.status !== "queued" || task.nextRunAt) return null;
  if (Number(task.runs ?? 0) !== 0 || Number(task.resumes ?? 0) !== 0) return null;
  const zone = timezone?.trim();
  if (!zone) return null;
  const when = task.prompt
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("什么时候："))
    ?.slice("什么时候：".length)
    .trim();
  if (!when) return null;
  return nextClockRun(when, zone, new Date(now.getTime() + 60_000));
}

/** Which zone a written clock is read in: 「按 Asia/Shanghai」 for 「每天 7:30」 or 「每周一 9:00」,
 * empty for anything else (an interval has no clock) or when there is no zone to name. */
export function clockZoneNote(when: string, timezone: string | null | undefined): string {
  const zone = timezone?.trim();
  if (!zone) return "";
  const text = when.trim();
  const clock =
    /^每天\s*\d{1,2}:\d{2}/.test(text) || /^每周[一二三四五六日]\s*\d{1,2}:\d{2}/.test(text);
  return clock ? t.settings.clockZone(zone) : "";
}

/** The day a usage total was counted (`YYYY-MM-DD` from the server), as a short date. */
export function usageDayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** The group rail's one status: a need waits in her own chat; a running desktop is in use. */
export function groupMemberMark(input: {
  state: "needs" | "blocked" | "running" | "waiting" | "idle";
  line: string;
  desktop: string;
}): { tone: "wait" | "desk" | "plain"; text: string } {
  if (input.state === "needs") return { tone: "wait", text: "等你" };
  if (input.desktop === "running") return { tone: "desk", text: "在用电脑" };
  const line = input.line.trim();
  return { tone: "plain", text: line || "空闲" };
}

/** The switch on a routine: on pauses it, off resumes it. */
export function routineSwitch(on: boolean): "pause" | "resume" {
  return on ? "pause" : "resume";
}

/** The duty line: who they are, the background, and what they never touch. Empty when unset. */
export function dutyText(
  parts: Partial<Record<"who" | "background" | "boundaries", string | null>> | null,
): string {
  if (!parts) return "";
  return [parts.who, parts.background, parts.boundaries]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

/** v1.2: a member's questions, reviews and account needs stay in her chat. With nobody open,
 * only what has no member (so it is not lost) stays in the group. */
export function needsForMember<T>(
  needs: readonly T[],
  memberId: string | null,
  environmentOf: (item: T) => string | null,
): T[] {
  if (memberId) return needs.filter((item) => environmentOf(item) === memberId);
  return needs.filter((item) => environmentOf(item) == null);
}

/** An account need whose guide card is already in this conversation. The row would only point at
 * that card. Task questions and reviews stay. */
export function dropGuidedAccountNeeds<T>(
  needs: readonly T[],
  guidedAccountIds: ReadonlySet<string>,
  accountIdOf: (item: T) => string | null,
): T[] {
  return needs.filter((item) => {
    const id = accountIdOf(item);
    return !(id && guidedAccountIds.has(id));
  });
}

/** Tasks that run on this member's desktop. */
export function taskIdsForMember<T extends { id: string; status?: string }>(
  tasks: readonly T[],
  memberId: string,
  environmentOf: (task: T) => string | null,
): string[] {
  // A cancelled task (a deleted routine) never reports again: it is not read, so a member who once had
  // fifty routines does not keep fifty requests going.
  return tasks
    .filter((task) => task.status !== "cancelled" && environmentOf(task) === memberId)
    .map((task) => task.id);
}

/** Most tasks of one member whose reports are read one by one: the newest (the list is oldest first). The
 * rest still show their runs under 最近运行, and a routine's results are filed on the conversation, which
 * is read as a whole. Fifty routines at once would be fifty requests per round from each of two polls. */
export const reportTaskCap = 20;
export const capReportTasks = (ids: readonly string[]): string[] => ids.slice(-reportTaskCap);

/** How often a member's per-task report reads go round. One request per task each round, so the
 * round slows down with the number of tasks: at most about 12 requests a minute from one poll (two polls read a member's tasks), far under the server's
 * 120 a minute per address (a member may have 50 routines; at 5 s each they were 600 a minute and locked the
 * person out with 「刚才的请求太多了」). */
export const taskReportPollMs = (tasks: number, baseMs: number): number =>
  Math.max(baseMs, tasks * 5000);

/** Pages of one member's routine results. A page that failed to load is `null` and is left
 * out. When every page failed, `null` means keep whatever is already on screen. */
export function loadedTaskReports<T>(pages: readonly (readonly T[] | null)[]): T[] | null {
  const ok = pages.filter((page): page is readonly T[] => page !== null);
  if (ok.length === 0 && pages.length > 0) return null;
  return ok.flat();
}

/** Facts remembered while this member's desktop was in use. Ones with no member stay off the card. */
export function memoriesForMember<T extends { accountId?: string | null }>(
  memories: readonly T[],
  accountId: string,
): T[] {
  return memories.filter((memory) => memory.accountId === accountId);
}

/** The newest result of one routine, one line, so the top of her chat says what it last did. */
export function newestReportSentence(
  reports: readonly { taskId: string; createdAt: string; text?: string; title?: string }[],
  taskId: string,
): string {
  const newest = reports
    .filter((report) => report.taskId === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  const text = (newest?.text || newest?.title || "").trim().split("\n")[0]?.trim() ?? "";
  // A stored status word is not the result. The card already translates that label.
  if (
    !text ||
    text === "Finished" ||
    text === "Update" ||
    text === "Needs attention" ||
    text === "Needs your input" ||
    text === "Ready for your review" ||
    text === "Run failed"
  )
    return "";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** This routine's results, newest first. The card shows a few; the conversation keeps the rest. */
export function recentReportsFor<T extends { taskId: string; createdAt: string }>(
  reports: readonly T[],
  taskId: string,
  limit = 5,
): T[] {
  return reports
    .filter((report) => report.taskId === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** The newest report of one routine, for the line under it on the member card. */
export function latestReportFor<T extends { taskId: string; createdAt: string }>(
  reports: readonly T[],
  taskId: string,
): T | null {
  return recentReportsFor(reports, taskId, 1)[0] ?? null;
}

/** Routines a template could not schedule, written on the goal as `标题（时候）：…`. */
export function goalRoutines(goal: string | null | undefined): { title: string; when: string }[] {
  const rows: { title: string; when: string }[] = [];
  for (const line of (goal ?? "").split("\n")) {
    const match = /^(.+?)（([^）]+)）：/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const title = match[1].trim();
    const when = match[2].trim();
    if (title && when) rows.push({ title, when });
  }
  return rows;
}

/** Apps a template wrote on the goal as `要连接：…`. Empty when that line is absent. */
export function appsToConnect(goal: string | null | undefined): string {
  const line = (goal ?? "")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.startsWith("要连接："));
  return line?.slice("要连接：".length).trim() ?? "";
}
