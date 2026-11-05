/**
 * The pure model of the new shell. Everything the rail, the accounts page,
 * the chat cards and the header compute from server data lives here, so every surface reads the
 * same answer (design §4, §5) and node:test can pin it. No react-native, no fetch.
 *
 * Inputs are what the existing APIs return (GET /api/agent tasks, GET /api/environments views,
 * GET /api/workspace actions, chat reports) plus the optional contracts of the parallel pacing
 * stream (environment `pacing`, task `state.operatingPlan`, project brief) and of N1/N2. Every
 * optional field degrades to a documented reading; nothing here throws on a malformed payload.
 */

import type { AgentTask, ChatReport, IncidentKind } from "../../../../packages/domain/src/agent.ts";
import type {
  EnvironmentStatus,
  EnvironmentView,
} from "../../../../packages/domain/src/environments.ts";
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import {
  clockLabel,
  endedRecently,
  type TaskPhase,
  taskEnvironmentId,
  taskPhase,
} from "../../../../packages/domain/src/task-phase.ts";
import type { TranscriptItem } from "../chat-reports-core.ts";
import { failureText, phaseWords, t, taskTitleText } from "./strings.ts";
import type { Light } from "./theme.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const toMs = (now: Date | number) => (typeof now === "number" ? now : now.getTime());

// ───────────────────────────── tasks ─────────────────────────────

/** A task's phase as the shell shows it: `stalled` marks a run while the worker has no heartbeat
 * (`stalledPhase`). */
export type EntryPhase = TaskPhase & { stalled?: boolean };

/** A task with its phase, computed once per render pass. */
export interface TaskEntry {
  task: AgentTask;
  phase: EntryPhase;
  /** The bound account id (`input.environmentId`); null = the project's default desktop. */
  environmentId: string | null;
}

/** A run while the worker has no heartbeat (ShellData.stalled, the source of 进度汇报's line):
 * nothing carries it on, so wherever its phase shows (a pill, a task row, an account's 此刻, ⌘K,
 * 正在做, the task panel, a task card) it reads 「后台停着」, grey, with the line 「后台停着，不会
 * 推进」, never 运行中 or the step it is doing (`stalled` set). Its key stays "run": its place in
 * the order and its buttons are the run's. Any other phase is returned as it is: a queued task
 * still reads 排队中, a wait or a schedule when it goes on. */
export function stalledPhase(phase: TaskPhase, stalled: boolean): EntryPhase {
  if (!stalled || phase.key !== "run") return phase;
  return {
    ...phase,
    label: t.members.stalled,
    tone: "grey",
    sub: t.progress.stalled,
    stalled: true,
  };
}

/** Each task with its phase; an older account loop's title reads the new way (`taskTitleText`),
 * so every surface showing `entry.task.title` says 「<name> 的日常运营」. `stalled`: the worker has
 * no heartbeat (ShellData.stalled), so a run reads as stopped (`stalledPhase`). */
export function taskEntries(
  tasks: readonly AgentTask[],
  now: Date | number,
  stalled = false,
): TaskEntry[] {
  return tasks.map((raw) => {
    const title = taskTitleText(raw.title);
    const task = title === raw.title ? raw : { ...raw, title };
    return {
      task,
      phase: stalledPhase(taskPhase(task, { now, words: phaseWords }), stalled),
      environmentId: taskEnvironmentId(task),
    };
  });
}

/** A task's state as the person reads it (等你回答 / 运行中 / 排队中 / 已暂停 …): its phase label from
 * the shared phase table, never the raw `status` (「queued」); a run while the worker has no
 * heartbeat reads 「后台停着」 (`stalledPhase`). For a list line (a search hit). */
export function taskPhaseLabel(
  task: Parameters<typeof taskPhase>[0],
  now: Date | number = Date.now(),
  stalled = false,
): string {
  return stalledPhase(taskPhase(task, { now, words: phaseWords }), stalled).label;
}

const atMs = (entry: TaskEntry) => {
  const value = entry.phase.at ? Date.parse(entry.phase.at) : Number.NaN;
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};
/** 此刻 order: rank, then the earlier resume / next time, then the newer task. */
export function byPriority(a: TaskEntry, b: TaskEntry): number {
  return (
    a.phase.rank - b.phase.rank ||
    atMs(a) - atMs(b) ||
    b.task.updatedAt.localeCompare(a.task.updatedAt)
  );
}

/** The rail's task section (design §3.2): tasks that need you are only counted here (they
 * show in 需要你); active = running and queued, then waiting by resume time, then scheduled by
 * next run; paused and the last 24 hours' ended tasks are folded. */
export interface RailTasks {
  needCount: number;
  active: TaskEntry[];
  paused: TaskEntry[];
  ended: TaskEntry[];
}
export function railTasks(entries: readonly TaskEntry[], now: Date | number): RailTasks {
  const live = entries.filter((entry) => !entry.phase.needsYou);
  const active = live
    .filter((entry) => ["run", "queue", "wait", "sched"].includes(entry.phase.key))
    .sort(byPriority);
  return {
    needCount: entries.filter((entry) => entry.phase.needsYou).length,
    active,
    paused: live.filter((entry) => entry.phase.key === "pause").sort(byPriority),
    ended: live
      .filter((entry) => endedRecently(entry.phase, now))
      .sort((a, b) => atMs(b) - atMs(a)),
  };
}

