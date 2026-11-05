/**
 * The
 * 进度汇报 page's logic. The web app's chat is the conversation only (chat-state's
 * `conversationOnly`); what the background tasks report is read here instead:
 *   ReportFeed      the project's reports, every page of them: the newest page at once and on
 *                   each refresh (new reports, and which were read elsewhere; `check` looks at the
 *                   newest few and refreshes only when they changed), older pages as the person
 *                   scrolls, and "seen" for what the page's tab shows (POST /api/chat-reports/read,
 *                   the chat's own call), each conversation's after its own last message, in
 *                   batches, one request at a time, backing off after a failure
 *   progressNow     正在做: the tasks running, queued or waiting to go on, one line each
 *   progressItems   a list in the page's order (newest first): one task's reports in a row merge
 *                   (更早 N 条), a stop report and a job notice stand alone
 *   progressDays, progressByTask, tabReports  the tabs 全部 · 要你看 · 对外动作 · 按任务
 *   tabUnread, freshReports  where the unread reports are (a count on each tab) and which were
 *                   new during this visit (新 on their blocks)
 * Pure: no react-native, so node:test can import it (apps/mobile/test/shell-progress.test.ts).
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import {
  markRetryMs,
  markTimeoutMs,
  normalizeReports,
  type ReportsRequest,
  reportNeedsAttention,
  reportsMarkBatch,
  reportsPageSize,
} from "../../chat-reports-core.ts";
import { isWaitCard, latestNeedReportIds, stoppedLine, taskCardLines } from "../chat/core.ts";
import { byPriority, needReportLabels, type TaskEntry } from "../model.ts";
import { t } from "../strings.ts";

/** Newest first: the page's order. */
const newestFirst = (a: ChatReport, b: ChatReport) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Whether the page lists a report: every report but a project's request to the founder (a line
 * of the 营销总群's conversation, not progress) and the cards a wait wrote before waits stopped
 * being reports. */
export function onProgressPage(report: Pick<ChatReport, "kind" | "title" | "notice">): boolean {
  return report.notice?.kind !== "founder_request" && !isWaitCard(report);
}

/** The reports the page shows that nobody has read yet (the sidebar's count). */
export function unreadCount(reports: readonly ChatReport[]): number {
  return reports.filter((report) => onProgressPage(report) && !report.readAt).length;
}

/** The count beside the page's entry: how many unread reports are held, with a 「+」 while older
 * pages are unread for all the page knows (the oldest held is unread and more may follow), and at
 * most 「99+」; null when there is none. */
export function unreadLabel(state: Pick<FeedState, "reports" | "exhausted">): string | null {
  const count = unreadCount(state.reports);
  if (!count) return null;
  const oldest = state.reports.filter(onProgressPage).at(-1);
  const more = !state.exhausted && !!oldest && !oldest.readAt;
  return count > 99 ? "99+" : more ? `${count}+` : String(count);
}

/** A report of something done on a site: it names the site and the action, or links to it. */
export function isExternalAction(report: Pick<ChatReport, "action" | "links">): boolean {
  return !!report.action || report.links.length > 0;
}

export type ProgressTab = "all" | "attention" | "external" | "byTask";
export const progressTabs: readonly ProgressTab[] = ["all", "attention", "external", "byTask"];

/** The reports a tab lists, in the page's order. 要你看: failures, questions and reviews
 * (`reportNeedsAttention`); 对外动作: `isExternalAction`; 全部 and 按任务: everything. */
export function tabReports(reports: readonly ChatReport[], tab: ProgressTab): ChatReport[] {
  const shown = reports.filter(onProgressPage);
  if (tab === "attention") return shown.filter(reportNeedsAttention);
  if (tab === "external") return shown.filter(isExternalAction);
  return shown;
}

/** How many unread reports each tab lists: the count beside a tab, so the person sees where the
 * new ones are when the tab he is on has none. */
export function tabUnread(reports: readonly ChatReport[]): Record<ProgressTab, number> {
  const counts = { all: 0, attention: 0, external: 0, byTask: 0 } as Record<ProgressTab, number>;
  for (const tab of progressTabs)
    counts[tab] = tabReports(reports, tab).filter((report) => !report.readAt).length;
  return counts;
}

