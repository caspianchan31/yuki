// The live rail's pure helpers (shell/rail/rail-model.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import {
  accountsTableShape,
  accountsTableWidth,
  layoutMode,
} from "../../../packages/client/src/shell/layout-core.ts";
import {
  type AccountView,
  buildAccountModels,
  flagLabel,
  taskEntries,
} from "../../../packages/client/src/shell/model.ts";
import {
  accountRowFlags,
  accountTableColumnWidths,
  accountTableMins,
  accountTableMinWidth,
  briefStatus,
  focusOffset,
  hasUnread,
  nowLine,
  railAccountRow,
  railTaskState,
  regionLines,
  reportLine,
  reportTone,
  sideChatCount,
  sideChatNote,
  stackedRegionLine,
  taskButtons,
} from "../../../packages/client/src/shell/rail/rail-model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import type { AgentTask, ChatReport } from "../../../packages/domain/src/agent.ts";
import { runEndedWithoutCompletionQuestion } from "../../../packages/domain/src/task-phase.ts";

const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number, dayOffset = 0) =>
  new Date(2026, 9, 10 + dayOffset, hours, minutes).toISOString();

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "任务",
    prompt: "p",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: at(12, 0),
    updatedAt: at(14, 0),
    attempts: 1,
    artifactIds: [],
    ...overrides,
  };
}
function account(overrides: Record<string, unknown> = {}, _pacing?: unknown): AccountView {
  const settings = {
    timezone: "America/Los_Angeles",
    locale: "en-US",
    updatedAt: null,
    ...((overrides.settings as object) ?? {}),
  };
  return {
    ...normalizeEnvironment({
      id: "a1",
      name: "Oak_Example_2",
      accountLabel: "u/Oak_Example_2",
      projectId: "p1",
      status: "running",
      ...overrides,
      settings,
    }),
  };
}
function report(overrides: Partial<ChatReport> = {}): ChatReport {
  return {
    id: "r1",
    taskId: "t1",
    taskTitle: "AcmeGame Reddit推广",
    threadId: "main",
    kind: "report",
    title: "Update",
    text: "回复 r/IPhoneApps\n> Been using AcmeGame for exactly…",
    links: ["https://reddit.com/r/iphoneapps/comments/x"],
    createdAt: at(14, 10),
    readAt: "2026-10-10T06:11:00.000Z",
    ...overrides,
  };
}
const entriesOf = (tasks: AgentTask[]) => taskEntries(tasks, now);
const models = (accounts: AccountView[], tasks: AgentTask[] = []) =>
  buildAccountModels({ accounts, entries: entriesOf(tasks), now });

test("account row: flags (never a two-tasks flag), 此刻 +n", () => {
  const [row] = models(
    [account()],
    [
      task({ id: "r1", title: "AcmeGame Reddit推广", input: { environmentId: "a1" } }),
      task({ id: "r2", title: "第二个", input: { environmentId: "a1" } }),
    ],
  );
  // Two running tasks on one account: no flag (decision 4).
  assert.deepEqual(accountRowFlags(row), []);
  const now1 = nowLine(row);
  assert.equal(now1?.entry.phase.label, "运行中");
  assert.equal(now1?.more, "+1");

  const [idle] = models([account({ id: "a9" })]);
  assert.equal(nowLine(idle), null);
  // The account's own row does not name it twice (the chat's 「[account] 」 title prefix).
  const [own] = models(
    [account({ id: "a1" })],
    [task({ id: "p1", title: "[a1name] AcmeGame Reddit推广", input: { environmentId: "a1" } })],
  );
  assert.equal(nowLine({ ...own, name: "a1name" })?.title, "AcmeGame Reddit推广");

  const [broken] = models([account({ id: "e", status: "error" })]);
  assert.deepEqual(
    accountRowFlags(broken).map((flag) => [flag.label, flag.tone]),
    [["桌面出错", "red"]],
  );
});

