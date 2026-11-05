// The pure logic of the chat's cards — report tone, quote
// blocks and link labels, which stop report shows the live need card / the receipt / a snapshot,
// the task card lines, the 操作账号 row, the answer box payload, tool results, the newest desktop
// call, the empty state and the chat model's project context.
import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptItem } from "../../../packages/client/src/chat-reports-core.ts";
import {
  answerPayload,
  chatModelContext,
  chatStatusLines,
  emptyStateKind,
  isWaitCard,
  latestNeedReportIds,
  linkLabel,
  mascotVariant,
  missingFieldsOf,
  modelTaskLimit,
  needReportPhase,
  needReportView,
  operatorState,
  plainPreview,
  quoteFold,
  receiptCovers,
  receiptForNeed,
  receiptLine,
  redirectView,
  reportCardView,
  reportClock,
  reportFold,
  reportLead,
  reportSource,
  reportTone,
  reviewCardView,
  reviewIsExpired,
  reviewLine,
  serverToolView,
  snapshotText,
  splitReportText,
  taskCardLines,
  taskNeedFor,
  taskResultsKey,
  toolResultRef,
  transcriptTurns,
  withoutWaitCards,
} from "../../../packages/client/src/shell/chat/core.ts";
import {
  groupTranscript,
  type NeedItem,
  needItems,
  needReportLabels,
  type TaskEntry,
  taskEntries,
} from "../../../packages/client/src/shell/model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import type { AgentTask, ChatReport } from "../../../packages/domain/src/agent.ts";
import { runEndedWithoutCompletionQuestion } from "../../../packages/domain/src/task-phase.ts";

const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number, dayOffset = 0) =>
  new Date(2026, 9, 10 + dayOffset, hours, minutes).toISOString();

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "AcmeGame Reddit推广",
    prompt: "p",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: at(12, 50),
    updatedAt: at(14, 0),
    attempts: 1,
    artifactIds: [],
    ...overrides,
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
    text: "x",
    links: [],
    createdAt: at(14, 10),
    readAt: null,
    afterMessageId: null,
    ...overrides,
  };
}
const entriesOf = (tasks: AgentTask[]) => taskEntries(tasks, now);
const entryOf = (overrides: Partial<AgentTask> = {}) => entriesOf([task(overrides)])[0];
const needsOf = (tasks: AgentTask[]): NeedItem[] =>
  needItems({ entries: entriesOf(tasks), actions: [], accounts: [] });
const step = (title: string, status: AgentTask["plan"][number]["status"]) => ({
  id: title,
  title,
  status,
});

// ───────────────────────────── reports ─────────────────────────────

test("report headers are coloured by their fixed label, never by a task title", () => {
  assert.equal(reportTone("Finished"), "green");
  assert.equal(reportTone("Run 3 finished"), "green");
  assert.equal(reportTone("Needs attention"), "red");
  assert.equal(reportTone("Run failed"), "red");
  assert.equal(reportTone("Paused after repeated failures"), "red");
  assert.equal(reportTone("Watch needs attention"), "red");
  assert.equal(reportTone("Needs your input"), "amber");
  assert.equal(reportTone("Ready for your review"), "amber");
  assert.equal(reportTone("Update"), "neutral");
  assert.equal(reportTone("Comment"), "neutral");
  assert.equal(reportTone("Plan v2"), "neutral");
  assert.equal(reportTone("Comment · over pace"), "neutral");
  assert.equal(reportTone("Finished · over pace"), "green");
  assert.equal(reportTone("Finished the review"), "neutral");
});

test("a report's '>' lines become one quote block; the prose around it stays", () => {
  assert.deepEqual(
    splitReportText(
      "在 r/IPhoneApps 回复 1 条。原文：\n> Been using AcmeGame for exactly this.\n> Disclosure: I'm on the team.\n\n下一条 20 分钟后。",
    ),
    [
      { kind: "text", text: "在 r/IPhoneApps 回复 1 条。原文：" },
      {
        kind: "quote",
        text: "Been using AcmeGame for exactly this.\nDisclosure: I'm on the team.",
      },
      { kind: "text", text: "下一条 20 分钟后。" },
    ],
  );
  assert.deepEqual(splitReportText("only prose\nline two"), [
    { kind: "text", text: "only prose\nline two" },
  ]);
  assert.deepEqual(splitReportText(">quoted"), [{ kind: "quote", text: "quoted" }]);
  assert.deepEqual(splitReportText(""), []);
  assert.deepEqual(splitReportText("\n\n"), []);
});

