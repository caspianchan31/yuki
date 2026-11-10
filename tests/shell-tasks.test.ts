// v1.7.2 快照只带活的 (packages/domain/src/shell-tasks.ts): which tasks the shell's snapshot carries.
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../packages/client/src/api-response.ts";
import { taskCardLines } from "../packages/client/src/shell/chat/core.ts";
import { needItems, taskEntries } from "../packages/client/src/shell/model.ts";
import {
  cardNeedsRead,
  cardTask,
  detailEntry,
  planBlock,
  readTaskOnce,
  trimmedTask,
} from "../packages/client/src/shell/task/detail-core.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { shellTasks, trimFinishedTask } from "../packages/domain/src/shell-tasks.ts";
import { taskPhase } from "../packages/domain/src/task-phase.ts";

const day = 86_400_000;
const now = Date.parse("2026-11-09T12:00:00.000Z");
const task = (
  id: string,
  status: AgentTask["status"],
  agoDays: number,
  extra: Partial<AgentTask> = {},
): AgentTask => ({
  id,
  title: id,
  prompt: id,
  kind: "agent",
  status,
  plan: [{ id: "s1", title: "step", status: "pending" } as never],
  evidence: [{ id: "e1", kind: "web", title: "x", summary: "y" } as never],
  input: { environmentId: "env-1" },
  state: { lastShot: "s" },
  createdAt: new Date(now - (agoDays + 1) * day).toISOString(),
  updatedAt: new Date(now - agoDays * day).toISOString(),
  attempts: 0,
  artifactIds: [],
  ...extra,
});

test("live tasks and routines stay whole; finished ones of the last week come trimmed; older ones go", () => {
  const routine = task("r", "succeeded", 30, {
    routine: { trigger: { kind: "interval" } } as never,
    nextRunAt: new Date(now + day).toISOString(),
  });
  const cancelledRoutine = task("r-off", "cancelled", 1, {
    routine: { trigger: { kind: "interval" } } as never,
  });
  const restingRoutineNoNext = task("r-done", "succeeded", 20, {
    routine: { trigger: { kind: "interval" } } as never,
  });
  const tasks = [
    task("running", "running", 40),
    task("queued", "queued", 0),
    task("waiting", "waiting_input", 10),
    task("done-2d", "succeeded", 2),
    task("failed-6d", "failed", 6),
    task("cancelled-8d", "cancelled", 8),
    task("done-40d", "succeeded", 40),
    routine,
    cancelledRoutine,
    restingRoutineNoNext,
  ];
  const kept = shellTasks(tasks, { now });
  assert.deepEqual(
    kept.map((t) => t.id),
    ["running", "queued", "waiting", "done-2d", "failed-6d", "r", "r-off", "r-done"],
  );
  const running = kept.find((t) => t.id === "running");
  assert.equal(running?.plan.length, 1, "a live task keeps its plan");
  const done = kept.find((t) => t.id === "done-2d");
  assert.deepEqual(done?.plan, []);
  assert.deepEqual(done?.evidence, []);
  assert.deepEqual(done?.input, { environmentId: "env-1" }, "what the shell reads stays");
  assert.deepEqual(done?.state, { lastShot: "s" });
  assert.equal(
    kept.find((t) => t.id === "r")?.plan.length,
    1,
    "a routine with a next run stays whole",
  );
  assert.deepEqual(kept.find((t) => t.id === "r-off")?.plan, [], "a cancelled routine is past");
  assert.equal(
    kept.find((t) => t.id === "r-done")?.plan.length,
    1,
    "a routine with no next run (one started by mail) rests, it is not past",
  );
});

test("at most `max` finished tasks, the newest", () => {
  const tasks = Array.from({ length: 150 }, (_, i) => task(`t${i}`, "succeeded", i / 100));
  const kept = shellTasks(tasks, { now, max: 100 });
  assert.equal(kept.length, 100);
  assert.ok(
    kept.every((t) => Number(t.id.slice(1)) < 100),
    "the newest hundred",
  );
  // the one exactly at the boundary counts
  assert.equal(shellTasks(tasks, { now, days: 0.5 }).length, 51);
});

test("trimFinishedTask leaves every other field", () => {
  const t = task("x", "succeeded", 1, { result: "done", runs: 3 });
  const trimmed = trimFinishedTask(t);
  assert.deepEqual({ ...trimmed, plan: t.plan, evidence: t.evidence }, t);
});

// What 需要你 is made of: the entries whose phase says needsYou (shell/model.ts needItems).
const needIds = (tasks: AgentTask[]) =>
  needItems({ entries: taskEntries(tasks, now), actions: [], accounts: [] }).map((n) => n.key);