/** "下一次 明天 10:05" for the quiet status strip, from the earliest wait or scheduled run. */
export function quietNext(entries: readonly TaskEntry[], now: Date | number): string {
  const next = entries
    .filter((entry) => entry.phase.key === "wait" || entry.phase.key === "sched")
    .sort((a, b) => atMs(a) - atMs(b))[0];
  const clock = next?.phase.at ? clockLabel(next.phase.at, now, phaseWords) : "";
  return clock ? t.strip.quietNext(clock) : t.strip.quietNothing;
}

// ───────────────────────────── accounts ─────────────────────────────

/** An account (environment) view as the shell holds it. */
export type AccountView = EnvironmentView;

/** What the account flags and light read of a view: an EnvironmentView or an AccountView. */
type AccountState = Pick<EnvironmentView, "status" | "signIns"> &
  Partial<Pick<EnvironmentView, "id" | "projectId" | "computer">>;

/** An account flag: the desktop flag, and (fork, credentials) the facts only the owner can act
 * on: a site's `wrong_password` / `needs_code` / `suspended` / `no_login` (`site:<status>:<site>`). */
export type AccountFlag = "desktopError" | `site:${string}`;
/** The site facts only the owner can act on, as flags. */
export const ownerSiteStatuses = [
  "wrong_password",
  "needs_code",
  "suspended",
  "no_login",
  "needs_owner",
] as const;
/** A `needs_code` / `needs_owner` fact the owner said he handled
 * (`ownerHandledAt`) and nothing confirmed yet: the AI is confirming it (「正在确认 x 的登录…」),
 * never 「要验证码」 again. Its flag is `site:confirming:<site>`. When no record came for too long
 * after that (`ownerHandledStale`, the server decides), it is `site:unconfirmed:<site>`: 「还没确认
 * 上，再点一次我弄好了或让她再看」, with the desktop card again; never a stale blame status
 * behind nothing. */
export type OwnerSiteStatus = (typeof ownerSiteStatuses)[number] | "confirming" | "unconfirmed";
const handledStatuses = ["confirming", "unconfirmed"] as const;
/** A sign-in fact as a flag; null when it is not one the owner acts on (or waits on). */
export function factFlag(fact: {
  site: string;
  status: string;
  ownerHandledAt?: string | null;
  ownerHandledStale?: boolean | null;
}): AccountFlag | null {
  if (!(ownerSiteStatuses as readonly string[]).includes(fact.status)) return null;
  if ((fact.status === "needs_code" || fact.status === "needs_owner") && fact.ownerHandledAt)
    return fact.ownerHandledStale
      ? `site:unconfirmed:${fact.site}`
      : `site:confirming:${fact.site}`;
  return `site:${fact.status}:${fact.site}`;
}
/** A site flag's parts. */
export function siteFlag(flag: AccountFlag): { status: OwnerSiteStatus; site: string } | null {
  const match = /^site:([a-z_]+):(.+)$/.exec(flag);
  if (!match) return null;
  const status = [...ownerSiteStatuses, ...handledStatuses].find((item) => item === match[1]);
  return status ? { status, site: match[2] } : null;
}
/** One account row's data, shared by the rail, the accounts page, details and pickers. */
export interface AccountModel {
  id: string;
  name: string;
  /** The account label when it says more than the name (u/name == name is hidden). */
  label: string | null;
  projectId: string | null;
  desktop: EnvironmentStatus;
  desktopWord: string;
  /** v1.5: why the computer is in error, in plain words; null when it is not. */
  desktopReason: string | null;
  locale: string | null;
  timezone: string | null;
  light: Light;
  flags: AccountFlag[];
  /** 此刻: the task with the lowest rank among the account's live tasks, and how many more. */
  now: { entry: TaskEntry; more: number } | null;
  /** An open infrastructure incident of one of its live tasks (what keeps
   * failing and since when): the row shows the fact while the task retries by itself, instead
   * of a silent loop. Never in 需要你. */
  incident?: { kind: IncidentKind; since: string } | null;
  /** 下次: the earliest resume or scheduled run. */
  next: { at: string; label: string } | null;
  /** 「example.com 已登录 · x.com 密码不对」; null when nothing is known. */
  login: string | null;
  /** Live (not ended) tasks bound to this account, by priority. */
  tasks: TaskEntry[];
  view: AccountView;
}

export function desktopWord(status: EnvironmentStatus): string {
  return t.desktop[status] ?? t.desktop.error;
}

/** v1.5: why a computer is in error, in plain words; null when it is not. The server's own
 * message (which may name the provider or a setting) is matched, never shown. */
export function desktopReason(status: EnvironmentStatus, message?: string | null): string | null {
  if (status !== "error") return null;
  const said = (message ?? "").toLowerCase();
  const r = t.desktop.reasons;
  if (said.includes("not configured") || said.includes("computer_enabled")) return r.disabled;
  if (said.includes("out of credit")) return r.noCredit;
  if (said.includes("did not answer in time") || said.includes("too long to start"))
    return r.timedOut;
  if (said.includes("ownership or isolation")) return r.isolation;
  if (said.includes("settings") || said.includes("decrypt")) return r.settings;
  return r.unknown;
}

/** The label worth showing beside the name: not when it is just the name again. */
export function shownLabel(name: string, label: string | null | undefined): string | null {
  if (!label) return null;
  return label.trim().toLowerCase() === name.trim().toLowerCase() ? null : label;
}

