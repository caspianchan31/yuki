// The core on its own (apps/server/src/tenancy-port.ts): createApp with `singleUserTenancy`
// serves one implicit space to its admin, with chat, projects, routines and skills, and none of
// the multi-tenant layer's routes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { singleUserTenancy } from "../apps/server/src/tenancy-port.ts";
import { modelFixture } from "./helpers/model.ts";

async function boot(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-single-user-"));
  const db = await createStore();
  const config: Config = {
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
    setupCode: "test-setup-code",
  };
  const server = await createApp(db, config, { tenancy: singleUserTenancy });
  t.after(async () => {
    await server.chat.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const setup = await server.app.request("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "caspian",
      password: "correct horse battery",
      code: "test-setup-code",
    }),
  });
  assert.equal(setup.status, 201);
  const { token } = (await setup.json()) as { token: string };
  const call = (method: string, path: string, body?: unknown) =>
    server.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { server, config, call };
}

test("a single-user core: sign in, a group, a chat run, a routine and a skill", async (t) => {
  await modelFixture(t, () => undefined);
  const { server, config, call } = await boot(t);

  const me = (await (await call("GET", "/api/me")).json()) as {
    user: { username: string };
    spaces: { role: string; members: number }[];
  };
  assert.equal(me.user.username, "caspian");
  assert.deepEqual(
    me.spaces.map(({ role, members }) => ({ role, members })),
    [{ role: "admin", members: 1 }],
  );

  const created = await call("POST", "/api/projects", { name: "Reddit" });
  assert.equal(created.status, 201);
  const projects = (await (await call("GET", "/api/projects")).json()) as unknown[];
  assert.ok(projects.length >= 1);

  const input: RunAgentInput = {
    threadId: `single-${randomUUID()}`,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "你好" }],
    tools: [],
    context: [],
    state: {},
  };
  const events = (
    await lastValueFrom(
      new ConversationAgent(config, server.agent, "local-user").run(input).pipe(toArray()),
    )
  ).map((event) => EventSchemas.parse(event));
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);

  const routine = await server.agent.routines.create("local-user", {
    name: "订单",
    instruction: "看有没有新订单",
    trigger: { type: "every", minutes: 60 },
  });
  assert.equal(routine.status, "queued");
  assert.equal(routine.routine?.trigger.type, "every");

  await server.agent.skills.save(
    "local-user",
    { name: "周报", description: "每周五汇总本周进展", steps: "1. 打开清单" },
    "sentence",
  );
  const skills = (await (await call("GET", "/api/skills")).json()) as { name: string }[];
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["周报"],
  );

  // The multi-tenant layer is not mounted: none of its routes exists.
  for (const path of [
    "/api/platform/spaces",
    "/api/platform/billing/subscriptions",
    "/api/billing",
    "/api/billing/stores",
    "/api/signup/prices",
    "/api/spaces",
    "/api/space",
    "/api/store",
  ])
    assert.equal((await call("GET", path)).status, 404, path);
});
