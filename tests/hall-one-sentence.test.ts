// The 营销总群's assistant finishes a request in one reply:
// it makes the project a request names, and hands the work to that project, where it runs and
// reports. The fixture plays the model's tool choices; whether a real model makes them is checked
// in production acceptance.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { writeGoal, writePersona } from "../apps/server/src/accounts/records.ts";
import type { BrowserService } from "../apps/server/src/browser.ts";
import {
  ConversationAgent,
  hallChatLine,
  memberChatLine,
  memberChatWaiting,
  noProjectNote,
  resultOnlyRule,
  routedNote,
} from "../apps/server/src/engine/conversation.ts";
import { spaceOwnTool } from "../apps/server/src/engine/hall-gate.ts";
import { ProjectService } from "../apps/server/src/projects.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { memberConversationId } from "../packages/domain/src/member-thread.ts";
import type { Project } from "../packages/domain/src/projects.ts";
import { projectOwner } from "../packages/domain/src/projects.ts";
import { type Harness, harness, proxy } from "./helpers/sign-in-harness.ts";

const body = (h: Harness, at: number) =>
  JSON.parse(h.requests[at]?.body ?? "{}") as {
    instructions: string;
    tool_choice?: unknown;
    tools?: { name: string; parameters?: { properties?: Record<string, unknown> } }[];
    input: { type: string; output?: unknown }[];
  };
