/**
 * At any moment the screen tells the owner one thing —
 * what to do next. The pure decisions behind it, so node:test can pin them
 * (apps/mobile/test/shell-focus.test.ts):
 *   nextSteps     需要你's items as one sentence and one button each, most urgent first: what
 *                 stops an account from acting at all (a site handed it over, a code, a ban, a
 *                 desktop error), then a task's question or review (and a
 *                 paused standing loop), then a failed task (a failed standing loop first), then
 *                 a missing or wrong login, then an account that is not operating at all (no
 *                 long-term goal, no job: 定目标); ties newest first. One step per
 *                 需要你 item (its most urgent fact), so the counts match 需要你 and the tab title.
 *   summaryLine   the live panel's one line: 「2 个号在跑 · 1 件排队中 · 1 件等下一轮 · 今天做了 5
 *                 件 · 1 件等你」 (only a run is 在跑, and only while the worker has a heartbeat)
 *   foldOpen      which live-panel section starts open (only 需要你, only with items) and the
 *                 owner's remembered choice per section
 * No react-native, no storage access.
 */
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import { needGuides } from "./chat/guide-core.ts";
import {
  type AccountFlag,
  type AccountModel,
  type NeedItem,
  siteFlag,
  type TaskEntry,
} from "./model.ts";
import { t } from "./strings.ts";

// ───────────────────────────── next step ─────────────────────────────

/** blocked 0 · question 1 · failed 2 · login 3 · idle 4 (lower first). */
export type StepCategory = "blocked" | "question" | "failed" | "login" | "idle";
const categoryRank: Record<StepCategory, number> = {
  blocked: 0,
  question: 1,
  failed: 2,
  login: 3,
  idle: 4,
};

/** What the step's one button does; every one reuses a flow that already exists. */
export type StepAction =
  /** The chat's guidance card for this fact (nav.showGuide). */
  | { kind: "guide"; key: string }
  /** The task detail. */
  | { kind: "task"; taskId: string }
  /** The account detail. */
  | { kind: "account"; environmentId: string }
  /** The upstream review sheet. */
  | { kind: "review"; action: ActionProposal }
  /** The project's credentials page. */
  | { kind: "credentials" };

export type StepButton = "fill" | "answer" | "review" | "look" | "goal";

