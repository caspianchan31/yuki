// v1.4 acceptance fix: a hall request for no project, sent as the word "null" instead of JSON
// null, made a group named "null" with nobody in it. No group is made from it, the project
// service refuses such a name, and a stray group already made is not listed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import type { BrowserService } from "../apps/server/src/browser.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { ProjectService } from "../apps/server/src/projects.ts";
import type { Project } from "../packages/domain/src/projects.ts";
import { type Harness, harness } from "./helpers/sign-in-harness.ts";

function projectsOf(h: Harness) {
  const projects = new ProjectService(
    h.db,
    h.config,
    h.computer,
    h.environments,
    {} as BrowserService,
    h.agent,
  );
  return projects;
}
async function chat(h: Harness, text: string) {
  const input: RunAgentInput = {
    threadId: `thread-${randomUUID()}`,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
  };
  await lastValueFrom(new ConversationAgent(h.config, h.agent, h.owner).run(input).pipe(toArray()));
}
const stray = async (h: Harness, name = "null") => {
  const now = new Date().toISOString();
  const id = randomUUID();
  await h.db.put(h.owner, "projects", {
    id,
    name,
    deleting: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

test("a request for no project, said as the word null, makes no group", async (t) => {
  const h = await harness(t);
  const projects = projectsOf(h);
  h.queue.push({
    name: "route_request",
    arguments: { project: "null", why: "存一个技能，不属于任何项目" },
  });
  await chat(h, "把「晨报」存成技能：每天整理一页");
  assert.deepEqual(await projects.list(h.owner), []);
  assert.deepEqual(await h.db.list<Project>(h.owner, "projects"), []);
  // The person's own 新建群 refuses it the same way (the hall makes no group since v1.7.6).
  await assert.rejects(() => projects.create(h.owner, { name: "null" }), { status: 422 });
  await assert.rejects(() => projects.create(h.owner, { name: " None " }), { status: 422 });
});

test("a stray group already made is not listed, unless someone is in it", async (t) => {
  const h = await harness(t);
  const projects = projectsOf(h);
  const real = await projects.create(h.owner, { name: "运营组" });
  const emptyId = await stray(h);
  assert.deepEqual(
    (await projects.list(h.owner)).map((p) => p.name),
    ["运营组"],
  );
  const ann = await h.environments.create(h.owner, { name: "Ann" });
  await h.environments.move(h.owner, ann.id, null, emptyId);
  assert.deepEqual(
    (await projects.list(h.owner)).map((p) => p.name).sort(),
    ["null", "运营组"].sort(),
  );
  assert.ok(real.id);
});
