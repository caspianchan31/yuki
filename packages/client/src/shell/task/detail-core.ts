/**
 * The pure view model of the task detail panel. It only reads what
 * the task record, its run events and its reports already say, so node:test can pin every line
 * the panel shows. Nothing here adds a step: the ⋯ menu and the buttons are the existing
 * endpoints (control, PATCH repeatMinutes), and questions, reviews and failures are the shared
 * need card's (decision 4).
 *
 * Pure: no react-native.
 */
import {
  type AgentArtifact,
  type AgentTask,
  type ChatReport,
  continuingLabel,
  providerQuotaPattern,
  type RunEvent,
  repeatableTaskKinds,
  runCappedLabel,
  runStoppedLabel,
  taskWait,
} from "../../../../../packages/domain/src/agent.ts";
import {
  runTroubleLabel,
  standingRevivedLabel,
} from "../../../../../packages/domain/src/standing.ts";
import {
  clockLabel,
  firstLine,
  planProgress,
  rhythmLabel,
  showsSteps,
  type TaskPhase,
} from "../../../../../packages/domain/src/task-phase.ts";
import { isSafeAssistantUrl } from "../../assistant-markdown.ts";
import { type ReportTone, reportTone, unconfirmedLine } from "../chat/core.ts";
import {
  type AccountModel,
  type EntryPhase,
  type NeedItem,
  type OperatingPlan,
  phaseActions,
  type TaskAction,
  type TaskEntry,
  taskEntries,
} from "../model.ts";
import {
  failureDetailText,
  failureText,
  phaseWords,
  reportLabel,
  reportWords,
  runNoteView,
  serverText,
  t,
  taskRhythm,
} from "../strings.ts";

/** A whole, non-negative count (a repeating task's runs). */
const count = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** GET /api/agent/tasks/:id → the parts the panel uses. */
export interface TaskDetailPayload {
  task: AgentTask;
  events: RunEvent[];
  artifacts: AgentArtifact[];
}

/** Reads GET /api/agent/tasks/:id defensively; null when it has no task. */
export function normalizeTaskDetail(payload: unknown): TaskDetailPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const task = value.task as AgentTask | undefined;
  if (!task || typeof task !== "object" || typeof task.id !== "string") return null;
  const list = <T>(raw: unknown): T[] => (Array.isArray(raw) ? (raw as T[]) : []);
  return {
    task,
    events: list<RunEvent>(value.events).filter(
      (event) => event && typeof event.id === "string" && typeof event.date === "string",
    ),
    artifacts: list<AgentArtifact>(value.artifacts).filter(
      (artifact) => artifact && typeof artifact.id === "string",
    ),
  };
}

/** The live entry when the task is in the polled list, else one built from the detail read. */
export function detailEntry(
  live: TaskEntry | undefined,
  fetched: AgentTask | null | undefined,
  now: number,
  /** The worker has no heartbeat (ShellData.stalled): a run reads 后台停着 here too. */
  stalled: boolean,
): TaskEntry | null {
  if (live) return live;
  if (fetched) return taskEntries([fetched], now, stalled)[0] ?? null;
  return null;
}

/** The caption under 任务规则, saying who wrote the rules (fork, report line): 「聊天代拟」 for a
 * task the chat delegated (it has `originThreadId`), 「你写的」 for a prompt the person typed in
 * the new-task form (`typedByOwner`), and nothing for any other task (a goal plan, an idea, a
 * watch, or a task from before either was recorded): no caption claims an author it cannot
 * know. */
export function rulesHint(task: Pick<AgentTask, "originThreadId" | "typedByOwner">): string | null {
  if (task.originThreadId) return t.taskDetail.rulesHint;
  if (task.typedByOwner) return t.taskDetail.rulesHintTyped;
  return null;
}

/**
 * The 节奏 line: 「一次性」, 「每天 · 已跑 4 轮」. No count of waits or of
 * automatic continuations: neither has a limit, and the counters are the runs' own.
 */
export function rhythmLine(task: Pick<AgentTask, "repeatMinutes" | "runs" | "input">): string {
  const rhythm = taskRhythm(task);
  const runs = task.repeatMinutes ? t.taskCard.runs(count(task.runs)) : "";
  return t.taskDetail.rhythmLine(rhythm, runs);
}

