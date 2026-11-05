// The /api/projects contract and the partition it creates. A request that
// names a project acts as the project owner, so per-owner records (memories here) are
// separate per project, and deleting a project purges them while accounts survive.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { intelligenceUserId } from "../apps/server/src/chat/cloud-migration.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ProjectView } from "../packages/domain/src/projects.ts";
import {
  isProjectOwner,
  PROJECT_HEADER,
  parseOwner,
  projectOwner,
  realOwnerOf,
} from "../packages/domain/src/projects.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const call = async (method: string, path: string, body?: unknown, project?: string | null) => {
  const response = await server.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(project ? { [PROJECT_HEADER]: project } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-projects-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("owner strings round-trip and never mix with environment suffixes", () => {
  const id = randomUUID();
  const scoped = projectOwner("local-user", id);
  assert.equal(scoped, `local-user/proj:${id}`);
  assert.deepEqual(parseOwner(scoped), { real: "local-user", projectId: id });
  assert.deepEqual(parseOwner("local-user"), { real: "local-user", projectId: null });
  assert.equal(realOwnerOf(scoped), "local-user");
  assert.equal(realOwnerOf(`local-user#env:${id}`), `local-user#env:${id}`);
  assert.equal(isProjectOwner(scoped), true);
  assert.equal(isProjectOwner("local-user"), false);
  assert.throws(() => projectOwner(`local-user#env:${id}`, id));
  assert.throws(() => projectOwner(scoped, id));
  assert.throws(() => projectOwner("local-user", "not-a-uuid"));
  // A garbage suffix is not a project.
  assert.deepEqual(parseOwner("local-user/proj:nope"), {
    real: "local-user/proj:nope",
    projectId: null,
  });
});

test("projects are created, listed, renamed and validated on the real owner", async () => {
  assert.deepEqual((await call("GET", "/api/projects")).body, []);
  assert.equal((await call("POST", "/api/projects", { name: "default" })).status, 422);
  assert.equal((await call("POST", "/api/projects", { name: "  " })).status, 422);
  const created = await call("POST", "/api/projects", { name: "AcmeSkills" });
  assert.equal(created.status, 201, created.text);
  const project = created.body as ProjectView;
  assert.equal(project.environments, 0);
  assert.equal((await call("POST", "/api/projects", { name: "acmeskills " })).status, 409);
  const other = (await call("POST", "/api/projects", { name: "AcmeGame" })).body as ProjectView;
  assert.deepEqual(
    ((await call("GET", "/api/projects")).body as ProjectView[]).map((p) => p.name),
    ["AcmeGame", "AcmeSkills"],
  );
  // Listing works from inside a project too: the header is ignored on /api/projects.
  assert.equal(
    ((await call("GET", "/api/projects", undefined, project.id)).body as ProjectView[]).length,
    2,
  );
  assert.equal(
    (await call("PATCH", `/api/projects/${project.id}`, { name: "AcmeGame" })).status,
    409,
  );
  const renamed = await call("PATCH", `/api/projects/${project.id}`, {
    name: "AcmeSkills Reddit",
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal((renamed.body as ProjectView).name, "AcmeSkills Reddit");
  assert.equal((await call("PATCH", `/api/projects/${randomUUID()}`, { name: "x" })).status, 404);
  assert.equal((await call("DELETE", `/api/projects/${other.id}`)).status, 204);
  assert.equal((await call("DELETE", `/api/projects/${other.id}`)).status, 404);
});

test("a project header partitions per-owner records; unknown projects are refused", async () => {
  const project = (await call("POST", "/api/projects", { name: "Partition" })).body as ProjectView;
  const memory = { text: "caspian is the founder persona", source: "You" };
  const inside = await call("POST", "/api/agent/memories", memory, project.id);
  assert.equal(inside.status, 201, inside.text);
  const scoped = projectOwner("local-user", project.id);
  assert.equal((await db.list(scoped, "memories")).length, 1);
  assert.equal(
    (await db.list("local-user", "memories")).some((m) => m.text === memory.text),
    false,
    "the default project does not see the project's memory",
  );
  const workspaceInside = await call("GET", "/api/agent", undefined, project.id);
  assert.equal(workspaceInside.status, 200);
  assert.equal(
    workspaceInside.body.memories.some((m: { text: string }) => m.text === memory.text),
    true,
  );
  const workspaceDefault = await call("GET", "/api/agent");
  assert.equal(
    workspaceDefault.body.memories.some((m: { text: string }) => m.text === memory.text),
    false,
  );
  // The project's own agent identity exists, so its snapshot is complete.
  assert.equal(typeof workspaceInside.body.identity?.name, "string");
  assert.equal((await call("GET", "/api/agent", undefined, randomUUID())).status, 404);
  assert.equal((await call("GET", "/api/agent", undefined, "not-a-uuid")).status, 404);
  // Deleting the project purges everything under its owner and refuses the header after.
  assert.equal((await call("DELETE", `/api/projects/${project.id}`)).status, 204);
  assert.equal((await db.list(scoped, "memories")).length, 0);
  assert.equal((await db.list(scoped, "agent-settings")).length, 0);
  assert.equal((await call("GET", "/api/agent", undefined, project.id)).status, 404);
});

test("project owners map to a CopilotKit cloud user id that the runtime accepts", () => {
  const safe = /^[\w.@:=-]+$/;
  const id = "0b7a1d6e-2c3f-4a8b-9c1d-5e6f7a8b9c0d";
  assert.equal(intelligenceUserId("local-user"), "local-user");
  const project = intelligenceUserId(projectOwner("local-user", id));
  assert.match(project, safe);
  assert.equal(project, `local-user=proj:${id}`);
  assert.notEqual(project, intelligenceUserId("local-user"));
  assert.notEqual(
    project,
    intelligenceUserId(projectOwner("local-user", "1b7a1d6e-2c3f-4a8b-9c1d-5e6f7a8b9c0d")),
  );
});