/** The reports that were new during this visit of the page (each block marks them 新): `fresh`
 * and every report unread now. Recording a report as seen does not take its mark away until the
 * page closes, so the person can tell which ones he was told about. Returns `fresh` itself when
 * nothing joins. */
export function freshReports(
  fresh: ReadonlySet<string>,
  reports: readonly ChatReport[],
): ReadonlySet<string> {
  const joining = reports.filter(
    (report) => onProgressPage(report) && !report.readAt && !fresh.has(report.id),
  );
  if (!joining.length) return fresh;
  return new Set([...fresh, ...joining.map((report) => report.id)]);
}

export type ProgressItem =
  /** One task's reports in a row, newest first: the newest shows, the rest behind 更早 N 条. */
  | { type: "reports"; key: string; taskId: string; reports: ChatReport[] }
  /** A stop report (a question, a review, a failure): the live need card, its receipt, or it. */
  | { type: "need"; key: string; report: ChatReport }
  /** A job taken, declined or done, a persona changed, the founder's line about the hall. */
  | { type: "notice"; key: string; report: ChatReport };

const isNeedReport = (report: Pick<ChatReport, "kind" | "title">) =>
  report.kind === "outcome" && needReportLabels.includes(report.title);

/** The newest stop report of each task: only it may show the live need card or the receipt. */
export function latestNeeds(reports: readonly ChatReport[]): Set<string> {
  return latestNeedReportIds(reports.filter(isNeedReport));
}

/** `reports` (newest first) as the page's items: consecutive reports of one task merge, a stop
 * report and a notice stand alone (the chat's `groupTranscript`, in the page's order). */
export function progressItems(reports: readonly ChatReport[]): ProgressItem[] {
  const items: ProgressItem[] = [];
  for (const report of reports) {
    const key = `report-${report.id}`;
    if (isNeedReport(report)) {
      items.push({ type: "need", key, report });
      continue;
    }
    if (report.notice) {
      items.push({ type: "notice", key, report });
      continue;
    }
    const last = items.at(-1);
    if (last?.type === "reports" && last.taskId === report.taskId) last.reports.push(report);
    else items.push({ type: "reports", key, taskId: report.taskId, reports: [report] });
  }
  return items;
}

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
/** The day a time falls on, as the timeline's divider says it: 今天 / 昨天 / 10月16日. */
export function dayOf(iso: string, now: Date | number): { key: string; label: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const today = new Date(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = dayKey(at);
  const label =
    key === dayKey(today)
      ? t.chat.day.today
      : key === dayKey(yesterday)
        ? t.chat.day.yesterday
        : t.chat.day.date(at.getMonth() + 1, at.getDate());
  return { key, label };
}

export interface ProgressDay {
  key: string;
  label: string;
  items: ProgressItem[];
}
/** `reports` (newest first) by day, newest day first, each day's reports as items. */
export function progressDays(reports: readonly ChatReport[], now: Date | number): ProgressDay[] {
  const days: { key: string; label: string; reports: ChatReport[] }[] = [];
  for (const report of reports) {
    const day = dayOf(report.createdAt, now) ?? { key: "", label: "" };
    const last = days.at(-1);
    if (last && last.key === day.key) last.reports.push(report);
    else days.push({ ...day, reports: [report] });
  }
  return days.map((day) => ({
    key: day.key,
    label: day.label,
    items: progressItems(day.reports),
  }));
}

export interface ProgressTask {
  taskId: string;
  /** The task's title as its newest report names it. */
  title: string;
  latestAt: string;
  count: number;
  items: ProgressItem[];
}
/** 按任务: each task's reports together, the task reported on last first. */
export function progressByTask(reports: readonly ChatReport[]): ProgressTask[] {
  const byTask = new Map<string, ChatReport[]>();
  for (const report of reports) {
    const list = byTask.get(report.taskId);
    if (list) list.push(report);
    else byTask.set(report.taskId, [report]);
  }
  return [...byTask.entries()].map(([taskId, list]) => ({
    taskId,
    title: list[0].taskTitle,
    latestAt: list[0].createdAt,
    count: list.length,
    items: progressItems(list),
  }));
}

export interface NowLine {
  entry: TaskEntry;
  /** What it does now (the step, 正在运行, 排队中) or when it goes on (15:00 继续（还剩 13 分）); a
   * run while the worker has no heartbeat: where it stopped (停在第 3/5 步 · …), or nothing (its
   * pill reads 后台停着 and the heading says nothing moves). */
  line: string;
  /** It moves now (the page's spinner): it runs and the worker is alive. A queued task waits for
   * its turn and a stalled worker moves nothing, so neither spins. */
  running: boolean;
}
const nowPhases = new Set(["run", "queue", "wait"]);
/** 正在做: the project's tasks that run, wait in the queue or wait to go on, the most urgent
 * first, one line each (what the chat's status lines said). What waits for the person is
 * 需要你's and the 要你看 tab's. `stalled`: the worker has no heartbeat (nothing moves). */
export function progressNow(
  entries: readonly TaskEntry[],
  now: Date | number,
  stalled = false,
): NowLine[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => nowPhases.has(entry.phase.key))
    .sort(byPriority)
    .filter((entry) => {
      if (seen.has(entry.task.id)) return false;
      seen.add(entry.task.id);
      return true;
    })
    .map((entry) => {
      const stopped = entry.phase.key === "run" && (stalled || !!entry.phase.stalled);
      return {
        entry,
        line: stopped
          ? stoppedLine(entry.task)
          : taskCardLines(entry, now).sub || entry.phase.detail || entry.phase.sub,
        running: entry.phase.key === "run" && !stopped,
      };
    });
}

