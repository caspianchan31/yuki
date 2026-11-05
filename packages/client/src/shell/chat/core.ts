/**
 * The pure logic behind the chat's cards (design §5.2–5.5,
 * §6). The components in this folder and shell/components/{NeedCard,ReportCardGroup,TaskCard}
 * only render what these helpers decide, so node:test pins the decisions
 * (apps/mobile/test/shell-chat.test.ts):
 *   reports      tone of a report title, quote blocks, link labels
 *   need reports which stop report shows the live need card, which the one-line receipt, which
 *                a snapshot (a need card never asks twice)
 *   task card    the meta line and the line under it
 *   composer     the 「操作账号」 row (stale when the account left the project)
 *   answer box   missingFields and the answer payload
 *   tools        delegate_task / server tool results, the calls the runtime refused (not shown),
 *                what a task card's results hang on (artifacts and the browser session)
 *   desktop      a reply's consecutive desktop steps folded into one block (its line, its shot)
 *   model        the chat model's project context (design §6.10)
 * Nothing here adds an approval step or changes what the system does; it only reads state.
 * Pure: no react-native, so node:test can import it.
 */
import {
  type AgentTask,
  type ChatReport,
  legacyWaitCardTitle,
  sliceText,
  toolInputRejected,
} from "../../../../../packages/domain/src/agent.ts";
import {
  clockLabel,
  planProgress,
  showsSteps,
  type TaskPhaseKey,
} from "../../../../../packages/domain/src/task-phase.ts";
import { type AccountModel, byPriority, type NeedItem, type TaskEntry } from "../model.ts";
import { phaseWords, reportWords, serverText, t, taskRhythm, taskTitleText } from "../strings.ts";
import type { Light } from "../theme.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ms = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(value) ? null : value;
};

// ───────────────────────────── reports ─────────────────────────────

export type ReportTone = "green" | "red" | "amber" | "neutral";

/** The server label without the " · over pace" suffix (and v0.6's sibling marks). */
const baseLabel = (title: string) =>
  title
    .trim()
    .replace(/ · over pace$/i, "")
    .replace(/ · (?:sibling touched|same place as .+)$/, "");

const redLabels: readonly string[] = [
  "Needs attention",
  "Run failed",
  "Paused after repeated failures",
  "Watch needs attention",
];

/** The colour of a report header (prototype rtone): finished green, failures red, a question or
 * a review amber, anything else neutral. Decided by the fixed label, never by a task title. */
export function reportTone(title: string): ReportTone {
  const base = baseLabel(title);
  if (base === "Finished" || /^Run \d+ finished$/.test(base)) return "green";
  if (redLabels.includes(base)) return "red";
  if (base === "Needs your input" || base === "Ready for your review") return "amber";
  return "neutral";
}

export interface TextSegment {
  kind: "text" | "quote";
  text: string;
}
/**
 * A report's text in blocks: lines starting with ">" are the quoted original (what was posted)
 * and become a quote block; the rest stays prose (rendered as markdown). Consecutive lines of one
 * kind form one block; blank edges are dropped.
 */
export function splitReportText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const kind = quote ? "quote" : "text";
    const value = quote ? quote[1] : line;
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += `\n${value}`;
    else segments.push({ kind, text: value });
  }
  return segments
    .map((segment) => ({
      ...segment,
      text: segment.text.replace(/^(?:[ \t]*\n)+/, "").trimEnd(),
    }))
    .filter((segment) => segment.text !== "");
}

/** A wait is not a report any more. Cards a wait wrote before that
 * ("Waiting 30 minutes", "Waiting 30 minutes (pacing)") are not shown anywhere: not in the
 * chat, the rail, a task's reports or the chat model's context. The server leaves them out of
 * `GET /api/chat-reports` (so a page is full); this keeps any that reach a client out too. */
const waitCardTitle = new RegExp(legacyWaitCardTitle);
export function isWaitCard(report: Pick<ChatReport, "kind" | "title">): boolean {
  return report.kind === "outcome" && waitCardTitle.test(report.title.trim());
}
/** The reports that are shown: every report except the cards a wait wrote before. */
export function withoutWaitCards<T extends Pick<ChatReport, "kind" | "title">>(
  reports: readonly T[],
): T[] {
  return reports.filter((report) => !isWaitCard(report));
}

/** A lead longer than this (characters or lines) is cut to its first lines. */
export const reportFold = { chars: 240, lines: 4 };
/** A posted text longer than this is folded to its first lines. */
export const quoteFold = { chars: 400, lines: 8 };
const isLong = (text: string, fold: { chars: number; lines: number }) =>
  text.length > fold.chars || text.split("\n").length > fold.lines;

export interface ReportCardView {
  /** Everything the report says to the person (the report's text, or an outcome's text). */
  summary: string;
  /** What the card shows by default: what was done (`reportLead`). */
  lead: string;
  /** The lead is a plain cut of a longer text (rendered as plain text with …). */
  leadPlain: boolean;
  /** The summary says more than the lead: the rest folds behind one tap. */
  more: boolean;
  /** The posted text, shown as a quote; "" when there is none. */
  quote: string;
  quoteLong: boolean;
  /** The line an action report without the address of the item itself
   * reads (「未确认：…」); "" on every other report. */
  unconfirmed: string;
}
/** 「未确认：没有这条内容自己的链接」 for an action report the server
 * recorded without the address of the item itself (`evidence: "missing"`), "" for any other. One
 * rule for every place a report shows: the card, the pane's 汇报 rows, 本任务汇报 and an account's
 * 最近汇报. */
