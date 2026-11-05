// The task unit's pure parts — task detail view model,
// the fallback new-task form, settings.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import {
  type AccountView,
  buildAccountModels,
  needItems,
  normalizePacing,
  operatingPlanOf,
  type TaskEntry,
  taskEntries,
} from "../../../packages/client/src/shell/model.ts";
import {
  failureText,
  phaseWords,
  serverText,
  t,
  taskRhythm,
} from "../../../packages/client/src/shell/strings.ts";
import {
  accountLine,
  detailActions,
  detailEntry,
  firstLines,
  mergeReports,
  middleBlocks,
  needsForTask,
  normalizeTaskDetail,
  operatingPlanBlock,
  planBlock,
  receiptLine,
  reportLines,
  reportTone,
  rhythmLine,
  rulesHint,
  shortLink,
  taskMenu,
  timelineEvent,
  timelineLines,
} from "../../../packages/client/src/shell/task/detail-core.ts";
import {
  checkNewTask,
  initialAccount,
  promptMax,
  readInterval,
  submissionFor,
} from "../../../packages/client/src/shell/task/new-task-core.ts";
import {
  checkPassword,
  clockSeconds,
  identityPayload,
  passwordErrorText,
  showsChatUpdates,
  workerLine,
} from "../../../packages/client/src/shell/task/settings-core.ts";
import type {
  AgentIdentity,
  AgentTask,
  ChatReport,
  RunEvent,
} from "../../../packages/domain/src/agent.ts";
import {
  runEndedWithoutCompletionQuestion,
  taskPhaseWordsZh,
} from "../../../packages/domain/src/task-phase.ts";

const now = new Date(2026, 9, 10, 14, 47).getTime();
const at = (hours: number, minutes: number, dayOffset = 0, seconds = 0) =>
  new Date(2026, 9, 10 + dayOffset, hours, minutes, seconds).toISOString();

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "AcmeSkills 评论三连",
    prompt: "用 Pine_Example_3 推广 AcmeSkills",
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
const entryOf = (value: AgentTask): TaskEntry => taskEntries([value], now)[0];
function account(overrides: Record<string, unknown> = {}): AccountView {
  return {
    ...normalizeEnvironment({
      id: "a1",
      name: "Pine_Example_3",
      accountLabel: "u/Pine_Example_3",
      projectId: "p1",
      status: "running",
      proxyConfigured: true,
      settings: {
        proxy: { configured: true, preview: "http://•••@203.0.113.105:5890" },
        timezone: "America/Los_Angeles",
        locale: "en-US",
        updatedAt: null,
        unreadable: false,
      },
      ...overrides,
    }),
    pacing: normalizePacing(undefined),
  };
}
function report(overrides: Partial<ChatReport> = {}): ChatReport {
  return {
    id: "r1",
    taskId: "t1",
    taskTitle: "AcmeSkills 评论三连",
    threadId: "main",
    kind: "report",
    title: "Update",
    text: "评论 r/aivideo\n原文：…",
    links: [],
    createdAt: at(14, 39),
    readAt: null,
    ...overrides,
  };
}
function event(id: string, date: string, title: string, detail = ""): RunEvent {
  return { id, taskId: "t1", date, kind: "step", title, detail };
}
const waiting = (extra: Record<string, unknown> = {}) =>
  task({
    status: "scheduled",
    nextRunAt: at(15, 0),
    state: {
      waits: 1,
      wait: {
        minutes: 20,
        note: "已评论 1/3（r/aivideo）。15:00 去 r/StableDiffusion 发下一条。",
        since: at(14, 40),
        until: at(15, 0),
      },
      ...extra,
    },
  });

// ───────────────────────────── task detail ─────────────────────────────

test("节奏 line: rhythm and runs; no count of waits or continuations (neither has a limit)", () => {
  assert.equal(rhythmLine(waiting()), "一次性");
  assert.equal(
    rhythmLine(task({ repeatMinutes: 1440, runs: 4, status: "scheduled" })),
    "每天 · 已跑 4 轮",
  );
  assert.equal(rhythmLine(task({ state: { autoContinued: 2, waits: 850 } })), "一次性");
  // A malformed run count reads as 0.
  assert.equal(
    rhythmLine(task({ repeatMinutes: 60, runs: -2 as unknown as number })),
    "每小时 · 已跑 0 轮",
  );
});

test("任务规则 caption: 聊天代拟 for the chat's tasks, 你写的 only for the 新任务 form", () => {
  assert.equal(rulesHint(task({ originThreadId: "thread-1" })), t.taskDetail.rulesHint);
  assert.ok(t.taskDetail.rulesHint.startsWith("聊天代拟"));
  assert.equal(rulesHint(task({ typedByOwner: true })), t.taskDetail.rulesHintTyped);
  assert.ok(t.taskDetail.rulesHintTyped.startsWith("你写的"));
  // Anything else (a goal plan, an idea, a task from before either was recorded) claims no
  // author: the chat's older tasks were shown as 你写的.
  assert.equal(rulesHint(task()), null);
  assert.equal(rulesHint(task({ originThreadId: null })), null);
});

test("⋯ menu follows the server's rules for repeating and cancelling", () => {
  const ops = (value: AgentTask) => taskMenu(value).map((item) => `${item.op}:${item.label}`);
  assert.deepEqual(ops(task({ status: "scheduled", repeatMinutes: 60 })), [
    "interval:改间隔",
    "stopRepeat:停止重复",
    "cancel:取消任务",
  ]);
  assert.deepEqual(ops(task()), ["interval:改成重复", "cancel:取消任务"]);
  assert.deepEqual(ops(task({ status: "succeeded" })), ["interval:改成重复"]);
  assert.deepEqual(ops(task({ status: "failed" })), ["interval:改成重复"]);
  assert.deepEqual(ops(task({ status: "cancelled", repeatMinutes: 60 })), []);
  assert.deepEqual(ops(task({ kind: "document" })), ["cancel:取消任务"]);
});

