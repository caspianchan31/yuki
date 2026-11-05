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
 *   founder (fork, make it run) the founder outside her own conversation reads her real loop
 *           (GET /api/founder, founder-core founderState): 正在做, 下次 …, 经营停了, 没在经营;
 *           「创始人」 only until that is known
 *   `stalled` the worker has no heartbeat (ShellData.stalled, the 进度汇报 page's line): nothing
 *           reads as moving
 *   routine (phase 2) the account's 经营循环 in one line: how often it wakes (its repeating
 *           task), when it last acted (the pacing ledger) and how many things it did today:
 *           「每 10 分钟 · 上次 01:46 · 今天 3 件」; null when nothing of it is known
 */
import {
  clockLabel,
  durationLabel,
  rhythmLabel,
} from "../../../../../packages/domain/src/task-phase.ts";
import { type FounderAccount, founderState } from "../founder/founder-core.ts";
import type { FounderRef } from "../jobs/jobs-core.ts";
import { type AccountModel, anyKind, flagLabel, type ProjectOverview } from "../model.ts";
import { incidentWord, phaseWords, t } from "../strings.ts";

export type MemberState = "needs" | "blocked" | "running" | "waiting" | "idle";

export interface MemberCard {
  key: string;
  name: string;
  /** The round avatar's letter; "" for the 运营专员 (the mascot). */
  initial: string;
  kind: "ops" | "account" | "project";
  founder: boolean;
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
  routine: string | null;
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

/** The minutes between the wakes of the account's loop: its live repeating task (the shortest
 * repeat when it has several); null without one. */
export function wakeMinutes(account: Pick<AccountModel, "tasks">): number | null {
  const repeats = account.tasks
    .map((entry) => entry.task.repeatMinutes)
    .filter((value): value is number => typeof value === "number" && value > 0);
  return repeats.length ? Math.min(...repeats) : null;
}

/** How many things the account did today, by its pacing ledger (every kind but `*`, which
 * repeats the others); null when the ledger is not known here. */
export function doneToday(account: Pick<AccountModel, "pacing">): number | null {
  const status = account.pacing.present ? account.pacing.status : null;
  if (!status) return null;
  return Object.entries(status.usedToday)
    .filter(([kind]) => kind !== anyKind)
    .reduce((sum, [, used]) => sum + Math.max(0, used), 0);
}

/** The account's 经营循环 in one line: 「每 10 分钟 · 上次 01:46 · 今天 3 件」. Each part only when
 * known; null when none is (no loop, no ledger). */
export function accountRoutine(
  account: Pick<AccountModel, "tasks" | "pacing">,
  now: number,
): string | null {
  const r = t.members.routine;
  const wake = wakeMinutes(account);
  const last = account.pacing.present ? account.pacing.status?.lastActionAt : null;
  const lastClock = last ? clockLabel(last, now, phaseWords) : "";
  const done = doneToday(account);
  const parts = [
    wake !== null ? r.every(rhythmLabel(wake, phaseWords)) : null,
    lastClock ? r.last(lastClock) : null,
    done !== null ? r.today(done) : null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(t.common.sep) : null;
}

export function accountMember(
  account: Pick<
    AccountModel,
    "id" | "name" | "flags" | "incident" | "now" | "tasks" | "next" | "desktop" | "view" | "pacing"
  >,
  now: number,
  founder: boolean,
  /** The worker has no heartbeat (ShellData.stalled): nothing reads as moving. */
  stalled: boolean,
): MemberCard {
  return {
    key: `account:${account.id}`,
    name: account.name,
    initial: initialOf(account.name),
    kind: "account",
    founder,
    environmentId: account.id,
    state: accountState(account, stalled),
    line: accountLine(account, now, stalled),
    now: account.now?.entry.task.title ?? null,
    desktopOn: account.desktop === "running",
    routine: accountRoutine(account, now),
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
    founder: false,
    projectId: project.id ?? undefined,
    state,
    line,
    now: null,
    desktopOn: false,
    routine: null,
  };
}

/** The 运营专员 of the conversation: the one who answers in it; no state of its own. */
export function opsMember(name: string): MemberCard {
  return {
    key: "ops",
    name,
    initial: "",
    kind: "ops",
    founder: false,
    state: "idle",
    line: t.members.ops,
    now: null,
    desktopOn: false,
    routine: null,
  };
}

/** The founder with no account in this conversation's accounts (a project's conversation: she
 * belongs to the space). Her real state from her loop (`account`, GET
 * /api/founder: running, waiting, stopped and why, or 没在经营 with nothing to work on), never a
 * fixed idle; only while that is not known (not read yet, another founder) 「创始人」. */
export function founderMember(
  founder: FounderRef,
  account: FounderAccount | null = null,
  now: number = Date.now(),
  stalled = false,
): MemberCard {
  const known =
    account && (!founder.environmentId || account.environmentId === founder.environmentId)
      ? founderState(account, now, stalled)
      : null;
  return {
    key: `founder:${founder.environmentId ?? founder.name}`,
    name: founder.name,
    initial: initialOf(founder.name),
    kind: "account",
    founder: true,
    ...(founder.environmentId ? { environmentId: founder.environmentId } : {}),
    state: known?.state ?? "idle",
    line: known?.line ?? t.members.founder,
    // Hover and the spoken label: why she stopped (or what keeps failing), else her loop.
    now: known?.detail ?? (known?.phase ? (account?.loop?.title ?? null) : null),
    desktopOn: false,
    routine: null,
  };
}

/** The bar's members, in order: the founder, then the accounts here (a project) or each project
 * (the hall), then the 运营专员 who answers this conversation. */
export function members(input: {
  hall: boolean;
  ops: string;
  founder: FounderRef | null;
  /** The founder as GET /api/founder reads her (her loop), for her face
   * where she is not one of the accounts here; null or absent while not known. */
  founderAccount?: FounderAccount | null;
  accounts: readonly Parameters<typeof accountMember>[0][];
  projects: readonly Parameters<typeof projectMember>[0][];
  now: number;
  /** The worker has no heartbeat (ShellData.stalled). */
  stalled: boolean;
}): MemberCard[] {
  const isFounder = (account: { id: string; name: string; view?: { founder?: boolean } }) =>
    account.view?.founder === true ||
    (input.founder !== null &&
      (input.founder.environmentId
        ? input.founder.environmentId === account.id
        : input.founder.name === account.name));
  const own = input.accounts.map((account) =>
    accountMember(account, input.now, isFounder(account), input.stalled),
  );
  const founderHere = own.find((member) => member.founder);
  const rest = own.filter((member) => !member.founder);
  const founder = founderHere
    ? [founderHere]
    : input.founder
      ? [founderMember(input.founder, input.founderAccount ?? null, input.now, input.stalled)]
      : [];
  const middle = input.hall
    ? input.projects
        .filter((project) => project.id !== null)
        .map((project) => projectMember(project, input.stalled))
    : [];
  return [...founder, ...rest, ...middle, opsMember(input.ops)];
}
