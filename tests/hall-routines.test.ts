// v1.4 (docs/routines.md「Yuki's own routines」; 2026-11-05 on a fresh install: 「每天早上 9 点跟我说一句
// 早安」 in Yuki's own chat made a one-off task and the reply said it was scheduled): a routine asked
// for in the hall is a real routine, Yuki's, in the space's scope, reporting in that chat; one for a
// group is made in that group; a task that runs once is answered as running once. The fixture plays
// the model's tool choices; whether a real model makes them is checked in acceptance (routine-home).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import type { BrowserService } from "../apps/server/src/browser.ts";
import {
  ConversationAgent,
  hallChatLine,
  onceNote,
  scheduleClaimRule,
} from "../apps/server/src/engine/conversation.ts";
import { routedProject, spaceOwnTool } from "../apps/server/src/engine/hall-gate.ts";
import { ProjectService } from "../apps/server/src/projects.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { projectOwner } from "../packages/domain/src/projects.ts";
import { isRoutine } from "../packages/domain/src/routines.ts";
import { type Harness, harness } from "./helpers/sign-in-harness.ts";

const body = (h: Harness, at: number) =>
  JSON.parse(h.requests[at]?.body ?? "{}") as {
    instructions: string;
    tools?: { name: string; parameters?: { properties?: Record<string, unknown> } }[];
    input: { type: string; output?: unknown }[];
  };
const lastOutput = (h: Harness) => {
  const items = body(h, h.requests.length - 1).input.filter(
    (item) => item.type === "function_call_output",
  );
  return JSON.parse(String(items.at(-1)?.output ?? "{}"));
};
async function chat(h: Harness, owner: string, text: string, threadId: string) {
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
  };
  await lastValueFrom(new ConversationAgent(h.config, h.agent, owner).run(input).pipe(toArray()));
}
function withProjects(h: Harness) {
  const projects = new ProjectService(
    h.db,
    h.config,
    h.computer,
    h.environments,
    {} as BrowserService,
    h.agent,
  );
  h.agent.createProject = (owner, name) => projects.create(owner, { name });
  return projects;
}
const routinesOf = async (h: Harness, owner: string) =>
  (await h.db.list<AgentTask>(owner, "tasks")).filter(isRoutine);

test("the hall with no groups: 「每天早上 9 点…」 makes Yuki's own routine, scheduled, reporting in that chat", async (t) => {
  const h = await harness(t);
  withProjects(h);
  const thread = `thread-${randomUUID()}`;
  h.queue.push(
    { name: "route_request", arguments: { project: null, why: "给你自己的提醒" } },
    {
      name: "create_routine",
      arguments: {
        name: "每日早安问候",
        instruction: "跟我说一句早安",
        trigger: { type: "daily", at: "09:00" },
      },
    },
  );
  await chat(h, h.owner, "每天早上 9 点跟我说一句早安", thread);
  const first = body(h, 0);
  assert.ok(first.instructions.includes(hallChatLine));
  assert.ok(first.instructions.includes(scheduleClaimRule));
  // The routing turn declares the routine tools; the reply for no project keeps all three.
  assert.ok(first.tools?.some((tool) => tool.name === "create_routine"));
  const names = body(h, 1).tools?.map((tool) => tool.name) ?? [];
  for (const name of ["create_routine", "update_routine", "list_routines"])
    assert.ok(names.includes(name), name);
  assert.ok(
    body(h, 1).tools?.find((tool) => tool.name === "create_routine")?.parameters?.properties
      ?.project,
    "the hall's create_routine names a group when it is one's",
  );

  const [routine] = await routinesOf(h, h.owner);
  assert.ok(routine, "a real routine exists");
  assert.equal(routine.title, "每日早安问候");
  assert.equal(routine.prompt, "跟我说一句早安");
  assert.deepEqual(routine.routine.trigger, { type: "daily", at: "09:00" });
  assert.equal(routine.status, "scheduled");
  assert.ok(routine.nextRunAt, "it waits for its next 09:00");
  assert.equal(routine.input.environmentId ?? null, null, "Yuki's own: no member's account");
  assert.equal(routine.originThreadId, thread, "it reports in the chat it was asked in");
  const made = lastOutput(h);
  assert.equal(made.created, true);
  assert.equal(made.routineId, routine.id);
  assert.equal(made.when, "每天 09:00");

  // list and update work on Yuki's own routines in the same chat.
  h.queue.push(
    { name: "route_request", arguments: { project: null, why: "改你的例行" } },
    { name: "list_routines", arguments: {} },
  );
  await chat(h, h.owner, "我有哪些例行？", thread);
  assert.deepEqual(
    lastOutput(h).routines.map((row: { routineId: string }) => row.routineId),
    [routine.id],
  );
  h.queue.push(
    { name: "route_request", arguments: { project: null, why: "改你的例行" } },
    {
      name: "update_routine",
      arguments: { routineId: routine.id, trigger: { type: "daily", at: "08:30" } },
    },
  );
  await chat(h, h.owner, "早安改到 8 点半", thread);
  assert.equal(lastOutput(h).when, "每天 08:30");
});