test("an account whose task the infrastructure keeps stopping shows the fact, not a silent loop", () => {
  // Review round 3: a hung desktop or a long provider outage retried every minute with nothing
  // shown. The task's open incident is the row's fact, grey (it retries by itself), and never
  // a need.
  const incident = { kind: "model", since: at(13, 2) };
  const [row] = models(
    [account({ id: "a1" })],
    [
      task({
        id: "s1",
        status: "scheduled",
        nextRunAt: at(14, 48),
        input: { environmentId: "a1" },
        state: { incident },
      }),
    ],
  );
  assert.deepEqual(row.incident, incident);
  assert.deepEqual(
    accountRowFlags(row).map((flag) => [flag.label, flag.tone]),
    [[t.incidents.flag(t.incidents.kinds.model), "grey"]],
  );
  // The task's own line says it too, with when it began and when it tries again.
  const sub = row.tasks[0].phase.sub;
  for (const part of [t.incidents.kinds.model, "13:02", "14:48"])
    assert.ok(sub.includes(part), part);
  assert.equal(row.tasks[0].phase.needsYou, false);
  // The desktop: in its words.
  const [desktop] = models(
    [account({ id: "a2" })],
    [
      task({
        id: "s2",
        status: "scheduled",
        nextRunAt: at(14, 48),
        input: { environmentId: "a2" },
        state: { incident: { kind: "desktop", since: at(13, 2) } },
      }),
    ],
  );
  assert.equal(accountRowFlags(desktop)[0].label, t.incidents.flag(t.incidents.kinds.desktop));
  // Over: no flag.
  const [over] = models(
    [account({ id: "a3" })],
    [
      task({
        id: "s3",
        status: "scheduled",
        nextRunAt: at(14, 48),
        input: { environmentId: "a3" },
        state: { incident: { ...incident, reportedAt: at(13, 5), resolvedAt: at(14, 0) } },
      }),
    ],
  );
  assert.equal(over.incident, null);
  assert.deepEqual(accountRowFlags(over), []);
  // A run that works normally again: the record still has the incident (the server ends it
  // after the run), but the row shows no flag while it runs.
  const [running] = models(
    [account({ id: "a4" })],
    [task({ id: "s4", status: "running", input: { environmentId: "a4" }, state: { incident } })],
  );
  assert.equal(running.incident, null);
  assert.deepEqual(accountRowFlags(running), []);
});

test("report rows: time, Chinese label, tone, first line, link", () => {
  const line = reportLine(report(), now);
  assert.deepEqual(line, {
    id: "r1",
    taskId: "t1",
    clock: "14:10",
    label: "进展",
    tone: "neutral",
    text: "回复 r/IPhoneApps",
    hasLink: true,
    unconfirmed: "",
  });
  // An action report the server recorded without
  // the item's own address says so on the pane's row too, not only on the card.
  const missing = reportLine(
    report({
      text: "在论坛发好了一条。",
      links: [],
      action: { site: "forum.example", action: "post" },
      evidence: "missing",
    }),
    now,
  );
  assert.equal(missing.unconfirmed, t.reportCard.unconfirmed);
  assert.equal(missing.unconfirmed, "未确认：没有这条内容自己的链接");
  assert.equal(missing.hasLink, false);
  const yesterday = reportLine(
    report({ title: "Finished", createdAt: at(22, 5, -1), links: [], text: "  \n" }),
    now,
  );
  assert.equal(yesterday.clock, "昨天 22:05");
  assert.equal(yesterday.tone, "green");
  assert.equal(yesterday.text, "AcmeGame Reddit推广");
  assert.equal(yesterday.hasLink, false);

  assert.equal(reportTone("Run 3 finished"), "green");
  assert.equal(reportTone("Needs attention"), "red");
  assert.equal(reportTone("Run failed"), "red");
  assert.equal(reportTone("Paused after repeated failures"), "red");
  assert.equal(reportTone("Watch needs attention"), "red");
  assert.equal(reportTone("Needs your input"), "amber");
  assert.equal(reportTone("Ready for your review"), "amber");
  assert.equal(reportTone("Comment"), "neutral");
  assert.equal(reportTone("Comment · over pace"), "neutral");
  assert.equal(reportTone("Plan v2"), "neutral");
  assert.equal(reportTone("计划 v1"), "neutral");
  assert.equal(reportLine(report({ title: "Comment · over pace" }), now).label, "评论 · 超出节奏");
  assert.equal(reportLine(report({ title: "Plan v2" }), now).label, "计划第 2 版");
  // The same Chinese words as the card: a fixed server text, a provider's quota answer.
  assert.equal(
    reportLine(
      report({
        title: "Needs attention",
        text: "429 You exceeded your current quota, please check your plan and billing details.",
      }),
      now,
    ).text,
    "模型服务的余额或额度用完了：需要你到模型服务商那里充值或调整套餐，然后点「重试」。",
  );
  assert.equal(
    reportLine(report({ title: "Needs your input", text: runEndedWithoutCompletionQuestion }), now)
      .text,
    t.server.lines[runEndedWithoutCompletionQuestion],
  );
  // The summary sentence is the row's text; the posted text stays in the card.
  assert.equal(
    reportLine(report({ text: "在 r/test 回复了一条。", posted: "Thanks, that helped!" }), now)
      .text,
    "在 r/test 回复了一条。",
  );
});