const phaseLight: Partial<Record<TaskPhase["key"], Light>> = {
  input: "amber",
  approval: "amber",
  fail: "red",
  run: "blue",
  queue: "blue",
  wait: "teal",
  sched: "teal",
  pause: "grey",
};

/** The account's flags: a desktop in error and the sign-in facts only the owner can act on. With no
 * computer connected a member has no desktop or sign-ins: no flag is hers. */
export function accountFlags(view: AccountState): AccountFlag[] {
  const flags: AccountFlag[] = [];
  if (view.computer === false) return flags;
  if (view.status === "error") flags.push("desktopError");
  for (const fact of view.signIns ?? []) {
    const flag = factFlag(fact);
    if (flag) flags.push(flag);
  }
  return flags;
}
/** A project sign-in fact as the shell keeps it: the site, the status and (fork, incident
 * screenshots) the id of the incident whose picture was kept, when there is one. */
export interface ProjectSignIn {
  site: string;
  status: string;
  shot?: string;
  /** When the fact was recorded (absent when the server does not say). */
  at?: string;
  /** The owner said he handled it; the AI is confirming it. */
  ownerHandledAt?: string;
  /** With `ownerHandledAt`: no record came for too long; the owner is asked to look again. */
  ownerHandledStale?: boolean;
  /** The page's own words the record quoted, and whether the server reads the
   * page as a step the desktop's own tools can answer (the desktop card's lines). */
  seen?: string;
}
/** The incident id of a sign-in fact whose picture of that moment
 * was kept (「当时的画面」); null when there is none. */
export function factShot(fact: unknown): string | null {
  const incident =
    fact && typeof fact === "object" ? (fact as { incident?: unknown }).incident : null;
  if (!incident || typeof incident !== "object") return null;
  const { id, shot } = incident as { id?: unknown; shot?: unknown };
  return shot === true && typeof id === "string" && id ? id : null;
}
/** GET /api/credentials/sign-ins → each fact's site and status (anything malformed is left out). */
export function normalizeProjectSignIns(payload: unknown): ProjectSignIn[] {
  const list =
    payload && typeof payload === "object" ? (payload as { signIns?: unknown }).signIns : null;
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const fact = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const shot = factShot(fact);
    const at = typeof fact.at === "string" && fact.at ? fact.at : null;
    const handled =
      typeof fact.ownerHandledAt === "string" && fact.ownerHandledAt ? fact.ownerHandledAt : null;
    return typeof fact.site === "string" && fact.site && typeof fact.status === "string"
      ? [
          {
            site: fact.site,
            status: fact.status,
            ...(shot ? { shot } : {}),
            ...(at ? { at } : {}),
            ...(handled ? { ownerHandledAt: handled } : {}),
            ...(handled && fact.ownerHandledStale === true ? { ownerHandledStale: true } : {}),
            ...(typeof fact.seen === "string" && fact.seen ? { seen: fact.seen } : {}),
          },
        ]
      : [];
  });
}
/** The project's own sign-in facts (GET /api/credentials/sign-ins: the logins its default
 * desktop uses) as flags, by the same rule as an account's (and as the server's project count). */
export function projectSignInFlags(
  facts: readonly { site: string; status: string }[],
): AccountFlag[] {
  return facts.flatMap((fact) => {
    const flag = factFlag(fact);
    return flag ? [flag] : [];
  });
}
/** The flags that put the account in 需要你 (one item per account): every flag is one only the
 * owner can act on, as the server counts it. */
export const needsYouFlags = (flags: readonly AccountFlag[]) => [...flags];

/** A flag as the account row prints it. */
export function flagLabel(flag: AccountFlag): string {
  const site = siteFlag(flag);
  if (site) {
    const words = {
      wrong_password: t.needs.wrongPassword,
      needs_code: t.needs.needsCode,
      needs_owner: t.needs.needsOwner,
      suspended: t.needs.suspended,
      no_login: t.needs.noLogin,
      confirming: t.needs.confirming,
      unconfirmed: t.needs.unconfirmed,
    } as const;
    return words[site.status](site.site);
  }
  if (flag === "desktopError") return t.flags.desktopError;
  return flag;
}
/** What 需要你 says for a flag. */
export function needText(flag: AccountFlag): string {
  if (flag === "desktopError") return t.needs.desktopError;
  return flagLabel(flag);
}
/** Where the owner deals with a flag: replace or add the site's login on the credentials page,
 * type a code on the account's desktop, or look at the account. */
export function needAction(
  flag: AccountFlag,
): { kind: "login"; site: string } | { kind: "desktop" } | { kind: "account" } {
  const site = siteFlag(flag);
  if (site?.status === "wrong_password" || site?.status === "no_login")
    return { kind: "login", site: site.site };
  if (
    site?.status === "needs_code" ||
    site?.status === "needs_owner" ||
    // Not confirmed after the owner's step: back to the desktop.
    site?.status === "unconfirmed"
  )
    return { kind: "desktop" };
  return { kind: "account" };
}
/** The account row's 登录 line: each site it has a login or a fact for, with the latest fact
 * (「example.com 已登录 · x.com 密码不对」); null when there is neither, so nothing is claimed. */