// A card is the title, the sentence for the person, the link and the posted
// text as a quote; long texts fold; the cards a wait wrote before are never shown.
test("a report card: the sentence, then the posted text quoted; legacy '>' lines quote too", () => {
  const view = reportCardView(
    report({
      text: "在 r/iosgaming 回复了一个找离线游戏的帖子。",
      posted: "  AcmeGame has been great for this.  ",
    }),
  );
  assert.equal(view.summary, "在 r/iosgaming 回复了一个找离线游戏的帖子。");
  assert.equal(view.lead, view.summary);
  assert.equal(view.more, false);
  assert.equal(view.quote, "AcmeGame has been great for this.");
  assert.equal(view.quoteLong, false);
  // A report written before `posted` existed quotes its '>' lines.
  const legacy = reportCardView(report({ text: "Commented on r/test\n> Great point, thanks!" }));
  assert.equal(legacy.summary, "Commented on r/test");
  assert.equal(legacy.quote, "Great point, thanks!");
  // A long text without a separate action part shows a cut, the rest folded.
  const wall =
    "Next run should: 1. Take a screenshot\n2. Click Comment\n3. Read the log\n4. Count\n5. Wait";
  assert.equal(reportCardView(report({ text: wall })).more, true);
  assert.equal(reportCardView(report({ text: "x".repeat(reportFold.chars + 1) })).more, true);
  assert.equal(
    reportCardView(report({ text: "s", posted: "p".repeat(quoteFold.chars + 1) })).quoteLong,
    true,
  );
  assert.equal(reportCardView(report({ text: "s", posted: "short" })).quoteLong, false);
});

test("a report card shows what was done by default; the run's working notes fold behind one tap", () => {
  // The owner's trim: the first paragraph is the action; whatever follows is folded, whatever
  // it says and whatever the site.
  const action = "在 example.org 的论坛回复了一个问题，[链接](https://example.org/t/1)。";
  const notes = [
    "已处理：1a2b, 3c4d, 5e6f",
    "今日剩余额度：评论 3 条",
    "下一轮：先看回复，再找新的问题。",
  ].join("\n");
  const view = reportCardView(
    report({ text: `${action}\n\n${notes}`, links: ["https://example.org/t/1"] }),
  );
  assert.equal(view.lead, action);
  assert.equal(view.leadPlain, false);
  assert.equal(view.more, true);
  for (const line of notes.split("\n")) assert.ok(!view.lead.includes(line), line);
  assert.ok(view.summary.includes(notes), "the whole text is one tap away");
  // Any later paragraph folds, in any language, with no word list.
  const english = reportCardView(report({ text: "Posted a reply.\n\nAnything else at all." }));
  assert.equal(english.lead, "Posted a reply.");
  assert.equal(english.more, true);
  // A heading alone is not the action: it joins the paragraph after it.
  const headed = reportCardView(report({ text: "## 汇报\n\n回复了一条。\n\n备注" }));
  assert.equal(headed.lead, "## 汇报\n\n回复了一条。");
  assert.equal(headed.more, true);
  // A long first paragraph is cut too.
  const long = reportCardView(report({ text: `${"做了一件事，".repeat(80)}\n\n备注` }));
  assert.equal(long.leadPlain, true);
  assert.ok(long.lead.endsWith("…"));
  assert.ok(long.lead.length <= reportFold.chars + 1);
  // One short paragraph: nothing to fold.
  assert.deepEqual(reportLead("回复了一条。"), { lead: "回复了一条。", plain: false, more: false });
});

test("a folded text previews plain lines, never raw markdown", () => {
  assert.equal(
    plainPreview(
      "## Done\n**Posted** 2 comments:\n- [r/a](https://x.y/a)\n- `r/b`\n\nmore\nand more",
    ),
    "Done\nPosted 2 comments:\n• r/a\n• r/b",
  );
  assert.equal(plainPreview("one\ntwo", 1), "one");
});

test("a long one-paragraph text folds to a shorter preview, cut by characters", () => {
  // Review round 3, blocking: plainPreview cut by lines only, so a 720-character summary
  // without line breaks showed whole, and 展开全文 / 收起 switched between the same text.
  const paragraph = "今天在 r/iosgaming 和 r/iphone 各回复了几个找离线游戏的帖子，".repeat(24);
  assert.ok(paragraph.length > 700 && !paragraph.includes("\n"));
  const preview = plainPreview(paragraph);
  assert.ok(preview.length <= reportFold.chars, String(preview.length));
  assert.ok(paragraph.startsWith(preview));
  // What the folded card renders: the cut with …, much shorter than the text.
  const view = reportCardView(report({ text: paragraph }));
  assert.equal(view.more, true);
  assert.equal(view.leadPlain, true);
  assert.ok(view.lead.endsWith("…"));
  assert.ok(view.lead.length <= reportFold.chars + 1);
  assert.ok(view.lead.length < view.summary.length);
  // Never half an emoji at the cut.
  const emoji = plainPreview("😀".repeat(200));
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji));
  // A fixed server text reads in Chinese on the card, as on the rail's 汇报 line.
  assert.equal(
    reportCardView(
      report({
        title: "Needs attention",
        text: "429 You exceeded your current quota, please check your plan and billing details.",
      }),
    ).summary,
    t.server.providerQuota,
  );
  // A short text is not folded.
  assert.equal(reportCardView(report({ text: "回复了一条。" })).more, false);
});