export function unconfirmedLine(report: Pick<ChatReport, "evidence" | "evidenceWhy">): string {
  if (report.evidence !== "missing") return "";
  // The reason the server gave, when it gave one.
  const why = report.evidenceWhy;
  return why && why !== "address" ? t.reportCard.unconfirmedWhy[why] : t.reportCard.unconfirmed;
}
/** A paragraph that is only a markdown heading (「## 汇报」): it names the part, it is not one. */
const headingOnly = (paragraph: string) => /^\s{0,3}#{1,6}\s+\S.*$/.test(paragraph.trim());
/**
 * What a report card shows by default (fork, the owner's trim): what was done, from the report's
 * own structure. The report's first paragraph is its action (a heading alone joins the paragraph
 * after it); what follows (the run's working notes: what it already handled, what is left, its
 * next steps) folds behind one tap. A report without a separate action part (one paragraph)
 * shows a short cut of it. A first paragraph that is itself long is cut too (plain, with …).
 */
export function reportLead(summary: string): { lead: string; plain: boolean; more: boolean } {
  const paragraphs = summary
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const first: string[] = [];
  for (const paragraph of paragraphs) {
    first.push(paragraph);
    if (!headingOnly(paragraph)) break;
  }
  const lead = first.join("\n\n");
  const rest = first.length < paragraphs.length;
  if (!isLong(lead, reportFold)) return { lead, plain: false, more: rest };
  return { lead: `${plainPreview(lead)}…`, plain: true, more: true };
}
/**
 * A report card's content (design §6.4, fork report line): what was done (`reportLead`), the
 * rest folded, then the posted text as a quote. A report with `posted` quotes it; one written
 * before `posted` existed quotes its ">" lines (`splitReportText`). An action report the server
 * recorded without the address of the item itself reads 「未确认：…」 (`unconfirmed`).
 */
export function reportCardView(
  report: Pick<ChatReport, "text" | "posted" | "evidence"> & { title?: string },
): ReportCardView {
  const segments = splitReportText(report.text);
  // A fixed server text (the old question) in the client's words, the same mapping as the rail's
  // 汇报 line; a provider's quota answer only on the 出问题 outcome, whose text is the task's
  // failure. What the run wrote stays as written, even when it mentions billing.
  const summary = reportWords(report.title)(
    segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.text)
      .join("\n\n"),
  );
  const quote = [
    report.posted?.trim() ?? "",
    ...segments.filter((segment) => segment.kind === "quote").map((segment) => segment.text),
  ]
    .filter(Boolean)
    .join("\n\n");
  const { lead, plain, more } = reportLead(summary);
  return {
    summary,
    lead,
    leadPlain: plain,
    more,
    quote,
    quoteLong: isLong(quote, quoteFold),
    unconfirmed: unconfirmedLine(report),
  };
}
/** A stop report's snapshot line (its need is over): the same words as the live card
 * (`reportWords`), so an older 出问题 card never shows a provider's raw error. */
export function snapshotText(report: Pick<ChatReport, "text" | "title">): string {
  return reportWords(report.title)(report.text.trim());
}
/** A folded text's preview: its first lines as plain text (markdown marks dropped), so a folded
 * card never shows raw markdown, and at most `chars` characters (cut on a code point), so a long
 * text without line breaks folds too. */
