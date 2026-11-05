/**
 * The members bar's model: who is in this conversation, what
 * state each is in and the one line under its name. The bar (MemberBar.tsx) only draws it.
 *
 *   state   needs    red    a need, a failure or a question waits on the person
 *           blocked  amber  kept from running by an open infrastructure incident (it retries)
 *           running  dark   a task of its runs now, and the worker is alive (its heartbeat)
 *           waiting  grey   queued, waiting or scheduled: it will run by itself; a run the
 *                           worker no longer carries (no heartbeat: nothing moves)
 *           idle     faint  nothing live: paused (line 已暂停), or no task (停着)
 *   line    one short line: 「正在做」, 「排队中」, 「后台停着」, 「01:56 再试」, 「桌面没响应 2 小时了」,
 *           「没在经营」, 「停着」; a project in the hall: 「等你 2 件」, 「3 个在跑」, 「等着」, 「后台停着」,
 *           「没在跑」
 *   `stalled` the worker has no heartbeat (ShellData.stalled, the 进度汇报 page's line): nothing
 *           reads as moving
 */
import { durationLabel } from "../../../../../packages/domain/src/task-phase.ts";
import { type AccountModel, flagLabel, type ProjectOverview } from "../model.ts";
import { incidentWord, t } from "../strings.ts";

export type MemberState = "needs" | "blocked" | "running" | "waiting" | "idle";

export interface MemberCard {
  key: string;
  name: string;
  /** The round avatar's letter; "" for the 运营专员 (the mascot). */
  initial: string;
  kind: "ops" | "account" | "project";
  environmentId?: string;
  /** A project standing in the hall for its accounts (kind "project"). */
  projectId?: string;
  state: MemberState;
  line: string;
  /** What it is on now, for hover and the accessibility label; null when nothing. */
  now: string | null;
  /** Its desktop is on: the small dot at the avatar's corner. */
  desktopOn: boolean;
  /** Its 经营循环 in one line (phase 2); null for a member without one. */
}

const initialOf = (name: string) => name.trim().charAt(0).toUpperCase();

/** A member's spoken label (accessibility, hover): its parts in order, each once, empty ones
 * left out (「停着」 as the state word and as the line is said once). */
export function spokenLabel(parts: readonly (string | null | undefined)[]): string {
  return [...new Set(parts.filter((part): part is string => !!part))].join(t.common.sep);
}

/** An account's state from what its live tasks are doing; `stalled`: the worker has no
 * heartbeat, so nothing it does moves. */
export function accountState(
  account: Pick<AccountModel, "flags" | "incident" | "now" | "tasks">,
  stalled = false,
): MemberState {
  if (
    account.flags.length ||
    account.now?.entry.phase.needsYou ||
    account.tasks.some((entry) => entry.phase.key === "fail")
  )
    return "needs";
  if (account.incident) return "blocked";
  const key = account.now?.entry.phase.key;
  // 正在做 only for a run the worker carries on: a queued task waits for the worker to take it
  // (排队中 everywhere else), and with no heartbeat a run waits for the worker too.
  if (key === "run") return stalled ? "waiting" : "running";
  if (key === "queue" || key === "wait" || key === "sched") return "waiting";
  return "idle";
}