test("a report card's source line names the account once", () => {
  const account = { name: "Oak_Example_2" };
  assert.equal(
    reportSource("[Oak_Example_2] AcmeGame Reddit推广", account, false),
    "AcmeGame Reddit推广 · Oak_Example_2",
  );
  assert.equal(
    reportSource("AcmeGame Reddit推广", account, false),
    "AcmeGame Reddit推广 · Oak_Example_2",
  );
  // Another account's name in brackets is part of the title.
  assert.equal(reportSource("[Other] 推广", account, false), "[Other] 推广 · Oak_Example_2");
  assert.equal(reportSource("看看 r/IPhoneApps", null, true), "看看 r/IPhoneApps");
  assert.equal(reportSource("看看 r/IPhoneApps", null, false), "看看 r/IPhoneApps");
});

test("under a speaker line the source line never names the account again", () => {
  const ann = { name: "Founder_Ann" };
  // The account's own loop, old title or new: the speaker line says it all.
  assert.equal(reportSource("经营 · Founder_Ann", ann, false, "Founder_Ann"), "");
  assert.equal(reportSource("Founder_Ann 的日常运营", ann, false, "Founder_Ann"), "");
  // Another task of the account: its title only, without the 「[name] 」 the chat puts first.
  assert.equal(reportSource("[Founder_Ann] 推广仓库", ann, false, "Founder_Ann"), "推广仓库");
  assert.equal(reportSource("每日巡检", ann, false, "Founder_Ann"), "每日巡检");
  // The founder's copy speaking in another project (no account here): the same.
  assert.equal(reportSource("经营 · Founder_Ann", null, false, "Founder_Ann"), "");
  // No speaker (the default desktop): as before, an old loop title in the new words.
  assert.equal(reportSource("经营 · Nova", null, false), "Nova 的日常运营");
  for (const line of [
    reportSource("经营 · Founder_Ann", ann, false, "Founder_Ann"),
    reportSource("推广仓库", ann, false, "Founder_Ann"),
  ])
    assert.ok(!line.includes("Founder_Ann"), line);
});

test("the cards a wait wrote before are not shown; nothing else is hidden", () => {
  const waits = [
    report({ id: "w1", kind: "outcome", title: "Waiting 19 minutes" }),
    report({ id: "w2", kind: "outcome", title: "Waiting 1 minute" }),
    report({ id: "w3", kind: "outcome", title: "Waiting 30 minutes (pacing)" }),
  ];
  const kept = [
    report({ id: "k1", kind: "report", title: "Notice", text: "Waiting 19 minutes" }),
    report({ id: "k2", kind: "outcome", title: "Finished" }),
    report({ id: "k3", kind: "report", title: "Waiting 5 minutes" }),
    report({ id: "k4", kind: "outcome", title: "Needs your input" }),
  ];
  for (const item of waits) assert.equal(isWaitCard(item), true, item.title);
  assert.deepEqual(
    withoutWaitCards([...waits, ...kept]).map((item) => item.id),
    ["k1", "k2", "k3", "k4"],
  );
});

test("the redirect card reads the task's title and state word, never its id", () => {
  assert.deepEqual(
    redirectView(
      { taskId: "a".repeat(64), instruction: "别发帖" },
      JSON.stringify({ redirected: true, task: "推广 AcmeGame", state: "排队中" }),
    ),
    { taskId: "a".repeat(64), line: "推广 AcmeGame · 排队中", failed: false, reason: null },
  );
  // A known reason in Chinese; an unknown one is never shown in English.
  assert.deepEqual(redirectView({}, { error: "This task has ended; delegate a new one instead" }), {
    taskId: null,
    line: null,
    failed: true,
    reason: "这个任务已经结束，要做请重新派一个。",
  });
  assert.deepEqual(redirectView({}, { error: "Some new server sentence" }), {
    taskId: null,
    line: null,
    failed: true,
    reason: null,
  });
  // Only a result that confirms it is a success: a missing, unreadable or unknown result is not.
  for (const result of [
    undefined,
    "not json",
    {},
    { redirected: false },
    { task: "x", state: "y" },
  ])
    assert.deepEqual(redirectView(undefined, result), {
      taskId: null,
      line: null,
      failed: true,
      reason: null,
    });
});

test("links read without scheme, www or trailing slash; times as the Chinese clock", () => {
  assert.equal(
    linkLabel("https://www.reddit.com/r/iphoneapps/comments/1o2k7xq/comment/nj3f8a2/"),
    "reddit.com/r/iphoneapps/comments/1o2k7xq/comment/nj3f8a2",
  );
  assert.equal(linkLabel("http://example.com"), "example.com");
  assert.equal(reportClock(at(14, 10), now), "14:10");
  assert.equal(reportClock(at(9, 12, -1), now), "昨天 09:12");
  assert.equal(reportClock("nope", now), "nope");
});

// ───────────────────────────── need reports ─────────────────────────────

test("the stop labels map to the phase that is still waiting", () => {
  assert.deepEqual(Object.keys(needReportPhase).sort(), [...needReportLabels].sort());
  const needs = needsOf([
    task({ id: "q", status: "waiting_input", question: "AcmeGame 是什么？" }),
    task({ id: "f", status: "failed", error: "ECONNREFUSED", updatedAt: at(14, 41) }),
  ]);
  assert.equal(
    taskNeedFor(report({ taskId: "q", title: "Needs your input" }), needs)?.key,
    "task:q",
  );
  assert.equal(
    taskNeedFor(report({ taskId: "f", title: "Needs attention" }), needs)?.key,
    "task:f",
  );
  assert.equal(taskNeedFor(report({ taskId: "f", title: "Run failed" }), needs)?.key, "task:f");
  // The task stops for something else than the report says: no live card.
  assert.equal(taskNeedFor(report({ taskId: "q", title: "Needs attention" }), needs), null);
  assert.equal(taskNeedFor(report({ taskId: "f", title: "Update" }), needs), null);
  assert.equal(taskNeedFor(report({ taskId: "gone", title: "Needs your input" }), needs), null);
});

