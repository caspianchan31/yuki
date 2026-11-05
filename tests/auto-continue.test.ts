// Fork: a one-off task whose model run ends without a completion call (the step cap, or a reply
// with no tool call) is queued again automatically. As often as needed: there
// is no limit (AGENT_AUTO_CONTINUE_RUNS is gone, like the waits limit) and it never asks the
// person; they can pause or cancel the task. A completion or a user answer resets the count the
// next run's message carries.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { runEndedWithoutCompletion } from "../apps/server/src/engine/model.ts";
import { modelFixture } from "./helpers/model.ts";

const owner = "auto-continue-owner";
const note = (count: number) => `continues the task automatically (continuation ${count})`;

async function app(t: TestContext, overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auto-continue-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...overrides,
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return server;
}

/** Runs one worker tick and returns the model request bodies that run sent. */
async function tick(server: Awaited<ReturnType<typeof app>>, requests: { body: string }[]) {
  const from = requests.length;
  await server.agent.worker.tick();
  return requests.slice(from).map((request) => request.body);
}

test("AGENT_AUTO_CONTINUE_RUNS is gone: setting it changes nothing and is not read", (t) => {
  const keys = ["AGENT_AUTO_CONTINUE_RUNS", "CPK_INTELLIGENCE_API_KEY"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Even a value the old check refused no longer stops the server: nothing reads it.
  for (const value of ["0", "3", "three"]) {
    process.env.AGENT_AUTO_CONTINUE_RUNS = value;
    assert.equal("agentAutoContinueRuns" in readConfig(), false);
  }
});

test("a one-off run that hits the step cap continues by itself, run after run, and never asks", async (t) => {
  // Every model step plans again, so each run stops at the two-step cap without completing.
  const { requests } = await modelFixture(t, () => ({
    name: "set_plan",
    arguments: { steps: ["Open the site", "Post the update"] },
  }));
  const server = await app(t, { agentMaxSteps: 2 });
  const task = await server.agent.createTask(owner, { prompt: "Post the weekly update" });

  const first = await tick(server, requests);
  assert.equal(first.length, 2);
  assert.ok(
    !first[0].includes("continues the task automatically"),
    "a first run is not a continuation",
  );
  let detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "queued", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.state.autoContinued, 1);
  assert.ok(!detail.task.question);
  const continuing = detail.events.find((event) => event.title === "Continuing automatically");
  assert.equal(continuing?.kind, "status");
  assert.match(continuing?.detail ?? "", /without a completion call/);

  // Past the old cap of 3: it goes on, and nothing ever asks the person.
  for (const count of [1, 2, 3, 4, 5]) {
    const bodies = await tick(server, requests);
    assert.ok(bodies[0].includes(note(count)), `run ${count + 1} is told it continues`);
    assert.ok(bodies[0].includes("finish_task"));
    detail = await server.agent.detail(owner, task.id);
    assert.equal(detail.task.status, "queued", `run ${count + 1}`);
    assert.ok(!detail.task.question);
    assert.equal(detail.task.state.autoContinued, count + 1);
  }
  // No count and no limit in the timeline, and no question.
  assert.ok(!detail.events.some((event) => /\d+\/\d+|Waiting for you/.test(event.title)));
  assert.ok(!(await server.agent.detail(owner, task.id)).task.question);
  // The person can stop it: Pause takes it out of the queue.
  const paused = await server.agent.control(owner, task.id, "pause");
  assert.equal(paused.status, "paused");
  assert.equal((await tick(server, requests)).length, 0);
});

test("a user answer resets the counter and stays in the continued run's message", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "ask_user", arguments: { question: "Which folder?" } } : undefined,
  );
  const server = await app(t);
  const task = await server.agent.createTask(owner, { prompt: "Tidy the inbox" });
  await tick(server, requests);
  let saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "waiting_input");
  assert.equal(saved.question, "Which folder?");

  const answered = await server.agent.answer(owner, task.id, "Keep going with the newsletters");
  assert.equal(answered.status, "queued");
  const afterAnswer = await tick(server, requests);
  assert.ok(afterAnswer[0].includes("Additional answer: Keep going with the newsletters"));
  assert.ok(!afterAnswer[0].includes("continues the task automatically"));
  saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.autoContinued, 1);
  assert.equal(saved.state.answer, "Keep going with the newsletters");

  const continued = await tick(server, requests);
  assert.ok(continued[0].includes("Additional answer: Keep going with the newsletters"));
  assert.ok(continued[0].includes(note(1)));
  saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.autoContinued, 2);
  assert.equal(saved.state.answer, "Keep going with the newsletters");
});

test("a completion after a continuation resets the counter", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? undefined : { name: "finish_task", arguments: { summary: "Inbox is tidy." } },
  );
  const server = await app(t);
  const task = await server.agent.createTask(owner, { prompt: "Tidy the inbox" });
  await tick(server, requests);
  assert.equal((await server.agent.getTask(owner, task.id)).state.autoContinued, 1);
  const bodies = await tick(server, requests);
  assert.ok(bodies[0].includes(note(1)));
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.result, "Inbox is tidy.");
  assert.equal(saved.state.autoContinued, 0);
  assert.equal(saved.artifactIds.length, 1, "the run's saved state is kept");
});

test("a real question still waits for the person", async (t) => {
  const { requests } = await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Which account?" },
  }));
  const server = await app(t);
  const asks = await server.agent.createTask(owner, { prompt: "Post the update" });
  await tick(server, requests);
  const waiting = await server.agent.getTask(owner, asks.id);
  assert.equal(waiting.status, "waiting_input");
  assert.equal(waiting.question, "Which account?");
  assert.notEqual(waiting.question, runEndedWithoutCompletion);
  assert.equal(waiting.state.autoContinued, undefined);
});