export function plainPreview(
  text: string,
  lines = reportFold.lines,
  chars = reportFold.chars,
): string {
  const preview = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|`)/g, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, lines)
    .join("\n");
  return preview.length > chars ? sliceText(preview, chars).trimEnd() : preview;
}

/** The source line of a report card: 「AcmeGame 推广 · alpha」,
 * 「… · 跑在默认桌面」 for a task on the default desktop. The chat's tasks on an account carry
 * the account in their title (「[alpha] AcmeGame 推广」, delegate_task), so
 * the name is not said twice. Under a speaker line (`speaker`, the account that speaks) the
 * account is not named again: only the task's title, or nothing for its own loop. */
export function reportSource(
  rawTitle: string,
  account: { name: string } | null,
  defaultDesktop: boolean,
  speaker: string | null = null,
): string {
  const title = taskTitleText(rawTitle);
  // The speaker line above names the account,
  // so this line keeps only the task, and nothing for the account's own loop.
  if (speaker)
    return title === t.taskTitle.loop(speaker) ? "" : titleWithoutAccount(title, speaker);
  if (account) return `${titleWithoutAccount(title, account.name)}${t.common.sep}${account.name}`;
  if (defaultDesktop) return title;
  return title;
}

/** A task's title without the 「[account] 」 the chat puts at its start (delegate_task), where
 * the account is already named (the report card's source line, the account's own row). */
export function titleWithoutAccount(title: string, account: string): string {
  const prefix = `[${account}] `;
  const bare = title.startsWith(prefix) ? title.slice(prefix.length).trim() : title;
  return bare || title;
}

/** How a report link reads on its ↗ row: no scheme, no "www.", no trailing slash. */
export function linkLabel(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/** A report's time in the chat ("14:10", "昨天 09:12", "10-08 10:05"). */
export function reportClock(iso: string, now: Date | number): string {
  return clockLabel(iso, now, phaseWords) || iso;
}

// ───────────────────────────── need reports ─────────────────────────────

/** The phase a stop report stands for (model.ts `needReportLabels`). */
export const needReportPhase: Readonly<Record<string, TaskPhaseKey>> = {
  "Needs your input": "input",
  "Ready for your review": "approval",
  "Needs attention": "fail",
  "Run failed": "fail",
};

const byCreated = (a: ChatReport, b: ChatReport) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** The newest stop report of each task, by id: only it may show the live card or the receipt;
 * an older one is a snapshot (the same task never asks twice in one transcript). */
export function latestNeedReportIds(reports: readonly ChatReport[]): Set<string> {
  const newest = new Map<string, ChatReport>();
  for (const report of [...reports].sort(byCreated)) newest.set(report.taskId, report);
  return new Set([...newest.values()].map((report) => report.id));
}

type TaskNeed = Extract<NeedItem, { kind: "task" }>;
/** The 需要你 item of the report's task when the task still stops for what the report says
 * (a question report while the task waits for an answer, a failure report while it is failed…). */
export function taskNeedFor(
  report: Pick<ChatReport, "taskId" | "title">,
  needs: readonly NeedItem[],
): TaskNeed | null {
  const phase = needReportPhase[report.title];
  if (!phase) return null;
  return (
    needs.find(
      (item): item is TaskNeed =>
        item.kind === "task" &&
        item.entry.task.id === report.taskId &&
        item.entry.phase.key === phase,
    ) ?? null
  );
}

export interface ReceiptLike {
  text: string;
  at: string;
  /** The server's `updatedAt` of the task in its answer to the act (nav.Receipt). */
  since?: string;
}
/** The person acted on the task at or after `raised` (the receipt replaces the card). Compared
 * on the server's clock when the receipt carries it, else on this device's. */
export function receiptCovers(
  receipt: ReceiptLike | undefined,
  raised: string | undefined,
): boolean {
  if (!receipt) return false;
  const at = ms(receipt.since) ?? ms(receipt.at);
  const from = ms(raised);
  return at !== null && (from === null || at >= from);
}

export type NeedReportView =
  | { kind: "card"; item: TaskNeed }
  | { kind: "receipt"; receipt: ReceiptLike }
  | { kind: "snapshot" };
/**
 * What a stop report shows in the transcript (design §6.5): the live need card while the task
 * still waits for that (newest report of the task only), else the receipt of what the person did
 * after it, else a compact snapshot of the report. Never asks again.
 */
export function needReportView(input: {
  report: ChatReport;
  latest: boolean;
  needs: readonly NeedItem[];
  receipts: Readonly<Record<string, ReceiptLike>>;
}): NeedReportView {
  const { report, latest } = input;
  if (!latest) return { kind: "snapshot" };
  const item = taskNeedFor(report, input.needs);
  if (item) return { kind: "card", item };
  const receipt = input.receipts[report.taskId];
  if (receipt && receiptCovers(receipt, report.createdAt)) return { kind: "receipt", receipt };
  return { kind: "snapshot" };
}

/** The receipt a need card collapses into, when the person acted after the need was raised. */
export function receiptForNeed(
  item: NeedItem,
  receipts: Readonly<Record<string, ReceiptLike>>,
): ReceiptLike | null {
  if (item.kind !== "task") return null;
  const receipt = receipts[item.entry.task.id];
  return receipt && receiptCovers(receipt, item.entry.task.updatedAt) ? receipt : null;
}

/** 「你点了重试，任务重新运行 · 14:48」 */
export function receiptLine(receipt: ReceiptLike, now: Date | number): string {
  return t.needs.receiptAt(receipt.text, clockLabel(receipt.at, now, phaseWords));
}

// ───────────────────────────── task card ─────────────────────────────

/**
 * The task card's two lines (prototype taskCard): meta 「一次性 · 第 3/5 步」 (a repeating task:
 * 「每天 · 已跑 1 轮」) and the line under it: what it is doing now while it runs (while the
 * worker has no heartbeat, 「后台停着，不会推进」: stalledPhase), 「下次 明天
 * 10:05」 while scheduled, otherwise the phase line. No count of automatic
 * continuations (there is no limit); an operating task (bound to an account) shows no step,
 * since its steps never move (`showsSteps`); and a finished task's line is empty: its finish
 * sentence is the 完成 card's, not said twice in the chat.
 */
export function taskCardLines(entry: TaskEntry, now: Date | number): { meta: string; sub: string } {
  const { task, phase } = entry;
  const rhythm = taskRhythm(task);
  const progress = planProgress(task);
  const steps = showsSteps(task) && progress.total > 0;
  const meta = task.repeatMinutes
    ? t.taskCard.meta(rhythm, t.taskCard.runs(task.runs ?? 0))
    : t.taskCard.meta(
        rhythm,
        steps && phase.key !== "done" ? t.taskCard.step(progress.current, progress.total) : "",
      );
  let sub = phase.sub;
  // The step it is on; never the previous run's handoff (state.lastUpdate, see taskPhase). A run
  // the worker does not carry on (no heartbeat) does nothing now: its line says so (stalledPhase).
  if (phase.key === "run" && steps && !phase.stalled)
    sub = serverText(progress.title) || phaseWords.running;
  else if (phase.key === "sched" && phase.at && !phase.incident)
    sub = phaseWords.scheduledOnce(clockLabel(phase.at, now, phaseWords));
  else if (phase.key === "done") sub = "";
  return { meta, sub };
}

/** Where a run the worker does not carry on (no heartbeat) stopped: 「停在第 3/5 步 · 打开评论区」;
 * "" for a task that shows no steps (an operating task's never move: `showsSteps`). */
export function stoppedLine(task: AgentTask): string {
  const progress = planProgress(task);
  if (!showsSteps(task) || !progress.total) return "";
  return t.progress.stoppedAt(
    phaseWords.step(progress.current, progress.total, serverText(progress.title)),
  );
}

/** The line under a
 * conversation for each background task that reports here and is doing something right now
 * (running: what it does, 后台正在做 with a spinner; queued: 排队中, no spinner; with no worker
 * heartbeat neither moves) or is stuck (failed, or waiting for the owner: where). A
 * task that only waits or is scheduled has no line: when it goes on is already on its task card
 * and in the live panel. A task reports
 * to the conversation it came from; one from no conversation (an account's loop) to the main
 * chat. */
export interface ChatStatusLine {
  taskId: string;
  text: string;
  running: boolean;
}
export function chatStatusLines(
  entries: readonly TaskEntry[],
  threadId: string | null,
  mainId: string | null,
  now: Date | number,
  /** The worker has no heartbeat (ShellData.stalled): no line says 正在做 or spins. */
  stalled: boolean,
): ChatStatusLine[] {
  const here = (entry: TaskEntry) =>
    entry.task.originThreadId
      ? entry.task.originThreadId === threadId
      : !!threadId && threadId === mainId;
  const live = new Set(["run", "queue", "fail", "input", "approval"]);
  // One line per task, and never the same line twice: a task listed twice, or two tasks that
  // read the same (an account's loop and an older one renamed to 「<name> 的日常运营」), show once,
  // the more urgent first.
  const seenTasks = new Set<string>();
  const seenTexts = new Set<string>();
  return entries
    .filter((entry) => here(entry) && live.has(entry.phase.key))
    .sort(byPriority)
    .map((entry) => {
      // 后台正在做 (with a spinner) only for a run the worker carries on: a queued task reads its
      // phase (「…」排队中), and with no heartbeat a run reads that nothing moves (进度汇报's words).
      const running = entry.phase.key === "run" && !stalled;
      const { sub } = taskCardLines(entry, now);
      const what =
        entry.phase.key === "run" && stalled
          ? t.progress.stalled
          : sub || entry.phase.detail || entry.phase.label;
      return {
        taskId: entry.task.id,
        running,
        text: running
          ? t.chat.statusLine.running(entry.task.title, what)
          : t.chat.statusLine.waiting(entry.task.title, what),
      };
    })
    .filter((line) => {
      if (seenTasks.has(line.taskId) || seenTexts.has(line.text)) return false;
      seenTasks.add(line.taskId);
      seenTexts.add(line.text);
      return true;
    });
}

// ───────────────────────────── composer ─────────────────────────────

export interface OperatorInput {
  /** useThreadEnvironment(): null = default desktop (不指定). */
  environment: { id: string; name: string } | null;
  loading: boolean;
  stale: boolean;
  unavailable: boolean;
  error: string;
}
export interface OperatorState {
  /** The server has no accounts (no desktop provider): no row. */
  hidden: boolean;
  label: string;
  /** Deleted, or no longer one of this project's accounts: red, 「请重选」. */
  stale: boolean;
  /** The selection could not be loaded; tapping retries. */
  failed: boolean;
  light: Light | null;
  /** The selected account id (null = 不指定 / still loading). */
  accountId: string | null;
}
/** The 「操作账号：<name> ▾」 row above the input (design §6.7). */
export function operatorState(
  env: OperatorInput,
  accounts: { byId: ReadonlyMap<string, Pick<AccountModel, "name" | "light">>; loaded: boolean },
): OperatorState {
  const base = { hidden: false, stale: false, failed: false, light: null, accountId: null };
  if (env.unavailable) return { ...base, hidden: true, label: "" };
  if (env.loading)
    return env.error
      ? { ...base, failed: true, label: t.composer.operator(t.common.unavailable) }
      : { ...base, label: t.composer.operatorLoading };
  if (!env.environment) return { ...base, label: t.composer.operatorNone };
  const account = accounts.byId.get(env.environment.id);
  const gone = env.stale || (accounts.loaded && !account);
  return {
    ...base,
    stale: gone,
    label: t.composer.operator(account?.name ?? env.environment.name),
    light: gone ? null : (account?.light ?? null),
    accountId: env.environment.id,
  };
}

// ───────────────────────────── answer box ─────────────────────────────

export interface AnswerField {
  name: string;
  label: string;
  checkbox: boolean;
}
/** `state.missingFields` (a document task's form fields, or names): one input each. */
export function missingFieldsOf(task: Pick<AgentTask, "state">): AnswerField[] {
  const raw = task.state?.missingFields;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const fields: AnswerField[] = [];
  for (const item of raw) {
    const value = record(item);
    const name =
      typeof item === "string"
        ? item.trim()
        : typeof value.name === "string"
          ? value.name.trim()
          : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    fields.push({ name, label: name.replace(/_/g, " "), checkbox: value.type === "checkbox" });
  }
  return fields;
}

/** What 发送回答 posts (POST /api/agent/tasks/:id/input): the text, or a stock line when only the
 * fields were filled (the server needs a non-empty answer); null when there is nothing to send. */
export function answerPayload(
  text: string,
  values: Readonly<Record<string, string | boolean>>,
  fields: readonly AnswerField[],
): { answer: string; fields?: Record<string, string | boolean> } | null {
  const filled: Record<string, string | boolean> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.checkbox) {
      if (typeof value === "boolean") filled[field.name] = value;
    } else if (typeof value === "string" && value.trim()) filled[field.name] = value.trim();
  }
  const answer = text.trim();
  const anyField = Object.values(filled).some((value) => value !== false);
  if (!answer && !anyField) return null;
  return {
    answer: answer || t.needs.fieldsAnswer,
    ...(Object.keys(filled).length ? { fields: filled } : {}),
  };
}
/** 「标题 · 25 分后过期」 for an upstream review; 「标题 · 已过期」 once past. `shown` is the title
 * the row already shows above the line: when it is the review's own title, the line is only
 * 「25 分后过期」 / 「已过期」 (never the title twice). */
export function reviewLine(
  action: { title: string; expiresAt: string; noExpiry?: boolean; draft?: boolean },
  now: Date | number,
  duration: (ms: number) => string,
  shown?: string,
): string {
  // A chat-started task's review has no expiry; it waits for the person.
  if (action.noExpiry) return action.draft ? t.needs.reviewDraft : t.needs.reviewWaiting;
  const until = ms(action.expiresAt);
  const nowMs = typeof now === "number" ? now : now.getTime();
  const repeated = shown !== undefined && shown.trim() === action.title.trim();
  if (until === null) return repeated ? "" : action.title;
  if (until > nowMs) {
    const left = duration(until - nowMs);
    return repeated ? t.needs.reviewExpiresIn(left) : t.needs.reviewSub(action.title, left);
  }
  return repeated ? t.needs.reviewExpiredShort : t.needs.reviewExpired(action.title);
}

/** Whether an upstream review can no longer be decided: the server marked it expired, or it is
 * still awaiting review past its expiry (the sweep has not run yet; approving it is refused). */
export function reviewIsExpired(
  action: { status: string; expiresAt: string; askFirst?: boolean; noExpiry?: boolean },
  now: Date | number = Date.now(),
): boolean {
  if (action.status === "expired") return true;
  if (action.status !== "awaiting_review" || action.noExpiry) return false;
  const until = ms(action.expiresAt);
  return until !== null && until <= (typeof now === "number" ? now : now.getTime());
}

/** A review card's buttons. 允许一次 · 总是允许 · 拒绝; a draft
 * (a message to people) says 草稿 with 发送 · 不发, and 总是允许 only when it is not a routine's.
 * Expired: no decision, only 总是允许 (which saves the rule and runs nothing). */
export function reviewCardView(
  action: {
    status: string;
    expiresAt: string;
    noExpiry?: boolean;
    draft?: boolean;
    fromRoutine?: boolean;
  },
  now: Date | number = Date.now(),
) {
  const expired = reviewIsExpired(action, now);
  const open = action.status === "awaiting_review" && !expired;
  const draft = action.draft === true;
  const alwaysOffered = (open || expired) && !(draft && action.fromRoutine === true);
  return {
    expired,
    open,
    draft,
    /** The tag beside the title: 草稿 for a draft. */
    tag: draft ? t.review.draft : null,
    approve: open ? (draft ? t.review.sendDraft : t.review.allowOnce) : null,
    deny: open ? (draft ? t.review.noSend : t.review.refuse) : null,
    always: alwaysOffered ? t.review.alwaysAllow : null,
    /** 已过期，没有执行 on an expired card. */
    expiredLine: expired ? t.review.expiredNote : null,
  };
}

// ───────────────────────────── tool results ─────────────────────────────

/** A server tool's result (a JSON string or object) as `{ id, error }`. */
export function toolResultRef(result: unknown): { id: string | null; error: string | null } {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const item = record(value);
  const id =
    typeof item.id === "string" && item.id
      ? item.id
      : typeof item.taskId === "string" && item.taskId
        ? item.taskId
        : null;
  return { id, error: typeof item.error === "string" && item.error ? item.error : null };
}

/** The chat's three tools that act on a task already started, and the
 * field of the result that confirms each reached it. */
export type TaskControlKind = "redirect" | "pause" | "resume";
const confirmedBy: Record<TaskControlKind, string> = {
  redirect: "redirected",
  pause: "paused",
  resume: "resumed",
};
/** A task-control card's words: its title while loading, done, failed, and the group chat line. */
export function taskControlWords(kind: TaskControlKind) {
  switch (kind) {
    case "pause":
      return {
        loading: t.tools.pausing,
        done: t.tools.pause,
        failed: t.tools.pauseFailed,
        group: t.group.paused,
      };
    case "resume":
      return {
        loading: t.tools.resuming,
        done: t.tools.resume,
        failed: t.tools.resumeFailed,
        group: t.group.resumed,
      };
    default:
      return {
        loading: t.tools.redirecting,
        done: t.tools.redirect,
        failed: t.tools.redirectFailed,
        group: t.group.redirected,
      };
  }
}
/** redirect_task's card (fork, report line): the task's title and its state word from the
 * result, never the id or a status name; the task to open comes from the call's own argument.
 * `failed` unless the result confirms it reached the task (`redirected: true`), and `reason` is
 * the server's reason in Chinese when it is a known one (`serverText`), else null: its English
 * is never shown.
 * Pause_task / resume_task's cards read the same, confirmed by their own
 * field (`paused` / `resumed`), the task from the call's argument or, for an account's loop, the
 * result's `taskId`. */
export function redirectView(
  args: unknown,
  result: unknown,
  kind: TaskControlKind = "redirect",
): { taskId: string | null; line: string | null; failed: boolean; reason: string | null } {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const item = record(value);
  const argued = record(args).taskId;
  const taskId = typeof argued === "string" && argued ? argued : item.taskId;
  const error = typeof item.error === "string" && item.error ? item.error : null;
  const line =
    typeof item.task === "string" && item.task && typeof item.state === "string" && item.state
      ? t.tools.redirectLine(item.task, item.state)
      : null;
  const said = error ? serverText(error) : "";
  // It reached the task only when the result says so (`redirected: true`);
  // a missing, unreadable or unknown result is not a confirmation.
  const confirmed = item[confirmedBy[kind]] === true && !error;
  return {
    taskId: typeof taskId === "string" && taskId ? taskId : null,
    line: confirmed ? line : null,
    failed: !confirmed,
    reason: error && said !== error ? said : null,
  };
}

export type ServerToolName =
  | "agent_status"
  | "task_events"
  | "create_goal"
  | "watch_page"
  | "remember_fact";
/** The chat's own bookkeeping, never a
 * reply: saving its plan or progress (agent_status), reading a task's activity (task_events),
 * noting a fact (remember_fact). Their result is the assistant's working state, already on the
 * live rail and the 进度汇报 page; in the conversation they would only read 「已保存」. A card that
 * carries something for the owner (a delegated task, a credential to give, a choice, a job, a goal
 * or watch set up for him) is not one of them. */
export const bookkeepingTools: ReadonlySet<string> = new Set<ServerToolName>([
  "agent_status",
  "task_events",
  "remember_fact",
]);
const toolCallName = (call: unknown): string => {
  const fn = record(record(call).function);
  return typeof fn.name === "string" ? fn.name : "";
};
/** The message as the conversation shows it: an assistant message without its bookkeeping tool
 * calls (the same object when it has none, so nothing else re-renders for it). A message left
 * with no text and no call is silent (`assistantSays`). */
export function withoutBookkeeping<M>(message: M): M {
  const calls = (message as { role?: unknown; toolCalls?: unknown }).toolCalls;
  if ((message as { role?: unknown }).role !== "assistant" || !Array.isArray(calls)) return message;
  const shown = calls.filter((call) => !bookkeepingTools.has(toolCallName(call)));
  return shown.length === calls.length ? message : { ...message, toolCalls: shown };
}
/** The card name and where 「看… ›」 goes for each server tool card (the old pages are gone, so
 * goals and watches open the rail's 任务, memories the rail's 项目资料; a task opens its panel). */
export function serverToolView(name: ServerToolName): {
  title: string;
  section: "tasks" | "notes";
} {
  switch (name) {
    case "agent_status":
      return { title: t.tools.progress, section: "tasks" };
    case "task_events":
      return { title: t.tools.taskEvents, section: "tasks" };
    case "create_goal":
      return { title: t.tools.goal, section: "tasks" };
    case "watch_page":
      return { title: t.tools.watch, section: "tasks" };
    case "remember_fact":
      return { title: t.tools.memory, section: "notes" };
  }
}

/** A tool call the runtime refused before
 * running it (its arguments did not fit the schema: `toolInputRejected`) is the model's own
 * working state: it reads the refusal and calls again. The message as the conversation shows it
 * leaves that call out (the same object when none was refused); a message left with nothing is
 * silent (`assistantSays`). `resultOf` is the tool result of a call id, as the transcript has it. */
export function withoutRejectedCalls<M>(message: M, resultOf: (callId: string) => unknown): M {
  const calls = (message as { role?: unknown; toolCalls?: unknown }).toolCalls;
  if ((message as { role?: unknown }).role !== "assistant" || !Array.isArray(calls)) return message;
  const shown = calls.filter((call) => {
    const id = record(call).id;
    return typeof id !== "string" || !toolInputRejected(resultOf(id));
  });
  return shown.length === calls.length ? message : { ...message, toolCalls: shown };
}

// ───────────────────────────── desktop steps ─────────────────────────────

/** A step on the desktop: use_desktop's actions, and the desktop browser opened from a command
 * (`openmuse-browser URL`; `openmuse-browser page` reads the open tabs). */
export type DesktopStepKind = keyof typeof t.desktop.steps;
export interface DesktopStep {
  /** The tool call's id. */
  id: string;
  kind: DesktopStepKind;
  /** The step in plain words (strings.ts `desktop.steps`); never the receipt's command line. */
  words: string;
  /** The step has its result. */
  done: boolean;
  /** The result is the step's own error (the desktop stopped, the input refused by the desktop). */
  failed: boolean;
  /** The receipt whose screenshot shows the desktop after this step, when there is one. */
  receiptId: string | null;
  /** The account whose desktop it is, as the result names it. */
  who: string | null;
}
/** The desktop steps of one reply that follow one another: the conversation shows them as one
 * block, drawn where the last of them is (`at`); the other steps draw nothing. */
export interface DesktopRun {
  steps: DesktopStep[];
  /** The call id the block is drawn at: the run's first step (the reply's words between steps
   * follow it in place). */
  at: string;
  /** The transcript's newest run: the one a running reply is still adding to. */
  newest: boolean;
}
/** Every desktop step's call id → its run. */
export type DesktopFold = ReadonlyMap<string, DesktopRun>;

const parseArgs = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
};
const parseResult = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
};
const stepKinds = new Set<string>(Object.keys(t.desktop.steps));
const scrollWords: Readonly<Record<string, string>> = t.desktop.scrollTo;

/** The words of a use_desktop step from its arguments: a key by its names (the schema keeps
 * them readable), a scroll by its direction, typed text never (it may be a password). */
export function desktopStepWords(kind: DesktopStepKind, args: Record<string, unknown>): string {
  if (kind === "key" && typeof args.text === "string" && args.text.trim())
    return t.desktop.keyNamed(args.text.trim());
  if (kind === "click_control" && typeof args.name === "string" && args.name.trim())
    return t.desktop.clickNamed(args.name.trim().slice(0, 40));
  if (kind === "scroll" && typeof args.scroll_direction === "string")
    return scrollWords[args.scroll_direction] ?? t.desktop.steps.scroll;
  return t.desktop.steps[kind];
}

/** The desktop step a tool call is, with its result (undefined while it runs); null for any
 * other call. A use_desktop call whose action is not known yet (its arguments still streaming)
 * is a step without a kind of its own: it reads 「桌面操作」. */
export function desktopStepOf(call: unknown, result: unknown): DesktopStep | null {
  const value = record(call);
  const fn = record(value.function);
  const id = typeof value.id === "string" ? value.id : "";
  if (!id || typeof fn.name !== "string") return null;
  const args = parseArgs(fn.arguments);
  const parsed = result === undefined ? null : parseResult(result);
  const error = parsed && typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  const base = {
    id,
    done: parsed !== null,
    failed: error !== null,
    receiptId: parsed && typeof parsed.receiptId === "string" ? parsed.receiptId : null,
    who: parsed ? (record(parsed.environment).name as string | undefined) || null : null,
  };
  if (fn.name === "use_desktop") {
    const action = typeof args.action === "string" ? args.action : "";
    if (!stepKinds.has(action)) return { ...base, kind: "screenshot", words: t.desktop.step };
    const kind = action as DesktopStepKind;
    return { ...base, kind, words: desktopStepWords(kind, args) };
  }
  if (fn.name === "run_computer_command" && typeof args.command === "string") {
    const command = args.command.trim();
    const browser = /^openmuse-browser(?:\s+(\S+))?/.exec(command);
    if (!browser) return null;
    const kind: DesktopStepKind = browser[1] === "page" ? "pages" : "open_page";
    return { ...base, kind, words: t.desktop.steps[kind], receiptId: null };
  }
  return null;
}

interface FoldMessage {
  role?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
  content?: unknown;
}
/**
 * The transcript's desktop steps folded into runs: all the desktop steps of one reply are one
 * run, and only a person's message ends it. The assistant's words and its other cards between
 * steps do not; they stay where they are, as its narration of the run.
 * Steps the runtime refused never reach this (`withoutRejectedCalls`). Each run is drawn once,
 * where its first step is; the newest run is the one a running reply still adds to.
 */
export function desktopFold(messages: readonly unknown[]): DesktopFold {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    const value = message as FoldMessage;
    if (value?.role === "tool" && typeof value.toolCallId === "string")
      results.set(value.toolCallId, value.content);
  }
  const runs: DesktopRun[] = [];
  let open: DesktopRun | null = null;
  for (const message of messages) {
    const value = message as FoldMessage;
    if (value?.role === "user") {
      open = null;
      continue;
    }
    if (value?.role !== "assistant" || !Array.isArray(value.toolCalls)) continue;
    for (const call of value.toolCalls) {
      const id = record(call).id;
      const step = desktopStepOf(call, typeof id === "string" ? results.get(id) : undefined);
      if (!step) continue;
      if (!open) {
        open = { steps: [], at: step.id, newest: false };
        runs.push(open);
      }
      open.steps.push(step);
    }
  }
  const fold = new Map<string, DesktopRun>();
  for (const run of runs) {
    // A person's message after the last run ends it too: the reply running
    // now is a later one and adds nothing to it (a refused reply's block spun through the next).
    run.newest = run === runs.at(-1) && run === open;
    for (const step of run.steps) fold.set(step.id, run);
  }
  return fold;
}

export interface DesktopRunView {
  /** The block's one line: 「正在 Nova_Harrison 的桌面上操作 · 第 3 步 · 点击」 while it
   * works, 「在桌面上做了 3 步」 (「· 1 步没成功」) once the reply ended. */
  line: string;
  live: boolean;
  count: number;
  failed: number;
  /** The receipt of the latest screenshot in the run, when any step took one. */
  receiptId: string | null;
  /** The account whose desktop it is: from the steps' results, else the conversation's account. */
  who: string | null;
}
/** What a run's block shows. `replying`: a reply is running in this conversation now; a run is
 * live only while that reply still adds to it (the newest run). A step
 * left without a result is not live once no reply runs; it ended without succeeding, so it counts
 * as 没成功. `who` is the conversation's account when no step named one. */
export function desktopRunView(
  run: DesktopRun,
  replying: boolean,
  who: string | null = null,
): DesktopRunView {
  const last = run.steps.at(-1);
  const live = !!last && replying && run.newest;
  const named = [...run.steps].reverse().find((step) => step.who)?.who ?? who;
  const receiptId = [...run.steps].reverse().find((step) => step.receiptId)?.receiptId ?? null;
  const failed = run.steps.filter((step) => step.failed || (!live && !step.done)).length;
  const count = run.steps.length;
  const line = live
    ? named
      ? t.desktop.operating(named, count, last?.words ?? "")
      : t.desktop.operatingHere(count, last?.words ?? "")
    : [t.desktop.didSteps(count), failed ? t.desktop.stepsFailed(failed) : ""]
        .filter(Boolean)
        .join(t.common.sep);
  return { line, live, count, failed, receiptId, who: named };
}

/**
 * What a delegated task's results under its chat card (thread-artifacts TaskResults) hang on:
 * its artifact ids, and the browser session the server's task detail finds through
 * `state.browserId` / `state.sessionId` (read_web sets those without adding an artifact, so a
 * task that only browsed still shows its browser card). "" = nothing to show and nothing to
 * read; a new id (a new result) is a new read, the same ids on every poll are not.
 */
export function taskResultsKey(task: Pick<AgentTask, "artifactIds" | "state">): string {
  const artifacts = (Array.isArray(task.artifactIds) ? task.artifactIds : []).filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  const state = record(task.state);
  const browsers = [
    ...new Set(
      [state.browserId, state.sessionId].filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  if (!artifacts.length && !browsers.length) return "";
  return `${artifacts.join(",")}|${browsers.join(",")}`;
}

// ───────────────────────────── who speaks ─────────────────────────────

/** The capybara's colour (upstream's agent avatar setting, still stored in the identity):
 * sky, sand or lilac; sky when it was never set. */
export type MascotVariant = "sky" | "sand" | "lilac";
export function mascotVariant(avatar: unknown): MascotVariant {
  return avatar === "sand" || avatar === "lilac" ? avatar : "sky";
}

export interface Turn {
  /** owner: the person's bubble on the right; assistant: OpenMuse the capybara speaking;
   * silent: an assistant message with nothing to show (no text, no tool card): not drawn. */
  speaker: "owner" | "assistant" | "silent";
  /** The capybara's avatar shows on the first of its consecutive turns only. */
  avatar: boolean;
}
interface TurnMessage {
  role: string;
  content?: unknown;
  toolCalls?: readonly unknown[];
}
/**
 * Who says each transcript item (the chat reads as a conversation, as upstream did): the
 * person's messages are theirs; OpenMuse's replies, the task reports and the "needs you" items
 * are all things the capybara says. Consecutive capybara turns share one avatar; a silent
 * message neither takes nor breaks it.
 */
export function transcriptTurns(
  items: readonly ({ type: "message"; message: TurnMessage } | { type: string })[],
): Turn[] {
  let previous: "owner" | "assistant" | null = null;
  return items.map((item): Turn => {
    const message = item.type === "message" && "message" in item ? item.message : null;
    if (message?.role === "user") {
      previous = "owner";
      return { speaker: "owner", avatar: false };
    }
    if (message && !assistantSays(message)) return { speaker: "silent", avatar: false };
    const avatar = previous !== "assistant";
    previous = "assistant";
    return { speaker: "assistant", avatar };
  });
}
/** An assistant message shows something: text, or a tool card. */
export function assistantSays(message: TurnMessage): boolean {
  return (
    (typeof message.content === "string" && message.content.trim() !== "") ||
    (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
  );
}

// ───────────────────────────── empty state ─────────────────────────────

/** Design §6.9: 未分组 has its own text; a project without accounts offers 加入. */
export function emptyStateKind(
  projectId: string | null,
  accounts: number,
): "default" | "noAccounts" | "ready" {
  if (projectId === null) return "default";
  return accounts ? "ready" : "noAccounts";
}

// ───────────────────────────── model context ─────────────────────────────

export const modelTaskLimit = 20;
export interface ChatModelContext {
  project: string;
  accounts: { name: string; desktop: string; now: TaskPhaseKey | null }[];
  /** account: the bound account's name (its id when it is not one of this project's accounts);
   * null = the project's default desktop. */
  tasks: { id: string; title: string; phase: TaskPhaseKey; account: string | null }[];
}
/**
 * The chat model's context (design §6.10): the current project, its accounts (desktop state and
 * what each is doing now) and a short task summary (live tasks by priority, then the most
 * recently ended; at most 20). Only stable values (phase keys, not "还剩 13 分"), so the context
 * changes only when the state does.
 */
export function chatModelContext(input: {
  projectName: string;
  accounts: readonly Pick<AccountModel, "id" | "name" | "desktop" | "now">[];
  entries: readonly TaskEntry[];
  limit?: number;
}): ChatModelContext {
  const names = new Map(input.accounts.map((account) => [account.id, account.name]));
  const live = input.entries.filter((entry) => !entry.phase.ended).sort(byPriority);
  const ended = input.entries
    .filter((entry) => entry.phase.ended)
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  return {
    project: input.projectName,
    accounts: input.accounts.map((account) => ({
      name: account.name,
      desktop: account.desktop,
      now: account.now?.entry.phase.key ?? null,
    })),
    tasks: [...live, ...ended].slice(0, input.limit ?? modelTaskLimit).map((entry) => ({
      id: entry.task.id,
      title: entry.task.title,
      phase: entry.phase.key,
      account: entry.environmentId ? (names.get(entry.environmentId) ?? entry.environmentId) : null,
    })),
  };
}