test("only the newest stop report of a task can ask; older ones are snapshots", () => {
  const first = report({ id: "a", title: "Needs your input", createdAt: at(13, 0) });
  const second = report({ id: "b", title: "Needs your input", createdAt: at(14, 0) });
  const other = report({ id: "c", taskId: "t2", title: "Needs attention", createdAt: at(13, 30) });
  assert.deepEqual([...latestNeedReportIds([second, other, first])].sort(), ["b", "c"]);
  const needs = needsOf([task({ status: "waiting_input", question: "q?" })]);
  assert.deepEqual(needReportView({ report: first, latest: false, needs, receipts: {} }), {
    kind: "snapshot",
  });
  const live = needReportView({ report: second, latest: true, needs, receipts: {} });
  assert.equal(live.kind, "card");
});

test("after acting the stop report shows the receipt, before it a snapshot", () => {
  const asked = report({ title: "Needs your input", createdAt: at(14, 0) });
  const receipt = { text: t.needs.receiptAnswered, at: at(14, 30) };
  // The task left 需要你 (answered, now running): the receipt replaces the card.
  assert.deepEqual(
    needReportView({ report: asked, latest: true, needs: [], receipts: { t1: receipt } }),
    { kind: "receipt", receipt },
  );
  // A receipt from before this question does not answer it.
  assert.deepEqual(
    needReportView({
      report: asked,
      latest: true,
      needs: [],
      receipts: { t1: { text: "x", at: at(13, 0) } },
    }),
    { kind: "snapshot" },
  );
  assert.deepEqual(needReportView({ report: asked, latest: true, needs: [], receipts: {} }), {
    kind: "snapshot",
  });
  assert.equal(receiptLine(receipt, now), `${t.needs.receiptAnswered} · 14:30`);
});

test("a need card collapses to its receipt once the person acted after it was raised", () => {
  const [item] = needsOf([task({ status: "failed", error: "boom", updatedAt: at(14, 41) })]);
  assert.equal(receiptForNeed(item, {}), null);
  assert.equal(receiptForNeed(item, { t1: { text: "r", at: at(14, 40) } }), null);
  assert.deepEqual(receiptForNeed(item, { t1: { text: "r", at: at(14, 42) } }), {
    text: "r",
    at: at(14, 42),
  });
  assert.equal(receiptCovers(undefined, at(1, 0)), false);
  assert.equal(receiptCovers({ text: "r", at: "bad" }, at(1, 0)), false);
  assert.equal(receiptCovers({ text: "r", at: at(1, 0) }, undefined), true);
  // The server's stamp wins over a client clock that runs ahead: a need raised again after the
  // act (server time 14:45) shows again although the device thought it acted at 14:50.
  const ahead = { text: "r", at: at(14, 50), since: at(14, 43) };
  assert.equal(receiptCovers(ahead, at(14, 41)), true);
  assert.equal(receiptCovers(ahead, at(14, 45)), false);
  const review: NeedItem = {
    kind: "account",
    key: "account:a",
    reason: "desktopError",
    flags: ["desktopError"],
    account: {} as never,
  };
  assert.equal(receiptForNeed(review, { t1: { text: "r", at: at(15, 0) } }), null);
});

test("stop reports stand alone in the transcript; the rest of a task's reports merge", () => {
  const items: TranscriptItem<{ id: string }>[] = [
    { type: "message", key: "m1", message: { id: "m1" } },
    { type: "report", key: "r-a", report: report({ id: "a", kind: "report", title: "Plan v1" }) },
    { type: "report", key: "r-b", report: report({ id: "b", kind: "report", title: "Comment" }) },
    {
      type: "report",
      key: "r-c",
      report: report({ id: "c", kind: "outcome", title: "Needs your input" }),
    },
    { type: "report", key: "r-d", report: report({ id: "d", kind: "report", title: "Reply" }) },
  ];
  assert.deepEqual(
    groupTranscript(items).map((item) =>
      item.type === "reports" ? `reports:${item.reports.map((r) => r.id).join("")}` : item.type,
    ),
    ["message", "reports:ab", "need", "reports:d"],
  );
});

// ───────────────────────────── task card ─────────────────────────────