test("the hall: a routine routed to a group is made in that group, not in the hall", async (t) => {
  const h = await harness(t);
  const projects = withProjects(h);
  const alpha = await projects.create(h.owner, { name: "alpha" });
  h.queue.push(
    { name: "route_request", arguments: { project: "alpha", why: "alpha 的日报" } },
    {
      name: "create_routine",
      arguments: {
        name: "alpha 日报",
        instruction: "汇总 alpha 的进展",
        trigger: { type: "weekly", at: "18:00", days: [5] },
      },
    },
  );
  await chat(h, h.owner, "每周五晚上 6 点给 alpha 做个日报", `thread-${randomUUID()}`);
  assert.ok(body(h, 1).tools?.some((tool) => tool.name === "create_routine"));
  assert.equal((await routinesOf(h, h.owner)).length, 0);
  const [routine] = await routinesOf(h, projectOwner(h.owner, alpha.id));
  assert.ok(routine);
  assert.equal(routine.originThreadId ?? null, null, "it reports in the group's chat");
  assert.equal(lastOutput(h).project, "alpha");
  assert.ok(spaceOwnTool("create_routine"));
});

test("delegate_task that runs once says so: never told as scheduled", async (t) => {
  const h = await harness(t);
  withProjects(h);
  h.queue.push(
    { name: "route_request", arguments: { project: null, why: "你自己的事" } },
    { name: "delegate_task", arguments: { prompt: "查一下明天的天气" } },
  );
  await chat(h, h.owner, "查一下明天的天气", `thread-${randomUUID()}`);
  const once = lastOutput(h);
  assert.equal(once.runsOnce, true);
  assert.equal(once.note, onceNote);
  assert.equal((await routinesOf(h, h.owner)).length, 0);

  h.queue.push(
    { name: "route_request", arguments: { project: null, why: "你自己的事" } },
    { name: "delegate_task", arguments: { prompt: "看一眼首页", repeatMinutes: 60 } },
  );
  await chat(h, h.owner, "每小时看一眼首页", `thread-${randomUUID()}`);
  assert.equal(lastOutput(h).runsOnce, undefined);
});

test("a group's own chat keeps its routine tools and the claim rule", async (t) => {
  const h = await harness(t);
  const projects = withProjects(h);
  const alpha = await projects.create(h.owner, { name: "alpha" });
  await chat(h, projectOwner(h.owner, alpha.id), "你好", `thread-${randomUUID()}`);
  const inProject = body(h, 0);
  assert.ok(inProject.instructions.includes(scheduleClaimRule));
  const create = inProject.tools?.find((tool) => tool.name === "create_routine");
  assert.ok(create);
  assert.equal(create.parameters?.properties?.project, undefined);
});

test("the hall: routing to its own name (Yuki) is for no project, even with a group called Yuki", async (t) => {
  const h = await harness(t);
  const projects = withProjects(h);
  const named = await projects.create(h.owner, { name: "Yuki" });
  h.queue.push(
    { name: "route_request", arguments: { project: "Yuki", why: "归 Yuki：给用户本人的问候" } },
    {
      name: "create_routine",
      arguments: {
        name: "早安",
        instruction: "跟我说一句早安",
        trigger: { type: "daily", at: "09:00" },
      },
    },
  );
  await chat(h, h.owner, "每天早上 9 点跟我说一句早安", `thread-${randomUUID()}`);
  assert.equal((await routinesOf(h, h.owner)).length, 1, "Yuki's own, in the hall");
  assert.equal((await routinesOf(h, projectOwner(h.owner, named.id))).length, 0);
  assert.equal(routedProject("yuki"), null);
  assert.equal(routedProject("alpha"), "alpha");
});