test("在侧聊 only for side chats with rich threads on; unread is a dot, not a count", () => {
  const main = { id: "main", enabled: true };
  const names = new Map<string, string | null>([
    ["side1", "r/LocalLLM 回复"],
    ["side2", null],
  ]);
  assert.equal(sideChatNote(report(), main, names), null);
  assert.equal(sideChatNote(report({ threadId: "side1" }), main, names), "在侧聊：r/LocalLLM 回复");
  assert.equal(sideChatNote(report({ threadId: "side2" }), main, names), "在侧聊：未命名对话");
  assert.equal(sideChatNote(report({ threadId: "gone" }), main, names), "在侧聊：未命名对话");
  assert.equal(
    sideChatNote(report({ threadId: "side1" }), { id: "main", enabled: false }, names),
    null,
  );
  assert.equal(
    sideChatNote(report({ threadId: "side1" }), { id: "local", enabled: true }, names),
    null,
  );

  assert.equal(hasUnread([report(), report({ readAt: null })]), true);
  assert.equal(hasUnread([report()]), false);
  assert.equal(hasUnread([]), false);

  assert.equal(
    sideChatCount(
      [
        { id: "main", archived: false },
        { id: "s1", archived: false },
        { id: "s2", archived: true },
        { id: "s3", archived: false },
      ],
      "main",
    ),
    2,
  );
});

test("task row buttons: 立即继续 inside a wait records the skip; 改间隔 opens the task", () => {
  const wait = { minutes: 20, note: "已评论 1/3", since: at(14, 40), until: at(15, 0) };
  const [waiting, scheduled, running, paused, failed, asked, done, queued, once] = entriesOf([
    task({ status: "scheduled", nextRunAt: wait.until, state: { wait } }),
    task({ status: "scheduled", repeatMinutes: 1440, nextRunAt: at(10, 5, 1), runs: 1 }),
    task({ status: "running" }),
    task({ status: "paused" }),
    task({ status: "failed", updatedAt: at(14, 41) }),
    task({ status: "waiting_input", question: "?" }),
    task({ status: "succeeded", updatedAt: at(14, 0) }),
    task({ status: "queued" }),
    task({ status: "scheduled", nextRunAt: at(14, 48) }),
  ]);
  // A one-off task scheduled again has no interval to change and nothing to stop repeating.
  assert.deepEqual(taskButtons(once), [
    { kind: "control", op: "run", label: "立即运行", inWait: false },
  ]);
  assert.deepEqual(taskButtons(waiting), [
    { kind: "control", op: "run", label: "立即继续", inWait: true },
    { kind: "control", op: "pause", label: "暂停", inWait: false },
  ]);
  assert.deepEqual(taskButtons(waiting, true), [
    { kind: "control", op: "run", label: "立即继续", inWait: true },
  ]);
  assert.deepEqual(taskButtons(scheduled), [
    { kind: "control", op: "run", label: "立即运行", inWait: false },
    { kind: "panel", op: "interval", label: "改间隔" },
    { kind: "repeat", op: "stopRepeat", label: "停止重复" },
  ]);
  assert.deepEqual(
    taskButtons(running).map((button) => button.label),
    ["暂停"],
  );
  assert.deepEqual(
    taskButtons(paused).map((button) => button.label),
    ["恢复"],
  );
  assert.deepEqual(
    taskButtons(failed).map((button) => button.label),
    ["重试"],
  );
  // Questions are answered on the need card; nothing to press on an ended or queued task.
  assert.deepEqual(taskButtons(asked), []);
  assert.deepEqual(taskButtons(done), []);
  assert.deepEqual(taskButtons(queued), []);
});