test("the phase's own buttons; none while the need card carries them", () => {
  const labels = (value: AgentTask, need = false) =>
    detailActions(entryOf(value).phase, need, !!value.repeatMinutes).map((item) => item.label);
  assert.deepEqual(labels(waiting()), ["立即继续", "暂停"]);
  assert.deepEqual(labels(task()), ["暂停"]);
  assert.deepEqual(labels(task({ status: "scheduled", repeatMinutes: 60, nextRunAt: at(15, 0) })), [
    "立即运行",
    "改间隔",
    "停止重复",
  ]);
  // A one-off task scheduled again (the infrastructure stopped its run) has no interval.
  assert.deepEqual(labels(task({ status: "scheduled", nextRunAt: at(15, 0) })), ["立即运行"]);
  assert.deepEqual(labels(task({ status: "paused" })), ["恢复"]);
  assert.deepEqual(labels(task({ status: "failed", error: "boom", updatedAt: at(14, 41) })), [
    "重试",
  ]);
  assert.deepEqual(
    labels(task({ status: "failed", error: "boom", updatedAt: at(14, 41) }), true),
    [],
  );
  assert.deepEqual(labels(task({ status: "queued" })), []);
  assert.deepEqual(labels(task({ status: "succeeded" })), []);
});

test("need items of one task: its own stop and a proposal that belongs to it", () => {
  const asking = task({ id: "t1", status: "waiting_input", question: "AcmeGame 是什么？" });
  const other = task({ id: "t2", status: "failed", error: "x", updatedAt: at(14, 0) });
  const entries = taskEntries([asking, other], now);
  const needs = needItems({
    entries,
    actions: [
      {
        id: "act1",
        title: "回复邮件",
        status: "awaiting_review",
        taskId: "t1",
      } as unknown as Parameters<typeof needItems>[0]["actions"][number],
    ],
    accounts: [],
  });
  assert.deepEqual(
    needsForTask(needs, "t1").map((item) => item.key),
    ["task:t1", "review:act1"],
  );
  assert.deepEqual(
    needsForTask(needs, "t2").map((item) => item.key),
    ["task:t2"],
  );
  assert.deepEqual(needsForTask(needs, "t3"), []);
});

test("middle block by phase", () => {
  const blocks = (value: AgentTask, hasNeed = false) => {
    const entry = entryOf(value);
    return middleBlocks(value, entry.phase, hasNeed, now);
  };
  // When it goes on, never the AI's wait note (its handoff to its next run).
  assert.deepEqual(blocks(waiting()), {
    need: false,
    blocks: [{ title: "等待", body: "15:00 继续（还剩 13 分）", tone: "normal" }],
  });
  assert.ok(!JSON.stringify(blocks(waiting())).includes("r/StableDiffusion"));
  // An operating task's steps never move: 现在在做 is the phase's line.
  assert.equal(
    blocks(
      task({
        input: { environmentId: "env-1" },
        plan: [{ id: "s1", title: "打开账号桌面", status: "running" }],
      }),
    ).blocks[0].body,
    "正在运行",
  );
  // A provider's quota answer reads in Chinese.
  assert.equal(
    blocks(
      task({
        status: "failed",
        error:
          "429 You exceeded your current quota, please check your plan and billing details.\n第二行",
        updatedAt: at(14, 41),
      }),
      true,
    ).blocks[0].body,
    `${t.server.providerQuota}\n第二行`,
  );
  // 现在在做 is the run's step, never the previous run's handoff.
  assert.equal(
    blocks(task({ state: { lastUpdate: "Next run should: 1. Take a screenshot" } })).blocks[0].body,
    "正在运行",
  );
  assert.equal(
    blocks(
      task({
        plan: [
          { id: "s1", title: "打开 Reddit", status: "succeeded" },
          { id: "s2", title: "找帖子", status: "running" },
        ],
      }),
    ).blocks[0].body,
    "找帖子",
  );
  assert.equal(
    blocks(task({ status: "scheduled", repeatMinutes: 1440, nextRunAt: at(10, 5, 1) })).blocks[0]
      .body,
    "每天跑一次。下次 明天 10:05。",
  );
  assert.equal(
    blocks(task({ status: "scheduled", nextRunAt: at(16, 30) })).blocks[0].body,
    "下次 16:30 运行。",
  );
  // A finished run's summary with the server's not-confirmed line
  // (service.ts markUnconfirmed) shows that line first, in Chinese, never the raw mark.
  const unconfirmedResult = blocks(
    task({
      status: "succeeded",
      result: "已成功发布\n[not confirmed: no address of the item itself]",
    }),
  ).blocks[0];
  assert.equal(unconfirmedResult.body, `${t.reportCard.unconfirmed}\n已成功发布`);
  assert.equal(blocks(task({ status: "succeeded", result: "已发布" })).blocks[0].body, "已发布");
  // The task's own line (cards, rows) starts from that line too.
  assert.equal(
    entryOf(
      task({
        status: "succeeded",
        result: "已成功发布\n[not confirmed: no address of the item itself]",
      }),
    ).phase.sub,
    t.reportCard.unconfirmed,
  );
  // A wait paused part-way: 原定 15:00 恢复.
  const pausedInWait = waiting();
  pausedInWait.status = "paused";
  assert.equal(blocks(pausedInWait).blocks[0].body, "原定 15:00 恢复。点「恢复」后照原计划继续。");
  assert.equal(blocks(task({ status: "paused" })).blocks[0].body, "点「恢复」后继续。");
  // Questions, reviews and recent failures: the need card; the full error only when it says more.
  const asking = task({ status: "waiting_input", question: "AcmeGame 是什么？" });
  assert.deepEqual(blocks(asking, true), { need: true, blocks: [] });
  assert.equal(blocks(asking, false).blocks[0].body, "AcmeGame 是什么？");
  const failedShort = task({ status: "failed", error: "ECONNREFUSED", updatedAt: at(14, 41) });
  assert.deepEqual(blocks(failedShort, true), { need: true, blocks: [] });
  const failedLong = task({
    status: "failed",
    error: "桌面连不上代理出口 203.0.113.105:5890\n（ECONNREFUSED），重试 3 次仍失败",
    updatedAt: at(14, 41),
  });
  assert.deepEqual(blocks(failedLong, true).blocks, [
    {
      title: "错误",
      body: "桌面连不上代理出口 203.0.113.105:5890\n（ECONNREFUSED），重试 3 次仍失败",
      tone: "error",
    },
  ]);
  // Failed more than 7 days ago: no need card, the error block and 重试 in the buttons.
  const old = task({ status: "failed", error: "boom", updatedAt: at(9, 0, -9) });
  assert.deepEqual(blocks(old, false), {
    need: false,
    blocks: [{ title: "错误", body: "boom", tone: "error" }],
  });
  assert.deepEqual(
    blocks(task({ status: "succeeded", result: "发了 3 条评论\n\n链接见汇报" })).blocks,
    [{ title: "结果", body: "发了 3 条评论\n链接见汇报", tone: "normal" }],
  );
  assert.deepEqual(blocks(task({ status: "cancelled" })).blocks, []);
  assert.deepEqual(blocks(task({ status: "queued" })).blocks, []);
});

