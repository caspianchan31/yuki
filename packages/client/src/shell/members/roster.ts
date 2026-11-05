// v1.2: the contact list groups members by how often their routine wakes, and projects as 群.
// 每天 is anything that wakes sooner than a week (a standing loop with no interval counts: it
// still has a routine). 每周 is a week or longer. 没有例行 is a member with neither.
import type { AgentTask, ChatReport } from "../../../../../packages/domain/src/agent.ts";
import { memberAccountId } from "../../../../../packages/domain/src/member-thread.ts";
import { isStandingTask } from "../../../../../packages/domain/src/standing.ts";
import { taskEnvironmentId } from "../../../../../packages/domain/src/task-phase.ts";
import { isHandoffNotice } from "../../chat-reports-core.ts";

export type RoutineBucket = "daily" | "weekly" | "none";

/** Seven days, the same ceiling as a task's repeatMinutes. */
export const weekMinutes = 7 * 24 * 60;

const ended = new Set(["succeeded", "cancelled"]);

export function routineBucket(
  repeatMinutes: readonly (number | null | undefined)[],
  standing: boolean,
): RoutineBucket {
  const repeats = repeatMinutes.filter(
    (minutes): minutes is number =>
      typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0,
  );
  const shortest = repeats.length ? Math.min(...repeats) : null;
  // A standing loop wakes on its own, sooner than a week, even beside a weekly task.
  if (standing || (shortest !== null && shortest < weekMinutes)) return "daily";
  if (shortest !== null) return "weekly";
  return "none";
}

type RoutineTask = Pick<AgentTask, "repeatMinutes" | "input" | "state" | "status">;

/** Live tasks only: a finished one is not a routine. */
export function taskRoutineBucket(tasks: readonly RoutineTask[]): RoutineBucket {
  const live = tasks.filter((task) => !ended.has(task.status));
  return routineBucket(
    live.map((task) => task.repeatMinutes),
    live.some((task) => isStandingTask(task)),
  );
}

export interface RosterMember {
  id: string;
  name: string;
  line: string;
  bucket: RoutineBucket;
  founder: boolean;
  projectId: string | null;
}

export interface RosterGroup {
  id: string | null;
  name: string;
  line: string;
  deleting: boolean;
}

export interface RosterSection {
  key: "daily" | "weekly" | "groups" | "none";
  label: string;
  members: RosterMember[];
  groups: RosterGroup[];
}

/** Sections in the design's order. A section with nobody in it is left out, except 群 when
 * `keepGroups` is set: its heading holds 新建群, so it stays with no group made yet. */
export function rosterSections(input: {
  members: readonly RosterMember[];
  groups: readonly RosterGroup[];
  keepGroups?: boolean;
}): RosterSection[] {
  const daily = input.members.filter((member) => member.bucket === "daily");
  const weekly = input.members.filter((member) => member.bucket === "weekly");
  const none = input.members.filter((member) => member.bucket === "none");
  const sections: RosterSection[] = [];
  if (daily.length) sections.push({ key: "daily", label: "每天", members: daily, groups: [] });
  if (weekly.length) sections.push({ key: "weekly", label: "每周", members: weekly, groups: [] });
  if (none.length) sections.push({ key: "none", label: "没有例行", members: none, groups: [] });
  if (input.groups.length || input.keepGroups)
    sections.push({ key: "groups", label: "群", members: [], groups: [...input.groups] });
  return sections;
}

function environmentIdOf(task: { input?: unknown }): string | null {
  const input = task.input;
  if (!input || typeof input !== "object") return null;
  const id = (input as { environmentId?: unknown }).environmentId;
  return typeof id === "string" && id ? id : null;
}

function asRoutineTask(value: unknown): RoutineTask | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Partial<RoutineTask>;
  if (typeof task.status !== "string") return null;
  return {
    status: task.status,
    repeatMinutes: typeof task.repeatMinutes === "number" ? task.repeatMinutes : null,
    input: task.input && typeof task.input === "object" ? task.input : {},
    state: task.state && typeof task.state === "object" ? task.state : {},
  };
}

/** GET /api/agent → each account's bucket, from the tasks bound to it. */
export function bucketsFromAgent(payload: unknown): Map<string, RoutineBucket> {
  const tasks =
    payload && typeof payload === "object" ? (payload as { tasks?: unknown }).tasks : null;
  const byAccount = new Map<string, RoutineTask[]>();
  if (Array.isArray(tasks)) {
    for (const value of tasks) {
      const task = asRoutineTask(value);
      const id = task ? environmentIdOf(task) : null;
      if (!task || !id) continue;
      const list = byAccount.get(id) ?? [];
      list.push(task);
      byAccount.set(id, list);
    }
  }
  return new Map([...byAccount].map(([id, list]) => [id, taskRoutineBucket(list)]));
}

/** Each member's newest result. A handoff stays out. Her own conversation counts even after the
 * task is gone. */
export function rosterPreview(
  tasks: AgentTask[],
  reports: ChatReport[],
): Map<string, { text: string; at: string }> {
  const envOf = new Map(tasks.map((task) => [task.id, taskEnvironmentId(task)]));
  const latest = new Map<string, { at: string; text: string }>();
  for (const report of reports) {
    if (isHandoffNotice(report)) continue;
    const env = envOf.get(report.taskId) || memberAccountId(report.threadId);
    const text = (report.text || report.title || "").trim();
    if (!env || !text) continue;
    const known = latest.get(env);
    if (!known || report.createdAt > known.at) latest.set(env, { at: report.createdAt, text });
  }
  return latest;
}

/** The contact row's second line. A need or a live status stays. A quiet member shows her latest
 * result instead, one line, cut when it is long. */
export function rosterLine(status: string, latest: string | null, quiet: boolean): string {
  const line = status.trim();
  const sentence = latest?.trim().split("\n")[0]?.trim() ?? "";
  const shown = sentence.length > 42 ? `${sentence.slice(0, 42)}…` : sentence;
  if (line && !quiet) return line;
  return shown || line;
}

/** A 需要你 line that stays in the group. A member's question, review or account need is on her
 * own conversation, so another project's group count leaves it out. A line the server did not
 * describe stays, so an older count is not wiped. */
export function groupKeepsNeed(line: { kind: string; account: string | null }): boolean {
  if (line.kind === "account") return false;
  if (line.kind === "project" || line.kind === "unknown") return true;
  return !line.account?.trim();
}

export function groupNeedCount(lines: readonly { kind: string; account: string | null }[]): number {
  return lines.filter(groupKeepsNeed).length;
}