export function loginLine(view: Pick<EnvironmentView, "siteLogins" | "signIns">): string | null {
  const sites = new Set([
    ...(view.siteLogins ?? []).map((login) => login.site),
    ...(view.signIns ?? []).map((fact) => fact.site),
  ]);
  if (!sites.size) return null;
  const facts = new Map((view.signIns ?? []).map((fact) => [fact.site, fact]));
  return [...sites]
    .sort()
    .map((site) => {
      const fact = facts.get(site);
      return fact ? t.signIn.site(site, t.signIn.statuses[fact.status] ?? fact.status) : site;
    })
    .join(t.common.sep);
}
/** The detail's 登录 block: each site with its latest fact, the user name saved for it, when the
 * fact was recorded and what the AI wrote (masked by the server). */
export function signInRows(account: Pick<AccountModel, "view" | "flags">): {
  site: string;
  headline: string;
  username: string | null;
  at: string | null;
  detail: string | null;
  /** The page's words the record quoted, found on the page. */
  seen: string | null;
  flagged: boolean;
}[] {
  const view = account.view;
  const sites = new Set([
    ...(view.siteLogins ?? []).map((login) => login.site),
    ...(view.signIns ?? []).map((fact) => fact.site),
  ]);
  return [...sites].sort().map((site) => {
    const fact = view.signIns?.find((item) => item.site === site) ?? null;
    const login = view.siteLogins?.find((item) => item.site === site) ?? null;
    return {
      site,
      headline: fact ? t.signIn.site(site, t.signIn.statuses[fact.status] ?? fact.status) : site,
      username: login?.username ?? null,
      at: fact?.at ?? null,
      detail: fact?.detail ?? null,
      seen: fact?.seen ?? null,
      flagged: account.flags.some((flag) => siteFlag(flag)?.site === site),
    };
  });
}
/** One light per account (design §4.4). A run while the worker has no heartbeat is grey, as its
 * pill (stalledPhase): the blue light reads 「在跑或排队中」. */
export function accountLight(view: AccountState, top: TaskEntry | null): Light {
  const flags = accountFlags(view);
  if (needsYouFlags(flags).length) return "red";
  if (!top) return view.status === "missing" ? "hollow" : "grey";
  if (top.phase.stalled) return "grey";
  return phaseLight[top.phase.key] ?? "grey";
}

export function buildAccountModels(input: {
  accounts: readonly AccountView[];
  entries: readonly TaskEntry[];
  now: Date | number;
}): AccountModel[] {
  return input.accounts
    .filter((view) => !view.deleting)
    .map((view) => {
      const tasks = input.entries
        .filter((entry) => entry.environmentId === view.id && !entry.phase.ended)
        .sort(byPriority);
      const top = tasks[0] ?? null;
      const nextEntry = tasks
        .filter(
          (entry) => (entry.phase.key === "wait" || entry.phase.key === "sched") && entry.phase.at,
        )
        .sort((a, b) => atMs(a) - atMs(b))[0];
      const clock = nextEntry?.phase.at
        ? clockLabel(nextEntry.phase.at, input.now, phaseWords)
        : "";
      return {
        id: view.id,
        name: view.name,
        label: shownLabel(view.name, view.accountLabel),
        projectId: view.projectId,
        desktop: view.status,
        desktopWord: desktopWord(view.status),
        desktopReason: desktopReason(view.status, view.message),
        locale: view.settings.locale,
        timezone: view.settings.timezone,
        light: accountLight(view, top),
        flags: accountFlags(view),
        now: top ? { entry: top, more: tasks.length - 1 } : null,
        // Only while the task waits or is scheduled because of it: a run that works normally
        // again shows no flag (the record keeps the incident until the server ends it).
        incident:
          tasks.find(
            (entry) =>
              (entry.phase.key === "wait" || entry.phase.key === "sched") && entry.phase.incident,
          )?.phase.incident ?? null,
        next:
          nextEntry?.phase.at && clock
            ? {
                at: nextEntry.phase.at,
                label:
                  nextEntry.phase.key === "wait"
                    ? t.accountsRail.nextWait(clock)
                    : t.accountsRail.nextSched(clock),
              }
            : null,
        login: loginLine(view),
        tasks,
        view,
      };
    });
}

// ───────────────────────────── 需要你 ─────────────────────────────

/** One entry of 需要你 (decision 4). Same-account-in-two-tasks is not one. */
export type NeedItem =
  | { kind: "task"; key: string; entry: TaskEntry; account: AccountModel | null }
  | { kind: "review"; key: string; action: ActionProposal; entry: TaskEntry | null }
  | {
      kind: "account";
      key: string;
      account: AccountModel;
      /** The first flag that needs the owner; `flags` all of them. Each site's
       * sign-in step is an item of its own (`needParts`); the account's other flags are one. */
      reason: AccountFlag;
      flags: AccountFlag[];
    }
  /** The project's own logins (its default desktop): one item per site's step (`needParts`),
   * as the overview counts them. */
  | {
      kind: "project";
      key: string;
      flags: AccountFlag[];
      /** Site → the incident whose picture was kept. */
      shots?: Record<string, string>;
      /** Site → when its fact was recorded (the chat card's place). */
      raisedAt?: Record<string, string>;
      /** Site → the page's words its fact quoted and whether the page is a
       * step the desktop's own tools can answer (the desktop card's lines). */
      said?: Record<string, SiteSaid>;
    };