test("the rail scrolls to a laid-out section; 需要你 hidden means the top", () => {
  const offsets = {
    needs: { y: 0, height: 0 },
    accounts: { y: 0, height: 220 },
    tasks: { y: 220, height: 300 },
  };
  assert.equal(focusOffset("needs", offsets), 0);
  assert.equal(focusOffset("tasks", offsets), 220);
  assert.equal(focusOffset("reports", offsets), null);
  assert.equal(focusOffset("needs", {}), 0);
  assert.equal(focusOffset("accounts", { accounts: { y: 0, height: 0 } }), 0);
});

test("project brief status: saved and updated time", () => {
  assert.equal(briefStatus(at(14, 46), true, now), "已保存 · 更新于 14:46");
  assert.equal(briefStatus(at(14, 46), false, now), "更新于 14:46");
  assert.equal(briefStatus(null, true, now), "已保存");
  assert.equal(briefStatus(null, false, now), "");
});

test("rail strings: no wait note (it is the run's own handoff), nothing that asks for pacing", () => {
  assert.ok(!("waitNote" in t.tasksRail));
  const all = JSON.stringify(t, (_, value) =>
    typeof value === "function" ? String(value) : value,
  );
  for (const banned of ["发完汇报", "每发一条汇报给我", "间隔 20 分钟发", "审批", "批准"])
    assert.ok(!all.includes(banned), banned);
});

test("the accounts table: 地区 from 1100, the actions give way to a docked detail", () => {
  // Every column at its least width, the gaps and the row padding: a table never spills.
  // Tablet and below: the prototype's grid with the actions (a table from about 900 px).
  assert.equal(accountTableMinWidth(), 866);
  assert.equal(accountTableMinWidth({ region: false, act: true }), 866);
  // Desktop: + 地区 (110 + gap).
  assert.equal(accountTableMinWidth({ region: true, act: true }), 986);
  // Beside the docked detail: no 详情 / 分配到… column, and the tight columns.
  assert.equal(accountTableMinWidth({ region: true, act: false }), 706);
  assert.equal(accountTableMins({ region: true, act: true }), accountTableColumnWidths.roomy);
  assert.equal(accountTableMins({ region: true, act: false }), accountTableColumnWidths.tight);
  // The meta column keeps its full width beside the detail.
  assert.equal(accountTableColumnWidths.tight.meta, accountTableColumnWidths.roomy.meta);
});

test("the desktop accounts page keeps the 地区 column from 1100, detail docked or not", () => {
  // A classic scrollbar takes up to 17 px of the page's row.
  const scrollbar = 17;
  for (const width of [1100, 1200, 1255, 1271, 1280, 1440, 1920]) {
    const mode = layoutMode(width);
    assert.equal(mode, "desktop");
    // The detail docked (an account selected): 地区 and no actions column.
    const docked = accountsTableShape(mode, true);
    assert.deepEqual(docked, { region: true, act: false });
    assert.ok(
      accountsTableWidth(width, true) - scrollbar >= accountTableMinWidth(docked),
      `${width} docked: ${accountsTableWidth(width, true)}`,
    );
    // No detail: 地区 and the actions column.
    const full = accountsTableShape(mode, false);
    assert.deepEqual(full, { region: true, act: true });
    assert.ok(
      accountsTableWidth(width, false) - scrollbar >= accountTableMinWidth(full),
      `${width} full`,
    );
  }
  // The page's row: the window less the 340 px detail and its border, at most 1040, less 2 × 14.
  assert.equal(accountsTableWidth(1100, true), 1100 - 341 - 28);
  assert.equal(accountsTableWidth(1200, true), 1200 - 341 - 28);
  assert.equal(accountsTableWidth(1100, false), 1040 - 28);
  // Tablet: no 地区, the actions stay (the detail is a card there).
  assert.deepEqual(accountsTableShape(layoutMode(1000), false), { region: false, act: true });
});

