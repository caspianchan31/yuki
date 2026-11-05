// The shared status vocabulary of a background task.
import assert from "node:assert/strict";
import test from "node:test";
import { runEndedWithoutCompletion } from "../apps/server/src/engine/model.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import {
  clockLabel,
  durationLabel,
  endedRecently,
  firstLine,
  inputReason,
  planProgress,
  rhythmLabel,
  runEndedWithoutCompletionQuestion,
  showsSteps,
  taskEnvironmentId,
  taskPhase,
  taskPhaseCounts,
  taskPhaseWordsZh,
} from "../packages/domain/src/task-phase.ts";

// Local times, so clock labels do not depend on the machine's time zone.
const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number, dayOffset = 0) =>
  new Date(2026, 9, 10 + dayOffset, hours, minutes).toISOString();

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "AcmeGame Reddit推广",
    prompt: "用 Oak_Example_2 推广 AcmeGame",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: at(12, 50),
    updatedAt: at(14, 45),
    attempts: 1,
    artifactIds: [],
    ...overrides,
  };
}
const steps = (statuses: AgentTask["plan"][number]["status"][]) =>
  statuses.map((status, index) => ({ id: String(index), title: `步骤${index + 1}`, status }));

test("the domain copy of the server's question matches the server", () => {
  assert.equal(runEndedWithoutCompletionQuestion, runEndedWithoutCompletion);
});

test("a running task reads 运行中 with its step, never the previous run's handoff", () => {
  // state.lastUpdate is the record a run leaves for the next one (a wait_until note, the text of
  // a run that hit the step cap): during a run it is the previous run's, never shown here
  // (report line, docs/report-back.md).
  const phase = taskPhase(
    task({
      plan: steps(["succeeded", "succeeded", "running", "pending", "pending"]),
      state: { lastUpdate: "Next run should: 1. Take a screenshot\nDraft saved to /workspace/x" },
    }),
    { now },
  );
  assert.equal(phase.key, "run");
  assert.equal(phase.label, "运行中");
  assert.equal(phase.tone, "blue");
  assert.equal(phase.needsYou, false);
  assert.equal(phase.sub, "第 3/5 步 · 步骤3");
  assert.equal(phase.detail, "");
  assert.equal(phase.rank, 3);
  assert.equal(phase.ended, false);
  const bare = taskPhase(task({ plan: [] }), { now });
  assert.equal(bare.sub, "正在运行");
});

test("a queued task reads 排队中, an automatic continuation too: no count, no limit", () => {
  const queued = taskPhase(task({ status: "queued" }), { now });
  assert.equal(queued.key, "queue");
  assert.equal(queued.tone, "blueSoft");
  assert.equal(queued.sub, "排队中，等后台接手");
  const continuing = taskPhase(task({ status: "queued", state: { autoContinued: 7 } }), {
    now,
  });
  assert.equal(continuing.sub, "排队中，等后台接手");
});

test("an operating task (bound to an account) shows no step count: its steps never move", () => {
  // Only finish_task marks steps done, and an operating task goes through
  // its plan again on every run, so 「第 1/5 步」 stayed all day.
  const bound = task({
    input: { environmentId: "env-1" },
    plan: steps(["running", "pending", "pending", "pending", "pending"]),
  });
  assert.equal(showsSteps(bound), false);
  assert.equal(showsSteps(task()), true);
  const phase = taskPhase(bound, { now });
  assert.equal(phase.key, "run");
  assert.equal(phase.sub, "正在运行");
  assert.ok(!phase.sub.includes("步"));
});

test("an open infrastructure incident is the line of the task, and never in 需要你", () => {
  const words = {
    ...taskPhaseWordsZh,
    incident: (kind: string, since: string, next: string) => `${kind} ${since} ${next}`,
  };
  const incident = { kind: "proxy", since: at(13, 2) };
  const stopped = taskPhase(
    task({ status: "scheduled", nextRunAt: at(14, 48), state: { incident } }),
    { now, words },
  );
  assert.equal(stopped.key, "sched");
  assert.equal(stopped.needsYou, false);
  assert.deepEqual(stopped.incident, incident);
  assert.equal(stopped.sub, "proxy 13:02 14:48");
  const wait = { minutes: 20, note: "proxy 407", since: at(14, 40), until: at(15, 0) };
  const waiting = taskPhase(
    task({ status: "scheduled", nextRunAt: wait.until, state: { wait, incident } }),
    { now, words },
  );
  assert.equal(waiting.key, "wait");
  assert.equal(waiting.sub, "proxy 13:02 15:00");
  assert.equal(waiting.detail, "", "the wait note is never the person's");
  // Over (resolvedAt), it is no longer the task's line.
  const over = taskPhase(
    task({
      status: "scheduled",
      nextRunAt: wait.until,
      state: { wait, incident: { ...incident, reportedAt: at(13, 30), resolvedAt: at(14, 0) } },
    }),
    { now, words },
  );
  assert.equal(over.incident, undefined);
  assert.equal(over.sub, "15:00 继续（还剩 13 分）");
  // Without the words the line is the wait's or the schedule's as before.
  const plain = taskPhase(
    task({ status: "scheduled", nextRunAt: at(14, 48), state: { incident } }),
    { now },
  );
  assert.equal(plain.sub, "下次 14:48");
});