/** The line under an account's name. */
export function accountLine(
  account: Pick<AccountModel, "flags" | "incident" | "now" | "tasks" | "next">,
  now: number,
  stalled = false,
): string {
  const state = accountState(account, stalled);
  if (state === "needs") {
    if (account.flags[0]) return flagLabel(account.flags[0]);
    // Its standing loop stopped: the account does nothing at all.
    const stopped = account.tasks.find((entry) => entry.phase.stopped)?.phase;
    if (stopped) return stopped.key === "pause" ? t.members.loopPaused : t.members.loopStopped;
    return account.now?.entry.phase.label ?? "";
  }
  if (state === "blocked" && account.incident) {
    const since = Date.parse(account.incident.since);
    return t.members.blocked(
      incidentWord(account.incident.kind),
      durationLabel(Math.max(0, now - (Number.isNaN(since) ? now : since))),
    );
  }
  // A standing task of it runs without acting (its plan's pace, nothing done
  // on a site for days: `TaskPhase.behind`), said instead of 正在做 / 等着.
  const behind = account.tasks.find((entry) => entry.phase.behind)?.phase.behind;
  if (behind && (state === "running" || state === "waiting")) return t.members.behind(behind.days);
  if (state === "running") return t.members.running;
  // A run the worker no longer carries (no heartbeat): it does not move, as 进度汇报 says.
  if (state === "waiting" && account.now?.entry.phase.key === "run") return t.members.stalled;
  // A queued task reads its phase word (排队中), as in 此刻, the accounts table and 进度汇报.
  if (state === "waiting" && account.now?.entry.phase.key === "queue")
    return account.now.entry.phase.label;
  if (state === "waiting") return account.next?.label ?? t.members.waiting;
  // A paused routine reads 已暂停, as its phase does in 此刻 and the task (one word everywhere);
  // a desktop that runs is not work running, so it never makes an account 正在做.
  if (account.now?.entry.phase.key === "pause") return account.now.entry.phase.label;
  return t.members.idle;
}

export function accountMember(
  account: Pick<
    AccountModel,
    "id" | "name" | "flags" | "incident" | "now" | "tasks" | "next" | "desktop" | "view"
  >,
  now: number,
  /** The worker has no heartbeat (ShellData.stalled): nothing reads as moving. */
  stalled: boolean,
): MemberCard {
  return {
    key: `account:${account.id}`,
    name: account.name,
    initial: initialOf(account.name),
    kind: "account",
    environmentId: account.id,
    state: accountState(account, stalled),
    line: accountLine(account, now, stalled),
    now: account.now?.entry.task.title ?? null,
    desktopOn: account.desktop === "running",
  };
}

/** A project's state in the hall, from its overview counts; `stalled` as for an account. */
export function projectState(
  project: Pick<ProjectOverview, "counts">,
  stalled = false,
): MemberState {
  const c = project.counts;
  // `needsYou` holds the failures in 需要你 already (taskPhaseCounts): failed7d never adds to it.
  if (c.needsYou > 0) return "needs";
  if (c.running > 0 && !stalled) return "running";
  if (c.running + c.queued + c.waiting + c.scheduled > 0) return "waiting";
  return "idle";
}

export function projectMember(
  project: Pick<ProjectOverview, "id" | "name" | "accounts" | "counts">,
  stalled: boolean,
): MemberCard {
  const state = projectState(project, stalled);
  const c = project.counts;
  const line =
    state === "needs"
      ? // The project's whole 需要你, the number its rows on the 需要你 page add up to.
        t.members.projectNeeds(c.needsYou)
      : state === "running"
        ? t.members.projectRunning(c.running)
        : state === "waiting"
          ? stalled && c.running > 0
            ? t.members.stalled
            : t.members.waiting
          : project.accounts
            ? t.members.projectIdle
            : t.members.noAccounts;
  return {
    key: `project:${project.id}`,
    name: project.name,
    initial: initialOf(project.name),
    kind: "project",
    projectId: project.id ?? undefined,
    state,
    line,
    now: null,
    desktopOn: false,
  };
}

/** The 运营专员 of the conversation: the one who answers in it; no state of its own. */
export function opsMember(name: string): MemberCard {
  return {
    key: "ops",
    name,
    initial: "",
    kind: "ops",
    state: "idle",
    line: t.members.ops,
    now: null,
    desktopOn: false,
  };
}

/** The bar's members, in order: the accounts here (a project) or each project
 * (the hall), then the 运营专员 who answers this conversation. */
export function members(input: {
  hall: boolean;
  ops: string;
  accounts: readonly Parameters<typeof accountMember>[0][];
  projects: readonly Parameters<typeof projectMember>[0][];
  now: number;
  /** The worker has no heartbeat (ShellData.stalled). */
  stalled: boolean;
}): MemberCard[] {
  const own = input.accounts.map((account) => accountMember(account, input.now, input.stalled));
  const middle = input.hall
    ? input.projects
        .filter((project) => project.id !== null)
        .map((project) => projectMember(project, input.stalled))
    : [];
  return [...own, ...middle, opsMember(input.ops)];
}