test("a stacked accounts row keeps 地区 as a line of its own on desktop", () => {
  const docked = { region: true, act: false };
  assert.equal(
    stackedRegionLine({ locale: "en-US", timezone: "America/Los_Angeles" }, docked),
    "en-US · America/Los_Angeles",
  );
  assert.equal(
    stackedRegionLine({ locale: null, timezone: "Europe/London" }, docked),
    `${t.accountDetail.notSet} · Europe/London`,
  );
  assert.equal(stackedRegionLine({ locale: null, timezone: null }, docked), t.accountDetail.notSet);
  // Below 1100 the page has no 地区.
  assert.equal(
    stackedRegionLine(
      { locale: "en-US", timezone: "America/Los_Angeles" },
      { region: false, act: true },
    ),
    null,
  );
});

test("地区 is the account's locale over its time zone; 没设 where unset", () => {
  assert.deepEqual(regionLines({ locale: "en-US", timezone: "America/Los_Angeles" }), [
    "en-US",
    "America/Los_Angeles",
  ]);
  assert.deepEqual(regionLines({ locale: null, timezone: "Europe/London" }), [
    t.accountDetail.notSet,
    "Europe/London",
  ]);
  assert.deepEqual(regionLines({ locale: null, timezone: null }), [t.accountDetail.notSet]);
});

test("the rail's 汇报 line shows a report that mentions billing as written", () => {
  // Fixer round 2, blocking 1.
  const text = "在 r/stripe 回复了一个关于 billing 的帖子。";
  assert.equal(reportLine(report({ title: "Comment", text }), now).text, text);
});

test("the rail's account row: name, a problem to see, 此刻 and 下次; the rest is in the detail", () => {
  const [row] = models(
    [account({ id: "a1" }, { settings: {}, effective: {}, status: {} })],
    [
      task({ id: "r1", title: "推广", input: { environmentId: "a1" } }),
      task({
        id: "w1",
        title: "另一件事",
        status: "scheduled",
        nextRunAt: at(15, 0),
        state: { wait: { until: at(15, 0), note: "已处理 a, b, c；剩余 3 条" } },
        input: { environmentId: "a1" },
      }),
    ],
  );
  const shown = railAccountRow(row);
  assert.deepEqual(Object.keys(shown).sort(), ["flags", "name", "next", "now"]);
  assert.equal(shown.name, "Oak_Example_2");
  assert.equal(shown.now?.title, "推广");
  assert.match(shown.next ?? "", /15:00/);
  assert.deepEqual(shown.flags, []);
  // No share count, no region, no pacing counters, no desktop state, no report.
  const text = JSON.stringify({ ...shown, now: shown.now?.title });
  for (const hidden of ["共用", "跨", "en-US", "今日", "桌面", "已处理"])
    assert.ok(!text.includes(hidden), hidden);
  // A problem the owner must see stays on the row.
  const [broken] = models([account({ id: "e", status: "error" })]);
  assert.deepEqual(
    railAccountRow(broken).flags.map((flag) => flag.label),
    [t.flags.desktopError],
  );
  // The per-site sign-in line is in the account's
  // detail, never on the rail's row; a site fact only the owner can act on is a flag there.
  const signedIn = railAccountRow({ ...row, login: "example.com 已登录" } as typeof row);
  assert.deepEqual(Object.keys(signedIn).sort(), ["flags", "name", "next", "now"]);
  assert.ok(!JSON.stringify({ ...signedIn, now: null }).includes("已登录"));
  assert.deepEqual(
    railAccountRow({ ...row, flags: ["site:wrong_password:example.com"] }).flags.map((flag) => [
      flag.label,
      flag.tone,
    ]),
    [[flagLabel("site:wrong_password:example.com"), "red"]],
  );
  // 下次 is when, nothing more: no rhythm in brackets for a repeating task (the owner's trim).
  const [repeats] = models(
    [account({ id: "a5" })],
    [
      task({
        id: "rep",
        status: "scheduled",
        repeatMinutes: 120,
        runs: 3,
        nextRunAt: at(16, 0),
        input: { environmentId: "a5" },
      }),
    ],
  );
  const next = railAccountRow(repeats).next ?? "";
  assert.ok(next.includes("16:00"), next);
  assert.doesNotMatch(next, /[（()）]|每|小时|分钟/);
});

