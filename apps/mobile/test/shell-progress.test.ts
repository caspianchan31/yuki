// The web
// app's chat is the conversation only, and the tasks' reports are on the 进度汇报 page. Pinned here:
// what the 营销总群's timeline keeps (the members' speech), that the chat then records only those
// as seen, the page's tabs, items, days and tasks, 正在做, and ReportFeed (paging, refresh, the
// cheap check for new reports, and "seen" for what the tab lists, each conversation's after its
// own last message, in batches with a backoff); and the page's place in the address (#progress,
// an entry of its own so Back closes it).
import assert from "node:assert/strict";
import test from "node:test";
import {
  isGroupSpeech,
  type MarkConditions,
  type ReportsRequest,
  reportsPageSize,
  ThreadReports,
  timelineReports,
} from "../../../packages/client/src/chat-reports-core.ts";
import { type TaskEntry, taskEntries } from "../../../packages/client/src/shell/model.ts";
import {
  dayOf,
  freshReports,
  isExternalAction,
  lastShownMessage,
  latestNeeds,
  mergeFeed,
  onProgressPage,
  probeSize,
  progressByTask,
  progressDays,
  progressItems,
  progressNow,
  ReportFeed,
  tabReports,
  tabUnread,
  unreadCount,
  unreadLabel,
} from "../../../packages/client/src/shell/progress/progress-core.ts";
import { phaseWords, t } from "../../../packages/client/src/shell/strings.ts";
import type { AgentTask, ChatReport } from "../../../packages/domain/src/agent.ts";
import { taskPhase } from "../../../packages/domain/src/task-phase.ts";
import { hashMove, hashOfPage, pageOfHash, pushedByApp } from "../../web/src/shell/page-hash.ts";
import { registerShellPages } from "../../web/src/shell/shell-pages.ts";

