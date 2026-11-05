// Fork: a background task can repeat every N minutes. A finished run schedules the next one
// (and each run notifies), a new run starts from a clean plan, failures retry at the next
// interval and pause after five in a row, and the schedule can be changed or stopped.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentNotification, AgentTask } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

const config = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  model: "openai/fixture",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
});
const due = (db: Awaited<ReturnType<typeof createStore>>, owner: string, id: string) =>
  db.compareAndSwap(
    owner,
    "tasks",
    id,
    { status: "scheduled" },
    { nextRunAt: "2020-01-01T00:00:00Z" },
  );

test("a repeating task runs again after its interval, each run from a clean plan", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-repeat-"));
  const db = await createStore();
  let run = 0;
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: `Checked the feed (run ${++run})` },
  }));
  const server = await createApp(db, config(directory));
  const owner = "local-user";
  const token = (
    await (
      await server.app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()
  ).token as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.app.request(`/api/agent${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    // Only open-ended tasks repeat; the interval is bounded.
    await assert.rejects(
      () => server.agent.createTask(owner, { prompt: "x", kind: "document", repeatMinutes: 5 }),
      /Only general and plan tasks can repeat/,
    );
    await assert.rejects(() => server.agent.createTask(owner, { prompt: "x", repeatMinutes: 0 }));
    const before = Date.now();
    const task = await server.agent.createTask(owner, {
      title: "Check the feed",
      prompt: "Look at the feed and note anything new",
      repeatMinutes: 5,
    });
    assert.equal(task.repeatMinutes, 5);
    assert.equal(task.runs, 0);
    assert.equal(task.status, "queued");

    await server.agent.worker.tick();
    let detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.runs, 1);
    assert.equal(detail.task.result, "Checked the feed (run 1)");
    const nextRunAt = Date.parse(detail.task.nextRunAt ?? "");
    assert.ok(nextRunAt >= before + 5 * 60000 - 1000 && nextRunAt <= Date.now() + 5 * 60000 + 1000);
    assert.ok(detail.task.plan.every((step) => step.status === "succeeded"));
    assert.ok(detail.events.some((event) => event.title === "Run 1 started"));
    // Not due yet: another tick changes nothing.
    await server.agent.worker.tick();
    detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.runs, 1);

    await due(db, owner, task.id);
    await server.agent.worker.tick();
    detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
    assert.equal(detail.task.runs, 2);
    assert.equal(detail.task.result, "Checked the feed (run 2)");
    assert.ok(detail.events.some((event) => event.title === "Run 2 started"));
    // Each run notified once.
    const notifications = await db.list<AgentNotification>(owner, "notifications");
    const runNotices = notifications.filter((n) => n.title === "Check the feed");
    assert.equal(runNotices.length, 2);

    // "Run now" queues the next run immediately.
    const runNow = await call("POST", `/tasks/${task.id}/control`, { action: "run" });
    assert.equal(runNow.status, 200);
    assert.equal(runNow.body.status, "queued");
    assert.equal((await call("POST", `/tasks/${task.id}/control`, { action: "run" })).status, 409);
    await server.agent.worker.tick();
    detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.runs, 3);
    assert.equal(detail.task.status, "scheduled");

    // Changing the interval moves the next run; stopping completes the task with its result.
    const slower = await call("PATCH", `/tasks/${task.id}`, { repeatMinutes: 60 });
    assert.equal(slower.status, 200);
    assert.equal(slower.body.repeatMinutes, 60);
    assert.ok(Date.parse(slower.body.nextRunAt) >= Date.now() + 59 * 60000);
    assert.equal((await call("PATCH", `/tasks/${task.id}`, { repeatMinutes: 99999 })).status, 422);
    const stopped = await call("PATCH", `/tasks/${task.id}`, { repeatMinutes: null });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, "succeeded");
    assert.equal(stopped.body.result, "Checked the feed (run 3)");
    assert.equal(stopped.body.repeatMinutes, null);
    // And a finished task can be made to repeat again.
    const again = await call("PATCH", `/tasks/${task.id}`, { repeatMinutes: 1 });
    assert.equal(again.body.status, "scheduled");
    // The task shows up in the workspace snapshot with its schedule.
    const snapshot = await call("GET", "");
    const listed = (snapshot.body.tasks as AgentTask[]).find((item) => item.id === task.id);
    assert.equal(listed?.repeatMinutes, 1);
    assert.equal(listed?.runs, 3);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeating task retries a failed run at the next interval and pauses after five", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-repeat-fail-"));
  const db = await createStore();
  await modelFixture(t, () => undefined, { errorStatus: () => 500 });
  const server = await createApp(db, config(directory));
  const owner = "repeat-fail-owner";
  try {
    const task = await server.agent.createTask(owner, {
      title: "Flaky job",
      prompt: "Do the flaky thing",
      repeatMinutes: 2,
    });
    for (let failures = 1; failures <= 4; failures++) {
      await server.agent.worker.tick();
      const detail = await server.agent.detail(owner, task.id);
      assert.equal(detail.task.status, "scheduled", `after failure ${failures}`);
      assert.ok(detail.task.error);
      assert.equal(detail.task.state.failures, failures);
      assert.equal(detail.task.runs, 0);
      await due(db, owner, task.id);
    }
    await server.agent.worker.tick();
    const detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.status, "paused");
    assert.equal(detail.task.state.failures, 5);
    // One alert for the streak's retries and one for the pause, not five.
    const notifications = await db.list<AgentNotification>(owner, "notifications");
    assert.equal(notifications.filter((n) => n.title === "Flaky job failed").length, 1);
    assert.equal(notifications.filter((n) => n.title === "Flaky job paused").length, 1);
    // Resuming queues a fresh attempt.
    const resumed = await server.agent.control(owner, task.id, "resume");
    assert.equal(resumed.status, "queued");
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeating run that ends without a completion call counts as finished", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-repeat-"));
  const db = await createStore();
  // The model answers with no tool call: a one-off task continues by itself (see
  // auto-continue.test.ts), a repeating run counts as finished.
  await modelFixture(t, () => undefined);
  const server = await createApp(db, config(directory));
  const owner = "local-user";
  try {
    const once = await server.agent.createTask(owner, { prompt: "Say hello" });
    const repeating = await server.agent.createTask(owner, {
      prompt: "Say hello every hour",
      repeatMinutes: 60,
    });
    for (let tick = 0; tick < 5; tick++) {
      await server.agent.worker.tick();
      if ((await server.agent.getTask(owner, repeating.id)).status === "scheduled") break;
    }
    const continuing = await server.agent.detail(owner, once.id);
    assert.notEqual(continuing.task.status, "waiting_input");
    assert.ok(!continuing.task.question);
    const scheduled = await server.agent.detail(owner, repeating.id);
    assert.equal(
      scheduled.task.status,
      "scheduled",
      scheduled.task.error ?? scheduled.task.question,
    );
    assert.equal(scheduled.task.runs, 1);
    // No stand-in result and no 第 N 轮完成 card for a run without a
    // finish_task summary (docs/report-back.md).
    assert.ok(!scheduled.task.result);
    assert.ok(!("notice" in scheduled.task.state));
    assert.ok(!scheduled.task.question);
    assert.ok(
      scheduled.events.some(
        (event) => event.title === "Run ended without a completion call; counted as finished",
      ),
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