test("the task card reads rhythm · step, and what it does now; no count of continuations", () => {
  const running = entryOf({
    status: "running",
    plan: [
      step("发帖", "succeeded"),
      step("找提问", "succeeded"),
      step("回复", "running"),
      step("等待", "pending"),
      step("汇报", "pending"),
    ],
    // The previous run's handoff (a wait note) is never the card's line (report line).
    state: { autoContinued: 1, lastUpdate: "Next run should: 1. Take a screenshot" },
  });
  assert.deepEqual(taskCardLines(running, now), {
    meta: "一次性 · 第 3/5 步",
    sub: "回复",
  });
  // An operating task (bound to an account): its steps never move, so no step at all.
  const operating = entryOf({
    status: "running",
    input: { environmentId: "env-1" },
    plan: [step("打开账号桌面", "running"), step("找帖子", "pending")],
  });
  // Its rhythm: it goes on until done or stopped, not 一次性 (fixer round 2, minor 7).
  assert.deepEqual(taskCardLines(operating, now), { meta: "持续进行", sub: "正在运行" });
  assert.equal(operating.phase.sub, "正在运行");
  // A finished task's line is empty: its finish sentence is the 完成 card's.
  const done = entryOf({
    status: "succeeded",
    result: "按你说的停了，今天发了 3 条评论。",
    plan: [step("回复", "succeeded")],
  });
  assert.deepEqual(taskCardLines(done, now), { meta: "一次性", sub: "" });
  const daily = entryOf({
    status: "scheduled",
    repeatMinutes: 1440,
    runs: 1,
    nextRunAt: at(10, 5, 1),
  });
  assert.deepEqual(taskCardLines(daily, now), {
    meta: "每天 · 已跑 1 轮",
    sub: "下次 明天 10:05",
  });
  const waiting = entryOf({
    status: "scheduled",
    nextRunAt: at(15, 0),
    state: { waits: 1, wait: { minutes: 20, note: "下一条", since: at(14, 40), until: at(15, 0) } },
  });
  assert.equal(taskCardLines(waiting, now).sub, "15:00 继续（还剩 13 分）");
  // No count of waits or continuations (report line).
  assert.equal(taskCardLines(waiting, now).meta, "一次性");
  const noPlan = entryOf({ status: "running", state: { lastUpdate: "Next run should: post" } });
  assert.equal(taskCardLines(noPlan, now).sub, "正在运行");
  // The server's default steps read in Chinese on the card and in the rail's phase line.
  const defaults = entryOf({
    status: "running",
    plan: [step("Understand the outcome", "running"), step("Plan the work", "pending")],
  });
  assert.equal(taskCardLines(defaults, now).sub, "弄清要的结果");
  assert.equal(defaults.phase.sub, "第 1/2 步 · 弄清要的结果");
  // The worker has no heartbeat: the run does nothing now, so the card never says the step it is
  // doing (its meta still says where it is).
  const [stalled] = taskEntries([running.task], now, true);
  assert.deepEqual(taskCardLines(stalled, now), {
    meta: "一次性 · 第 3/5 步",
    sub: t.progress.stalled,
  });
});

// ───────────────────────────── composer ─────────────────────────────

test("the 操作账号 row: none, loading, failed, hidden, an account, stale when it left", () => {
  const byId = new Map([["a1", { name: "Oak_Example_2", light: "blue" as const }]]);
  const env = { environment: null, loading: false, stale: false, unavailable: false, error: "" };
  const loaded = { byId, loaded: true };
  assert.equal(operatorState({ ...env, unavailable: true }, loaded).hidden, true);
  assert.equal(operatorState(env, loaded).label, t.composer.operatorNone);
  assert.equal(operatorState({ ...env, loading: true }, loaded).label, t.composer.operatorLoading);
  assert.equal(operatorState({ ...env, loading: true, error: "x" }, loaded).failed, true);
  const picked = operatorState({ ...env, environment: { id: "a1", name: "old name" } }, loaded);
  assert.deepEqual(
    { label: picked.label, stale: picked.stale, light: picked.light, id: picked.accountId },
    { label: "操作账号：Oak_Example_2", stale: false, light: "blue", id: "a1" },
  );
  // Moved to another project (not among this project's accounts) or deleted: stale, red.
  const moved = operatorState({ ...env, environment: { id: "a9", name: "Moved" } }, loaded);
  assert.equal(moved.stale, true);
  assert.equal(moved.label, "操作账号：Moved");
  assert.equal(moved.light, null);
  // While the accounts are still loading, an unknown account is not called stale yet.
  assert.equal(
    operatorState({ ...env, environment: { id: "a9", name: "Moved" } }, { byId, loaded: false })
      .stale,
    false,
  );
  assert.equal(
    operatorState({ ...env, stale: true, environment: { id: "a1", name: "x" } }, loaded).stale,
    true,
  );
});

// ───────────────────────────── answer box ─────────────────────────────

test("missingFields become inputs; the answer always carries text", () => {
  const fields = missingFieldsOf({
    state: {
      missingFields: [
        "product_link",
        { name: "consent", type: "checkbox" },
        { name: "product_link" },
        { nope: 1 },
        "",
      ],
    },
  });
  assert.deepEqual(fields, [
    { name: "product_link", label: "product link", checkbox: false },
    { name: "consent", label: "consent", checkbox: true },
  ]);
  assert.deepEqual(missingFieldsOf({ state: {} }), []);
  assert.equal(answerPayload("  ", {}, []), null);
  assert.deepEqual(answerPayload(" 是离线翻译 App ", {}, []), { answer: "是离线翻译 App" });
  assert.deepEqual(answerPayload("", { product_link: " https://x " }, fields), {
    answer: t.needs.fieldsAnswer,
    fields: { product_link: "https://x" },
  });
  assert.equal(answerPayload("", { consent: false }, fields), null);
  assert.deepEqual(answerPayload("ok", { consent: true, product_link: "" }, fields), {
    answer: "ok",
    fields: { consent: true },
  });
});