/** The ⋯ menu (design §3.4): 改间隔 (改成重复 for a one-off task), 停止重复 (repeating tasks
 * only), 取消任务 (with a confirm). Same rules as the server: only general and plan tasks repeat,
 * a cancelled task does not change, a finished or failed task is not cancelled. */
export type MenuOp = "interval" | "stopRepeat" | "cancel";
export function taskMenu(
  task: Pick<AgentTask, "kind" | "status" | "repeatMinutes"> & Partial<Pick<AgentTask, "input">>,
): { op: MenuOp; label: string }[] {
  const items: { op: MenuOp; label: string }[] = [];
  // An account's standing loop has no cadence of ours, and Cancel on it is 停止经营.
  const loop = task.input?.accountLoop === true;
  if (loop) {
    if (!["succeeded", "failed", "cancelled"].includes(task.status))
      items.push({ op: "cancel", label: t.taskDetail.stopOperating });
    return items;
  }
  const repeatable = repeatableTaskKinds.has(task.kind) && task.status !== "cancelled";
  if (repeatable)
    items.push({
      op: "interval",
      label: task.repeatMinutes ? t.taskDetail.changeInterval : t.taskDetail.repeatThis,
    });
  if (repeatable && task.repeatMinutes)
    items.push({ op: "stopRepeat", label: t.taskDetail.stopRepeating });
  if (!["succeeded", "failed", "cancelled"].includes(task.status))
    items.push({ op: "cancel", label: t.taskDetail.cancelTask });
  return items;
}

/** The phase's own buttons (prototype rowActions, non-compact). None while the need card is
 * shown: it carries 回答 / 审阅 / 重试 / 立即继续 itself. 改间隔 / 停止重复 only on a repeating
 * task. */
export function detailActions(
  phase: Pick<TaskPhase, "key">,
  needShown: boolean,
  repeating = false,
): TaskAction[] {
  return needShown ? [] : phaseActions(phase, false, repeating);
}

/** The need items of this task (decision 4): its question / review / failure, and an upstream
 * proposal that belongs to it. */
export function needsForTask(needs: readonly NeedItem[], taskId: string): NeedItem[] {
  return needs.filter(
    (item) =>
      (item.kind === "task" && item.entry.task.id === taskId) ||
      (item.kind === "review" && item.entry?.task.id === taskId),
  );
}