/** Merges fetched reports into the held list by id (the fetched copy wins, but a report once
 * read stays read: a page read before a mark answered says nothing new about it), newest first,
 * with no cap: the page keeps every page it read. Returns `current` itself when nothing changed. */
export function mergeFeed(current: ChatReport[], incoming: readonly ChatReport[]): ChatReport[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((report) => [report.id, report]));
  let changed = false;
  for (const fetched of incoming) {
    const old = byId.get(fetched.id);
    const report =
      old?.readAt && !fetched.readAt
        ? { ...fetched, readAt: old.readAt, afterMessageId: old.afterMessageId }
        : fetched;
    if (old && JSON.stringify(old) === JSON.stringify(report)) continue;
    byId.set(report.id, report);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort(newestFirst);
}

export interface FeedState {
  /** Every report read so far, newest first (wait cards left out). */
  reports: ChatReport[];
  /** The first page has answered. */
  loaded: boolean;
  /** An older page is being read. */
  older: boolean;
  /** There is no older page. */
  exhausted: boolean;
  error: string;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Every report but the cards a wait wrote before waits stopped being reports. */
const notWaitCard = (report: ChatReport) => !isWaitCard(report);
/** Pages read back at most, after a long absence, to join the newest page to what is held. */
const gapPages = 10;
/** How many of the newest reports `check` reads to tell whether anything changed. */
export const probeSize = 5;
/** How often the page, while open, looks for new reports (`check`); the provider looks at the
 * rail's pace (pollMs.reports) the rest of the time. */
export const progressPagePollMs = 5_000;
/** What a list of reports says about change: each one and whether it was read. */
const changeKey = (list: readonly ChatReport[]) =>
  list.map((report) => `${report.id}:${report.readAt ?? ""}`).join(",");

/** Where a conversation's reports are recorded as seen: the id of its last shown message ("" for
 * an empty one), null while it is not settled (a reply streaming: wait), undefined when this page
 * does not show the conversation (the feed reads its messages). */
export type SeenAnchor = (threadId: string) => string | null | undefined;

/** The last message a conversation shows (the person's and the replies: the chat's own
 * `visible`), from GET /api/copilotkit/threads/:id/messages; "" for none, null for an answer
 * that is not a message list. */
export function lastShownMessage(payload: unknown): string | null {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  let last = "";
  for (const message of messages) {
    const { id, role } = (message ?? {}) as { id?: unknown; role?: unknown };
    if (typeof id === "string" && (role === "user" || role === "assistant")) last = id;
  }
  return last;
}

/**
 * The project's reports (or one conversation's) for the 进度汇报 page (see the file comment).
 * `refresh` reads the newest page (and, when a whole page is newer than anything held, back until
 * it meets); `check` reads only the newest few and refreshes when they changed; `loadOlder` the
 * page before the oldest held. `see(anchorOf, listed)` records as seen the unread reports the
 * page's tab lists, each after its own conversation's last message (`SeenAnchor`: the phone,
 * whose chat still places reports, puts them where they were seen; a report anchored on another
 * conversation's message would sink to the end of its own), up to `reportsMarkBatch` of one
 * conversation per request with one request in flight; `unsee` stops it when the page closes.
 */
export class ReportFeed {
  private state: FeedState = {
    reports: [],
    loaded: false,
    older: false,
    exhausted: false,
    error: "",
  };
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  /** Bumped when the held list starts again from the newest pages: an older page read for the
   * list before is dropped. */
  private epoch = 0;
  /** The newest few as the last read saw them (`check`). */
  private newestKey: string | null = null;
  private marking = false;
  private anchorOf: SeenAnchor | null = null;
  private listed: ReadonlySet<string> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly failed = new Map<string, { failures: number; retryAt: number }>();
  private readonly gone = new Set<string>();
  /** `threadId` keeps one conversation's reports; null reads the whole project's (what 进度汇报
   * shows: a task started from a side chat reports there too, and the web chat shows none). */
  constructor(
    readonly threadId: string | null,
    private readonly request: ReportsRequest,
    private readonly now: () => number = Date.now,
    private readonly markTimeout = markTimeoutMs,
  ) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getState = () => this.state;
  private set(change: Partial<FeedState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private async page(query: Record<string, string>, limit = reportsPageSize) {
    // Built by hand: React Native's URLSearchParams is incomplete.
    const params = Object.entries({
      ...(this.threadId ? { threadId: this.threadId } : {}),
      limit: String(limit),
      ...query,
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    const list = normalizeReports(await this.request(`/api/chat-reports?${params}`)).filter(
      (report) => !this.threadId || report.threadId === this.threadId,
    );
    // Oldest first, as the server sends them; `full` says whether an older page may follow.
    return { list, full: list.length >= limit };
  }
  readonly refresh = (): Promise<void> => {
    this.refreshing ??= this.readNewest().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  };
  private async readNewest() {
    const first = !this.state.loaded;
    const newestHeld = this.state.reports[0];
    try {
      let page = await this.page({});
      // Kept for `check` only once the read lands: a gap page that fails leaves the newest page
      // unmerged, and the next check must read it again.
      const newestKey = changeKey(page.list.slice(-probeSize));
      const read = [...page.list];
      // Joined: the page reaches back to what is held, or there is nothing older.
      const meets = () =>
        !newestHeld || !page.full || page.list[0].createdAt <= newestHeld.createdAt;
      for (let rounds = 0; !meets() && rounds < gapPages; rounds++) {
        const oldest = page.list[0];
        page = await this.page({ before: oldest.createdAt, beforeId: oldest.id });
        read.push(...page.list);
      }
      const fetched = read.filter(notWaitCard);
      this.newestKey = newestKey;
      if (meets()) {
        // Into what is held now (an older page or a mark may have landed while this read).
        this.set({
          reports: mergeFeed(this.state.reports, fetched),
          loaded: true,
          error: "",
          ...(first ? { exhausted: !page.full } : {}),
        });
        return;
      }
      // Still a whole page newer than anything held after `gapPages`: what lies between is
      // unknown, so the list starts again from the pages just read and older ones load from there
      // (the held ones come back as the person scrolls).
      this.epoch += 1;
      this.set({ reports: mergeFeed([], fetched), loaded: true, error: "", exhausted: false });
    } catch (e) {
      this.set({ error: errorText(e) });
    }
  }
  /** Reads the newest few reports and the newest page only when they changed (a new report, or
   * one read elsewhere): cheap enough to run often. The first call reads the newest page. */
  readonly check = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    this.checking ??= this.probe().finally(() => {
      this.checking = null;
    });
    return this.checking;
  };
  private async probe() {
    if (this.newestKey === null) return this.refresh();
    const { list } = await this.page({}, probeSize);
    if (changeKey(list) !== this.newestKey) await this.refresh();
  }
  readonly loadOlder = (): Promise<void> => {
    if (!this.state.loaded || this.state.exhausted) return Promise.resolve();
    this.reading ??= this.readOlder().finally(() => {
      this.reading = null;
    });
    return this.reading;
  };
  private async readOlder() {
    const oldest = this.state.reports.at(-1);
    if (!oldest) {
      this.set({ exhausted: true });
      return;
    }
    const epoch = this.epoch;
    this.set({ older: true });
    try {
      const page = await this.page({ before: oldest.createdAt, beforeId: oldest.id });
      if (epoch !== this.epoch) {
        this.set({ older: false });
        return;
      }
      this.set({
        reports: mergeFeed(this.state.reports, page.list.filter(notWaitCard)),
        older: false,
        exhausted: !page.full,
        error: "",
      });
    } catch (e) {
      this.set({ older: false, error: errorText(e) });
    }
  }
  /** Records as seen the unread reports the page's tab lists (`listed`: their ids; every report
   * the page holds when left out), each after its conversation's last message (`anchorOf`); see
   * the class comment. Returns the ids sent now. */
  readonly see = (anchorOf: SeenAnchor, listed?: Iterable<string>): string[] => {
    this.anchorOf = anchorOf;
    this.listed = listed ? new Set(listed) : null;
    if (this.marking) return [];
    const now = this.now();
    const due = this.state.reports.filter(
      (report) =>
        onProgressPage(report) &&
        !report.readAt &&
        (!this.listed || this.listed.has(report.id)) &&
        !this.gone.has(report.id) &&
        (this.failed.get(report.id)?.retryAt ?? 0) <= now,
    );
    // One conversation per request: the first whose last message is known or can be read.
    const waiting = new Set<string>();
    for (const report of due) {
      if (waiting.has(report.threadId)) continue;
      const anchor = anchorOf(report.threadId);
      if (anchor === null) {
        waiting.add(report.threadId);
        continue;
      }
      const ids = due
        .filter((item) => item.threadId === report.threadId)
        .slice(0, reportsMarkBatch)
        .map((item) => item.id);
      void this.mark(ids, report.threadId, anchor);
      return ids;
    }
    return [];
  };
  /** The page closed: nothing more is recorded as seen until it opens again. */
  readonly unsee = () => {
    this.anchorOf = null;
    this.listed = null;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
  };
  /** A conversation's last shown message, read when the page does not show it: null for one the
   * server no longer has (no conversation to place the report in). Throws when it cannot read. */
  private async lastMessageOf(threadId: string): Promise<string | null> {
    try {
      const last = lastShownMessage(
        await this.request(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages`),
      );
      if (last === null) throw new Error("Unexpected answer");
      return last;
    } catch (e) {
      if ((e as { status?: unknown } | null)?.status === 404) return null;
      throw e;
    }
  }
  private async mark(ids: string[], threadId: string, anchor: string | undefined) {
    this.marking = true;
    let saved: ChatReport[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), this.markTimeout);
        (timer as { unref?: () => void }).unref?.();
      });
      const afterMessageId =
        anchor === undefined ? await Promise.race([this.lastMessageOf(threadId), timeout]) : anchor;
      const payload = await Promise.race([
        this.request("/api/chat-reports/read", { ids, afterMessageId }),
        timeout,
      ]);
      if (!Array.isArray((payload as { reports?: unknown } | null)?.reports))
        throw new Error("Unexpected answer");
      saved = normalizeReports(payload);
    } catch {
      // A 429, a network error or a hung request: each report below waits for its backoff.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const returned = new Map((saved ?? []).map((report) => [report.id, report]));
    const recorded: ChatReport[] = [];
    let wait = 0;
    for (const id of ids) {
      const report = returned.get(id);
      if (report?.readAt) {
        this.failed.delete(id);
        recorded.push(report);
      } else if (saved && !report) {
        // The server no longer has it: retrying would never succeed.
        this.failed.delete(id);
        this.gone.add(id);
      } else {
        const failures = (this.failed.get(id)?.failures ?? 0) + 1;
        const delay = markRetryMs(failures);
        this.failed.set(id, { failures, retryAt: this.now() + delay });
        wait = Math.max(wait, delay);
      }
    }
    this.marking = false;
    const reports = mergeFeed(this.state.reports, recorded);
    if (reports !== this.state.reports) this.set({ reports });
    if (this.anchorOf === null) return;
    // The rest of a long backlog (or another conversation's) goes next; a failed batch once its
    // backoff is over.
    const again = () => {
      if (this.anchorOf !== null) this.see(this.anchorOf, this.listed ?? undefined);
    };
    if (wait) {
      if (this.retry !== undefined) clearTimeout(this.retry);
      this.retry = setTimeout(() => {
        this.retry = undefined;
        again();
      }, wait);
      (this.retry as { unref?: () => void }).unref?.();
    } else again();
  }
}
