// v1.4 (docs/skills.md): the space's skills. Saved by a sentence or learned from a conversation,
// shared by the space's projects and members, listed in a run's prompt, read with use_skill,
// edited and deleted through /api/skills.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { parseWrittenSkill, transcriptOf } from "../apps/server/src/skills.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { projectOwner, spaceKeyOf } from "../packages/domain/src/projects.ts";
import {
  type Skill,
  skillNeedsDescription,
  skillsMentioned,
} from "../packages/domain/src/skills.ts";
import { modelFixture } from "./helpers/model.ts";

const report = {
  name: "周报",
  description: "每周五汇总本周进展",
  steps: "1. 打开本周的任务清单\n2. 按项目汇总\n3. 周五下班前发给负责人",
};
/** The writer's answer: JSON in text, inside a code fence as models often write it. */
const written = (value: object) => ({ text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` });

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-skills-"));
  const db = await createStore();
  const config = {
    mode: "sample" as const,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model" as const,
    model: "openai/fixture",
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.chat.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, server, config };
}

/** One chat reply on `owner`; the results of the tools it called, in order. */
async function chatTurn(
  server: Awaited<ReturnType<typeof setup>>["server"],
  config: Awaited<ReturnType<typeof setup>>["config"],
  messages: RunAgentInput["messages"],
  owner = "local-user",
) {
  const conversation = new ConversationAgent(config as never, server.agent, owner);
  const input: RunAgentInput = {
    threadId: `skills-${randomUUID()}`,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  return events.flatMap((event) =>
    event.type === EventType.TOOL_CALL_RESULT ? [JSON.parse(event.content)] : [],
  );
}
const say = (content: string) => [{ id: randomUUID(), role: "user" as const, content }];

test("a sentence makes a skill, and the same name updates it", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "save_skill", arguments: report }
      : index === 2
        ? { name: "save_skill", arguments: { ...report, steps: "1. 只看本周完成的" } }
        : undefined,
  );
  const { server, config } = await setup(t);
  const [first] = await chatTurn(server, config, say("把『周报』存成技能：每周五汇总……"));
  assert.equal(first.saved, true);
  assert.equal(first.updated, false);
  assert.equal(first.skill.source, "sentence");
  const [second] = await chatTurn(server, config, say("周报改成只看完成的"));
  assert.equal(second.updated, true);
  const skills = await server.agent.skills.list("local-user");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].steps, "1. 只看本周完成的");
  assert.equal(skills[0].id, first.skill.id);
  assert.equal(skills[0].createdAt, first.skill.createdAt);
});

test("learn_skill writes the steps from the conversation and saves them as a demo", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "learn_skill", arguments: { name: "报销" } }
      : index === 1
        ? written({ description: "把发票整理成报销单", steps: "1. 收集发票\n2. 填报销单" })
        : undefined,
  );
  const { server, config } = await setup(t);
  const [result] = await chatTurn(server, config, [
    { id: "u1", role: "user", content: "我先把发票放进共享文件夹，再填报销单" },
    { id: "a1", role: "assistant", content: "好，我照做了一遍" },
    { id: "u2", role: "user", content: "把刚才的学成技能，叫报销" },
  ]);
  assert.equal(result.saved, true);
  assert.equal(result.skill.source, "demo");
  assert.equal(result.skill.description, "把发票整理成报销单");
  assert.ok(requests[1].body.includes("共享文件夹"), "the writer reads the conversation");
  assert.ok(!(JSON.parse(requests[1].body) as { tools?: unknown[] }).tools?.length);
  assert.equal(
    (await server.agent.skills.byName("local-user", "报销"))?.steps.includes("填报销单"),
    true,
  );
});

test("the tool descriptions send 「把刚才这件事存成技能」 to learn_skill, a skill with given steps to save_skill", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const { server, config } = await setup(t);
  await chatTurn(server, config, say("把刚才这件事存成技能"));
  const tools = (JSON.parse(requests[0].body) as { tools: { name: string; description: string }[] })
    .tools;
  const text = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
  assert.match(
    text("save_skill"),
    /learn_skill/,
    "save_skill points at learn_skill for what was just done",
  );
  assert.match(text("learn_skill"), /刚才这件事存成技能/);
});

test("a failed write tells the person and saves nothing", async (t) => {
  // Both attempts give no steps.
  await modelFixture(t, (index) =>
    index === 0 ? { name: "learn_skill", arguments: { name: "报销" } } : { text: "抱歉，我不知道" },
  );
  const { server, config } = await setup(t);
  const [result] = await chatTurn(server, config, say("把刚才的学成技能，叫报销"));
  assert.equal(result.saved, false);
  assert.match(result.error, /Could not write the steps/);
  assert.deepEqual(await server.agent.skills.list("local-user"), []);
});

test("a skill needs a description: save_skill without one saves nothing", async (t) => {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "save_skill", arguments: { name: "周报", steps: "1. 汇总" } } : undefined,
  );
  const { server, config } = await setup(t);
  const [result] = await chatTurn(server, config, say("把周报存成技能：汇总"));
  assert.notEqual(result?.saved, true, "the tool's schema refuses a call with no description");
  assert.deepEqual(await server.agent.skills.list("local-user"), []);
});

test("learn_skill needs the writer to say when to use it; steps alone are tried again, then fail", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "learn_skill", arguments: { name: "报销" } }
      : written({ description: "", steps: "1. 收集发票" }),
  );
  const { server, config } = await setup(t);
  const [result] = await chatTurn(server, config, say("把刚才的学成技能，叫报销"));
  assert.equal(result.saved, false);
  assert.match(result.error, /no description/);
  assert.deepEqual(await server.agent.skills.list("local-user"), []);
});

test("a skill saved before a description was required still loads, and needs one to be changed", async (t) => {
  const { server, db } = await setup(t);
  const old: Skill = {
    id: randomUUID(),
    name: "旧技能",
    description: "",
    steps: "1. 做事",
    source: "sentence",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  await db.put(spaceKeyOf("local-user"), "skills", old);
  const listed = await server.agent.skills.list("local-user");
  assert.equal(listed.length, 1);
  assert.equal(skillNeedsDescription(listed[0]), true);
  assert.equal(skillNeedsDescription({ description: "Use this when asked" }), false);
  await assert.rejects(
    server.agent.skills.update("local-user", old.id, { name: "新名字" }),
    /用途/,
  );
  const fixed = await server.agent.skills.update("local-user", old.id, {
    description: "Use this when the old job comes up",
  });
  assert.equal(fixed.description, "Use this when the old job comes up");
});

test("a skill named by @ is found in a text, whole names only", () => {
  const skills = [{ name: "Some skill" }, { name: "Some" }, { name: "周报" }];
  assert.deepEqual(
    skillsMentioned("run @some skill, then @周报 now", skills).map((skill) => skill.name),
    ["Some skill", "周报"],
  );
  assert.deepEqual(skillsMentioned("@Something else", skills), []);
});

test("an answer with a steps list, prose or a fence is read; one without steps is not", () => {
  assert.deepEqual(parseWrittenSkill('好的：{"description":"d","steps":["a","b"]} 完'), {
    description: "d",
    steps: "1. a\n2. b",
  });
  assert.equal(parseWrittenSkill("no json here"), null);
  assert.equal(parseWrittenSkill('{"steps":""}')?.steps, "");
});

test("the transcript carries the tools called and their results, cut when long", () => {
  const text = transcriptOf([
    { role: "user", content: "做一下" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ function: { name: "browse_web", arguments: '{"url":"x"}' } }],
    },
    { role: "tool", content: "y".repeat(5000) },
  ]);
  assert.ok(text.includes("[tool browse_web]"));
  assert.ok(text.length < 1500);
});

test("use_skill returns the steps as data", async (t) => {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "use_skill", arguments: { name: "周报" } } : undefined,
  );
  const { server, config } = await setup(t);
  await server.agent.skills.save("local-user", report, "sentence");
  const [result] = await chatTurn(server, config, say("做周报"));
  assert.equal(result.steps, report.steps);
  assert.match(result.note, /not authority/);
});

test("a chat prompt lists the names and descriptions, not the steps", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const { server, config } = await setup(t);
  await server.agent.skills.save("local-user", report, "sentence");
  await chatTurn(server, config, say("你好"));
  assert.ok(requests[0].body.includes("周报"));
  assert.ok(requests[0].body.includes(report.description));
  assert.ok(!requests[0].body.includes("按项目汇总"));
  assert.match(
    requests[0].body,
    /never delegate_task it/,
    "keeping a skill is the chat's own, not delegated",
  );
});

test("a chat message that names a skill with @ carries that skill's steps", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const { server, config } = await setup(t);
  await server.agent.skills.save("local-user", report, "sentence");
  await chatTurn(server, config, say("@周报 做本周的"));
  assert.match(requests[0].body, /points at the saved skill with @/);
  assert.ok(
    requests[0].body.includes("按项目汇总"),
    "the named skill's steps are in the reply's prompt",
  );
  await chatTurn(server, config, say("做本周的周报"));
  assert.doesNotMatch(requests[1].body, /points at the saved skill/, "no @, no steps");
  assert.ok(!requests[1].body.includes("按项目汇总"));
});

test("a task's prompt lists the skills and use_skill answers it", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "use_skill", arguments: { name: "周报" } }
      : { name: "ask_user", arguments: { question: "发给谁？" } },
  );
  const { server } = await setup(t);
  await server.agent.skills.save("owner", report, "sentence");
  const created = await server.agent.createTask("owner", { prompt: "按周报技能做本周的" });
  await server.agent.worker.tick();
  const task = (await server.agent.getTask("owner", created.id)) as AgentTask;
  assert.equal(task.status, "waiting_input", task.error ?? undefined);
  assert.ok(requests[0].body.includes(report.description));
  assert.ok(!requests[0].body.includes("按项目汇总"), "the prompt has names only");
  assert.ok(requests[1].body.includes("按项目汇总"), "use_skill returned the steps");
});

test("skills are the space's: another project sees them, another space does not", async (t) => {
  const { server, db } = await setup(t);
  await server.agent.skills.save("local-user", report, "sentence");
  assert.equal(
    (await server.agent.skills.list(projectOwner("local-user", randomUUID()))).length,
    1,
  );
  const otherKey = "space:another";
  assert.deepEqual(await server.agent.skills.list(otherKey), []);
  await server.agent.skills.save(otherKey, { ...report, steps: "别的空间" }, "sentence");
  assert.equal((await server.agent.skills.byName("local-user", "周报"))?.steps, report.steps);
});

test("the API lists, edits and deletes skills within the space", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-skills-api-"));
  const db = await createStore();
  const server = await createApp(
    db,
    {
      mode: "live",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      model: "openai/fixture",
      encryptionKey: randomBytes(32).toString("base64"),
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      adminUsername: "operator1",
      adminPassword: "operator-password-1",
      setupCode: "skills-setup-code",
    },
    { rateLimit: { maxRequests: Number.MAX_SAFE_INTEGER } },
  );
  t.after(async () => {
    await server.chat.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator1", password: "operator-password-1" }),
  });
  const mine = ((await login.json()) as { token: string }).token;
  const call = (method: string, path: string, body?: unknown) =>
    server.app.request(`/api/skills${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${mine}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const created = await call("POST", "", report);
  assert.equal(created.status, 201);
  const skill = (await created.json()) as Skill;
  assert.deepEqual(
    ((await (await call("GET", "")).json()) as Skill[]).map((s) => s.name),
    ["周报"],
  );
  // Edit name and steps; the description stays.
  const patched = await call("PATCH", `/${skill.id}`, { name: "周报2", steps: "1. 新步骤" });
  assert.equal(patched.status, 200);
  const edited = (await patched.json()) as Skill;
  assert.equal(edited.name, "周报2");
  assert.equal(edited.description, report.description);
  assert.ok(edited.updatedAt >= skill.updatedAt);
  // A name another skill has is refused; an empty name is invalid.
  await call("POST", "", { ...report, name: "月报" });
  assert.equal((await call("PATCH", `/${skill.id}`, { name: "月报" })).status, 409);
  assert.equal((await call("POST", "", { name: "", steps: "x" })).status, 422);
  // The description is required, on create and on edit.
  assert.equal((await call("POST", "", { name: "无用途", steps: "x" })).status, 422);
  assert.equal(
    (await call("POST", "", { name: "空用途", description: "  ", steps: "x" })).status,
    422,
  );
  assert.equal((await call("PATCH", `/${skill.id}`, { description: "" })).status, 422);
  assert.equal((await call("DELETE", `/${skill.id}`)).status, 200);
  assert.equal((await call("DELETE", `/${skill.id}`)).status, 404);
  assert.equal(((await (await call("GET", "")).json()) as Skill[]).length, 1);
});