/** The first `max` lines of a text (blank lines dropped), with … when there is more. */
export function firstLines(value: unknown, max = 8): string {
  const lines = text(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…` : lines.join("\n");
}

export interface TextBlock {
  title: string;
  body: string;
  tone: "normal" | "error";
}
/** The middle of the panel by phase (design §3.4): the need card for a question, a review or a
 * failure (plus the full error when it is longer than the card's first line); 等待 (when it goes
 * on: never the AI's wait note, fork report line), 现在在做 (停在这一步 while the worker has no
 * heartbeat), 排期, 已暂停, the result of a
 * finished task. */
export function middleBlocks(
  task: AgentTask,
  phase: EntryPhase,
  hasNeed: boolean,
  now: number,
): { need: boolean; blocks: TextBlock[] } {
  const clock = (iso: string | undefined | null) => clockLabel(iso, now, phaseWords);
  const block = (title: string, body: string, tone: TextBlock["tone"] = "normal") =>
    body ? [{ title, body, tone }] : [];
  switch (phase.key) {
    case "input":
      return {
        need: hasNeed,
        blocks: hasNeed
          ? []
          : block(t.taskDetail.question, text(task.question) || phase.sub || phase.detail),
      };
    case "approval":
      return {
        need: hasNeed,
        blocks: hasNeed ? [] : block(t.taskDetail.review, text(task.question) || phase.sub),
      };
    case "fail": {
      const error = failureText(text(task.error));
      const longer = error && error !== firstLine(error, Number.POSITIVE_INFINITY);
      return {
        need: hasNeed,
        blocks: !hasNeed || longer ? block(t.taskDetail.error, error || phase.sub, "error") : [],
      };
    }
    case "wait":
      // The wait note is the run's handoff to its next run, kept for the AI
      // (priorState.wait); the person reads when it goes on.
      return { need: false, blocks: block(t.taskDetail.waitTitle, phase.sub) };
    case "run": {
      // The step the run is on, never state.lastUpdate: that is the record
      // the previous run left for this one (a wait note, the text of a run that hit the step
      // cap), not what this run is doing now (task-phase.ts, the running case). An operating
      // task's steps never move, so its line is the phase's (`showsSteps`).
      // While the worker has no heartbeat (stalledPhase) nothing is being done: the step it
      // stopped on, if it shows steps (the line above already says 后台停着，不会推进).
      const progress = planProgress(task);
      const step = showsSteps(task) ? serverText(progress.title) : "";
      if (phase.stalled) return { need: false, blocks: block(t.taskDetail.stoppedTitle, step) };
      return { need: false, blocks: block(t.taskDetail.nowDoing, step || phase.sub) };
    }
    case "sched": {
      const next = clock(task.nextRunAt);
      const body = phase.incident
        ? phase.sub
        : !next
          ? phase.sub
          : task.repeatMinutes
            ? t.taskDetail.scheduleLine(rhythmLabel(task.repeatMinutes, phaseWords), next)
            : t.taskDetail.scheduleOnce(next);
      return { need: false, blocks: block(t.taskDetail.schedule, body) };
    }
    case "pause": {
      const wait = taskWait(task);
      const at = wait ? clock(wait.until) : "";
      return {
        need: false,
        blocks: block(
          t.taskDetail.pausedTitle,
          at ? t.taskDetail.pausedInWait(at) : t.taskDetail.pausedPlain,
        ),
      };
    }
    case "done": {
      // The server's line that an action of the run is not
      // confirmed (service.ts markUnconfirmed) comes first, in the client's words.
      const result = runNoteView(text(task.result));
      const body = [result.unconfirmed, firstLines(result.text)].filter(Boolean).join("\n");
      return { need: false, blocks: block(t.taskDetail.result, body) };
    }
    default:
      return { need: false, blocks: [] };
  }
}

/** What the 账号 line shows: the bound account, the default desktop (unbound, decision 3: a
 * marker, never blocked), still loading, or an account no longer in this project. */
export type AccountLine =
  | { kind: "account"; account: AccountModel }
  | { kind: "default" }
  | { kind: "loading" }
  | { kind: "gone"; environmentId: string };
export function accountLine(
  environmentId: string | null,
  accountById: ReadonlyMap<string, AccountModel>,
  accounts: { loading: boolean; count: number },
): AccountLine {
  if (!environmentId) return { kind: "default" };
  const account = accountById.get(environmentId);
  if (account) return { kind: "account", account };
  if (accounts.loading && !accounts.count) return { kind: "loading" };
  return { kind: "gone", environmentId };
}

export interface PlanLine {
  key: string;
  text: string;
  state: "done" | "current" | "todo";
}
/** 计划 n/m (folded): each step with ✓ when done and ← 当前 on the one in progress. Null when
 * the task has no plan. An operating task's (`showsSteps`) is 计划 with its
 * steps and no count or 「← 当前」: nothing moves them while it works. */
/** The plan the server gives a task before a run sets one (service.ts planTitles). */
const serverDefaultPlan = [
  "Understand the outcome",
  "Plan the work",
  "Use connected tools",
  "Return a result",
];
export function planBlock(
  task: Pick<AgentTask, "plan" | "input">,
  ended: boolean,
): { label: string; lines: PlanLine[] } | null {
  const plan = Array.isArray(task.plan) ? task.plan : [];
  if (!plan.length) return null;
  const progress = planProgress(task);
  const steps = showsSteps(task);
  // An account's task shows only the plan its runs set (set_plan), never the server's default
  // steps it starts with (fork, report line: filler, not the task's plan).
  if (
    !steps &&
    plan.length === serverDefaultPlan.length &&
    plan.every((step, index) => step.title === serverDefaultPlan[index])
  )
    return null;
  const lines = plan.map((step, index): PlanLine => {
    const state =
      step.status === "succeeded"
        ? "done"
        : steps && !ended && index + 1 === progress.current
          ? "current"
          : "todo";
    const suffix =
      state === "done"
        ? t.taskDetail.stepDone
        : state === "current"
          ? t.taskDetail.stepCurrent
          : "";
    return { key: step.id || String(index), text: `${serverText(step.title)}${suffix}`, state };
  });
  return {
    label: steps ? t.taskDetail.plan(progress.current, progress.total) : t.taskDetail.planPlain,
    lines,
  };
}

export interface PlanRow {
  label: string;
  lines: string[];
}
/** 运营计划 v{n}: 选区 (one community per line: name — why · rule), 内容形式, 口径, 节奏, 复盘,
 * 期限, and 拟定于 HH:MM. Empty parts are left out. */
export function operatingPlanBlock(
  plan: OperatingPlan | null,
  now: number,
): { title: string; rows: PlanRow[]; setAt: string } | null {
  if (!plan) return null;
  const words = t.operatingPlan;
  const rows: PlanRow[] = [
    {
      label: words.communities,
      lines: plan.communities.map((item) => t.taskDetail.community(item.name, item.why, item.rule)),
    },
    { label: words.forms, lines: [plan.forms] },
    { label: words.voice, lines: [plan.voice] },
    { label: words.pace, lines: [plan.pace] },
    { label: words.review, lines: [plan.review] },
    { label: words.horizon, lines: [plan.horizon] },
  ]
    .map((row) => ({ ...row, lines: row.lines.filter(Boolean) }))
    .filter((row) => row.lines.length);
  const setAt = plan.setAt ? clockLabel(plan.setAt, now, phaseWords) : "";
  return {
    title: words.title(plan.version),
    rows,
    setAt: setAt ? words.setAt(setAt) : "",
  };
}

// One report-tone rule for the chat, the rail and the task detail (chat/core.ts).
export { type ReportTone, reportTone } from "../chat/core.ts";

/** "example.com/posts/abc…" for a link line. */
export function shortLink(url: string, max = 42): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    const shown = `${host}${path}`;
    return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}

/** Reports from several reads, one copy each, newest first. */
export function mergeReports(...lists: readonly (readonly ChatReport[])[]): ChatReport[] {
  const byId = new Map<string, ChatReport>();
  for (const list of lists) for (const report of list) byId.set(report.id, report);
  return [...byId.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export interface ReportLine {
  id: string;
  time: string;
  label: string;
  tone: ReportTone;
  text: string;
  links: { url: string; short: string }[];
  /** 「未确认：…」 for an action report without the item's own address; "" otherwise. */
  unconfirmed: string;
}
/** 本任务汇报: time · Chinese label (tone) · first line · ↗ links (http/https only), and
 * 「未确认：…」 under an action report that has no address of the item itself. */
export function reportLines(reports: readonly ChatReport[], now: number): ReportLine[] {
  return mergeReports(reports).map((report) => ({
    id: report.id,
    time: clockLabel(report.createdAt, now, phaseWords),
    label: reportLabel(report.title, report.action),
    tone: reportTone(report.title),
    text: firstLine(reportWords(report.title)(report.text)),
    links: (Array.isArray(report.links) ? report.links : [])
      .filter((link) => typeof link === "string" && isSafeAssistantUrl(link))
      .map((url) => ({ url, short: shortLink(url) })),
    unconfirmed: unconfirmedLine(report),
  }));
}

export interface TimelineLine {
  id: string;
  time: string;
  title: string;
  detail: string;
}
/** A wait's run event title (service.ts wait: 「Waiting 20 minutes」, 「… (pacing)」). */
const waitEventTitle = /^Waiting \d+ minutes?( \(pacing\))?$/;
/** Lines of an event's detail that are the person's to read; the rest stays for the AI. */
const resumesLine = /^Resumes at (.+)$/;
const redirectedLine = "Runs again now: the person sent a new instruction";
/** A run's start (service.ts executeOnce): its detail is the task's prompt, shown under 任务规则. */
const runStartTitle = /^(Started working|Resumed work|Run \d+ started)$/;
/** wait_until's step event of the older server: its title was the tool's instruction for the
 * model, and the wait has its own 「Waiting N minutes」 event. */
const oldWaitStepTitle = /^Wait the minutes the task's\b/;
/** A mark only the server reads. */
const hiddenLine = (line: string) => !line || line === "[unclassified link]";
/** A raw link: a report's card has it. */
const rawLink = /^https?:\/\/\S+$/;
/**
 * One run event as the timeline shows it (fork, report line): never the AI's own notes. A wait
 * reads 「等待到 13:12」 (its note is the run's handoff to its next run, kept for the AI); the
 * run's own commentary (「Agent update」) is not shown; a run the infrastructure stopped reads
 * when it goes on, without the raw error; a run's start without the task's prompt (it is under
 * 任务规则); a report once (its sentence as the title, then what was posted, no raw link); marks
 * only the server reads (「[unclassified link]」) are left out; pacing and profile facts and every fixed server text read in Chinese
 * (`serverText`). Null for an event that is not shown.
 */
/** A failed tool call (model.ts `<tool> failed`) or run (service.ts): its detail is the raw
 * error. */
const failureEventTitle =
  /^(?:[a-z][a-z0-9_]* failed|Run failed; next run scheduled|Paused after repeated failures)$/;
/** The line of a wait's or a stopped run's event that names what failed (service.ts). */
const blockedLine = /^Blocked: [a-z_]+$/;
export function timelineEvent(
  event: Pick<RunEvent, "id" | "date" | "title" | "detail" | "kind">,
  now: number,
): TimelineLine | null {
  const title = text(event.title);
  const lines = text(event.detail)
    .split("\n")
    .map((line) => line.trim());
  const clock = (iso: string) => clockLabel(iso, now, phaseWords) || iso;
  const resumes = lines.map((line) => resumesLine.exec(line)?.[1]).find(Boolean);
  let shownTitle = serverText(title);
  let detail: string[];
  if (title === "Agent update" || oldWaitStepTitle.test(title)) return null;
  if (runStartTitle.test(title)) {
    detail = [];
  } else if (event.kind === "report") {
    // The report's sentence is the title (its first line, whole), then what was posted; never
    // the same sentence twice and never the raw link.
    const [first, ...rest] = lines.filter((line) => !hiddenLine(line) && !rawLink.test(line));
    if (first) shownTitle = serverText(first);
    detail = rest.map(serverText);
  } else if (waitEventTitle.test(title)) {
    if (resumes) shownTitle = t.server.waitingUntil(clock(resumes), / \(pacing\)$/.test(title));
    detail = lines
      .filter((line) => line === redirectedLine || blockedLine.test(line))
      .map(serverText);
  } else if (title === runStoppedLabel) {
    // What stopped it (the incident's word) and when it goes on; never the raw error.
    detail = [
      ...lines.filter((line) => blockedLine.test(line)).map(serverText),
      ...(resumes ? [t.server.resumesAt(clock(resumes))] : []),
    ];
  } else if (title === runCappedLabel) {
    // The run's own time limit; when the next one goes on.
    detail = resumes ? [t.server.resumesAt(clock(resumes))] : [];
  } else if (title === continuingLabel || /^Continuing automatically/.test(title)) {
    detail = [];
  } else if (failureEventTitle.test(title)) {
    // A failed tool or run: the raw error stays in the record for the AI; the person reads
    // only what the mapping knows (a provider's quota answer).
    detail = lines.filter((line) => providerQuotaPattern.test(line)).map(failureText);
  } else {
    // An error's detail is a failure (a provider's quota answer reads as the owner's reason).
    // A standing task's trouble and revival events carry the failure too.
    const failure =
      event.kind === "error" || title === runTroubleLabel || title === standingRevivedLabel;
    const words = failure ? failureDetailText : serverText;
    detail = lines.filter((line) => !hiddenLine(line)).map((line) => words(line));
  }
  const body = detail.filter(Boolean).join("\n");
  return {
    id: event.id,
    time: clockLabel(event.date, now, phaseWords),
    title: shownTitle,
    detail: body.length > 400 ? `${body.slice(0, 399).trimEnd()}…` : body,
  };
}
/** 时间线 (folded): run events newest first, `limit` of them, and how many older ones are not
 * shown. */
export function timelineLines(
  events: readonly RunEvent[],
  now: number,
  limit = 100,
): { lines: TimelineLine[]; older: number } {
  const shown = [...events]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .map((event) => timelineEvent(event, now))
    .filter((line): line is TimelineLine => line !== null);
  return {
    lines: shown.slice(0, limit),
    older: Math.max(0, shown.length - limit),
  };
}

/** The receipt line once the person acted and the task no longer waits for them (nav.receipts). */
export function receiptLine(
  receipt: { text: string; at: string } | undefined,
  now: number,
): string {
  if (!receipt) return "";
  const at = clockLabel(receipt.at, now, phaseWords);
  return at ? t.needs.receiptAt(receipt.text, at) : receipt.text;
}
