// Conversations on this server through the real createApp and runtime HTTP
// path: project scoping, 开新主聊天, reports bound to the current main chat, the conversation's
// latest run on the report poll, and history that survives a restart (main chat and a side chat
// started through the runtime's agent cloning).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { createApp } from "../apps/server/src/app.ts";
import { chatDatabase } from "../apps/server/src/chat/chat-store.ts";
import { mainThreadBusyMessage } from "../apps/server/src/chat/main-thread.ts";
import { mainThreadKeptMessage } from "../apps/server/src/chat/thread-routes.ts";
import type { ThreadRecord } from "../apps/server/src/chat/types.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let directory: string;
const config = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
});

type App = Awaited<ReturnType<typeof createApp>>;
let db: Store, server: App, token: string;

async function open(store: Store, dataDir: string) {
  const created = await createApp(store, config(dataDir));
  const session = await created.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return { created, token: (await session.json()).token as string };
}

const headers = (project?: string, as = token) => ({
  Authorization: `Bearer ${as}`,
  "Content-Type": "application/json",
  ...(project ? { "X-OpenMuse-Project": project } : {}),
});
const get = (path: string, project?: string, app = server.app, as = token) =>
  app.request(path, { headers: headers(project, as) });
const send = (method: string, path: string, body: unknown, project?: string, app = server.app) =>
  app.request(path, { method, headers: headers(project), body: JSON.stringify(body) });

const userMessage = (content: string) => ({ id: randomUUID(), role: "user", content });
function runInput(threadId: string, messages: unknown[] = []) {
  return {
    threadId,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}
function sseEvents(text: string): BaseEvent[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent);
}
async function runTurn(threadId: string, text: string, project?: string, app = server.app) {
  const response = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(threadId, [userMessage(text)]),
    project,
    app,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return sseEvents(await response.text());
}
async function list(project?: string, archived = true) {
  const response = await get(
    `/api/copilotkit/threads?agentId=default&limit=100${archived ? "&includeArchived=true" : ""}`,
    project,
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { threads: ThreadRecord[] }).threads;
}
const mainOf = async (project?: string) =>
  ((await (await get("/api/main-thread", project)).json()) as { threadId: string }).threadId;
const newMain = (replacing: string, project?: string) =>
  send(
    "POST",
    "/api/main-thread/new",
    { replacing, formerName: "旧主聊天 · 到 2026-10-12" },
    project,
  );

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-threads-main-"));
  db = await createStore({ dataDir: join(directory, "postgres") });
  ({ created: server, token } = await open(db, directory));
});
after(async () => {
  await server?.chat.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a project's conversations belong to that project only", async () => {
  const created = await send("POST", "/api/projects", { name: "Launch" });
  assert.equal(created.status, 201);
  const project = ((await created.json()) as { id: string }).id;
  const projectMain = await mainOf(project);
  const defaultMain = await mainOf();
  assert.notEqual(projectMain, defaultMain);
  const side = randomUUID();
  await runTurn(side, "Show my calendar", project);
  assert.ok((await list(project)).some((thread) => thread.id === side));
  assert.equal(
    (await list()).some((thread) => thread.id === side),
    false,
  );
  // The default project cannot read, run on or rename the project's thread.
  assert.equal((await get(`/api/copilotkit/threads/${side}/messages`)).status, 404);
  const run = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(side, [userMessage("Hi")]),
  );
  assert.equal(run.status, 404);
  const rename = await send("PATCH", `/api/copilotkit/threads/${side}`, {
    agentId: "default",
    name: "Taken",
  });
  assert.equal(rename.status, 404);
  // An unknown project is a 404 on the runtime too, before any thread is touched.
  const unknown = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(randomUUID(), [userMessage("Hi")]),
    randomUUID(),
  );
  assert.equal(unknown.status, 404);
});

