import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { MODEL_MAX_RETRIES } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { claimCheckAttempts } from "../apps/server/src/mail/claim-check.ts";
import { reviewAttempts } from "../apps/server/src/review/action-review.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";

for (const scenario of [
  {
    name: "finish_task",
    arguments: { summary: "The requested work is complete." },
    status: "succeeded",
  },
  {
    name: "ask_user",
    arguments: { question: "Which date should I use?" },
    status: "waiting_input",
  },
  {
    name: "prepare_event",
    arguments: {
      title: "Sample walk",
      start: "2026-10-10T10:00:00-07:00",
      end: "2026-10-10T11:00:00-07:00",
    },
    status: "waiting_approval",
  },
  {
    name: "prepare_email",
    arguments: { to: ["friend@example.com"], subject: "Sample plan", body: "A walk tomorrow?" },
    status: "waiting_approval",
  },
]) {
  test(`${scenario.name} settles the task without another model request`, async (t) => {
    const { requests } = await modelFixture(t, () => scenario, {
      // A provider failure after the outcome must not replace it with a failed task.
      errorStatus: (index) => (index > 0 ? 503 : undefined),
    });
    const directory = await mkdtemp(join(tmpdir(), "openmuse-model-outcome-"));
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
    });
    try {
      const task = await server.agent.createTask("owner", { prompt: "Make a sample plan" });
      await server.agent.worker.tick();
      const saved = await server.agent.getTask("owner", task.id);
      assert.equal(saved.status, scenario.status, saved.error ?? saved.question);
      // An email's own check (mail/claim-check.ts) is more requests: its attempts, each retried
      // by the provider SDK on this 503; they failed, so the review is marked unchecked.
      // A calendar action has the action review's call (review/action-review.ts), which fails
      // the same way, so the card asks.
      assert.equal(
        requests.length,
        scenario.name === "prepare_email"
          ? 1 + claimCheckAttempts * (1 + MODEL_MAX_RETRIES)
          : scenario.name === "prepare_event"
            ? 1 + reviewAttempts * (1 + MODEL_MAX_RETRIES)
            : 1,
        "the outcome ends the model loop before its next turn",
      );
      if (scenario.status === "succeeded") assert.equal(saved.result, scenario.arguments.summary);
      if (scenario.status === "waiting_input")
        assert.equal(saved.question, scenario.arguments.question);
      if (scenario.status === "waiting_approval") {
        assert.ok(saved.actionId);
        const proposal = await db.get<ActionProposal>("owner", "actions", saved.actionId);
        assert.equal(proposal?.status, "awaiting_review", "a model never approves the action");
        if (scenario.name === "prepare_email")
          assert.equal(proposal?.claimCheck?.status, "unchecked");
      }
    } finally {
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