test("the rail's task card: one state line, never what a run wrote, no counters, no 节奏 mark", () => {
  const line = (overrides: Partial<AgentTask>) => {
    const [entry] = entriesOf([task(overrides)]);
    const state = railTaskState(entry, now);
    return [state.label, state.detail].filter(Boolean).join(t.common.sep);
  };
  const tomorrow = at(0, 0, 1);
  const inWait: Partial<AgentTask> = {
    status: "scheduled",
    nextRunAt: tomorrow,
    state: {
      lastUpdate: "已回复 3 条，剩余额度 2 条，下一轮先看回复",
      wait: { until: tomorrow, note: "已处理 id1, id2；下一轮继续", pacing: true },
      waits: 4,
    },
  };
  const waiting = line(inWait);
  // The phase's label, then when it goes on: what the run wrote never shows.
  const label = (overrides: Partial<AgentTask>) => entriesOf([task(overrides)])[0].phase.label;
  assert.ok(waiting.startsWith(label(inWait)), waiting);
  assert.ok(waiting.includes("00:00"), waiting);
  const repeating = line({
    status: "scheduled",
    repeatMinutes: 1440,
    runs: 6,
    nextRunAt: at(15, 0),
  });
  assert.ok(repeating.includes("15:00"), repeating);
  // A paused task is its state alone, also when it was paused inside a wait.
  const paused = line({ status: "paused" });
  const pausedInWait = line({
    status: "paused",
    nextRunAt: at(15, 0),
    state: { wait: { until: at(15, 0), note: "下一轮继续" } },
  });
  assert.equal(paused, label({ status: "paused" }));
  assert.equal(pausedInWait, paused);
  for (const shown of [waiting, repeating, paused, pausedInWait]) {
    assert.ok(!shown.includes("\n"), shown);
    assert.doesNotMatch(shown, /节奏|已跑|已等|还剩|已处理|额度|\d+ 轮|\d+ 次/);
  }
  assert.equal(line({ status: "running" }), label({ status: "running" }));
  // An open incident is the state while it waits.
  assert.match(
    line({
      status: "scheduled",
      nextRunAt: at(15, 0),
      state: { incident: { kind: "desktop", since: at(13, 2) } },
    }),
    /桌面/,
  );
});

test("while the worker has no heartbeat a run reads 后台停着 on the task row and the account row", () => {
  const raw = [
    task({
      id: "r",
      status: "running",
      input: { environmentId: "a1" },
      plan: [{ id: "s1", title: "找帖子", status: "running" }],
    }),
  ];
  const [entry] = taskEntries(raw, now, true);
  assert.deepEqual(railTaskState(entry, now).label, t.members.stalled);
  assert.notEqual(railTaskState(entry, now).label, entriesOf(raw)[0].phase.label);
  // The account's 此刻 (its pill on 账号 and on the phone's rows) is the same entry.
  const [row] = buildAccountModels({
    accounts: [account()],
    entries: taskEntries(raw, now, true),
    now,
  });
  assert.equal(row.now?.entry.phase.label, t.members.stalled);
  assert.equal(row.now?.entry.phase.tone, "grey");
  // Its light is not the blue one (「在跑或排队中」) either.
  assert.equal(row.light, "grey");
  assert.equal(models([account()], raw)[0].light, "blue");
  // A queued task still reads 排队中: it does not claim to move either way.
  const [queued] = taskEntries([task({ status: "queued" })], now, true);
  assert.equal(railTaskState(queued, now).label, "排队中");
});