/** What a site's fact says about its page, for the desktop card. */
export interface SiteSaid {
  seen?: string;
}
/**
 * An account's (or the project's) flags as
 * 需要你 items, each counted as itself. Every site's step is one item (its key `<base>|<flag>`);
 * the flags that are not a site's (the desktop, not operating) are one item under the
 * base key. In the flags' order, the account's own first.
 */
export function needParts(
  flags: readonly AccountFlag[],
): { suffix: string; flags: AccountFlag[] }[] {
  const own = flags.filter((flag) => !siteFlag(flag));
  return [
    ...(own.length ? [{ suffix: "", flags: own }] : []),
    ...flags
      .filter((flag) => siteFlag(flag))
      .map((flag) => ({ suffix: `|${flag}`, flags: [flag] })),
  ];
}
/** What the fact of `site` in a 需要你 item says about its page (the account's own facts, or
 * the project's `said`). */
export function siteSaid(
  item: Extract<NeedItem, { kind: "account" | "project" }>,
  site: string,
): SiteSaid {
  if (item.kind === "project") return item.said?.[site] ?? {};
  const fact = item.account.view.signIns?.find((entry) => entry.site === site);
  return {
    ...(fact?.seen ? { seen: fact.seen } : {}),
  };
}

export function needItems(input: {
  entries: readonly TaskEntry[];
  /** GET /api/workspace `actions` (any status; only awaiting_review are used). */
  actions: readonly ActionProposal[];
  accounts: readonly AccountModel[];
  /** The project's own sign-in facts (GET /api/credentials/sign-ins); none when not loaded. */
  projectSignIns?: readonly ProjectSignIn[];
}): NeedItem[] {
  const projectFlags = projectSignInFlags(input.projectSignIns ?? []);
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const tasks = input.entries.filter((entry) => entry.phase.needsYou).sort(byPriority);
  const reviewing = new Set(
    tasks.filter((entry) => entry.phase.key === "approval").map((entry) => entry.task.actionId),
  );
  const reviews = input.actions.filter(
    (action) => action.status === "awaiting_review" && !reviewing.has(action.id),
  );
  const entryById = new Map(input.entries.map((entry) => [entry.task.id, entry]));
  return [
    ...tasks.map(
      (entry): NeedItem => ({
        kind: "task",
        key: `task:${entry.task.id}`,
        entry,
        account: entry.environmentId ? (accountById.get(entry.environmentId) ?? null) : null,
      }),
    ),
    ...reviews.map(
      (action): NeedItem => ({
        kind: "review",
        key: `review:${action.id}`,
        action,
        entry: action.taskId ? (entryById.get(action.taskId) ?? null) : null,
      }),
    ),
    ...input.accounts.flatMap((account): NeedItem[] => {
      const flags = needsYouFlags(account.flags);
      // The order a person deals with them: the desktop, then each site.
      const order = (flag: AccountFlag) => (flag === "desktopError" ? 0 : 1);
      const sorted = [...flags].sort((a, b) => order(a) - order(b));
      return needParts(sorted).map(
        (part): NeedItem => ({
          kind: "account",
          key: `account:${account.id}${part.suffix}`,
          account,
          reason: part.flags[0] as AccountFlag,
          flags: part.flags,
        }),
      );
    }),
    ...needParts(projectFlags).map(
      (part): NeedItem => ({
        kind: "project" as const,
        key: `project:sign-ins${part.suffix}`,
        flags: part.flags,
        ...projectShots(input.projectSignIns ?? []),
        ...projectRaisedAt(input.projectSignIns ?? []),
        ...projectSaid(input.projectSignIns ?? []),
      }),
    ),
  ];
}
function projectSaid(facts: readonly ProjectSignIn[]): { said?: Record<string, SiteSaid> } {
  const said = Object.fromEntries(
    facts.flatMap((fact) => {
      if (!fact.seen) return [];
      return [
        [
          fact.site,
          {
            ...(fact.seen ? { seen: fact.seen } : {}),
          },
        ],
      ];
    }),
  );
  return Object.keys(said).length ? { said } : {};
}
function projectRaisedAt(facts: readonly ProjectSignIn[]): { raisedAt?: Record<string, string> } {
  const raisedAt = Object.fromEntries(
    facts.flatMap((fact) =>
      fact.at && (ownerSiteStatuses as readonly string[]).includes(fact.status)
        ? [[fact.site, fact.at]]
        : [],
    ),
  );
  return Object.keys(raisedAt).length ? { raisedAt } : {};
}
function projectShots(facts: readonly ProjectSignIn[]): { shots?: Record<string, string> } {
  const shots = Object.fromEntries(
    facts.flatMap((fact) =>
      fact.shot && (ownerSiteStatuses as readonly string[]).includes(fact.status)
        ? [[fact.site, fact.shot]]
        : [],
    ),
  );
  return Object.keys(shots).length ? { shots } : {};
}
/** The picture of each flagged site of a 需要你 item whose latest
 * incident (the fact's) kept one, in the item's order: 「当时的画面」 thumbnails. */
export function needShots(item: NeedItem): { site: string; id: string }[] {
  if (item.kind !== "account" && item.kind !== "project") return [];
  const shotOf = (site: string) =>
    item.kind === "account"
      ? factShot(item.account.view.signIns?.find((fact) => fact.site === site))
      : (item.shots?.[site] ?? null);
  const seen = new Set<string>();
  return item.flags.flatMap((flag) => {
    const site = siteFlag(flag)?.site;
    const id = site ? shotOf(site) : null;
    if (!site || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ site, id }];
  });
}
/** What a stopped task's 需要你 card says and its one button. A one-off task's
 * failure in full (`failureText`) with 重试; a standing task that stopped (`phase.stopped`), in the
 * owner's words: 「经营停了：<why>」 with 重试. The same on the phone, the web's 需要你 page and the
 * web chat. */
