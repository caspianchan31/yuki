import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { modelFixture } from "./helpers/model.ts";

test("AGENT_MAX_STEPS is optional and accepts whole numbers from 1 to 1000", (t) => {
  const keys = ["AGENT_MAX_STEPS", "CPK_INTELLIGENCE_API_KEY"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.AGENT_MAX_STEPS;
  assert.equal(readConfig().agentMaxSteps, undefined);
  for (const blank of ["", "  "]) {
    process.env.AGENT_MAX_STEPS = blank;
    assert.equal(readConfig().agentMaxSteps, undefined, "blank keeps the built-in limits");
  }
  for (const [value, steps] of [
    ["1", 1],
    [" 40 ", 40],
    ["200", 200],
  ] as const) {
    process.env.AGENT_MAX_STEPS = value;
    assert.equal(readConfig().agentMaxSteps, steps);
  }
  for (const value of ["0", "-3", "1001", "12.5", "1e2", "0x10", "ten"]) {
    process.env.AGENT_MAX_STEPS = value;
    assert.throws(() => readConfig(), {
      message: "AGENT_MAX_STEPS must be a whole number from 1 to 1000",
    });
  }
});

async function app(t: TestContext, overrides: Partial<Config>) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-max-steps-"));
  const db = await createStore();
  const config: Config = {
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
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { config, server };
}

for (const [overrides, steps] of [
  [{}, 16],
  [{ agentMaxSteps: 3 }, 3],
] as const) {
  test(`a chat reply that keeps calling tools stops after ${steps} model steps`, async (t) => {
    const { requests } = await modelFixture(t, () => ({ name: "agent_status", arguments: {} }));
    const { config, server } = await app(t, overrides);
    const conversation = new ConversationAgent(config, server.agent, "local-user");
    const events = await lastValueFrom(
      conversation
        .run({
          threadId: "max-steps-chat",
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "Check everything" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    assert.equal(requests.length, steps);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.ok(
      events.some((event) => /step limit/.test((event as { delta?: string }).delta ?? "")),
      "the cut-off reply says it hit the step limit",
    );
  });
}

for (const [overrides, steps] of [
  [{}, 16],
  [{ agentMaxSteps: 3 }, 3],
] as const) {
  test(`a background task that keeps calling tools stops after ${steps} model steps`, async (t) => {
    const { requests } = await modelFixture(t, () => ({
      name: "set_plan",
      arguments: { steps: ["Look around"] },
    }));
    const { server } = await app(t, overrides);
    const task = await server.agent.createTask("owner", { prompt: "Keep planning" });
    await server.agent.worker.tick();
    const saved = await server.agent.getTask("owner", task.id);
    // The capped run ended without a completion call, so the one-off task is queued to continue
    // automatically (auto-continue.test.ts) instead of waiting for input.
    assert.equal(saved.status, "queued", saved.error ?? saved.question);
    assert.equal(saved.state.autoContinued, 1);
    assert.equal(requests.length, steps);
  });
}