const report = (id: string, createdAt: string, extra: Partial<ChatReport> = {}): ChatReport => ({
  id,
  taskId: "task-1",
  taskTitle: "每日巡检",
  threadId: "main",
  kind: "report",
  title: "Update",
  text: `Report ${id}`,
  links: [],
  createdAt,
  readAt: null,
  afterMessageId: null,
  ...extra,
});
const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 8, minute)).toISOString();
const newestFirst = (list: ChatReport[]) =>
  [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

test("the hall's timeline keeps the members' speech; a project's keeps no report", () => {
  const request = report("req", at(1), {
    notice: { kind: "founder_request", project: "acmeskills", jobTitle: "发一帖", account: "Ann" },
  });
  const taken = report("taken", at(2), {
    notice: { kind: "job_taken", jobTitle: "发一帖", account: "Ann" },
  });
  const declined = report("declined", at(3), {
    notice: { kind: "job_declined", jobTitle: "发一帖", account: "Bob" },
  });
  const done = report("done", at(4), { notice: { kind: "job_done", jobTitle: "发一帖" } });
  const reply = report("reply", at(5), { project: "acmeskills" });
  const plain = report("plain", at(6));
  const failure = report("fail", at(7), { kind: "outcome", title: "Run failed" });
  const persona = report("persona", at(8), { notice: { kind: "persona", account: "Ann" } });
  const inHall = report("in-hall", at(9), { notice: { kind: "in_hall", account: "Ann" } });
  const all = [request, taken, declined, done, reply, plain, failure, persona, inHall];
  assert.deepEqual(
    all.filter(isGroupSpeech).map((item) => item.id),
    ["req", "taken", "declined", "done", "reply"],
  );
  assert.deepEqual(
    timelineReports(all, true).map((item) => item.id),
    ["req", "taken", "declined", "done", "reply"],
  );
  assert.deepEqual(timelineReports(all, false), []);
  // A founder's failure for a project is a stop report: the page's, not the timeline's.
  assert.equal(isGroupSpeech(report("x", at(1), { kind: "outcome", project: "a" })), false);
});

test("a conversation-only chat records as seen only the reports it places", async () => {
  const sent: unknown[] = [];
  const request: ReportsRequest = async (path, body) => {
    if (path === "/api/chat-reports/read") {
      sent.push(body);
      const ids = (body as { ids: string[] }).ids;
      return { reports: ids.map((id) => report(id, at(1), { readAt: at(2) })) };
    }
    return {
      reports: [
        report("speech", at(1), { notice: { kind: "job_taken", account: "Ann" } }),
        report("progress", at(2)),
      ],
    };
  };
  const store = new ThreadReports("main", request);
  await store.refresh();
  const idle: MarkConditions = {
    active: true,
    onScreen: true,
    loaded: true,
    syncing: false,
    replying: false,
    shown: true,
  };
  const due = store.markShown([{ id: "m1" }], idle, isGroupSpeech);
  assert.deepEqual(due, [{ id: "speech", afterMessageId: "m1" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ ids: ["speech"], afterMessageId: "m1" }]);
  // The phone (no filter) still records everything it shows.
  assert.deepEqual(store.markShown([{ id: "m1" }], idle), [
    { id: "progress", afterMessageId: "m1" },
  ]);
});

test("the page lists every report but a project's request to the founder; its tabs filter", () => {
  const list = newestFirst([
    report("a", at(1), { links: ["https://reddit.com/r/x/1"] }),
    report("b", at(2), { kind: "outcome", title: "Needs your input" }),
    report("c", at(3), { title: "Action", action: { site: "reddit.com", action: "comment" } }),
    report("d", at(4), { kind: "outcome", title: "Finished", readAt: at(5) }),
    report("e", at(5), { notice: { kind: "founder_request", account: "Ann" } }),
    report("f", at(6), { kind: "outcome", title: "Waiting 30 minutes" }),
  ]);
  assert.equal(onProgressPage(list[0]), false, "a wait card is never shown");
  assert.deepEqual(
    tabReports(list, "all").map((item) => item.id),
    ["d", "c", "b", "a"],
  );
  assert.deepEqual(
    tabReports(list, "attention").map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    tabReports(list, "external").map((item) => item.id),
    ["c", "a"],
  );
  assert.equal(isExternalAction(report("z", at(1))), false);
  // The sidebar counts what the page lists and nobody has read; 「+」 while older pages may hold
  // more unread ones.
  assert.equal(unreadCount(list), 3);
  assert.equal(unreadLabel({ reports: list, exhausted: true }), "3");
  assert.equal(unreadLabel({ reports: list, exhausted: false }), "3+");
  assert.equal(unreadLabel({ reports: [list[2]], exhausted: false }), null);
  // Each tab says how many unread reports it lists, so 要你看 opened with nothing new in it still
  // shows where the new ones are.
  assert.deepEqual(tabUnread(list), { all: 3, attention: 1, external: 2, byTask: 3 });
});

test("新: what was unread during this visit keeps its mark after it is recorded as seen", () => {
  const list = newestFirst([
    report("a", at(1), { readAt: at(2) }),
    report("b", at(3)),
    report("e", at(4), { notice: { kind: "founder_request", account: "Ann" } }),
  ]);
  const empty: ReadonlySet<string> = new Set();
  const fresh = freshReports(empty, list);
  assert.deepEqual([...fresh], ["b"], "only unread reports the page lists");
  // Recorded as seen: the mark stays for this visit.
  const seen = list.map((item) => (item.id === "b" ? { ...item, readAt: at(5) } : item));
  assert.equal(freshReports(fresh, seen), fresh, "nothing joins: the same set");
  assert.deepEqual([...freshReports(fresh, [report("c", at(6)), ...seen])].sort(), ["b", "c"]);
});

test("one task's reports in a row merge, newest first; a stop report and a notice stand alone", () => {
  const list = newestFirst([
    report("1", at(1)),
    report("2", at(2)),
    report("3", at(3), { kind: "outcome", title: "Run failed" }),
    report("4", at(4)),
    report("5", at(5), { taskId: "task-2" }),
    report("6", at(6), { taskId: "task-2" }),
    report("7", at(7), { notice: { kind: "job_taken", account: "Ann" } }),
  ]);
  const items = progressItems(list);
  assert.deepEqual(
    items.map((item) =>
      item.type === "reports"
        ? `${item.taskId}:${item.reports.map((r) => r.id).join(",")}`
        : `${item.type}:${item.report.id}`,
    ),
    ["notice:7", "task-2:6,5", "task-1:4", "need:3", "task-1:2,1"],
  );
  // Only the newest stop report of a task may show the live card or the receipt.
  const twice = newestFirst([
    report("old", at(1), { kind: "outcome", title: "Run failed" }),
    report("new", at(2), { kind: "outcome", title: "Needs your input" }),
    report("watch", at(3), { kind: "outcome", title: "Watch needs attention" }),
  ]);
  assert.deepEqual([...latestNeeds(twice)], ["new"]);
});

test("the page's days read 今天 / 昨天 / the date, newest first; tasks by their latest report", () => {
  const now = new Date(2026, 9, 19, 12, 0);
  const today = new Date(2026, 9, 19, 9, 0).toISOString();
  const yesterday = new Date(2026, 9, 18, 21, 0).toISOString();
  const earlier = new Date(2026, 9, 16, 8, 0).toISOString();
  assert.equal(dayOf(today, now)?.label, t.chat.day.today);
  assert.equal(dayOf(yesterday, now)?.label, t.chat.day.yesterday);
  assert.equal(dayOf(earlier, now)?.label, "10月16日");
  const list = newestFirst([
    report("a", earlier),
    report("b", yesterday, { taskId: "task-2", taskTitle: "发帖" }),
    report("c", today),
    report("d", new Date(2026, 9, 19, 10, 0).toISOString()),
  ]);
  const days = progressDays(list, now);
  assert.deepEqual(
    days.map((day) => [day.label, day.items.length]),
    [
      [t.chat.day.today, 1],
      [t.chat.day.yesterday, 1],
      ["10月16日", 1],
    ],
  );
  const tasks = progressByTask(list);
  assert.deepEqual(
    tasks.map((task) => [task.taskId, task.title, task.count]),
    [
      ["task-1", "每日巡检", 3],
      ["task-2", "发帖", 1],
    ],
  );
});

const task = (id: string, status: AgentTask["status"], extra: Partial<AgentTask> = {}) =>
  ({
    id,
    title: `任务 ${id}`,
    status,
    input: {},
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  }) as unknown as AgentTask;
const entry = (raw: AgentTask, now: number): TaskEntry => ({
  task: raw,
  phase: taskPhase(raw, { now, words: phaseWords }),
  environmentId: null,
});

test("正在做 lists what runs, queues or waits to go on, the most urgent first, once each", () => {
  const now = Date.parse(at(30));
  const entries = [
    entry(task("done", "succeeded"), now),
    entry(task("queued", "queued"), now),
    entry(task("running", "running"), now),
    entry(task("running", "running"), now),
    entry(task("asks", "waiting_input", { question: "哪个号？" }), now),
  ];
  const lines = progressNow(entries, now);
  // Only what runs spins: a queued task waits for its turn.
  assert.deepEqual(
    lines.map((line) => [line.entry.task.id, line.running]),
    [
      ["running", true],
      ["queued", false],
    ],
  );
  assert.ok(lines.every((line) => line.line));
  // The worker has no heartbeat: nothing moves, nothing spins.
  assert.deepEqual(
    progressNow(entries, now, true).map((line) => [line.entry.task.id, line.running]),
    [
      ["running", false],
      ["queued", false],
    ],
  );
  // As ShellData hands them over (taskEntries with the worker's state): the run's pill reads
  // 后台停着 and its line says where it stopped, never 运行中 / 正在运行 / the step it is doing.
  const raw = [
    task("steps", "running", {
      plan: [
        { id: "s1", title: "打开 Reddit", status: "succeeded" },
        { id: "s2", title: "找帖子", status: "running" },
      ],
    }),
    task("plain", "running"),
    task("queued", "queued"),
  ];
  const stalled = progressNow(taskEntries(raw, now, true), now, true);
  assert.deepEqual(
    stalled.map((line) => [line.entry.task.id, line.entry.phase.label, line.line, line.running]),
    [
      ["steps", "后台停着", "停在第 2/2 步 · 找帖子", false],
      ["plain", "后台停着", "", false],
      ["queued", "排队中", phaseWords.queued, false],
    ],
  );
  const alive = progressNow(taskEntries(raw, now, false), now, false);
  assert.deepEqual(
    alive.map((line) => [line.entry.phase.label, line.line, line.running]),
    [
      ["运行中", "找帖子", true],
      ["运行中", phaseWords.running, true],
      ["排队中", phaseWords.queued, false],
    ],
  );
});

test("ReportFeed reads the newest page, older pages on demand, and joins a gap after a while", async () => {
  const all = Array.from({ length: reportsPageSize + 30 }, (_, i) =>
    report(`r${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()),
  );
  const asked: string[] = [];
  let pool = all;
  const request: ReportsRequest = async (path) => {
    asked.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    const before = query.get("before");
    const sorted = [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const older = before ? sorted.filter((item) => item.createdAt < before) : sorted;
    return { reports: older.slice(-reportsPageSize) };
  };
  const feed = new ReportFeed("main", request);
  await feed.refresh();
  let state = feed.getState();
  assert.equal(state.loaded, true);
  assert.equal(state.reports.length, reportsPageSize);
  assert.equal(state.reports[0].id, all.at(-1)?.id, "newest first");
  assert.equal(state.exhausted, false);
  assert.match(asked[0], /threadId=main/);
  await feed.loadOlder();
  state = feed.getState();
  assert.equal(state.reports.length, all.length);
  assert.equal(state.exhausted, true);
  // After a long absence a whole page is newer than anything held: it reads back until it meets.
  const later = Array.from({ length: reportsPageSize + 5 }, (_, i) =>
    report(`n${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString()),
  );
  pool = [...all, ...later];
  await feed.refresh();
  assert.equal(feed.getState().reports.length, all.length + later.length);
  // Nothing new: the held list is kept as it is.
  const held = feed.getState().reports;
  assert.equal(mergeFeed(held, held.slice(0, 3)), held);
});

test("ReportFeed records what the page shows as seen, one batch at a time, with a backoff", async () => {
  const list = [
    report("a", at(1)),
    report("b", at(2), { readAt: at(3) }),
    report("c", at(4), { notice: { kind: "founder_request", account: "Ann" } }),
    report("d", at(5)),
  ];
  const sent: unknown[] = [];
  let fail = true;
  let clock = 1_000;
  const request: ReportsRequest = async (path, body) => {
    if (path === "/api/chat-reports/read") {
      sent.push(body);
      if (fail) throw new Error("429");
      const ids = (body as { ids: string[] }).ids;
      return { reports: ids.map((id) => ({ ...list.find((r) => r.id === id), readAt: at(9) })) };
    }
    return { reports: list };
  };
  const feed = new ReportFeed("main", request, () => clock);
  await feed.refresh();
  assert.equal(unreadCount(feed.getState().reports), 2);
  const main = () => "m9";
  // The founder's request is the hall chat's to record; what was read stays read.
  assert.deepEqual(feed.see(main), ["d", "a"]);
  assert.deepEqual(feed.see(main), [], "one request in flight");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ ids: ["d", "a"], afterMessageId: "m9" }]);
  // A failed batch waits for its backoff.
  assert.deepEqual(feed.see(main), []);
  clock += 10_000;
  fail = false;
  assert.deepEqual(feed.see(main), ["d", "a"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unreadCount(feed.getState().reports), 0);
  feed.unsee();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("ReportFeed records only what the tab lists; the rest stays new", async () => {
  const list = [
    report("plain", at(1)),
    report("failed", at(2), { kind: "outcome", title: "Run failed" }),
  ];
  const sent: { ids: string[] }[] = [];
  const request: ReportsRequest = async (path, body) => {
    if (path === "/api/chat-reports/read") {
      sent.push(body as { ids: string[] });
      const ids = (body as { ids: string[] }).ids;
      return { reports: ids.map((id) => ({ ...list.find((r) => r.id === id), readAt: at(9) })) };
    }
    return { reports: list };
  };
  const feed = new ReportFeed(null, request);
  await feed.refresh();
  // 要你看 shows the failure only.
  const attention = tabReports(feed.getState().reports, "attention").map((r) => r.id);
  assert.deepEqual(
    feed.see(() => "m1", attention),
    ["failed"],
  );
  await settle();
  assert.deepEqual(sent, [{ ids: ["failed"], afterMessageId: "m1" }]);
  assert.equal(unreadCount(feed.getState().reports), 1, "the plain report is still new");
  feed.unsee();
});

test("ReportFeed records each conversation's reports after its own last message", async () => {
  const list = [
    report("main-1", at(1)),
    report("side-1", at(2), { threadId: "side" }),
    report("away-1", at(3), { threadId: "away" }),
    report("gone-1", at(4), { threadId: "gone" }),
    report("busy-1", at(5), { threadId: "busy" }),
  ];
  const sent: unknown[] = [];
  const read: string[] = [];
  const request: ReportsRequest = async (path, body) => {
    if (path === "/api/chat-reports/read") {
      sent.push(body);
      const ids = (body as { ids: string[] }).ids;
      return { reports: ids.map((id) => ({ ...list.find((r) => r.id === id), readAt: at(9) })) };
    }
    if (path.startsWith("/api/copilotkit/threads/")) {
      read.push(path);
      if (path.includes("/gone/"))
        throw Object.assign(new Error("Thread not found"), { status: 404 });
      return {
        messages: [
          { id: "a-user", role: "user", content: "发一帖" },
          { id: "a-reply", role: "assistant", content: "好" },
          { id: "a-tool", role: "tool", content: "{}" },
        ],
      };
    }
    return { reports: list };
  };
  const feed = new ReportFeed(null, request);
  await feed.refresh();
  // main and side are on screen (settled), busy is on screen with a reply streaming; away and
  // gone are not shown on this page.
  const shown = new Map<string, string | null>([
    ["main", "m-last"],
    ["side", "s-last"],
    ["busy", null],
  ]);
  const anchorOf = (threadId: string) => shown.get(threadId);
  feed.see(anchorOf);
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(sent, [
    // Newest first: one conversation per request.
    { ids: ["gone-1"], afterMessageId: null },
    { ids: ["away-1"], afterMessageId: "a-reply" },
    { ids: ["side-1"], afterMessageId: "s-last" },
    { ids: ["main-1"], afterMessageId: "m-last" },
  ]);
  assert.deepEqual(read, [
    "/api/copilotkit/threads/gone/messages",
    "/api/copilotkit/threads/away/messages",
  ]);
  // The streaming conversation waits until it settles.
  assert.deepEqual(
    feed
      .getState()
      .reports.filter((r) => !r.readAt)
      .map((r) => r.id),
    ["busy-1"],
  );
  shown.set("busy", "b-last");
  assert.deepEqual(feed.see(anchorOf), ["busy-1"]);
  await settle();
  assert.deepEqual(sent.at(-1), { ids: ["busy-1"], afterMessageId: "b-last" });
  feed.unsee();
  // A conversation's last shown message: the person's or a reply, "" for none.
  assert.equal(lastShownMessage({ messages: [] }), "");
  assert.equal(lastShownMessage({ nope: true }), null);
});

test("ReportFeed's check reads the newest few and refreshes only when they changed", async () => {
  let list = [report("a", at(1)), report("b", at(2))];
  const asked: string[] = [];
  const request: ReportsRequest = async (path) => {
    asked.push(path);
    const limit = Number(new URLSearchParams(path.split("?")[1]).get("limit"));
    return { reports: list.slice(-limit) };
  };
  const feed = new ReportFeed(null, request);
  await feed.check();
  assert.equal(feed.getState().loaded, true, "the first check reads the newest page");
  assert.equal(asked.length, 1);
  await feed.check();
  assert.equal(asked.length, 2);
  assert.match(asked[1], new RegExp(`limit=${probeSize}$`));
  // A side chat's new report (the feed reads the whole project): the page reads again.
  list = [...list, report("c", at(3), { threadId: "side" })];
  await feed.check();
  assert.equal(asked.length, 4);
  assert.deepEqual(
    feed.getState().reports.map((r) => r.id),
    ["c", "b", "a"],
  );
  // One read elsewhere changes the newest few too.
  list = list.map((r) => (r.id === "b" ? { ...r, readAt: at(4) } : r));
  await feed.check();
  assert.equal(feed.getState().reports.find((r) => r.id === "b")?.readAt, at(4));
});

test("ReportFeed joins a gap into what is held now, and starts again when it cannot", async () => {
  const minute = (day: number, i: number) => new Date(Date.UTC(2026, 9, day, 0, i)).toISOString();
  const first = Array.from({ length: reportsPageSize + 30 }, (_, i) =>
    report(`r${String(i).padStart(4, "0")}`, minute(1, i)),
  );
  let pool = first;
  let gate: Promise<void> | null = null;
  const request: ReportsRequest = async (path, body) => {
    if (path === "/api/chat-reports/read") {
      const ids = (body as { ids: string[] }).ids;
      return { reports: ids.map((id) => ({ ...pool.find((r) => r.id === id), readAt: at(9) })) };
    }
    const query = new URLSearchParams(path.split("?")[1]);
    const before = query.get("before");
    // A gap page (before a report of the 2nd) waits while the test lands an older page and a
    // mark.
    if (before && gate && before >= minute(2, 0)) await gate;
    const sorted = [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const older = before ? sorted.filter((item) => item.createdAt < before) : sorted;
    return { reports: older.slice(-Number(query.get("limit"))) };
  };
  const feed = new ReportFeed(null, request);
  await feed.refresh();
  // A page and a half arrive while the page was away; the refresh reads back to join them.
  const later = Array.from({ length: reportsPageSize + 50 }, (_, i) =>
    report(`n${String(i).padStart(4, "0")}`, minute(2, i)),
  );
  pool = [...first, ...later];
  let open = () => {};
  gate = new Promise((resolve) => {
    open = resolve;
  });
  const refreshing = feed.refresh();
  await settle();
  // Meanwhile the person scrolls (an older page lands) and a report is recorded as seen.
  await feed.loadOlder();
  assert.equal(feed.getState().exhausted, true);
  feed.see(() => "m1", ["r0129"]);
  await settle();
  open();
  await refreshing;
  const state = feed.getState();
  assert.equal(state.reports.length, first.length + later.length, "nothing held was dropped");
  assert.equal(state.exhausted, true, "the older page's end stays known");
  assert.equal(state.reports.find((r) => r.id === "r0129")?.readAt, at(9), "the mark stays");
  feed.unsee();
  gate = null;
  // Far more than the gap pages while away: what lies between is unknown, so the list starts
  // again from the newest pages, and older ones load from there.
  const flood = Array.from({ length: reportsPageSize * 11 + 5 }, (_, i) =>
    report(`f${String(i).padStart(5, "0")}`, new Date(Date.UTC(2026, 9, 3, 0, 0, i)).toISOString()),
  );
  pool = [...pool, ...flood];
  await feed.refresh();
  const after = feed.getState();
  assert.equal(after.reports.length, reportsPageSize * 11);
  assert.equal(after.reports[0].id, flood.at(-1)?.id);
  assert.equal(after.exhausted, false, "older pages load from the newest pages read");
  assert.ok(!after.reports.some((r) => r.id.startsWith("n")), "no hole in the list");
});

test("ReportFeed's check reads the newest page again when a gap page failed", async () => {
  const minute = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  let pool = [report("a", minute(0))];
  let gapFails = false;
  const request: ReportsRequest = async (path) => {
    const query = new URLSearchParams(path.split("?")[1]);
    const before = query.get("before");
    if (before && gapFails) throw new Error("网络断了");
    const older = before ? pool.filter((item) => item.createdAt < before) : pool;
    return { reports: older.slice(-Number(query.get("limit"))) };
  };
  const feed = new ReportFeed(null, request);
  await feed.check();
  // More than a page arrives while away, and the read back to what is held fails.
  pool = [
    ...pool,
    ...Array.from({ length: reportsPageSize + 10 }, (_, i) =>
      report(`n${String(i).padStart(4, "0")}`, minute(i + 1)),
    ),
  ];
  gapFails = true;
  await feed.check();
  assert.match(feed.getState().error, /网络断了/);
  assert.equal(feed.getState().reports.length, 1, "the newest page waits for the gap");
  // The newest few are the same as on the failed read: the next check reads again all the same.
  gapFails = false;
  await feed.check();
  assert.equal(feed.getState().error, "");
  assert.equal(feed.getState().reports.length, reportsPageSize + 11);
});

test("a merged page never makes a read report new again", () => {
  const held = [report("a", at(1), { readAt: at(2), afterMessageId: "m1" })];
  const merged = mergeFeed(held, [report("a", at(1))]);
  assert.equal(merged, held, "nothing changed");
  const edited = mergeFeed(held, [report("a", at(1), { text: "改过" })]);
  assert.equal(edited[0].readAt, at(2));
  assert.equal(edited[0].text, "改过");
});

test("进度汇报 and 平台管理 live in the address; any other fragment is left alone", () => {
  assert.deepEqual(pageOfHash("#progress"), { progress: true });
  // The core knows no 平台管理 tab until the tenancy layer names them (tenancy/web/register-pages.ts).
  assert.equal(pageOfHash("#platform-codes"), null);
  registerShellPages(["pending", "codes", "exits", "spaces", "referrers", "system"]);
  assert.deepEqual(pageOfHash("#platform-codes"), { platform: "codes" });
  assert.equal(pageOfHash("#platform-nope"), null);
  // A password reset link's token is not a page.
  assert.equal(pageOfHash("#k3J9x-token"), null);
  assert.equal(hashOfPage({ platform: null, progress: true }), "#progress");
  assert.equal(hashOfPage({ platform: "spaces", progress: false }), "#platform-spaces");
  assert.equal(hashOfPage({ platform: null, progress: false }), "");
});

test("a page opening adds a history entry, so Back closes it; closing goes back over it", () => {
  assert.equal(hashMove("", "#progress", false), "push");
  // A fragment that is no page's stays in the entry behind.
  assert.equal(hashMove("#k3J9x-token", "#progress", false), "push");
  assert.equal(hashMove("#progress", "", true), "back");
  // Opened by the address (a bookmark, a typed address): what is behind it may be another site.
  assert.equal(hashMove("#progress", "", false), "replace");
  // A reload keeps the entry's mark: the entry the app pushed (by this load or one before) is
  // gone back over, so no dead entry is left for Back.
  assert.equal(pushedByApp({ openmusePage: "an-earlier-load" }), true);
  assert.equal(pushedByApp({ openmusePage: "this-load", other: 1 }), true);
  assert.equal(pushedByApp(null), false);
  assert.equal(pushedByApp({ other: 1 }), false);
  assert.equal(pushedByApp("openmusePage"), false);
  assert.equal(hashMove("#progress", "#platform-codes", true), "replace");
  assert.equal(hashMove("#platform-codes", "#platform-exits", true), "replace");
  assert.equal(hashMove("#progress", "#progress", true), null);
  assert.equal(hashMove("", "", false), null);
  assert.equal(hashMove("#k3J9x-token", "", false), null);
});

test("ReportFeed without a thread reads the whole project's reports, side chats' included", async () => {
  const asked: string[] = [];
  const request = async (path: string) => {
    asked.push(path);
    return {
      reports: [
        report("a", "2026-10-19T01:00:00.000Z"),
        report("b", "2026-10-19T02:00:00.000Z", { threadId: "side-1", taskTitle: "侧聊里派的活" }),
      ],
    };
  };
  const feed = new ReportFeed(null, request);
  await feed.refresh();
  assert.doesNotMatch(asked[0], /threadId=/, "no thread filter on the request");
  assert.deepEqual(
    feed.getState().reports.map((item) => item.id),
    ["b", "a"],
    "the side chat's report is kept, newest first",
  );
  // One conversation's feed still keeps only its own.
  const one = new ReportFeed("main", request);
  await one.refresh();
  assert.deepEqual(
    one.getState().reports.map((item) => item.id),
    ["a"],
  );
});