test("a task in its own wait_until reads 等待中 with the resume time and time left", () => {
  const wait = {
    minutes: 20,
    note: "已评论 1/3。\n下一条去 r/StableDiffusion",
    since: at(14, 40),
    until: at(15, 0),
  };
  const phase = taskPhase(
    task({ status: "scheduled", nextRunAt: wait.until, state: { wait, waits: 1 } }),
    { now },
  );
  assert.equal(phase.key, "wait");
  assert.equal(phase.label, "等待中");
  assert.equal(phase.tone, "teal");
  // No count of waits: they have no limit, so it is the task detail's fact only.
  assert.equal(phase.sub, "15:00 继续（还剩 13 分）");
  // The note is the run's handoff to its next run, never a line the person reads.
  assert.equal(phase.detail, "");
  assert.equal(phase.at, wait.until);
  assert.equal(phase.rank, 5);
  assert.equal(phase.needsYou, false);
  const pacing = taskPhase(
    task({
      status: "scheduled",
      nextRunAt: wait.until,
      state: { wait: { ...wait, pacing: true }, waits: 0 },
    }),
    { now },
  );
  assert.equal(pacing.pacing, true);
  assert.equal(pacing.sub, "15:00 继续（还剩 13 分）· 节奏");
});

test("a repeating task between runs reads 排期中 with rhythm, runs and next run", () => {
  const phase = taskPhase(
    task({ status: "scheduled", repeatMinutes: 1440, runs: 1, nextRunAt: at(10, 5, 1) }),
    { now },
  );
  assert.equal(phase.key, "sched");
  assert.equal(phase.tone, "tealSoft");
  assert.equal(phase.sub, "每天 · 已跑 1 轮 · 下次 明天 10:05");
  assert.equal(phase.rank, 6);
  // A wait record whose resume time is no longer the next run is not a wait.
  const moved = taskPhase(
    task({
      status: "scheduled",
      repeatMinutes: 60,
      runs: 3,
      nextRunAt: at(15, 30),
      state: { wait: { minutes: 20, note: "x", since: at(14, 0), until: at(14, 20) } },
    }),
    { now },
  );
  assert.equal(moved.key, "sched");
  assert.equal(moved.sub, "每小时 · 已跑 3 轮 · 下次 15:30");
  const once = taskPhase(task({ status: "scheduled", nextRunAt: at(16, 0) }), { now });
  assert.equal(once.key, "sched");
  assert.equal(once.sub, "下次 16:00");
});

test("an ask_user question is 等你回答 and needs you", () => {
  const phase = taskPhase(
    task({
      status: "waiting_input",
      question: "找不到 AcmeGame 的资料，它是什么、链接在哪？\n已查官网",
    }),
    { now },
  );
  assert.equal(phase.key, "input");
  assert.equal(phase.label, "等你回答");
  assert.equal(phase.tone, "amber");
  assert.equal(phase.needsYou, true);
  assert.equal(phase.reason, "question");
  assert.equal(phase.sub, "找不到 AcmeGame 的资料，它是什么、链接在哪？");
  assert.equal(phase.rank, 0);
});

test("a task stopped before the report line on a run without a completion call reads as such", () => {
  const phase = taskPhase(
    task({
      status: "waiting_input",
      question: runEndedWithoutCompletion,
      plan: [
        { id: "0", title: "启动桌面", status: "succeeded" },
        { id: "1", title: "找帖子", status: "succeeded" },
        { id: "2", title: "写回复", status: "succeeded" },
        { id: "3", title: "打开评论区", status: "waiting" },
      ],
      state: { autoContinued: 3 },
    }),
    { now },
  );
  assert.equal(phase.key, "input");
  assert.equal(phase.reason, "unfinished");
  assert.equal(phase.needsYou, true);
  assert.equal(phase.sub, "上一轮没确认做完 · 卡在：第 4 步 打开评论区");
  assert.ok(!/续跑|\d+\/\d+/.test(phase.sub), "no count and no limit");
  const bare = taskPhase(task({ status: "waiting_input", question: runEndedWithoutCompletion }), {
    now,
  });
  assert.equal(bare.sub, "上一轮没确认做完");
});

