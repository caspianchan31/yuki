// v1.4 routines on the member card: the when-line from the trigger, 最近运行 (three closed, twenty
// open), the cause words, who may be edited, and what the 修改 form sends.
import assert from "node:assert/strict";
import test from "node:test";
import {
  memberRoutines,
  routineCauseLabel,
  routineDraftBody,
  routineDraftOf,
  routineRunRows,
  yukiRoutines,
} from "../../../packages/client/src/shell/members/member-detail.ts";
import type { Routine, RoutineRun } from "../../../packages/domain/src/routines.ts";

const run = (n: number, over: Partial<RoutineRun> = {}): RoutineRun => ({
  startedAt: `2026-11-03T08:${String(60 - n).padStart(2, "0")}:00.000Z`,
  endedAt: `2026-11-03T08:${String(60 - n).padStart(2, "0")}:30.000Z`,
  status: "succeeded",
  summary: `第 ${n} 次`,
  cause: "schedule",
  ...over,
});
const routine = (over: Partial<Routine> = {}): Routine => ({
  trigger: { type: "daily", at: "09:00" },
  history: [],
  ...over,
});
const task = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    title: "晨报",
    prompt: "整理昨天的情况",
    status: "scheduled",
    repeatMinutes: 1440,
    input: {},
    state: {},
    routine: routine(),
    ...over,
  }) as never;

test("a routine's when-line comes from its trigger, not from the prompt", () => {
  const [daily] = memberRoutines([task({ prompt: "x\n什么时候：每周一 8:00" })]);
  assert.equal(daily?.when, "每天 09:00");
  const [mail] = memberRoutines([
    task({ routine: routine({ trigger: { type: "mail", from: "boss" } }) }),
  ]);
  assert.equal(mail?.when, "收到新邮件时（发件人含「boss」）");
  const [every] = memberRoutines([
    task({ routine: routine({ trigger: { type: "every", minutes: 45 } }), repeatMinutes: 45 }),
  ]);
  assert.equal(every?.when, "每 45 分钟");
  // A plain repeating task keeps its written line.
  const [plain] = memberRoutines([task({ routine: undefined, prompt: "做\n什么时候：每天 7:30" })]);
  assert.equal(plain?.when, "每天 7:30");
  assert.equal(plain?.routine, null);
});

test("on/off, test and edit follow the task's status", () => {
  const [on, off, running, failed] = memberRoutines([
    task({ id: "a" }),
    task({ id: "b", status: "paused" }),
    task({ id: "c", status: "running" }),
    task({ id: "d", status: "failed" }),
  ]);
  assert.deepEqual([on?.on, on?.ready, on?.editable], [true, true, true]);
  assert.deepEqual([off?.on, off?.ready, off?.editable], [false, false, true]);
  assert.deepEqual([running?.on, running?.ready, running?.editable], [true, false, false]);
  assert.deepEqual([failed?.on, failed?.editable], [false, true]);
  // A cancelled routine is gone from the list.
  assert.equal(memberRoutines([task({ status: "cancelled" })]).length, 0);
});

test("最近运行 shows three, and up to twenty when opened", () => {
  const history = Array.from({ length: 25 }, (_, n) => run(n + 1));
  const closed = routineRunRows(history, false);
  assert.equal(closed.rows.length, 3);
  assert.equal(closed.more, 17);
  const open = routineRunRows(history, true);
  assert.equal(open.rows.length, 20);
  assert.equal(open.more, 0);
  assert.equal(open.rows[0]?.summary, "第 1 次");
  assert.deepEqual(routineRunRows(undefined, true), { rows: [], more: 0 });
  assert.equal(new Set(open.rows.map((row) => row.key)).size, 20, "keys are unique");
});

test("a run's label says why it ran and how it ended", () => {
  assert.equal(routineCauseLabel("schedule"), "按时");
  assert.equal(routineCauseLabel("test"), "测试");
  assert.equal(routineCauseLabel("mail:<abc@x>"), "新邮件");
  const rows = routineRunRows(
    [
      run(1, { cause: "test" }),
      run(2, { status: "failed", cause: "mail:m1", summary: "邮箱读不到" }),
    ],
    true,
  ).rows;
  assert.equal(rows[0]?.label, "测试 · 成功");
  assert.equal(rows[0]?.ok, true);
  assert.equal(rows[1]?.label, "新邮件 · 失败");
  assert.equal(rows[1]?.ok, false);
});

test("the 修改 form sends only what changed, and says what to fix", () => {
  const original = routineDraftOf({
    title: "晨报",
    prompt: "整理昨天的情况",
    routine: routine({ trigger: { type: "weekly", at: "08:00", days: [1, 3] } }),
  });
  assert.equal(original.type, "weekly");
  assert.deepEqual(original.days, [1, 3]);
  assert.deepEqual(routineDraftBody(original, original), { error: "没有改动" });
  assert.deepEqual(routineDraftBody({ ...original, name: " 早报 " }, original), {
    body: { name: "早报" },
  });
  // Same days in another order is not a change.
  assert.deepEqual(routineDraftBody({ ...original, days: [3, 1] }, original), {
    error: "没有改动",
  });
  assert.deepEqual(routineDraftBody({ ...original, type: "daily", at: "07:30" }, original), {
    body: { trigger: { type: "daily", at: "07:30" } },
  });
  assert.deepEqual(
    routineDraftBody({ ...original, type: "mail", from: " boss ", subjectHas: "" }, original),
    { body: { trigger: { type: "mail", from: "boss" } } },
  );
  assert.deepEqual(routineDraftBody({ ...original, name: "  " }, original), {
    error: "名称不能空",
  });
  assert.deepEqual(routineDraftBody({ ...original, instruction: "" }, original), {
    error: "要做什么不能空",
  });
  assert.deepEqual(routineDraftBody({ ...original, at: "9点" }, original), {
    error: "时间写成 09:00 这样",
  });
  assert.deepEqual(routineDraftBody({ ...original, days: [] }, original), { error: "至少选一天" });
  assert.deepEqual(routineDraftBody({ ...original, type: "every", minutes: "0" }, original), {
    error: "间隔填 1 到 10080 分钟",
  });
});

test("Yuki's routines in her own chat: the triggered ones on no account; a one-off task is not one", () => {
  const rows = yukiRoutines([
    task({ id: "hers" }),
    task({ id: "member", input: { environmentId: "env-1" } }),
    task({ id: "once", routine: undefined, repeatMinutes: undefined, status: "waiting_input" }),
    task({ id: "plain", routine: undefined, repeatMinutes: 60 }),
    task({ id: "gone", status: "cancelled" }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["hers"],
  );
  assert.equal(rows[0]?.when, "每天 09:00");
});