export function stopNeed(entry: Pick<TaskEntry, "task" | "phase">): {
  text: string;
  op: "retry" | "resume";
  label: string;
} {
  const { task, phase } = entry;
  if (phase.stopped && phase.key === "pause")
    return { text: phase.sub, op: "resume", label: t.needs.resume };
  const error = task.error?.trim() ?? "";
  if (phase.stopped)
    return {
      text: phaseWords.loopStopped(error || phaseWords.failedUnknown),
      op: "retry",
      label: t.needs.retry,
    };
  // A failure the server wrote in English (a provider's quota answer) in Chinese.
  return { text: failureText(error) || phase.sub, op: "retry", label: t.needs.retry };
}

/** The project item's line: 「本项目：apple.com 密码不对 · x.com 要验证码」. */
export function projectNeedText(flags: readonly AccountFlag[]): string {
  return t.needs.projectFact(flags.map((flag) => needText(flag)).join(t.common.sep));
}

/** An account
 * item's one line: each thing the chat asks for named (「x.com 要验证码」), then 已在聊天里问你,
 * then the rest. The same on the phone and the web (need-card-state's `asked` / `other`). */
export function accountNeedLine(
  _item: Extract<NeedItem, { kind: "account" }>,
  m: { asked: readonly AccountFlag[]; other: readonly AccountFlag[] },
): string {
  return [
    ...m.asked.map((flag) => needText(flag)),
    ...(m.asked.length ? [t.guide.askedInChat] : []),
    ...m.other.map((flag) => needText(flag)),
  ].join(t.common.sep);
}
/** The project item's one line, the same way: 「本项目：x.com 要验证码 · 已在聊天里问你」. */
export function projectNeedLine(
  _item: Extract<NeedItem, { kind: "project" }>,
  m: { asked: readonly AccountFlag[]; other: readonly AccountFlag[] },
): string {
  return [
    m.asked.length ? projectNeedText(m.asked) : "",
    m.asked.length ? t.guide.askedInChat : "",
    m.other.length ? projectNeedText(m.other) : "",
  ]
    .filter(Boolean)
    .join(t.common.sep);
}

/** The status strip and project counts. `needsYou` is the whole 需要你 number (the 等你 cell is
 * needsYou − failed); running includes queued (design §3.1). */
export interface ShellCounts {
  needsYou: number;
  waitingOnYou: number;
  failed: number;
  running: number;
  waiting: number;
  scheduled: number;
}
export function shellCounts(
  entries: readonly TaskEntry[],
  needs: readonly NeedItem[],
): ShellCounts {
  const failed = entries.filter(
    (entry) => entry.phase.key === "fail" && entry.phase.needsYou,
  ).length;
  return {
    needsYou: needs.length,
    waitingOnYou: needs.length - failed,
    failed,
    running: entries.filter((entry) => entry.phase.key === "run" || entry.phase.key === "queue")
      .length,
    waiting: entries.filter((entry) => entry.phase.key === "wait").length,
    scheduled: entries.filter((entry) => entry.phase.key === "sched").length,
  };
}

// ───────────────────────────── reports ─────────────────────────────

/** The newest `count` reports, newest first (the rail's 汇报 section). */
export function latestReports(reports: readonly ChatReport[], count = 5): ChatReport[] {
  return [...reports]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, count);
}

/** Labels that are a stop the person must act on: shown as a need card, never merged. */
export const needReportLabels: readonly string[] = [
  "Needs your input",
  "Ready for your review",
  "Needs attention",
  "Run failed",
];

export type GroupedItem<M> =
  | { type: "message"; key: string; message: M }
  | { type: "reports"; key: string; taskId: string; reports: ChatReport[] }
  | { type: "need"; key: string; report: ChatReport }
  /** A card about the project's jobs or an account's persona (`report.notice`). */
  | { type: "notice"; key: string; report: ChatReport };

/**
 * Design §6.4–6.5: consecutive reports of one task (nothing of yours in between) merge into one
 * group whose latest is expanded; a need report always stands alone.
 */
export function groupTranscript<M>(
  items: readonly TranscriptItem<M>[],
  isNeed: (report: ChatReport) => boolean = (report) =>
    report.kind === "outcome" && needReportLabels.includes(report.title),
): GroupedItem<M>[] {
  const out: GroupedItem<M>[] = [];
  for (const item of items) {
    if (item.type === "message") {
      out.push(item);
      continue;
    }
    const report = item.report;
    if (isNeed(report)) {
      out.push({ type: "need", key: item.key, report });
      continue;
    }
    // A job declined or done, a persona changed: a card of its own, never merged.
    if (report.notice) {
      out.push({ type: "notice", key: item.key, report });
      continue;
    }
    const last = out.at(-1);
    if (last?.type === "reports" && last.taskId === report.taskId) last.reports.push(report);
    else out.push({ type: "reports", key: item.key, taskId: report.taskId, reports: [report] });
  }
  return out;
}

// ───────────────────────────── projects (N1) ─────────────────────────────