test("an upstream review asked first reads its title and when it expires", () => {
  const duration = (ms: number) => `${Math.round(ms / 60000)} 分`;
  const asked = (expiresAt: string) => ({ title: "回复邮件", expiresAt, askFirst: true });
  assert.equal(reviewLine(asked(at(15, 12)), now, duration), "回复邮件 · 25 分后过期");
  assert.equal(reviewLine(asked(at(14, 0)), now, duration), "回复邮件 · 已过期，没有执行");
  assert.equal(reviewLine(asked(""), now, duration), "回复邮件");
  // The row already shows the title: the line is only when it expires, never the title twice.
  assert.equal(reviewLine(asked(at(14, 0)), now, duration, "回复邮件"), "已过期，没有执行");
  assert.equal(reviewLine(asked(at(15, 12)), now, duration, "回复邮件"), "25 分后过期");
  assert.equal(
    reviewLine(asked(at(14, 0)), now, duration, "跟进客户"),
    "回复邮件 · 已过期，没有执行",
  );
});

test("a chat-started review has no expiry; a draft says so; buttons follow the card", () => {
  const duration = (ms: number) => `${Math.round(ms / 60000)} 分`;
  const chat = { title: "回复邮件", expiresAt: "9999-12-31T00:00:00.000Z", noExpiry: true };
  assert.equal(reviewLine(chat, now, duration), "等你决定");
  assert.equal(reviewLine({ ...chat, draft: true }, now, duration), "草稿，等你发送");
  assert.equal(reviewIsExpired({ status: "awaiting_review", ...chat }, now), false);
  const base = { status: "awaiting_review", expiresAt: at(15, 12) };
  assert.deepEqual(
    (({ approve, always, deny, tag }) => ({ approve, always, deny, tag }))(
      reviewCardView(base, now),
    ),
    { approve: "允许一次", always: "总是允许", deny: "拒绝", tag: null },
  );
  const draft = { ...base, draft: true };
  assert.deepEqual(
    (({ approve, always, deny, tag }) => ({ approve, always, deny, tag }))(
      reviewCardView(draft, now),
    ),
    { approve: "发送", always: "总是允许", deny: "不发", tag: "草稿" },
  );
  // A routine's draft has no 总是允许.
  assert.equal(reviewCardView({ ...draft, fromRoutine: true }, now).always, null);
  // Expired: no decision, 总是允许 still offered, and the card says nothing was run.
  const expired = reviewCardView({ status: "expired", expiresAt: at(14, 0) }, now);
  assert.deepEqual(
    {
      approve: expired.approve,
      deny: expired.deny,
      always: expired.always,
      line: expired.expiredLine,
    },
    { approve: null, deny: null, always: "总是允许", line: "已过期，没有执行" },
  );
});

test("a review asked first past its expiry can no longer be decided, even before the sweep marks it; one not asked first never expires", () => {
  assert.equal(reviewIsExpired({ status: "expired", expiresAt: at(15, 12) }, now), true);
  assert.equal(
    reviewIsExpired({ status: "awaiting_review", expiresAt: at(14, 0), askFirst: true }, now),
    true,
  );
  assert.equal(
    reviewIsExpired({ status: "awaiting_review", expiresAt: at(15, 12), askFirst: true }, now),
    false,
  );
  assert.equal(reviewIsExpired({ status: "awaiting_review", expiresAt: at(14, 0) }, now), true);
  assert.equal(reviewIsExpired({ status: "succeeded", expiresAt: at(14, 0) }, now), false);
});

test("the 立即继续 answer and the stop phases come from the shared table", () => {
  const [spent] = needsOf([
    task({ status: "waiting_input", question: runEndedWithoutCompletionQuestion }),
  ]);
  assert.equal(spent.kind === "task" && spent.entry.phase.reason, "unfinished");
  assert.ok(t.needs.continueAnswer.length > 0);
  // Nothing here offers an approval of a Reddit action: the only review is the upstream one.
  const all = JSON.stringify({
    chat: t.chat,
    needs: t.needs,
    tools: t.tools,
    files: t.files,
    desktop: t.desktop,
  });
  for (const banned of ["批准发帖", "确认发帖", "同意发布", "节奏", "汇报给我"])
    assert.ok(!all.includes(banned), banned);
});

// ───────────────────────────── tools ─────────────────────────────