test("waits never stop a task: there is no waits-limit question, only the task's own", () => {
  // Waits have no limit, so a question is always the task's own question,
  // whatever the count of waits or the wait record says.
  const question = "找不到 AcmeGame 的资料……链接在哪？";
  const asking = task({
    status: "waiting_input",
    question,
    state: {
      waits: 100,
      wait: { minutes: 20, note: "x", since: at(14, 0), until: at(14, 20), resumedAt: at(14, 30) },
    },
  });
  assert.equal(inputReason(asking), "question");
  const phase = taskPhase(asking, { now });
  assert.equal(phase.reason, "question");
  assert.equal(phase.sub, question);
  assert.equal(phase.needsYou, true);
  // A task in a wait is 等待中, never in 需要你, however many waits it has made.
  const waiting = taskPhase(
    task({
      status: "scheduled",
      nextRunAt: at(15, 0),
      state: { waits: 500, wait: { minutes: 20, note: "x", since: at(14, 40), until: at(15, 0) } },
    }),
    { now },
  );
  assert.equal(waiting.key, "wait");
  assert.equal(waiting.needsYou, false);
});

test("a review is 等你审阅 and needs you", () => {
  const phase = taskPhase(task({ status: "waiting_approval" }), { now });
  assert.equal(phase.key, "approval");
  assert.equal(phase.label, "等你审阅");
  assert.equal(phase.needsYou, true);
  assert.equal(phase.rank, 1);
  assert.equal(phase.sub, "邮件或日程草稿等你审阅");
});

test("a failure needs you for seven days, then it is history", () => {
  const recent = taskPhase(
    task({
      status: "failed",
      error: "桌面连不上代理出口 203.0.113.105:5890（ECONNREFUSED）\nstack",
      attempts: 3,
      updatedAt: at(14, 41),
    }),
    { now },
  );
  assert.equal(recent.key, "fail");
  assert.equal(recent.tone, "red");
  assert.equal(recent.needsYou, true);
  assert.equal(recent.rank, 2);
  assert.equal(recent.sub, "桌面连不上代理出口 203.0.113.105:5890（ECONNREFUSED） · 第 3 次");
  assert.equal(recent.detail, "桌面连不上代理出口 203.0.113.105:5890（ECONNREFUSED）");
  assert.equal(recent.ended, false);
  const old = taskPhase(
    task({ status: "failed", error: "boom", attempts: 1, updatedAt: at(10, 0, -8) }),
    { now },
  );
  assert.equal(old.needsYou, false);
  assert.equal(old.ended, true);
  assert.equal(old.rank, 9);
  assert.equal(old.sub, "boom");
  const bare = taskPhase(task({ status: "failed", error: null, attempts: 0 }), { now });
  assert.equal(bare.sub, "任务失败");
});

test("a pause inside a wait keeps the original resume time", () => {
  const wait = { minutes: 20, note: "下一条", since: at(14, 40), until: at(15, 0) };
  const inWait = taskPhase(task({ status: "paused", nextRunAt: wait.until, state: { wait } }), {
    now,
  });
  assert.equal(inWait.key, "pause");
  assert.equal(inWait.tone, "grey");
  assert.equal(inWait.sub, "原定 15:00 恢复");
  assert.equal(inWait.rank, 7);
  const plain = taskPhase(task({ status: "paused" }), { now });
  assert.equal(plain.sub, "已暂停，点恢复继续");
});

test("finished tasks are ended; 24-hour history is a separate check", () => {
  const done = taskPhase(
    task({ status: "succeeded", result: "心跳正常：桌面 38 秒内启动\n更多", updatedAt: at(10, 6) }),
    { now },
  );
  assert.equal(done.key, "done");
  assert.equal(done.label, "已完成");
  assert.equal(done.tone, "green");
  assert.equal(done.sub, "心跳正常：桌面 38 秒内启动");
  assert.equal(done.ended, true);
  assert.equal(endedRecently(done, now), true);
  const cancelled = taskPhase(task({ status: "cancelled", updatedAt: at(10, 0, -2) }), {
    now,
  });
  assert.equal(cancelled.key, "cancelled");
  assert.equal(cancelled.label, "已取消");
  assert.equal(endedRecently(cancelled, now), false);
  assert.equal(endedRecently(taskPhase(task(), { now }), now), false);
});