test("开新主聊天 archives the old main chat under a name and starts an empty one", async () => {
  const old = await mainOf();
  await runTurn(old, "Show my calendar");
  const response = await newMain(old);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { threadId: string; switched: boolean };
  assert.equal(body.switched, true);
  assert.notEqual(body.threadId, old);
  assert.equal(await mainOf(), body.threadId);
  const threads = await list();
  const former = threads.find((thread) => thread.id === old);
  assert.equal(former?.archived, true);
  assert.equal(former?.name, "旧主聊天 · 到 2026-10-12");
  assert.equal(
    (await list(undefined, false)).some((thread) => thread.id === old),
    false,
  );
  // The new main chat is empty and works.
  const events = await (await get(`/api/copilotkit/threads/${body.threadId}/events`)).json();
  assert.deepEqual(events, { events: [] });
  await runTurn(body.threadId, "Show my calendar");
  // The old one keeps its history; restored, it is a side chat (the main chat stays the new one).
  const restored = await send("PATCH", `/api/copilotkit/threads/${old}`, {
    agentId: "default",
    archived: false,
  });
  assert.equal(restored.status, 200);
  assert.equal(await mainOf(), body.threadId);
  const messages = await (await get(`/api/copilotkit/threads/${old}/messages`)).json();
  assert.ok(messages.messages.length >= 2);
});

test("the current main chat is never archived or deleted on its own", async () => {
  const main = await mainOf();
  for (const [method, path, body] of [
    ["POST", `/api/copilotkit/threads/${main}/archive`, { agentId: "default" }],
    ["PATCH", `/api/copilotkit/threads/${main}`, { agentId: "default", archived: true }],
    ["DELETE", `/api/copilotkit/threads/${main}`, { agentId: "default" }],
  ] as const) {
    const response = await send(method, path, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: mainThreadKeptMessage });
  }
  // Renaming it is fine.
  const renamed = await send("PATCH", `/api/copilotkit/threads/${main}`, {
    agentId: "default",
    name: "本周",
  });
  assert.equal(renamed.status, 200);
});

test("two 开新主聊天 at once switch once; a stale one gets the current main chat", async () => {
  const current = await mainOf();
  const [first, second] = await Promise.all([newMain(current), newMain(current)]);
  const answers = [
    (await first.json()) as { threadId: string; switched: boolean },
    (await second.json()) as { threadId: string; switched: boolean },
  ];
  assert.equal(answers.filter((answer) => answer.switched).length, 1);
  assert.equal(answers[0]?.threadId, answers[1]?.threadId);
  assert.equal(await mainOf(), answers[0]?.threadId);
  const record = await db.get<{ formerIds: string[] }>(
    "local-user",
    "conversation-settings",
    "main",
  );
  assert.equal(record?.formerIds.filter((id) => id === current).length, 1);
});

test("开新主聊天 waits while the main chat is replying", async () => {
  const main = await mainOf();
  const claimed = await server.chat.runner.claim({
    owner: "local-user",
    threadId: main,
    agentId: "default",
    runId: "held-main",
  });
  assert.deepEqual(claimed, { ok: true });
  const refused = await newMain(main);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: mainThreadBusyMessage });
  assert.equal(await mainOf(), main);
  await server.chat.runner.release(main, "held-main");
});

test("reports go to the current main chat, also from a main chat it replaced", async () => {
  const owner = "local-user";
  const before = await mainOf();
  await runTurn(before, "Show my calendar");
  const side = randomUUID();
  await runTurn(side, "Show my calendar");
  const switched = (await (await newMain(before)).json()) as { threadId: string };
  const current = switched.threadId;
  const reports = server.agent.reports;
  const fromFormer = await reports.outcome(
    owner,
    { id: randomUUID(), title: "Weekly", originThreadId: before },
    "Done",
    "Weekly done",
    `former-${randomUUID()}`,
  );
  const fromSide = await reports.outcome(
    owner,
    { id: randomUUID(), title: "Side", originThreadId: side },
    "Done",
    "Side done",
    `side-${randomUUID()}`,
  );
  const fromNowhere = await reports.outcome(
    owner,
    { id: randomUUID(), title: "Plain" },
    "Done",
    "Plain done",
    `plain-${randomUUID()}`,
  );
  assert.equal(fromFormer.report.threadId, current);
  assert.equal(fromSide.report.threadId, side);
  assert.equal(fromNowhere.report.threadId, current);

  // The live panel's read: only the current main chat's reports, with its latest run.
  const page = (await (
    await get(`/api/chat-reports?threadId=${encodeURIComponent(current)}&limit=5`)
  ).json()) as {
    reports: { id: string }[];
    thread?: { lastRunId: string | null; running: boolean };
  };
  const ids = page.reports.map((report) => report.id);
  assert.ok(ids.includes(fromFormer.report.id));
  assert.ok(ids.includes(fromNowhere.report.id));
  assert.equal(ids.includes(fromSide.report.id), false);
  assert.deepEqual(page.thread, { lastRunId: null, running: false });
  const events = await runTurn(current, "Show my calendar");
  const runId = (events[0] as { runId?: string }).runId;
  const after = (await (
    await get(`/api/chat-reports?threadId=${encodeURIComponent(current)}&limit=5`)
  ).json()) as { thread?: { lastRunId: string | null; running: boolean } };
  assert.deepEqual(after.thread, { lastRunId: runId, running: false });
  // Another project's (or an unknown) thread carries no run information.
  const foreign = (await (
    await get(`/api/chat-reports?threadId=${encodeURIComponent(randomUUID())}`)
  ).json()) as { thread?: unknown };
  assert.equal(foreign.thread, undefined);
});