function outputs(h: Harness, at = -1) {
  const index = at < 0 ? h.requests.length + at : at;
  return body(h, index)
    .input.filter((item) => item.type === "function_call_output")
    .map((item) => {
      try {
        return JSON.parse(String(item.output));
      } catch {
        return item.output;
      }
    });
}
async function chat(h: Harness, owner: string, text: string, threadId = `thread-${randomUUID()}`) {
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
/** The app's wiring: the hall makes projects through ProjectService. */
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
const projectNamed = async (h: Harness, name: string) =>
  (await h.db.list<Project>(h.owner, "projects")).find((item) => item.name === name);

test("a request for a project that does not exist: the hall makes it and hands the work there in the same reply", async (t) => {
  const h = await harness(t);
  withProjects(h);
  h.queue.push(
    { name: "route_request", arguments: { project: "acmegame", why: "点名的项目" } },
    { name: "delegate_task", arguments: { prompt: "在论坛上回一帖，介绍 acmegame" } },
  );
  await chat(h, h.owner, "@acmegame 运营专员 在论坛上回一帖，介绍 acmegame");
  const first = body(h, 0);
  assert.ok(first.instructions.includes(hallChatLine));
  // Every chat says its result, not its steps (stated once).
  assert.equal(first.instructions.split(resultOnlyRule).length, 2);
  assert.ok(first.instructions.includes(" Projects of this space (data): []."));
  // The first turn may only say whose the request is.
  // Every tool is declared in the routing turn (a call beside route_request is answered "not run, again after
  // routing", not "Unknown tool"), and route_request is forced.
  const firstNames = first.tools?.map((tool) => tool.name) ?? [];
  assert.ok(firstNames.includes("route_request") && firstNames.includes("delegate_task"));
  assert.deepEqual(first.tool_choice, { type: "function", name: "route_request" });
  // Routed to a project, the reply may only hand it over.
  const second = body(h, 1);
  assert.equal(second.tool_choice ?? "auto", "auto");
  const names = second.tools?.map((tool) => tool.name) ?? [];
  assert.ok(names.includes("delegate_task") && names.includes("create_job"), names.join());
  for (const doing of ["browse_web", "use_desktop", "agent_status", "set_account_goal"])
    assert.ok(!names.includes(doing), doing);
  // A skill is the space's, not the project's: keeping or reading one stays open when routed to a project.
  for (const space of ["save_skill", "learn_skill", "use_skill"])
    assert.ok(names.includes(space), space);
  assert.ok(
    second.tools?.find((tool) => tool.name === "delegate_task")?.parameters?.properties?.project,
  );

  const made = await projectNamed(h, "acmegame");
  assert.ok(made, "the project is made by routing to it");
  const [routed] = outputs(h, 1);
  assert.deepEqual(routed.project, { id: made.id, name: "acmegame" });
  assert.equal(routed.created, true);

  const scope = projectOwner(h.owner, made.id);
  const tasks = await h.db.list<AgentTask>(scope, "tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].input.environmentId, null, "on the project's default desktop");
  // It reports in the project's own conversation, not in the hall.
  assert.equal(tasks[0].originThreadId ?? null, null);
  assert.equal((await h.db.list<AgentTask>(h.owner, "tasks")).length, 0);
  const handed = outputs(h, 2).at(-1);
  assert.equal(handed.id, tasks[0].id);
  assert.equal(handed.project, "acmegame");
  assert.equal(handed.projectId, made.id);
});

test("the hall names a project's account: the task runs on it, an account of another project is refused", async (t) => {
  const h = await harness(t);
  const projects = withProjects(h);
  const alpha = await projects.create(h.owner, { name: "alpha" });
  const beta = await projects.create(h.owner, { name: "beta" });
  const bob = await h.environments.create(h.owner, { name: "Bob", proxyUrl: proxy });
  await h.environments.move(h.owner, bob.id, null, alpha.id);
  h.queue.push(
    { name: "route_request", arguments: { project: "alpha", why: "Bob 在 alpha" } },
    { name: "delegate_task", arguments: { prompt: "回一帖", project: "alpha", account: "Bob" } },
  );
  await chat(h, h.owner, "让 alpha 的 Bob 回一帖");
  assert.ok(
    body(h, 0).instructions.includes(
      ` Projects of this space (data): ${JSON.stringify([
        { name: "alpha", accounts: ["Bob"] },
        { name: "beta", accounts: [] },
      ])}.`,
    ),
  );
  const [task] = await h.db.list<AgentTask>(projectOwner(h.owner, alpha.id), "tasks");
  assert.equal(task.input.environmentId, bob.id);
  assert.equal(task.title, "[Bob] 回一帖");
  assert.equal(outputs(h).at(-1)?.account, "Bob");

  h.queue.push(
    { name: "route_request", arguments: { project: "beta", why: "点名 beta" } },
    { name: "delegate_task", arguments: { prompt: "回一帖", project: "beta", account: "Bob" } },
  );
  await chat(h, h.owner, "让 beta 的 Bob 回一帖");
  assert.match(String(outputs(h).at(-1)?.error), /No account named "Bob" in this project/);
  assert.equal((await h.db.list(projectOwner(h.owner, beta.id), "tasks")).length, 0);
});

test("a project already there is kept; a project's own conversation has no create_project and no project field", async (t) => {
  const h = await harness(t);
  const projects = withProjects(h);
  const alpha = await projects.create(h.owner, { name: "Alpha" });
  h.queue.push({ name: "route_request", arguments: { project: "alpha", why: "已有的项目" } });
  await chat(h, h.owner, "在 alpha 里办件事");
  const routed = outputs(h).at(-1);
  assert.deepEqual(routed.project, { id: alpha.id, name: "Alpha" });
  assert.equal(routed.created, false);
  assert.equal((await h.db.list<Project>(h.owner, "projects")).length, 1);

  const before = h.requests.length;
  await chat(h, projectOwner(h.owner, alpha.id), "你好");
  const inProject = body(h, before);
  assert.ok(!inProject.instructions.includes(hallChatLine));
  assert.ok(!inProject.tools?.some((tool) => tool.name === "create_project"));
  assert.equal(
    inProject.tools?.find((tool) => tool.name === "delegate_task")?.parameters?.properties?.project,
    undefined,
  );
});

test("a store's own conversation is no hall: no hall line, and create_project makes nothing", async (t) => {
  const h = await harness(t);
  withProjects(h);
  h.billing.scopeKind = async () => "store"; // the core only knows the kind, not the plan
  h.queue.push({ name: "create_project", arguments: { name: "acmegame" } });
  await chat(h, h.owner, "建一个 acmegame 项目");
  assert.ok(!body(h, 0).instructions.includes(hallChatLine));
  assert.match(String(outputs(h).at(-1)?.error), /only in the 营销总群/);
  assert.equal(await projectNamed(h, "acmegame"), undefined);
});

test("tools kept when a reply is routed to a project: hand-over, skills and a connected app's tools", () => {
  for (const name of [
    "delegate_task",
    "save_skill",
    "app_fakenotes__get_weather",
    "app_x__create_note",
  ])
    assert.ok(spaceOwnTool(name), name);
  for (const name of ["browse_web", "use_desktop", "agent_status", "prepare_email"])
    assert.ok(!spaceOwnTool(name), name);
});

test("a request for no project: route_request says so, and the reply gets every tool", async (t) => {
  const h = await harness(t);
  withProjects(h);
  h.queue.push({ name: "route_request", arguments: { project: null, why: "问的是空间本身" } });
  await chat(h, h.owner, "现在有几个项目？");
  const after = body(h, 1);
  const names = after.tools?.map((tool) => tool.name) ?? [];
  assert.ok(!names.includes("route_request"));
  assert.ok(names.includes("agent_status") && names.includes("create_project"), names.join());
  assert.deepEqual(outputs(h, 1).at(-1), {
    forNoProject: true,
    note: `${noProjectNote} ${routedNote}`,
  });
});

test("a member conversation speaks as that account and is not the hall assistant", async (t) => {
  const h = await harness(t);
  const alice = await h.account("Alice");
  const threadId = memberConversationId(alice.id);
  assert.ok(threadId);
  await h.environments.select(h.owner, threadId, alice.id);
  await writePersona(h.db, alice.derived, {
    fields: { who: "夜里出晨报" },
    source: "owner",
    by: { userId: null },
    reason: null,
  });
  await writeGoal(h.db, alice.derived, "要连接：gmail、slack", { userId: null });
  await h.db.put(h.owner, "tasks", {
    id: "brief-1",
    title: "出一页晨报",
    prompt: "交一页摘要\n什么时候：每天 7:30",
    status: "scheduled",
    input: { environmentId: alice.id },
  });
  h.queue.push({ text: "好" } as never);
  await chat(h, h.owner, "今天做了什么", threadId);
  const instructions = body(h, 0).instructions;
  assert.ok(instructions.includes(memberChatLine));
  assert.ok(!instructions.includes("create_job with the person's words"));
  assert.ok(!instructions.includes("cannot tell which account"));
  assert.ok(!instructions.includes("You are OpenMuse"));
  assert.ok(instructions.includes("You are the account in this conversation."));
  assert.ok(instructions.includes("Turn other requested jobs into durable delegated work"));
  assert.ok(instructions.includes("a routine repeated on a schedule) is a delegate_task job"));
  assert.ok(instructions.includes("夜里出晨报"));
  assert.ok(instructions.includes("要连接：gmail、slack"));
  assert.ok(instructions.includes("每天 7:30 出一页晨报"));
  assert.ok(!instructions.includes(hallChatLine));
  assert.ok(!instructions.includes(memberChatWaiting));
  const words = instructions.toLowerCase().match(/[\p{L}\p{N}_'`*-]+/gu) ?? [];
  const seen = new Map<string, number>();
  for (let i = 0; i + 10 <= words.length; i++) {
    const key = words.slice(i, i + 10).join(" ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  assert.deepEqual(
    [...seen].filter(([, count]) => count > 1).map(([key]) => key),
    [],
  );
});

test("a member conversation stays hers before her desktop is connected", async (t) => {
  const h = await harness(t);
  const alice = await h.account("Alice");
  const threadId = memberConversationId(alice.id);
  assert.ok(threadId);
  await writePersona(h.db, alice.derived, {
    fields: { who: "夜里出晨报" },
    source: "owner",
    by: { userId: null },
    reason: null,
  });
  await writeGoal(h.db, alice.derived, "要连接：gmail、slack", { userId: null });
  await h.db.put(h.owner, "tasks", {
    id: "brief-2",
    title: "出一页晨报",
    prompt: "交一页摘要\n什么时候：每天 7:30",
    status: "scheduled",
    input: { environmentId: alice.id },
  });
  h.queue.push({ text: "好" } as never);
  await chat(h, h.owner, "今天做了什么", threadId);
  const instructions = body(h, 0).instructions;
  assert.ok(instructions.includes(memberChatWaiting));
  assert.ok(!instructions.includes("create_job with the person's words"));
  assert.ok(!instructions.includes("cannot tell which account"));
  assert.ok(!instructions.includes("You are OpenMuse"));
  assert.ok(!instructions.includes("Turn other requested jobs into durable delegated work"));
  assert.ok(!instructions.includes("a routine repeated on a schedule) is a delegate_task job"));
  assert.ok(!instructions.includes("even its first round"));
  assert.ok(!instructions.includes("the task is running and will report back"));
  assert.ok(!instructions.includes("Calendar writes must use delegate_task"));
  assert.ok(instructions.includes("do not start a job while your desktop is not connected"));
  assert.ok(instructions.includes("夜里出晨报"));
  assert.ok(instructions.includes("要连接：gmail、slack"));
  assert.ok(instructions.includes("每天 7:30 出一页晨报"));
  assert.ok(!instructions.includes(memberChatLine));
  assert.ok(!instructions.includes(hallChatLine));
  const names = body(h, 0).tools?.map((tool) => tool.name) ?? [];
  assert.ok(!names.includes("route_request"));
  const words = instructions.toLowerCase().match(/[\p{L}\p{N}_'`*-]+/gu) ?? [];
  const seen = new Map<string, number>();
  for (let i = 0; i + 10 <= words.length; i++) {
    const key = words.slice(i, i + 10).join(" ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  assert.deepEqual(
    [...seen].filter(([, count]) => count > 1).map(([key]) => key),
    [],
  );
});

test("a fact remembered in her conversation stays on her card before her desktop is connected", async (t) => {
  const h = await harness(t);
  const alice = await h.account("Alice");
  const threadId = memberConversationId(alice.id);
  assert.ok(threadId);
  h.queue.push({ name: "remember_fact", arguments: { text: "早上只看三件事" } }, {
    text: "记住了",
  } as never);
  await chat(h, h.owner, "记住：早上只看三件事", threadId);
  const memories = await h.db.list<{ text: string; accountId?: string }>(h.owner, "memories");
  const fact = memories.find((item) => item.text === "早上只看三件事");
  assert.equal(fact?.accountId, alice.id);
});