export interface ProjectCounts {
  needsYou: number;
  running: number;
  queued: number;
  waiting: number;
  scheduled: number;
  failed7d: number;
}
/** One 需要你 item of a project as N1 lists it (apps/server/src/project-overview.ts
 * ProjectNeedLine): its needItems key, what kind of stop it is, the title and the account. An
 * `unknown` line stands for an item of a server that only counts (no `needs` yet). */
export interface ProjectNeedLine {
  key: string;
  kind: "input" | "approval" | "fail" | "review" | "account" | "project" | "unknown";
  title: string;
  account: string | null;
  /** A site's sign-in step (an item of its own): the site and what it needs
   * (a flag status: needs_owner, needs_code, confirming…), named by `needLineWords`. */
  site?: string;
  need?: string;
}
/** One row of GET /api/projects/overview. `id` null is the default project (未分组). */
export interface ProjectOverview {
  id: string | null;
  name: string;
  accounts: number;
  counts: ProjectCounts;
  /** Every 需要你 item; `counts.needsYou` is its length (normalizeOverview keeps it so). Absent
   * on a row built here without N1's lines: `projectNeedLines` stands one line in per count. */
  needs?: ProjectNeedLine[];
  lastActivityAt: string | null;
}
const zeroCounts: ProjectCounts = {
  needsYou: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  scheduled: 0,
  failed7d: 0,
};
/** Reads `{ projects: ProjectOverview[] }` defensively; null when the payload is unusable. */
export function normalizeOverview(payload: unknown): ProjectOverview[] | null {
  const list = record(payload).projects;
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const value = record(item);
    const counts = record(value.counts);
    const needs = Array.isArray(value.needs) ? value.needs.map(needLineOf) : undefined;
    return {
      id: str(value.id),
      name: str(value.name) ?? "",
      accounts: num(value.accounts) ?? 0,
      counts: {
        // One source: with the lines, the count is their number.
        needsYou: needs ? needs.length : (num(counts.needsYou) ?? zeroCounts.needsYou),
        running: num(counts.running) ?? 0,
        queued: num(counts.queued) ?? 0,
        waiting: num(counts.waiting) ?? 0,
        scheduled: num(counts.scheduled) ?? 0,
        failed7d: num(counts.failed7d) ?? 0,
      },
      ...(needs ? { needs } : {}),
      lastActivityAt: str(value.lastActivityAt),
    };
  });
}
const needKinds: readonly ProjectNeedLine["kind"][] = [
  "input",
  "approval",
  "fail",
  "review",
  "account",
  "project",
];
function needLineOf(item: unknown, index: number): ProjectNeedLine {
  const value = record(item);
  const kind = str(value.kind);
  const site = str(value.site);
  const need = str(value.need);
  return {
    key: str(value.key) ?? `need:${index}`,
    kind: needKinds.find((known) => known === kind) ?? "unknown",
    title: str(value.title) ?? "",
    account: str(value.account),
    ...(site && need ? { site, need } : {}),
  };
}
/** Another project's site step named as the account row prints it
 * (「x.com 要验证码」); null for any other line, or a status this client does not know. */
export function needLineWords(line: Pick<ProjectNeedLine, "site" | "need">): string | null {
  if (!line.site || !line.need) return null;
  const flag: AccountFlag = `site:${line.need}:${line.site}`;
  return siteFlag(flag) ? flagLabel(flag) : null;
}
/** A project's 需要你 lines: N1's, or (a server that only counts) one `unknown` line per item,
 * so the rows shown are always as many as the number counted. */
export function projectNeedLines(
  row: Pick<ProjectOverview, "id" | "counts" | "needs">,
): ProjectNeedLine[] {
  if (row.needs) return row.needs;
  return Array.from({ length: Math.max(0, row.counts.needsYou) }, (_, index) => ({
    key: `${row.id ?? ""}:${index}`,
    kind: "unknown" as const,
    title: "",
    account: null,
  }));
}

/** One project's group on the whole space's 需要你 page: the current project's items with every
 * action they have (needItems), each other project's as N1's lines, opened by switching to it. */
export type SpaceNeedGroup =
  | { current: true; projectId: string | null; items: NeedItem[] }
  | { current: false; projectId: string | null; name: string; lines: ProjectNeedLine[] };
/** The whole space's 需要你, grouped by project: the current project first, then the others with
 * anything waiting in the project list's order (sortProjects; 未分组 last). The one source of
 * 需要你: `spaceNeedCount` of it is every count shown (sidebar, tab title, bottom bar). The
 * overview's own row for the current project is not used: its items are the local ones. */
