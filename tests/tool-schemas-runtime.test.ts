// Fork: the tool input schemas the model receives must be valid JSON Schema 2020-12 without tuple
// items. A z.tuple becomes prefixItems (or array items), which the model API rejected in
// production. tool-schemas.test.ts converts the domain schemas; this test reads the tools out of
// the requests the model provider actually receives, for a task run bound to an account (the
// sign-in, pacing and profile tools) and for a chat reply on an account, so a tool built with an
// inline schema anywhere is covered too.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { Ajv2020 } from "ajv/dist/2020.js";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { harness } from "./helpers/sign-in-harness.ts";

type SentTool = {
  name?: string;
  parameters?: unknown;
  function?: { name?: string; parameters?: unknown };
};

const tuplish = (node: unknown): boolean => {
  if (!node || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  if ("prefixItems" in record || Array.isArray(record.items)) return true;
  return Object.values(record).some(tuplish);
};

/** Every tool in every request the provider received: name → its input schema. */
function sentTools(requests: { body: string }[]) {
  const tools = new Map<string, unknown>();
  for (const request of requests) {
    const body = JSON.parse(request.body) as { tools?: SentTool[] };
    for (const tool of body.tools ?? []) {
      const name = tool.name ?? tool.function?.name;
      const schema = tool.parameters ?? tool.function?.parameters;
      if (name) tools.set(name, schema);
    }
  }
  return tools;
}

function assertValid(tools: Map<string, unknown>) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const [name, schema] of tools) {
    assert.ok(schema && typeof schema === "object", `${name} has an input schema`);
    assert.equal(
      ajv.validateSchema(schema as object),
      true,
      `${name}: ${JSON.stringify(ajv.errors)}`,
    );
    assert.equal(tuplish(schema), false, `${name} uses tuple items`);
  }
}

test("every tool schema a task run on an account sends to the model is valid JSON Schema 2020-12 without tuple items", async (t) => {
  const h = await harness(t);
  await h.account("Alice", [{ site: "example.com", username: "alice", password: "pw-not-real" }]);
  h.queue.push({ name: "finish_task", arguments: { summary: "Done." } });
  await h.agent.worker.tick();
  // A task on no account too: the open build has no accounts, and its run sends the tools.
  await h.agent.createTask(h.owner, { prompt: "Check the weather" });
  h.queue.push({ name: "finish_task", arguments: { summary: "Done." } });
  await h.agent.worker.tick();
  const tools = sentTools(h.requests);
  for (const name of [
    "report_to_user",
    "finish_task",
    // v1.5: a member's own files
    "read_member_file",
    "update_member_file",
    "note_today",
  ])
    assert.ok(tools.has(name), `${name} reaches the model (got ${[...tools.keys()].join(", ")})`);
  assertValid(tools);
});

test("every tool schema a chat reply on an account sends to the model is valid JSON Schema 2020-12 without tuple items", async (t) => {
  const h = await harness(t);
  await h.account("Alice", [{ site: "example.com", username: "alice", password: "pw-not-real" }]);
  const input: RunAgentInput = {
    threadId: "thread-schemas",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Work on the account" }],
    tools: [],
    context: [],
    state: {},
  };
  await lastValueFrom(new ConversationAgent(h.config, h.agent, h.owner).run(input).pipe(toArray()));
  const tools = sentTools(h.requests);
  for (const name of [
    "set_account_persona",
    "set_account_goal",
    "read_account",
    // v1.5: a member's own files
    "remember_fact",
    "read_member_file",
    "update_member_file",
    "note_today",
  ])
    assert.ok(tools.has(name), `${name} reaches the model (got ${[...tools.keys()].join(", ")})`);
  assertValid(tools);
});