test("tool results are read defensively", () => {
  assert.deepEqual(toolResultRef('{"id":"t9"}'), { id: "t9", error: null });
  assert.deepEqual(toolResultRef({ taskId: "t8" }), { id: "t8", error: null });
  assert.deepEqual(toolResultRef('{"error":"no"}'), { id: null, error: "no" });
  assert.deepEqual(toolResultRef("not json"), { id: null, error: null });
  assert.deepEqual(toolResultRef(undefined), { id: null, error: null });
  assert.deepEqual(serverToolView("remember_fact"), { title: "记忆", section: "notes" });
  assert.deepEqual(serverToolView("watch_page"), { title: "网页监控", section: "tasks" });
  assert.equal(serverToolView("agent_status").section, "tasks");
});

test("a task card's results hang on its artifacts and its browser session", () => {
  // Nothing produced: no results block and no read of the task detail.
  assert.equal(taskResultsKey({ artifactIds: [], state: {} }), "");
  assert.equal(taskResultsKey({ artifactIds: [], state: { browserId: "", sessionId: 3 } }), "");
  // A task that only browsed (read_web sets state.browserId, no artifact) still has results:
  // the server's task detail finds its browser card through state.browserId / sessionId.
  const browsed = taskResultsKey({ artifactIds: [], state: { browserId: "b-1" } });
  assert.notEqual(browsed, "");
  assert.notEqual(taskResultsKey({ artifactIds: [], state: { sessionId: "s-1" } }), "");
  // The key changes with a new result, not on every poll of the same task.
  assert.equal(taskResultsKey({ artifactIds: [], state: { browserId: "b-1", step: 4 } }), browsed);
  assert.notEqual(taskResultsKey({ artifactIds: [], state: { browserId: "b-2" } }), browsed);
  const withFile = taskResultsKey({ artifactIds: ["f-1"], state: { browserId: "b-1" } });
  assert.notEqual(withFile, browsed);
  assert.notEqual(taskResultsKey({ artifactIds: ["f-1"], state: {} }), withFile);
  // The same session under both names is one session.
  assert.equal(
    taskResultsKey({ artifactIds: [], state: { browserId: "b-1", sessionId: "b-1" } }),
    browsed,
  );
});

test("the empty state is per project: 未分组, no accounts, ready", () => {
  assert.equal(emptyStateKind(null, 3), "default");
  assert.equal(emptyStateKind("p1", 0), "noAccounts");
  assert.equal(emptyStateKind("p1", 2), "ready");
  // Only a goal: the prefill and the copy never ask for pacing, communities, voice or reporting.
  for (const text of [
    t.empty.prefillText,
    t.empty.prefillSuggestion,
    t.chat.placeholder(t.group.hallOps),
  ])
    for (const banned of ["节奏", "间隔", "选区", "口径", "汇报", "分钟"])
      assert.ok(!text.includes(banned), `${text} ${banned}`);
});

// ───────────────────────────── model context ─────────────────────────────

test("the chat model sees the project, its accounts and at most 20 tasks", () => {
  const entries: TaskEntry[] = entriesOf([
    task({ id: "done", status: "succeeded", updatedAt: at(10, 0), input: {} }),
    task({ id: "run", status: "running", input: { environmentId: "a1" } }),
    task({ id: "ask", status: "waiting_input", question: "?", input: { environmentId: "gone" } }),
  ]);
  const accounts = [
    {
      id: "a1",
      name: "Oak_Example_2",
      desktop: "running" as const,
      now: { entry: entries[1], more: 0 },
    },
    { id: "a2", name: "Nova_Harrison", desktop: "stopped" as const, now: null },
  ];
  const context = chatModelContext({ projectName: "acmegame", accounts, entries });
  assert.deepEqual(context, {
    project: "acmegame",
    accounts: [
      { name: "Oak_Example_2", desktop: "running", now: "run" },
      { name: "Nova_Harrison", desktop: "stopped", now: null },
    ],
    tasks: [
      { id: "ask", title: "AcmeGame Reddit推广", phase: "input", account: "gone" },
      { id: "run", title: "AcmeGame Reddit推广", phase: "run", account: "Oak_Example_2" },
      { id: "done", title: "AcmeGame Reddit推广", phase: "done", account: null },
    ],
  });
  const many = entriesOf(
    Array.from({ length: 30 }, (_, index) => task({ id: `t${index}`, status: "queued" })),
  );
  assert.equal(
    chatModelContext({ projectName: "p", accounts: [], entries: many }).tasks.length,
    modelTaskLimit,
  );
  // Stable: the context holds phase keys, not relative times, so it only changes with the state.
  assert.ok(!JSON.stringify(context).includes("还剩"));
});

test("a report that mentions billing is shown as written; only 出问题 is a failure", () => {
  // Fixer round 2, blocking 1: a promotion task for a SaaS product writes about billing.
  const text =
    "在 r/stripe 回复了一个关于 billing 的帖子，讲 insufficient_quota 这类报错怎么处理。";
  assert.equal(reportCardView(report({ title: "Comment", text })).summary, text);
  assert.equal(
    reportCardView(report({ title: "Needs attention", text: "429 insufficient_quota" })).summary,
    t.server.providerQuota,
  );
});

test("an older 出问题 snapshot reads like the live card, never the provider's raw error", () => {
  const raw = "429 You exceeded your current quota, please check your plan and billing details.";
  const failed = report({ title: "Needs attention", text: raw });
  assert.equal(snapshotText(failed), reportCardView(failed).summary);
  assert.equal(snapshotText(failed), t.server.providerQuota);
  assert.equal(
    snapshotText(report({ title: "Needs your input", text: runEndedWithoutCompletionQuestion })),
    t.server.lines[runEndedWithoutCompletionQuestion],
  );
});