export function spaceNeeds(
  local: readonly NeedItem[],
  overview: readonly ProjectOverview[] | null,
  current: string | null,
): SpaceNeedGroup[] {
  const others = sortProjects((overview ?? []).filter((row) => row.id !== current))
    .map(
      (row): SpaceNeedGroup => ({
        current: false,
        projectId: row.id,
        name: row.name,
        lines: projectNeedLines(row),
      }),
    )
    .filter((group) => !group.current && group.lines.length > 0);
  return [{ current: true, projectId: current, items: [...local] }, ...others];
}
/** How many rows the whole space's 需要你 page lists. */
export function spaceNeedCount(groups: readonly SpaceNeedGroup[]): number {
  return groups.reduce(
    (sum, group) => sum + (group.current ? group.items.length : group.lines.length),
    0,
  );
}
/** Design §3.3: projects with something for you first, then by latest activity; 未分组 last. */
export function sortProjects(list: readonly ProjectOverview[]): ProjectOverview[] {
  return [...list].sort((a, b) => {
    if ((a.id === null) !== (b.id === null)) return a.id === null ? 1 : -1;
    const na = a.counts.needsYou > 0;
    const nb = b.counts.needsYou > 0;
    if (na !== nb) return na ? -1 : 1;
    return (
      (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.name.localeCompare(b.name)
    );
  });
}
/** The header's red dot: 需要你 in every project but the current one. */
export function otherProjectsNeedsYou(
  list: readonly ProjectOverview[] | null,
  current: string | null,
): number {
  return (list ?? [])
    .filter((project) => project.id !== current)
    .reduce((sum, project) => sum + projectNeedLines(project).length, 0);
}

// ───────────────────────────── worker ─────────────────────────────

/** Design §3.1: a heartbeat older than 45 seconds shows the red bar. The server's own verdict
 * (`running`, judged on the server's clock) comes first: while it says running there is no red
 * bar, however far this device's clock is ahead; when it says stopped, the bar waits until the
 * heartbeat is 45 s old here too, so a short gap between two ticks does not flash it. */
export const workerStaleMs = 45_000;
export interface WorkerHealth {
  down: boolean;
  /** How long since the last heartbeat; null without one. */
  sinceMs: number | null;
  lastTickAt: string | null;
}
export function workerHealth(
  worker: { running: boolean; lastTickAt?: string } | undefined,
  now: Date | number,
): WorkerHealth {
  if (!worker) return { down: false, sinceMs: null, lastTickAt: null };
  const last = worker.lastTickAt ? Date.parse(worker.lastTickAt) : Number.NaN;
  const sinceMs = Number.isNaN(last) ? null : Math.max(0, toMs(now) - last);
  return {
    down: !worker.running && (sinceMs === null || sinceMs > workerStaleMs),
    sinceMs,
    lastTickAt: worker.lastTickAt ?? null,
  };
}

// ───────────────────────────── task extras ─────────────────────────────

/** `state.operatingPlan` (feat/pacing contract), or null. */
export interface OperatingPlan {
  version: number;
  setAt: string | null;
  communities: { name: string; why: string; rule: string }[];
  forms: string;
  voice: string;
  pace: string;
  review: string;
  horizon: string;
}
const prose = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(prose).filter(Boolean).join(t.common.clauseSep);
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}${t.common.colon}${prose(item)}`)
      .join(t.common.clauseSep);
  return typeof value === "number" ? String(value) : "";
};
export function operatingPlanOf(task: Pick<AgentTask, "state">): OperatingPlan | null {
  const raw = task.state?.operatingPlan;
  if (!raw || typeof raw !== "object") return null;
  const plan = record(raw);
  const communities = Array.isArray(plan.communities)
    ? plan.communities.map((item) => {
        if (typeof item === "string") return { name: item, why: "", rule: "" };
        const value = record(item);
        return { name: prose(value.name), why: prose(value.why), rule: prose(value.rule) };
      })
    : [];
  return {
    version: num(plan.version) ?? 1,
    setAt: str(plan.setAt),
    communities: communities.filter((item) => item.name),
    forms: prose(plan.forms),
    voice: prose(plan.voice),
    pace: prose(plan.pace),
    review: prose(plan.review),
    horizon: prose(plan.horizon),
  };
}

/** GET /api/agent/brief → `{ text, updatedAt }`. */
export interface ProjectBrief {
  text: string;
  updatedAt: string | null;
}
export function normalizeBrief(payload: unknown): ProjectBrief {
  const value = record(payload);
  return {
    text: typeof value.text === "string" ? value.text : "",
    updatedAt: str(value.updatedAt),
  };
}

// ───────────────────────────── inline task actions ─────────────────────────────

/** POST /api/agent/tasks/:id/control actions, plus 改间隔 (opens an editor) and 停止重复
 * (PATCH repeatMinutes: null). 回答 / 审阅 are the need card's. */
export type TaskOp = "pause" | "resume" | "run" | "retry" | "cancel" | "interval" | "stopRepeat";
export interface TaskAction {
  op: TaskOp;
  label: string;
}
/** The buttons a task shows in place (prototype rowActions): only what the phase allows.
 * `compact` (chat task cards) drops the secondary one. Questions and reviews have none here:
 * the need card answers them. 改间隔 / 停止重复 only for a repeating task (`repeating`): a
 * one-off task scheduled again (after the infrastructure stopped its run) has no interval. */
export function phaseActions(
  phase: Pick<TaskPhase, "key">,
  compact = false,
  repeating = false,
): TaskAction[] {
  const words = t.tasksRail;
  switch (phase.key) {
    case "run":
      return [{ op: "pause", label: words.pause }];
    case "wait":
      return compact
        ? [{ op: "run", label: words.continueNow }]
        : [
            { op: "run", label: words.continueNow },
            { op: "pause", label: words.pause },
          ];
    case "sched":
      return compact || !repeating
        ? [{ op: "run", label: words.runNow }]
        : [
            { op: "run", label: words.runNow },
            { op: "interval", label: words.changeInterval },
            { op: "stopRepeat", label: words.stopRepeating },
          ];
    case "pause":
      return [{ op: "resume", label: words.resume }];
    case "fail":
      return [{ op: "retry", label: words.retry }];
    default:
      return [];
  }
}