test("history, the main chat and side chats survive a restart", async () => {
  const main = await mainOf();
  await runTurn(main, "Show my calendar");
  const side = randomUUID();
  // A side chat begins with a run the runtime serves with a clone of the agent per request.
  await runTurn(side, "Show my calendar");
  const before = {
    main: await (await get(`/api/copilotkit/threads/${main}/messages`)).json(),
    side: await (await get(`/api/copilotkit/threads/${side}/messages`)).json(),
    list: (await list()).map((thread) => thread.id),
  };
  await server.chat.close();
  await db.close();

  db = await createStore({ dataDir: join(directory, "postgres") });
  ({ created: server, token } = await open(db, directory));
  assert.equal(await mainOf(), main);
  assert.deepEqual(
    await (await get(`/api/copilotkit/threads/${main}/messages`)).json(),
    before.main,
  );
  assert.deepEqual(
    await (await get(`/api/copilotkit/threads/${side}/messages`)).json(),
    before.side,
  );
  assert.deepEqual(
    (await list()).map((thread) => thread.id),
    before.list,
  );
  // The reloaded conversation replays and takes the next turn after it.
  const connect = await send("POST", "/api/copilotkit/agent/default/connect", runInput(side));
  assert.equal(connect.status, 200);
  const replay = sseEvents(await connect.text());
  assert.ok(replay.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT));
  await runTurn(side, "Show my calendar again");
  const messages = (await (await get(`/api/copilotkit/threads/${side}/messages`)).json())
    .messages as unknown[];
  assert.ok(messages.length > before.side.messages.length);
});

test("health and the workspace say conversations are local, with no cloud fact on a new install", async () => {
  const health = (await (await server.app.request("/api/health")).json()) as {
    threads: string;
    threadMigration: { status: string };
  };
  assert.equal(health.threads, "local");
  assert.equal(health.threadMigration.status, "done");
  const workspace = (await (await get("/api/workspace")).json()) as {
    runtime: { threads?: string; cloudThreads?: unknown };
  };
  assert.equal(workspace.runtime.threads, "local");
  assert.equal(workspace.runtime.cloudThreads, undefined);
});

test("deleting a project deletes its conversations", async () => {
  const created = await send("POST", "/api/projects", { name: "Short-lived" });
  assert.equal(created.status, 201);
  const project = ((await created.json()) as { id: string }).id;
  const side = randomUUID();
  await runTurn(side, "Show my calendar", project);
  await mainOf(project);
  const owner = `local-user/proj:${project}`;
  const count = async () =>
    (
      await chatDatabase(db).sql<{ n: number }>(
        "SELECT count(*)::int AS n FROM chat_threads WHERE owner=$1",
        [owner],
      )
    )[0]?.n;
  assert.equal(await count(), 2);
  const removed = await server.app.request(`/api/projects/${project}`, {
    method: "DELETE",
    headers: headers(),
  });
  assert.equal(removed.status, 204, await removed.clone().text());
  assert.equal(await count(), 0);
  // Other projects' conversations are untouched.
  assert.ok((await list()).length > 0);
});