test("first lines of a result", () => {
  assert.equal(firstLines("a\n\nb\nc", 2), "a\nb\n…");
  assert.equal(firstLines("  only  "), "only");
  assert.equal(firstLines(undefined), "");
});

test("账号 line: bound account, default desktop (a marker, not a block), loading, gone", () => {
  const models = buildAccountModels({
    accounts: [account()],
    entries: [],
    now,
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  const ready = { loading: false, count: 1 };
  assert.deepEqual(accountLine(null, byId, ready), { kind: "default" });
  const bound = accountLine("a1", byId, ready);
  assert.equal(bound.kind, "account");
  assert.equal(bound.kind === "account" && bound.account.exit, "203.0.113.105:5890");
  assert.deepEqual(accountLine("a9", new Map(), { loading: true, count: 0 }), {
    kind: "loading",
  });
  assert.deepEqual(accountLine("a9", byId, ready), { kind: "gone", environmentId: "a9" });
});

test("计划 n/m with ✓ and ← 当前", () => {
  const value = task({
    plan: [
      { id: "s1", title: "打开 Reddit", status: "succeeded" },
      { id: "s2", title: "找帖子", status: "running" },
      { id: "s3", title: "发评论", status: "pending" },
      { id: "s4", title: "汇报", status: "pending" },
    ],
  });
  const block = planBlock(value, false);
  assert.equal(block?.label, "计划 2/4");
  assert.deepEqual(
    block?.lines.map((line) => [line.text, line.state]),
    [
      ["打开 Reddit ✓", "done"],
      ["找帖子 ← 当前", "current"],
      ["发评论", "todo"],
      ["汇报", "todo"],
    ],
  );
  assert.equal(
    planBlock(value, true)?.lines.some((line) => line.state === "current"),
    false,
  );
  assert.equal(planBlock(task(), false), null);
  // An operating task: 计划 with its steps, no count and no 「← 当前」 (they never move).
  const operating = planBlock({ ...value, input: { environmentId: "env-1" } }, false);
  assert.equal(operating?.label, "计划");
  assert.deepEqual(
    operating?.lines.map((line) => [line.text, line.state]),
    [
      ["打开 Reddit ✓", "done"],
      ["找帖子", "todo"],
      ["发评论", "todo"],
      ["汇报", "todo"],
    ],
  );
  // The server's default steps of an account's task are not its plan (fixer round 2, minor 8).
  const filler = [
    "Understand the outcome",
    "Plan the work",
    "Use connected tools",
    "Return a result",
  ];
  const defaults = filler.map((title, index) => ({
    id: `d${index}`,
    title,
    status: "pending" as const,
  }));
  assert.equal(planBlock(task({ plan: defaults, input: { environmentId: "env-1" } }), true), null);
  assert.equal(planBlock(task({ plan: defaults }), false)?.lines.length, 4);
});

test("节奏: an account's task that does not repeat goes on, it is not 一次性", () => {
  // Fixer round 2, minor 7: 「一直做到我叫停」 read 「一次性」.
  assert.equal(rhythmLine(task({ input: { environmentId: "env-1" } })), "持续进行");
  assert.equal(rhythmLine(task()), "一次性");
  assert.equal(taskRhythm({ repeatMinutes: 1440, input: { environmentId: "env-1" } }), "每天");
});

test("运营计划 v{n}: 选区 one per line, empty parts left out, 拟定于", () => {
  const plan = operatingPlanOf(
    task({
      state: {
        operatingPlan: {
          version: 2,
          setAt: at(12, 51),
          communities: [
            { name: "r/LocalLLaMA", why: "离线模型讨论多", rule: "一帖" },
            { name: "r/IPhoneApps", why: "", rule: "只回复相关提问" },
            "r/LocalLLM",
          ],
          forms: "以回复为主，一帖",
          voice: "以开发团队成员身份出现",
          pace: "间隔 30 分钟、每天 5 条评论（AI 定）",
          review: "",
          horizon: "一周",
        },
      },
    }),
  );
  assert.deepEqual(operatingPlanBlock(plan, now), {
    title: "运营计划第 2 版",
    rows: [
      {
        label: "选区",
        lines: [
          "r/LocalLLaMA — 离线模型讨论多 · 一帖",
          "r/IPhoneApps — 只回复相关提问",
          "r/LocalLLM",
        ],
      },
      { label: "内容形式", lines: ["以回复为主，一帖"] },
      { label: "口径", lines: ["以开发团队成员身份出现"] },
      { label: "节奏", lines: ["间隔 30 分钟、每天 5 条评论（AI 定）"] },
      { label: "期限", lines: ["一周"] },
    ],
    setAt: "拟定于 12:51",
  });
  assert.equal(operatingPlanBlock(operatingPlanOf(task()), now), null);
  assert.equal(
    operatingPlanBlock(operatingPlanOf(task({ state: { operatingPlan: {} } })), now)?.title,
    "运营计划第 1 版",
  );
});

test("本任务汇报: Chinese labels, tone, first line, only http(s) links, newest first", () => {
  const lines = reportLines(
    [
      report({ id: "r1", title: "Plan v2", createdAt: at(13, 56), text: "照你的指令\n…" }),
      report({
        id: "r2",
        title: "Comment · over pace",
        createdAt: at(14, 39),
        links: [
          "https://www.reddit.com/r/aivideo/comments/abc123/some_long_title_here/",
          "javascript:alert(1)",
        ],
      }),
      report({ id: "r3", kind: "outcome", title: "Run 2 finished", createdAt: at(10, 6) }),
    ],
    now,
  );
  assert.deepEqual(
    lines.map((line) => [line.id, line.time, line.label, line.tone, line.text]),
    [
      ["r2", "14:39", "评论 · 超出节奏", "neutral", "评论 r/aivideo"],
      ["r1", "13:56", "计划第 2 版", "neutral", "照你的指令"],
      ["r3", "10:06", "第 2 轮完成", "green", "评论 r/aivideo"],
    ],
  );
  assert.deepEqual(lines[0].links, [
    {
      url: "https://www.reddit.com/r/aivideo/comments/abc123/some_long_title_here/",
      short: "reddit.com/r/aivideo/comments/abc123/some…",
    },
  ]);
  assert.equal(reportTone("Needs your input"), "amber");
  assert.equal(reportTone("Ready for your review"), "amber");
  assert.equal(reportTone("Needs attention"), "red");
  assert.equal(reportTone("Run failed"), "red");
  assert.equal(reportTone("Finished"), "green");
  assert.equal(reportTone("Waiting 20 minutes (pacing)"), "neutral");
  assert.equal(shortLink("https://example.com/"), "example.com");
  assert.equal(shortLink("not a url"), "not a url");
  // 本任务汇报 (where 打开任务 lands): an action report without the item's own address reads
  // 「未确认：…」 with no link; every other line has none.
  assert.deepEqual(
    lines.map((line) => line.unconfirmed),
    ["", "", ""],
  );
  const [missing] = reportLines(
    [
      report({
        id: "m",
        title: "Update",
        text: "在论坛发好了一条。",
        links: [],
        action: { site: "forum.example", action: "post" },
        evidence: "missing",
      }),
    ],
    now,
  );
  assert.equal(missing.unconfirmed, "未确认：没有这条内容自己的链接");
  assert.deepEqual(missing.links, []);
});

test("reports from two reads merge without duplicates, newest first", () => {
  const merged = mergeReports(
    [report({ id: "a", createdAt: at(14, 0) }), report({ id: "b", createdAt: at(14, 30) })],
    [report({ id: "b", createdAt: at(14, 30) }), report({ id: "c", createdAt: at(13, 0) })],
  );
  assert.deepEqual(
    merged.map((item) => item.id),
    ["b", "a", "c"],
  );
});

test("时间线: newest first, capped, with the older count", () => {
  const events = [
    event("e1", at(12, 50), "Task created"),
    event("e2", at(13, 2), "Posted", "r/LocalLLaMA"),
    event("e3", at(9, 0, -1), "Earlier"),
  ];
  const all = timelineLines(events, now);
  assert.deepEqual(
    all.lines.map((line) => [line.time, line.title, line.detail]),
    [
      ["13:02", "Posted", "r/LocalLLaMA"],
      ["12:50", "Task created", ""],
      ["昨天 09:00", "Earlier", ""],
    ],
  );
  assert.equal(all.older, 0);
  const capped = timelineLines(events, now, 2);
  assert.equal(capped.lines.length, 2);
  assert.equal(capped.older, 1);
  const long = timelineLines([event("e4", at(14, 0), "Long", "x".repeat(500))], now);
  assert.equal(long.lines[0].detail.length, 400);
});

test("时间线 is for the person: no model instruction, no handoff note, no raw pacing key", () => {
  // Review round 3: 「Make a concrete plan for the delegated outcome. The person reads these
  // steps…」 as a title; English wait notes with /workspace paths, run_chain.py and counters;
  // 「minGapMinutes: 50」; 「karma 1240, created 2023-09-06T11:33:20.000Z (1132 days ago)」.
  const line = (title: string, detail = "", kind: RunEvent["kind"] = "status") =>
    timelineEvent({ id: "e", date: at(14, 0), kind, title, detail }, now);
  // A wait: 「等待到 15:00」, never the note.
  const wait = line(
    "Waiting 19 minutes",
    `Next run should: 1. Take a screenshot\nDraft saved to /workspace/comment2_draft.txt; run_chain.py usedToday: comments=1\nResumes at ${at(15, 0)}\n[no action recorded this run]`,
  );
  assert.deepEqual([wait?.title, wait?.detail], ["等待到 15:00", ""]);
  assert.equal(
    line("Waiting 30 minutes (pacing)", `n\nResumes at ${at(15, 0)}`)?.title,
    "等待到 15:00 · 节奏",
  );
  assert.equal(
    line(
      "Waiting 5 minutes",
      `n\nResumes at ${at(14, 5)}\nRuns again now: the person sent a new instruction`,
    )?.detail,
    "收到新指示，马上再跑",
  );
  // The run's own commentary is not shown at all.
  assert.equal(line("Agent update", "I'll check /workspace/x first", "step"), null);
  // A run the infrastructure stopped: when it goes on, not the raw error.
  const stopped = line(
    "Run stopped by the infrastructure; it runs again by itself",
    `Provider reported response.failed\nResumes at ${at(14, 48)}`,
    "error",
  );
  assert.equal(stopped?.detail, "14:48 继续");
  // set_plan: its own title; an old event titled with the tool's instruction reads the same.
  assert.equal(line("Plan set", "找帖子\n回复", "plan")?.title, "定了计划");
  assert.equal(
    line(
      "Make a concrete plan for the delegated outcome. The person reads these steps on the task card while you work: write each one for the person",
      "",
      "step",
    )?.title,
    "定了计划",
  );
  assert.equal(line("Search the public web. Supply a self-contained objective")?.title, "搜了网页");
  assert.equal(line("Pause for a fact or decision about the task's plan")?.title, "问了你");
  assert.equal(line("start_computer failed", "407", "error")?.title, "有一步没成功");
  // Pacing and profile facts as Chinese phrases.
  assert.deepEqual(
    line(
      "Pacing set",
      "minGapMinutes: 50\nmaxCommentsPerDay: 4\nmaxPostsPerDay: 0\nactiveHours: 9-23\nreason: 新号，先慢一点\nset by the person, left as they are: minGapMinutes, activeHours",
    )?.detail.split("\n"),
    [
      "每两次之间至少隔 50 分钟",
      "每天最多评论 4 条",
      "不发帖",
      "当地 9–23 点之间",
      "理由：新号，先慢一点",
      "你手动定的保持不变：间隔分钟、活动时段",
    ],
  );
  assert.equal(line("Pacing set", "maxPostsPerDay: unset")?.detail, "每天发帖上限：不设");
  // A profile event recorded before profiles were per site is data, shown as the task wrote it
  // (no client string names one site's own counters).
  assert.equal(
    line("Profile recorded", "karma 1240, created 2023-09-06T11:33:20.000Z (1132 days ago)")
      ?.detail,
    "karma 1240, created 2023-09-06T11:33:20.000Z (1132 days ago)",
  );
  // Caps by kind and profile facts by site; the kind, the
  // site and the facts are data, shown as the task sent them.
  assert.deepEqual(
    line(
      "Pacing set",
      "caps.example.com/comment: 5\ncaps.example.com/post: 0\ncaps.example.com/like: unset\nreason: 新号\nset by the person, left as they are: caps.example.com/post",
    )?.detail.split("\n"),
    [
      "example.com/comment 每天最多 5 次",
      "不做 example.com/post",
      "example.com/like 每天上限：不设",
      "理由：新号",
      "你手动定的保持不变：example.com/post 每天上限",
    ],
  );
  assert.equal(
    line("Profile recorded", 'example.com: {"followers":12,"verified":false}')?.detail,
    "example.com：followers 12 · verified false",
  );
  // A report's marks: over pace in words; an unclassified link mark is the server's own; the
  // sentence is the title only and the raw link is on the card.
  assert.deepEqual(
    ["title", "detail"].map((key) => {
      const shown = line(
        "回复了一条",
        "回复了一条\nhttps://reddit.com/r/x/comments/1/a/b\n[unclassified link]\n[pacing exceeded: remaining 0 / earliestNext none set]",
        "report",
      );
      return shown?.[key as "title" | "detail"];
    }),
    ["回复了一条", "（超出了这个号的节奏）"],
  );
  // Old run events of the limits that are gone read in Chinese.
  assert.equal(line("Waiting for you after 100 waits")?.title, "等了 100 次后停下等你");
  assert.equal(line("The task asked to wait 30 minutes more.")?.title, "任务要再等 30 分钟");
  assert.equal(line("Continuing automatically (2/3)")?.title, "自动接着做");
  assert.equal(line("Continuing automatically")?.title, "自动接着做");
  assert.equal(
    line("Waiting for you after 3 automatic continuations")?.title,
    "自动接着做了 3 次后停下等你",
  );
  // The Agent update events do not count toward the older ones either.
  const capped = timelineLines(
    [event("a", at(14, 0), "Agent update", "x"), event("b", at(13, 0), "Work completed", "done")],
    now,
    1,
  );
  assert.deepEqual(
    capped.lines.map((item) => item.title),
    ["完成"],
  );
  assert.equal(capped.older, 0);
});

test("task detail payload and entry", () => {
  assert.equal(normalizeTaskDetail(null), null);
  assert.equal(normalizeTaskDetail({ events: [] }), null);
  const payload = normalizeTaskDetail({
    task: task(),
    events: [event("e1", at(12, 0), "x"), { nope: true }],
    artifacts: "bad",
  });
  assert.equal(payload?.events.length, 1);
  assert.deepEqual(payload?.artifacts, []);
  const live = entryOf(task({ title: "live" }));
  assert.equal(detailEntry(live, task({ title: "read" }), now, false)?.task.title, "live");
  assert.equal(detailEntry(undefined, task({ title: "read" }), now, false)?.task.title, "read");
  assert.equal(detailEntry(undefined, null, now, false), null);
  // A task read on its own (not in the polled list) reads the worker's state too.
  assert.equal(detailEntry(undefined, task(), now, true)?.phase.label, t.members.stalled);
});

test("a run while the worker has no heartbeat reads 后台停着 in the task panel", () => {
  const steps = task({
    plan: [
      { id: "s1", title: "打开 Reddit", status: "succeeded" },
      { id: "s2", title: "找帖子", status: "running" },
    ],
  });
  const [entry] = taskEntries([steps], now, true);
  assert.equal(entry.phase.key, "run", "the order and the buttons stay the run's");
  assert.equal(entry.phase.label, "后台停着");
  assert.equal(entry.phase.sub, t.progress.stalled);
  assert.equal(entry.phase.tone, "grey");
  assert.deepEqual(
    detailActions(entry.phase, false, false),
    detailActions(entryOf(steps).phase, false, false),
  );
  // Not 现在在做: the step it stopped on.
  assert.deepEqual(middleBlocks(steps, entry.phase, false, now), {
    need: false,
    blocks: [{ title: t.taskDetail.stoppedTitle, body: "找帖子", tone: "normal" }],
  });
  // An operating task shows no step: the header's line says it all.
  const loop = task({
    input: { environmentId: "env-1" },
    plan: [{ id: "s1", title: "打开账号桌面", status: "running" }],
  });
  assert.deepEqual(middleBlocks(loop, taskEntries([loop], now, true)[0].phase, false, now), {
    need: false,
    blocks: [],
  });
  // Every other phase is as it was.
  for (const status of ["queued", "scheduled", "paused", "failed", "waiting_input"] as const) {
    const value = task({ status, nextRunAt: at(16, 30), updatedAt: at(14, 41) });
    assert.deepEqual(taskEntries([value], now, true)[0].phase, entryOf(value).phase, status);
  }
});

test("receipt line", () => {
  assert.equal(
    receiptLine({ text: "你点了重试，任务重新运行", at: at(14, 47) }, now),
    "你点了重试，任务重新运行 · 14:47",
  );
  assert.equal(receiptLine(undefined, now), "");
});

// ───────────────────────────── new task form ─────────────────────────────

test("每 [n] 分钟: whole minutes 1..10080 with Chinese errors", () => {
  assert.deepEqual(readInterval(" 60 "), { minutes: 60 });
  assert.deepEqual(readInterval("10080"), { minutes: 10080 });
  assert.deepEqual(readInterval(""), { error: t.interval.required });
  assert.deepEqual(readInterval("1.5"), { error: t.interval.whole });
  assert.deepEqual(readInterval("abc"), { error: t.interval.whole });
  assert.deepEqual(readInterval("0"), { error: t.interval.tooSmall });
  assert.deepEqual(readInterval("10081"), { error: t.interval.tooLarge });
});

test("new task: account required, this project's only; payload is the goal and the account", () => {
  const ids = ["a1", "a2"];
  const draft = {
    what: "  看看 r/IPhoneApps  ",
    environmentId: "a2",
    repeat: "once" as const,
    minutes: "60",
  };
  assert.deepEqual(checkNewTask(draft, ids), {
    ok: true,
    payload: {
      prompt: "看看 r/IPhoneApps",
      kind: "agent",
      input: { environmentId: "a2" },
      typed: true,
    },
  });
  assert.deepEqual(checkNewTask({ ...draft, repeat: "every", minutes: "45" }, ids), {
    ok: true,
    payload: {
      prompt: "看看 r/IPhoneApps",
      kind: "agent",
      input: { environmentId: "a2" },
      repeatMinutes: 45,
      typed: true,
    },
  });
  assert.deepEqual(checkNewTask({ ...draft, what: "  " }, ids), {
    ok: false,
    field: "what",
    error: t.newTask.whatRequired,
  });
  assert.deepEqual(checkNewTask({ ...draft, what: "x".repeat(promptMax + 1) }, ids), {
    ok: false,
    field: "what",
    error: t.newTask.tooLong(promptMax),
  });
  assert.deepEqual(checkNewTask(draft, []), {
    ok: false,
    field: "account",
    error: t.newTask.noAccounts,
  });
  assert.deepEqual(checkNewTask({ ...draft, environmentId: "elsewhere" }, ids), {
    ok: false,
    field: "account",
    error: t.newTask.accountRequired,
  });
  assert.deepEqual(checkNewTask({ ...draft, repeat: "every", minutes: "0" }, ids), {
    ok: false,
    field: "minutes",
    error: t.interval.tooSmall,
  });
  // 只跑一次 ignores whatever is in the minutes box.
  assert.equal(checkNewTask({ ...draft, minutes: "abc" }, ids).ok, true);
});

test("new task: preselected account and a request id stable per input", () => {
  assert.equal(initialAccount(["a1", "a2"], "a2"), "a2");
  assert.equal(initialAccount(["a1", "a2"], "gone"), "a1");
  assert.equal(initialAccount(["a1"], null), "a1");
  assert.equal(initialAccount([], "a1"), null);
  let n = 0;
  const makeId = () => `id-${++n}`;
  const payload = {
    prompt: "x",
    kind: "agent" as const,
    input: { environmentId: "a1" },
    typed: true as const,
  };
  const first = submissionFor(null, payload, makeId);
  assert.equal(first.id, "id-1");
  assert.equal(submissionFor(first, { ...payload }, makeId), first);
  assert.equal(submissionFor(first, { ...payload, prompt: "y" }, makeId).id, "id-2");
});

test("the form never suggests typing pacing, voice or reporting", () => {
  const banned = ["节奏", "汇报给我", "发完汇报", "分钟发", "每天 8", "口径是", "选区："];
  for (const word of banned) assert.ok(!t.newTask.whatPlaceholder.includes(word), word);
  const all = JSON.stringify(t, (_, value) =>
    typeof value === "function" ? String(value) : value,
  );
  for (const word of ["发完汇报", "每发一条汇报给我", "间隔 20 分钟发", "批准", "审批"])
    assert.ok(!all.includes(word), word);
  // The payload carries only the goal, the kind, the account, the repeat interval and that the
  // person typed it (so the task detail says 你写的).
  const check = checkNewTask({ what: "x", environmentId: "a1", repeat: "every", minutes: "30" }, [
    "a1",
  ]);
  assert.ok(check.ok);
  assert.deepEqual(Object.keys(check.ok ? check.payload : {}).sort(), [
    "input",
    "kind",
    "prompt",
    "repeatMinutes",
    "typed",
  ]);
  assert.deepEqual(Object.keys(check.ok ? check.payload.input : {}), ["environmentId"]);
});

// ───────────────────────────── settings ─────────────────────────────

test("change password: Chinese errors in the server's order of rules", () => {
  assert.deepEqual(checkPassword({ current: "", next: "longenough", repeat: "longenough" }), {
    ok: false,
    error: t.settings.passwordMissing,
  });
  assert.deepEqual(checkPassword({ current: "old", next: "short", repeat: "short" }), {
    ok: false,
    error: t.settings.passwordTooShort(8),
  });
  assert.deepEqual(checkPassword({ current: "old", next: "longenough", repeat: "longenougH" }), {
    ok: false,
    error: t.settings.passwordsDiffer,
  });
  assert.deepEqual(checkPassword({ current: "old", next: "longenough", repeat: "longenough" }), {
    ok: true,
    current: "old",
    next: "longenough",
  });
  const refused = (status: number, message: string) =>
    Object.assign(new Error(message), { status });
  assert.equal(passwordErrorText(refused(403, "Current password is incorrect")), "当前密码不对。");
  assert.equal(passwordErrorText(refused(429, "Too many")), t.settings.passwordTooMany);
  assert.equal(
    passwordErrorText(refused(500, "Database down")),
    t.settings.passwordFailed("Database down"),
  );
  assert.equal(passwordErrorText("offline"), t.settings.passwordFailed("offline"));
});

test("后台 heartbeat line", () => {
  assert.equal(clockSeconds(at(14, 46, 0, 58)), "14:46:58");
  assert.equal(clockSeconds("nope"), "");
  assert.deepEqual(workerLine({ down: false, sinceMs: 2000, lastTickAt: at(14, 46, 0, 58) }), {
    state: "ok",
    text: "正常 · 最后心跳 14:46:58",
  });
  assert.deepEqual(workerLine({ down: true, sinceMs: 3 * 60_000, lastTickAt: at(14, 44, 0, 2) }), {
    state: "down",
    text: "已停 3 分钟 · 最后心跳 14:44:02",
  });
  assert.deepEqual(workerLine({ down: false, sinceMs: null, lastTickAt: null }), {
    state: "unknown",
    text: t.settings.workerUnknown,
  });
  assert.deepEqual(workerLine({ down: true, sinceMs: null, lastTickAt: null }), {
    state: "down",
    text: t.settings.workerUnknown,
  });
});

test("汇报卡 switch changes only showChatUpdates", () => {
  const identity: AgentIdentity = {
    name: "Muse",
    tone: "concise",
    avatar: "lilac",
    showChatUpdates: true,
  };
  assert.equal(showsChatUpdates(identity), true);
  assert.equal(showsChatUpdates({ ...identity, showChatUpdates: undefined }), true);
  assert.equal(showsChatUpdates({ ...identity, showChatUpdates: false }), false);
  assert.equal(showsChatUpdates(undefined), true);
  assert.deepEqual(identityPayload(identity, false), {
    name: "Muse",
    tone: "concise",
    avatar: "lilac",
    showChatUpdates: false,
  });
  assert.deepEqual(identityPayload({ name: " ", tone: "warm" }, true), {
    name: "Yuki",
    tone: "warm",
    showChatUpdates: true,
  });
  assert.deepEqual(identityPayload(undefined, false), {
    name: "Yuki",
    tone: "warm",
    showChatUpdates: false,
  });
});

test("a task stopped before the report line on a run without a completion call: no count", () => {
  const stuck = task({
    status: "waiting_input",
    question: runEndedWithoutCompletionQuestion,
    state: { autoContinued: 3 },
    plan: [
      { id: "s1", title: "打开 Reddit", status: "succeeded" },
      { id: "s2", title: "打开评论区", status: "waiting" },
    ],
  });
  const entry = entryOf(stuck);
  assert.equal(entry.phase.sub, "上一轮没确认做完 · 卡在：第 2 步 打开评论区");
  assert.equal(rhythmLine(stuck), "一次性");
  assert.deepEqual(middleBlocks(stuck, entry.phase, true, now), { need: true, blocks: [] });
});

test("时间线 says each thing once: no prompt per run, no report twice, no tool instruction", () => {
  // Fixer round 2, blocking 2-4.
  const line = (title: string, detail = "", kind: RunEvent["kind"] = "status") =>
    timelineEvent({ id: "e", date: at(14, 0), kind, title, detail }, now);
  const prompt =
    "用 Oak_Example_2 在 Reddit 推广 iOS App AcmeGame。如果 Reddit 账号未登录，等待用户操作。一直做，直到我叫停。";
  // A run's start: the title only; the prompt is under 任务规则.
  for (const title of ["Started working", "Resumed work", "Run 3 started"])
    assert.equal(line(title, prompt)?.detail, "", title);
  assert.equal(line("Resumed work", prompt)?.title, "继续工作");
  // A report: the sentence once (whole, even when the title was clipped), then what was
  // posted; never the raw link.
  const sentence =
    "04:02 r/languagelearning 那一帖被 Reddit 的垃圾过滤器拦了，我已经换了一个说法。";
  const report = line(
    sentence.slice(0, 20),
    `${sentence}\nThanks, this helped a lot!\nhttps://www.reddit.com/r/languagelearning/comments/1/a/b`,
    "report",
  );
  assert.deepEqual([report?.title, report?.detail], [sentence, "Thanks, this helped a lot!"]);
  const notice = line("这个号的网络出口现在连不上。", "这个号的网络出口现在连不上。", "report");
  assert.deepEqual([notice?.title, notice?.detail], ["这个号的网络出口现在连不上。", ""]);
  // Every tool description the deployed server ever wrote as a step title reads in Chinese, or
  // is not shown (wait_until's: the wait has its own event).
  const oldStepTitles = [
    "Make a concrete plan for the delegated outcome",
    "Read the authorized workspace sources",
    "Read the complete selected email thread",
    "Import a selected email PDF attachment",
    "Inspect the supported fields of a PDF",
    "Save a new PDF using only values supplied by the user",
    "Search the public web. Supply a self-contained objective and 1-5 concise queries. Queries and objective are sent to an external search service.",
    "Read a public webpage in the agent browser",
    "Save a persistent plan, comparison or report",
    "Send the person a report in their conversation now; the run continues. Use after every external action (the permalink and the exact text) unless the task's rules set another timing, and for anything notable the run goes on past",
    "Prepare the exact email for a separate user review",
    "Prepare an event for a separate user review",
    "Pause for a fact or decision that is missing (not for waiting; use wait_until)",
    "Pause for a fact or decision that is missing",
    "Finish only when the requested outcome is actually achieved",
    "Save the operating plan of an operating goal (the whole plan) before the first action, and again with the whole updated plan when the person changes the communities",
    "Record the pacing you decided for this account from the facts in the pacing block, with your reason",
    "Record this account's own facts after opening https://www.reddit.com/api/me.json in this desktop's browser",
  ];
  for (const title of oldStepTitles) {
    const shown = line(title, "", "step");
    assert.ok(shown, title);
    assert.doesNotMatch(shown.title, /[A-Za-z]{4}/, title);
  }
  assert.equal(
    line("Finish only when the requested outcome is actually achieved", "", "step")?.title,
    "完成",
  );
  for (const title of [
    "Wait the minutes the task's own rules require, then run this task again with the note",
    "Wait the minutes the task's rules or the server pacing block require, then run this task again with the note",
    "Wait the minutes the task's rules or the account's set pacing require, then run this task again with the note",
  ])
    assert.equal(line(title, "", "step"), null, title);
  // An error event's provider quota answer reads as the owner's reason.
  assert.equal(
    line(
      "Task needs attention",
      "429 You exceeded your current quota, please check your plan and billing details.",
      "error",
    )?.detail,
    t.server.providerQuota,
  );
});

test("a report or a step that mentions billing is shown as written", () => {
  // Fixer round 2, blocking 1: only a failure maps a provider's quota answer.
  const text = "在 r/stripe 回复了一个关于 billing 的帖子。";
  assert.equal(serverText(text), text);
  assert.equal(
    timelineEvent(
      {
        id: "e",
        date: at(14, 0),
        kind: "report",
        title: text,
        detail: `${text}\nI moved billing to Stripe and it was fine`,
      },
      now,
    )?.detail,
    "I moved billing to Stripe and it was fine",
  );
  assert.equal(
    phaseWords.step(2, 5, "找 billing 相关的帖子"),
    taskPhaseWordsZh.step(2, 5, "找 billing 相关的帖子"),
  );
  // A failure still reads as the owner's reason.
  assert.equal(failureText("429 insufficient_quota"), t.server.providerQuota);
});

test("时间线 says why a task waited or was stopped, by the incident's word, never the raw error", () => {
  // Fixer round 3 (minor 9, 10): the wait for a proxy and a pacing wait read apart, and a run the
  // model provider stopped names it.
  const line = (title: string, detail = "", kind: RunEvent["kind"] = "status") =>
    timelineEvent({ id: "e", date: at(14, 0), kind, title, detail }, now);
  const resume = new Date(now);
  resume.setHours(15, 0, 0, 0);
  const wait = line(
    "Waiting 15 minutes",
    `proxy 407 again; try later\nResumes at ${resume.toISOString()}\nBlocked: proxy`,
  );
  assert.deepEqual([wait?.title, wait?.detail], ["等待到 15:00", "原因：代理连不上"]);
  const stopped = line(
    "Run stopped by the infrastructure; it runs again by itself",
    `Blocked: model\n529 Overloaded\nResumes at ${resume.toISOString()}`,
    "error",
  );
  assert.equal(stopped?.detail, "原因：模型服务连不上\n15:00 继续");
  assert.doesNotMatch(stopped?.detail ?? "", /529|Overloaded/);
});

test("本任务汇报 reads the same Chinese as the rail and the card: an old 出问题 never shows the raw error", () => {
  const raw = "429 You exceeded your current quota, please check your plan and billing details.";
  const [line] = reportLines([report({ id: "q", title: "Needs attention", text: raw })], now);
  assert.equal(line.text, t.server.providerQuota);
  // What a run wrote stays as written, even when it mentions billing.
  const written = "回复了一个关于 billing 的帖子。";
  assert.equal(
    reportLines([report({ id: "w", title: "Comment", text: written })], now)[0].text,
    written,
  );
});

test("时间线: a failed tool or run shows no raw error; only what the mapping knows", () => {
  const line = (title: string, detail: string) =>
    timelineEvent({ id: "e", date: at(14, 0), kind: "error", title, detail }, now);
  const raw = "TimeoutError: page.goto: Timeout 30000ms exceeded at https://example.com/x";
  for (const title of [
    "read_web failed",
    "Run failed; next run scheduled",
    "Paused after repeated failures",
  ]) {
    const shown = line(title, raw);
    assert.ok(shown, title);
    assert.equal(shown.detail, "", title);
    assert.doesNotMatch(shown.title, /failed|Paused/, title);
  }
  assert.equal(
    line("Run failed; next run scheduled", "429 insufficient_quota")?.detail,
    t.server.providerQuota,
  );
});