test("a task that still asks something of the person never leaves the snapshot, however old", () => {
  const quota = "insufficient_quota: You exceeded your current quota";
  // A standing task (its operating plan saved) on the default desktop, failed for what only the
  // owner can fix: it stays in 需要你 with no expiry.
  const standing = task("standing-30d", "failed", 30, {
    input: {},
    state: { operatingPlan: { version: 1, communities: ["a"] } },
    error: quota,
  });
  const legacyLoop = task("loop-90d", "failed", 90, { input: { accountLoop: true }, error: "x" });
  const failedMailRoutine = task("mail-routine-30d", "failed", 30, {
    routine: { trigger: { type: "mail" } } as never,
    error: quota,
  });
  const tasks = [
    standing,
    legacyLoop,
    failedMailRoutine,
    task("failed-30d", "failed", 30),
    task("done-30d", "succeeded", 30),
  ];
  assert.equal(taskPhase(standing, { now }).needsYou, true, "the fixture is a 需要你 task");
  const kept = shellTasks(tasks, { now });
  assert.deepEqual(
    kept.map((t) => t.id),
    ["standing-30d", "loop-90d", "mail-routine-30d"],
  );
  // The rule itself: the person's list is the same from the snapshot as from every task.
  assert.deepEqual(needIds(kept), needIds(tasks));
  assert.deepEqual(needIds(kept).sort(), ["task:loop-90d", "task:standing-30d"]);
  assert.deepEqual(kept[0]?.plan, [], "it is still a finished task: trimmed");
});

test("a recent failure still in 需要你 is kept beyond `max`", () => {
  const tasks = [
    task("failed-6d", "failed", 6),
    ...Array.from({ length: 120 }, (_, i) => task(`t${i}`, "succeeded", i / 100)),
  ];
  const kept = shellTasks(tasks, { now, max: 100 });
  assert.ok(kept.some((t) => t.id === "failed-6d"));
  assert.equal(kept.length, 101);
  assert.deepEqual(needIds(kept), needIds(tasks));
});

test("detail: the read task's plan and evidence win over the snapshot's trimmed copy", () => {
  const full = task("t", "failed", 2, {
    input: {},
    plan: [
      { id: "s1", title: "find the page", status: "succeeded" },
      { id: "s2", title: "write it up", status: "failed" },
    ] as never,
  });
  const [live] = taskEntries(shellTasks([full], { now }), now);
  assert.ok(live && trimmedTask(live.task));
  assert.equal(planBlock(live.task, true), null, "the trimmed copy alone has no plan");
  const entry = detailEntry(live, full, now, false);
  assert.equal(entry?.task.plan.length, 2);
  assert.equal(entry?.task.evidence.length, 1);
  assert.equal(planBlock(entry?.task ?? live.task, true)?.lines.length, 2);
  assert.equal(entry?.phase, live.phase, "the state stays the polled copy's");
  // The chat card's step line comes back with it.
  assert.doesNotMatch(taskCardLines(live, now).meta, /步/);
  assert.match(taskCardLines(entry ?? live, now).meta, /第 \d\/2 步/);
  // A live task's own copy is the newer one: nothing replaces it.
  const [running] = taskEntries([task("t", "running", 0)], now);
  assert.equal(detailEntry(running, full, now, false), running);
  assert.equal(detailEntry(live, null, now, false), live);
  assert.equal(detailEntry(undefined, full, now, false)?.task.plan.length, 2);
});

test("chat card: a task the snapshot does not carry is read, and is never called gone unless it is", async () => {
  const old = task("old", "succeeded", 40, { input: { environmentId: "env-9" } });
  assert.deepEqual(shellTasks([old], { now }), []);
  assert.equal(cardNeedsRead(undefined, false), true);
  const [trimmed] = taskEntries(shellTasks([task("d", "succeeded", 1)], { now }), now);
  assert.equal(cardNeedsRead(trimmed, false), false);
  assert.equal(cardNeedsRead(trimmed, true), true);
  const base = { live: undefined, now, stalled: false };
  // Not read yet, however fresh the list: not known, not gone.
  assert.deepEqual(cardTask({ ...base, read: null, listChecked: true }), {
    entry: null,
    missing: false,
  });
  const found = cardTask({ ...base, read: { task: old }, listChecked: true });
  assert.equal(found.missing, false);
  assert.equal(found.entry?.task.id, "old");
  assert.equal(found.entry?.environmentId, "env-9", "the card keeps its account");
  // Gone only when the read says so and a list newer than the first look lacks it too.
  const gone = { task: null, missing: true } as const;
  assert.equal(cardTask({ ...base, read: gone, listChecked: false }).missing, false);
  assert.equal(cardTask({ ...base, read: gone, listChecked: true }).missing, true);

  let calls = 0;
  const answers: Record<string, () => unknown> = {
    old: () => ({ task: old, events: [], artifacts: [] }),
    none: () => {
      throw new ApiError("Task not found", 404);
    },
    down: () => {
      throw new ApiError("Bad gateway", 502);
    },
  };
  const api = {
    request: async <T>(path: string): Promise<T> => {
      calls += 1;
      const id = decodeURIComponent(path.split("/").pop() ?? "");
      assert.equal(path, `/api/agent/tasks/${id}`);
      return (answers[id] as () => T)();
    },
  };
  assert.equal((await readTaskOnce(api, "old")).task?.id, "old");
  await readTaskOnce(api, "old");
  assert.equal(calls, 1, "one read however many cards ask");
  assert.deepEqual(await readTaskOnce(api, "none"), { task: null, missing: true });
  await assert.rejects(readTaskOnce(api, "down"));
  await assert.rejects(readTaskOnce(api, "down"));
  assert.equal(calls, 4, "a failed read is not remembered, and is not a missing task");
});
