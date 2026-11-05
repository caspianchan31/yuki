// While a deploy drains the worker, no new run
// starts (queued, scheduled or one a dead process left behind); the heartbeat goes on; once the
// drain ends the same tasks run. The service drains while `<dataDir>/drain` exists.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { drainFileName, TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

const task = (id: string, over: Partial<AgentTask> = {}): AgentTask => ({
  id,
  title: "t",
  prompt: "t",
  kind: "agent",
  status: "queued",
  plan: [],
  evidence: [],
  input: {},
  state: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempts: 0,
  leaseId: null,
  leaseUntil: null,
  artifactIds: [],
  ...over,
});

test("draining starts no run; the same tasks run once it ends", async () => {
  const db = await createStore();
  const past = new Date(Date.now() - 60_000).toISOString();
  await db.put("space:a", "tasks", task("queued"));
  await db.put("space:a", "tasks", task("due", { status: "scheduled", nextRunAt: past }));
  await db.put("space:a", "tasks", task("orphan", { status: "running", leaseUntil: past }));
  const directory = await mkdtemp(join(tmpdir(), "om-drain-"));
  const flag = join(directory, drainFileName);
  const { existsSync } = await import("node:fs");
  const ran: string[] = [];
  const worker = new TaskWorker(
    db,
    async (_owner, t) => {
      ran.push(t.id);
      return { status: "succeeded" as const, result: "ok" };
    },
    { draining: () => existsSync(flag) },
  );
  try {
    await writeFile(flag, "");
    assert.equal(worker.draining, true);
    await worker.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ran, [], "nothing starts while draining");
    assert.equal((await db.get<AgentTask>("space:a", "tasks", "queued"))?.status, "queued");
    await rm(flag);
    assert.equal(worker.draining, false);
    await worker.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ran.sort(), ["due", "orphan", "queued"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await db.close();
  }
});