// The chat is a conversation with OpenMuse the capybara.
test("an assistant message is the capybara speaking; an owner message is not", () => {
  const turns = transcriptTurns([
    { type: "message", message: { role: "user", content: "推一下 AcmeGame" } },
    { type: "message", message: { role: "assistant", content: "好的" } },
  ]);
  assert.deepEqual(turns, [
    { speaker: "owner", avatar: false },
    { speaker: "assistant", avatar: true },
  ]);
});

test("reports and needs-you items are said by the capybara, sharing one avatar in a run", () => {
  const turns = transcriptTurns([
    { type: "message", message: { role: "assistant", content: "记下了" } },
    { type: "reports" },
    { type: "need" },
    { type: "message", message: { role: "user", content: "继续" } },
    { type: "reports" },
  ]);
  assert.deepEqual(
    turns.map((turn) => [turn.speaker, turn.avatar]),
    [
      ["assistant", true],
      ["assistant", false],
      ["assistant", false],
      ["owner", false],
      ["assistant", true],
    ],
  );
});

test("an assistant message with nothing to show is silent and does not take the avatar", () => {
  const turns = transcriptTurns([
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", content: "" } },
    { type: "message", message: { role: "assistant", content: "", toolCalls: [{ id: "1" }] } },
  ]);
  assert.deepEqual(turns, [
    { speaker: "owner", avatar: false },
    { speaker: "silent", avatar: false },
    { speaker: "assistant", avatar: true },
  ]);
});

test("the capybara keeps the stored avatar colour, sky when there is none", () => {
  assert.equal(mascotVariant("lilac"), "lilac");
  assert.equal(mascotVariant("sand"), "sand");
  assert.equal(mascotVariant(undefined), "sky");
  assert.equal(mascotVariant("purple"), "sky");
});

test("the conversation's status lines: only what runs now or is stuck; a waiting task's time is on its card", () => {
  const running = task({
    id: "run",
    title: "推广仓库",
    status: "running",
    originThreadId: "side",
    plan: [
      { id: "0", title: "启动桌面，确认登录状态", status: "running" },
      { id: "1", title: "发帖", status: "pending" },
    ],
  });
  // An account's loop (from no conversation) waiting for its next run: when it goes on is on
  // its task card and in the live panel, so no line says it a third time.
  const waiting = task({
    id: "wait",
    title: "经营 · Nova",
    status: "scheduled",
    nextRunAt: at(23, 30),
  });
  const queued = task({ id: "queue", status: "queued" });
  const failed = task({ id: "fail", status: "failed", error: "桌面没响应" });
  const asking = task({ id: "ask", status: "waiting_input", question: "用哪个号？" });
  const ended = task({ id: "done", status: "succeeded", originThreadId: "side" });
  const elsewhere = task({ id: "other", status: "running", originThreadId: "another" });
  const entries = entriesOf([running, waiting, queued, failed, asking, ended, elsewhere]);
  // The side chat: its own running task, with a spinner and the step it is on.
  const side = chatStatusLines(entries, "side", "main", now, false);
  assert.deepEqual(
    side.map((line) => [line.taskId, line.running]),
    [["run", true]],
  );
  assert.ok(side[0].text.includes("推广仓库"));
  // The main chat: the stuck ones (where) and the queued one (排队中, no spinner: it does not
  // run yet); not the waiting loop.
  const main = chatStatusLines(entries, "main", "main", now, false);
  assert.deepEqual(main.map((line) => [line.taskId, line.running]).sort(), [
    ["ask", false],
    ["fail", false],
    ["queue", false],
  ]);
  const queuedLine = main.find((line) => line.taskId === "queue")?.text ?? "";
  assert.ok(!queuedLine.includes("正在做") && queuedLine.includes("排队中"), queuedLine);
  // With no worker heartbeat the running task does not spin or say 正在做: nothing moves.
  const stalled = chatStatusLines(entries, "side", "main", now, true);
  assert.deepEqual(
    stalled.map((line) => [line.taskId, line.running]),
    [["run", false]],
  );
  assert.ok(!stalled[0].text.includes("正在做") && stalled[0].text.includes(t.progress.stalled));
  assert.ok(!main.some((line) => line.text.includes("23:30")));
  assert.ok(main.find((line) => line.taskId === "ask")?.text.includes("用哪个号"));
  // A conversation with nothing reporting to it shows nothing.
  assert.deepEqual(chatStatusLines(entries, "quiet", "main", now, false), []);
  // The same task listed twice, or two tasks that read the same, make one line.
  const loopA = task({ id: "loop-a", title: "Nova_Harrison 的日常运营", status: "queued" });
  const loopB = task({ id: "loop-b", title: "Nova_Harrison 的日常运营", status: "queued" });
  const twice = chatStatusLines(entriesOf([loopA, loopA, loopB]), "main", "main", now, false);
  assert.equal(twice.length, 1);
});
