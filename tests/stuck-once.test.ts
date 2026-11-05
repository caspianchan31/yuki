// a run that only looked waits a second time only after naming what blocks it; the same part
// blocking run after run reaches the owner and is not probed at the same pace.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { incidentWaitsBeforeOwner, runTrouble } from "../packages/domain/src/standing.ts";
import { harness } from "./helpers/sign-in-harness.ts";

const runs = async (h: Awaited<ReturnType<typeof harness>>, id: string) => {
  await h.db.compareAndSwap<AgentTask>(
    h.owner,
    "tasks",
    id,
    {},
    { nextRunAt: new Date(0).toISOString() },
  );
  await h.agent.worker.tick();
  return (await h.db.get<AgentTask>(h.owner, "tasks", id)) as AgentTask;
};

test("blocked once shows on the task; blocked by the same part again is the owner's, and the next try waits longer", async (t) => {
  const h = await harness(t);
  const task = await h.agent.createTask(h.owner, { prompt: "核验第二批 10 家" });
  h.queue.push({
    name: "wait_until",
    arguments: { minutes: 60, note: "桌面连不上网", blocked: "network" },
  });
  let now = await runs(h, task.id);
  assert.equal(now.status, "scheduled");
  assert.equal((now.state.incident as { kind: string; waits: number }).kind, "network");
  assert.equal((now.state.incident as { waits: number }).waits, 1);
  assert.equal(runTrouble(now), null, "once: shown on the task's line, not yet a need");
  h.queue.push({
    name: "wait_until",
    arguments: { minutes: 60, note: "还是连不上网", blocked: "network" },
  });
  const before = Date.now();
  now = await runs(h, task.id);
  assert.equal((now.state.incident as { waits: number }).waits, incidentWaitsBeforeOwner);
  const trouble = runTrouble(now);
  assert.ok(trouble, "the same block again is the owner's");
  assert.equal(trouble.detail, "Blocked: network");
  assert.ok(Date.parse(now.nextRunAt ?? "") - before >= 2 * 60 * 60_000 - 5000, now.nextRunAt);
  // A wait with nothing blocking ends it, and the need goes with it.
  h.queue.push({ name: "wait_until", arguments: { minutes: 60, note: "等对方回复" } });
  now = await runs(h, task.id);
  assert.equal(runTrouble(now), null);
});