export interface NextStep {
  /** The 需要你 item's key. */
  key: string;
  category: StepCategory;
  /** When the fact was raised (ms); null when unknown (sorts after the known ones). */
  at: number | null;
  text: string;
  button: StepButton;
  action: StepAction;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** A flag's category: a missing or wrong login comes late, an account that is not operating last;
 * anything else stops the account. */
export function flagCategory(flag: AccountFlag): StepCategory {
  const site = siteFlag(flag);
  return site?.status === "no_login" || site?.status === "wrong_password" ? "login" : "blocked";
}
/** Within one item: the handover, a code, a ban, the desktop, then the logins. */
const flagOrder = (flag: AccountFlag): number => {
  const site = siteFlag(flag);
  if (site)
    return {
      needs_owner: 0,
      unconfirmed: 0,
      needs_code: 1,
      confirming: 1,
      suspended: 2,
      wrong_password: 7,
      no_login: 8,
    }[site.status];
  return 6;
};

/** The subject of a flag's sentence: 「Nova_Harrison 」 or 「本项目」. */
const who = (name: string | null) => (name ? `${name} ` : t.focus.project);

function flagStep(
  item: Extract<NeedItem, { kind: "account" | "project" }>,
  flag: AccountFlag,
): Omit<NextStep, "key" | "category" | "at"> {
  const f = t.focus;
  const name = item.kind === "account" ? item.account.name : null;
  const subject = who(name);
  // The chat's guidance card for exactly this fact, when typing (or the owner's step) can settle it.
  const [card] = needGuides([{ ...item, flags: [flag] }]);
  const look: StepAction =
    item.kind === "account"
      ? { kind: "account", environmentId: item.account.id }
      : { kind: "credentials" };
  const guideOr = (fallback: StepAction): StepAction =>
    card ? { kind: "guide", key: card.key } : fallback;
  const site = siteFlag(flag);
  if (site) {
    switch (site.status) {
      case "needs_owner":
        return { text: t.needs.needsOwner(site.site), button: "look", action: look };
      case "needs_code":
        return { text: f.needsCode(subject, site.site), button: "fill", action: guideOr(look) };
      case "suspended":
        return { text: f.suspended(subject, site.site), button: "look", action: look };
      // The owner did his part; the AI is confirming it.
      case "confirming":
        return { text: t.needs.confirming(site.site), button: "look", action: look };
      // Not confirmed after his step: the desktop card again (我弄好了 once more, or tell her to look).
      case "unconfirmed":
        return {
          text: t.needs.unconfirmed(site.site),
          button: "look",
          action: guideOr(look),
        };
      case "wrong_password":
        return { text: f.wrongPassword(subject, site.site), button: "fill", action: guideOr(look) };
      case "no_login":
        return { text: f.noLogin(subject, site.site), button: "fill", action: guideOr(look) };
    }
  }
  return { text: f.desktopError(subject), button: "look", action: look };
}

/** When an account's or the project's fact was recorded: the site's latest fact. */
function flagAt(item: Extract<NeedItem, { kind: "account" | "project" }>, flag: AccountFlag) {
  const site = siteFlag(flag);
  if (item.kind === "account") {
    if (site) return ms(item.account.view.signIns?.find((fact) => fact.site === site.site)?.at);
    return null;
  }
  return null;
}

/** One 需要你 item as its next step (its most urgent fact for an account or the project). */
export function stepOf(item: NeedItem): NextStep {
  const f = t.focus;
  switch (item.kind) {
    case "task": {
      const { task, phase } = item.entry;
      const at = ms(phase.at ?? task.updatedAt);
      // An account's standing loop that stopped: the account does nothing.
      if (phase.stopped)
        return {
          key: item.key,
          category: phase.key === "fail" ? "failed" : "question",
          at,
          text: phase.key === "fail" ? f.loopStopped(task.title) : f.loopPaused(task.title),
          button: "look",
          action: { kind: "task", taskId: task.id },
        };
      if (phase.key === "fail")
        return {
          key: item.key,
          category: "failed",
          at,
          text: f.failed(task.title),
          button: "look",
          action: { kind: "task", taskId: task.id },
        };
      if (phase.key === "approval")
        return {
          key: item.key,
          category: "question",
          at,
          text: f.review(task.title),
          button: "review",
          action: { kind: "task", taskId: task.id },
        };
      return {
        key: item.key,
        category: "question",
        at,
        text: f.question(task.title),
        button: "answer",
        action: { kind: "task", taskId: task.id },
      };
    }
    case "review":
      return {
        key: item.key,
        category: "question",
        at: ms(item.action.createdAt),
        text: f.review(item.entry?.task.title ?? item.action.title),
        button: "review",
        action: { kind: "review", action: item.action },
      };
    case "account":
    case "project": {
      const flag = [...item.flags].sort((a, b) => flagOrder(a) - flagOrder(b))[0];
      return {
        key: item.key,
        category: flagCategory(flag),
        at: flagAt(item, flag),
        ...flagStep(item, flag),
      };
    }
  }
}

/** 需要你's items as next steps, most urgent first; ties newest first, then 需要你's order. */
export function nextSteps(needs: readonly NeedItem[]): NextStep[] {
  return needs
    .map((item, index) => ({ step: stepOf(item), index }))
    .sort(
      (a, b) =>
        categoryRank[a.step.category] - categoryRank[b.step.category] ||
        (b.step.at ?? Number.NEGATIVE_INFINITY) - (a.step.at ?? Number.NEGATIVE_INFINITY) ||
        a.index - b.index,
    )
    .map(({ step }) => step);
}

/** The button's words. */
export function stepButtonText(button: StepButton): string {
  return t.focus.buttons[button];
}

/** 「还有 n 件」 beside the step, or null when it is the only one. */
export function moreText(steps: readonly NextStep[]): string | null {
  return steps.length > 1 ? t.focus.more(steps.length - 1) : null;
}

// ───────────────────────────── live panel ─────────────────────────────

/** The phases the worker carries on: a run, a queued task, a wait or a schedule. */
const toMove = new Set(["run", "queue", "wait", "sched"]);

const sameDay = (a: number, b: number) => {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
};

/** The live panel's one line (此刻): the accounts running a task now, the tasks queued, the tasks
 * that go on by themselves later (a wait, a retry, a schedule: 「N 件等下一轮」), what was done
 * today (each account's site actions today plus the tasks finished today), what waits on the
 * owner; a zero part is left out; 「现在没什么事」 when all are zero. Only a run counts as running,
 * and only while the worker is alive: with no heartbeat (`stalled`, ShellData.stalled) and
 * anything to move, the line says first that nothing moves (the 进度汇报 page's words) and
 * nothing reads as running. */
export function summaryLine(input: {
  accounts: readonly Pick<AccountModel, "tasks">[];
  entries: readonly TaskEntry[];
  waiting: number;
  now: Date | number;
  stalled: boolean;
}): string {
  const s = t.focus.summary;
  const now = typeof input.now === "number" ? input.now : input.now.getTime();
  const running = input.stalled
    ? 0
    : input.accounts.filter((account) => account.tasks.some((entry) => entry.phase.key === "run"))
        .length;
  const queued = input.entries.filter((entry) => entry.phase.key === "queue").length;
  const later = input.entries.filter(
    (entry) => entry.phase.key === "wait" || entry.phase.key === "sched",
  ).length;
  const stuck = input.stalled && input.entries.some((entry) => toMove.has(entry.phase.key));
  const finished = input.entries.filter((entry) => {
    const at = ms(entry.phase.at);
    return entry.phase.key === "done" && at !== null && sameDay(at, now);
  }).length;
  const done = finished;
  const parts = [
    stuck ? t.progress.stalled : "",
    running ? s.running(running) : "",
    queued ? s.queued(queued) : "",
    later ? s.later(later) : "",
    done ? s.doneToday(done) : "",
    input.waiting ? s.waiting(input.waiting) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(t.common.sep) : s.quiet;
}

/** The live panel's folding parts, each remembered on its own. */
export type FoldKey =
  | "needs"
  | "accounts"
  | "tasks"
  | "paused"
  | "ended"
  | "archivedJobs"
  | "reports"
  | "notes";
export type FoldState = Partial<Record<FoldKey, boolean>>;

const foldKeys: readonly FoldKey[] = [
  "needs",
  "accounts",
  "tasks",
  "paused",
  "ended",
  "archivedJobs",
  "reports",
  "notes",
];

/** How a section starts before the owner chose: only 需要你, and only with items. */
export function foldDefault(key: FoldKey, needCount: number): boolean {
  return key === "needs" && needCount > 0;
}

/** Whether a section is open: the owner's remembered choice, else the default. */
export function foldOpen(key: FoldKey, stored: FoldState, needCount: number): boolean {
  return stored[key] ?? foldDefault(key, needCount);
}

/** The remembered choices from storage; anything unreadable is dropped. */
export function readFoldState(raw: string | null | undefined): FoldState {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const state: FoldState = {};
    for (const key of foldKeys) {
      const open = (value as Record<string, unknown>)[key];
      if (typeof open === "boolean") state[key] = open;
    }
    return state;
  } catch {
    return {};
  }
}