test("priority orders 此刻: input, approval, failure, run, queue, wait, schedule, pause", () => {
  const wait = { minutes: 20, note: "n", since: at(14, 40), until: at(15, 0) };
  const phases = [
    task({ status: "paused" }),
    task({ status: "scheduled", repeatMinutes: 60, nextRunAt: at(15, 0) }),
    task({ status: "scheduled", nextRunAt: wait.until, state: { wait } }),
    task({ status: "queued" }),
    task({ status: "running" }),
    task({ status: "failed", updatedAt: at(14, 0) }),
    task({ status: "waiting_approval" }),
    task({ status: "waiting_input", question: "?" }),
  ].map((item) => taskPhase(item, { now }));
  const order = [...phases].sort((a, b) => a.rank - b.rank).map((phase) => phase.key);
  assert.deepEqual(order, ["input", "approval", "fail", "run", "queue", "wait", "sched", "pause"]);
});

test("counts per project follow decision 4", () => {
  const wait = { minutes: 20, note: "n", since: at(14, 40), until: at(15, 0) };
  const counts = taskPhaseCounts(
    [
      task({ status: "waiting_input", question: "?" }),
      task({ status: "waiting_approval" }),
      task({ status: "failed", updatedAt: at(14, 0) }),
      task({ status: "failed", updatedAt: at(14, 0, -10) }),
      task({ status: "running" }),
      task({ status: "queued" }),
      task({ status: "scheduled", nextRunAt: wait.until, state: { wait } }),
      task({ status: "scheduled", repeatMinutes: 1440, nextRunAt: at(10, 5, 1) }),
      task({ status: "paused" }),
      task({ status: "succeeded" }),
    ],
    now,
  );
  assert.deepEqual(counts, {
    needsYou: 3,
    running: 1,
    queued: 1,
    waiting: 1,
    scheduled: 1,
    failed7d: 1,
  });
});

test("words can be swapped in one place", () => {
  const english = {
    ...taskPhaseWordsZh,
    labels: { ...taskPhaseWordsZh.labels, run: "Running" },
    step: (current: number, total: number, what: string) => `Step ${current}/${total} · ${what}`,
  };
  const phase = taskPhase(task({ plan: steps(["running"]) }), { now, words: english });
  assert.equal(phase.label, "Running");
  assert.equal(phase.sub, "Step 1/1 · 步骤1");
});

test("helpers: clock, duration, rhythm, first line, plan progress, bound account", () => {
  assert.equal(clockLabel(at(15, 0), now), "15:00");
  assert.equal(clockLabel(at(10, 5, 1), now), "明天 10:05");
  assert.equal(clockLabel(at(9, 12, -1), now), "昨天 09:12");
  assert.equal(clockLabel(at(10, 5, 3), now), "10-13 10:05");
  assert.equal(clockLabel("nope", now), "");
  assert.equal(clockLabel(undefined, now), "");
  assert.equal(durationLabel(13 * 60000 - 1), "13 分");
  assert.equal(durationLabel(0), "1 分");
  assert.equal(durationLabel(80 * 60000), "1 小时 20 分");
  assert.equal(durationLabel(120 * 60000), "2 小时");
  assert.equal(durationLabel((2 * 1440 + 180) * 60000), "2 天 3 小时");
  assert.equal(rhythmLabel(null), "一次性");
  assert.equal(rhythmLabel(1440), "每天");
  assert.equal(rhythmLabel(60), "每小时");
  assert.equal(rhythmLabel(2880), "每 2 天");
  assert.equal(rhythmLabel(180), "每 3 小时");
  assert.equal(rhythmLabel(45), "每 45 分钟");
  assert.equal(firstLine("\n  hello \nworld"), "hello");
  assert.equal(firstLine(42), "");
  assert.equal(firstLine("abcdef", 4), "abc…");
  // A bare heading reads with the line after it (a plan card's 「选区：」 and its first place).
  assert.equal(
    firstLine("选区：\n- a film forum — editors ask there\n- b"),
    "选区：a film forum — editors ask there",
  );
  assert.equal(firstLine("Note:"), "Note:");
  assert.deepEqual(planProgress({ plan: steps(["succeeded", "pending", "pending"]) }), {
    done: 1,
    total: 3,
    current: 2,
    title: "步骤2",
  });
  assert.deepEqual(planProgress({ plan: [] }), { done: 0, total: 0, current: 0, title: "" });
  assert.equal(taskEnvironmentId({ input: { environmentId: "95c99f07" } }), "95c99f07");
  assert.equal(taskEnvironmentId({ input: {} }), null);
  assert.equal(taskEnvironmentId({ input: { environmentId: 7 } }), null);
});
