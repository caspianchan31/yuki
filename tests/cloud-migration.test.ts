// The one-time copy of CopilotKit cloud conversations, end to end against a
// fake cloud (a local HTTP server speaking the Intelligence REST shape) through the real
// CopilotKitIntelligence client: every owner and project, every page, archived threads, threads
// the list leaves out, a partial failure, a thread someone chatted on meanwhile, the id-by-id
// check, idempotence, the counts, and the start-up decision.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import { chatDatabase } from "../apps/server/src/chat/chat-store.ts";
import {
  type CloudMessage,
  type CloudThread,
  cloudImportRunId,
  cloudThreadsFact,
  initMigrationMarker,
  intelligenceUserId,
  migrateCloudThreads,
  migrationComplete,
  migrationHealth,
  migrationOwners,
  readMarker,
  startCloudMigration,
} from "../apps/server/src/chat/cloud-migration.ts";
import type { WireMessage } from "../apps/server/src/chat/types.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { projectOwner } from "../packages/domain/src/projects.ts";

const apiKey = "test-cloud-key-never-real";
const owner = "local-user";
const projectId = "0b7a1d6e-2c3f-4a8b-9c1d-5e6f7a8b9c0d";
const deletedProject = "1b7a1d6e-2c3f-4a8b-9c1d-5e6f7a8b9c0d";
const project = projectOwner(owner, projectId);

/** The fake cloud's data: threads per cloud user, messages per thread. */
interface CloudData {
  threads: Map<string, CloudThread[]>;
  /** Threads the list leaves out but GET /threads/:id finds (as an old main chat could be). */
  hidden: Map<string, CloudThread>;
  messages: Map<string, CloudMessage[]>;
  failMessages: Set<string>;
  failList: Set<string>;
  requests: string[];
  unauthorized: number;
}

const ids = {
  main: randomUUID(),
  formerMain: randomUUID(),
  sideA: randomUUID(),
  sideArchived: randomUUID(),
  sideFlaky: randomUUID(),
  sideFromTask: randomUUID(),
  sideMore: randomUUID(),
  projectMain: randomUUID(),
  projectSide: randomUUID(),
  deletedSide: randomUUID(),
  goneFromCloud: randomUUID(),
};

const turn = (n: number, thread: string): CloudMessage[] => [
  { id: `${thread}-u${n}`, role: "user", content: `Question ${n}` },
  {
    id: `${thread}-a${n}`,
    role: "assistant",
    content: "",
    toolCalls: [{ id: `${thread}-c${n}`, name: "search_mail", args: '{"q":"invoice"}' }],
  },
  { id: `${thread}-t${n}`, role: "tool", content: '{"results":[]}', toolCallId: `${thread}-c${n}` },
  { id: `${thread}-r${n}`, role: "assistant", content: `Answer ${n}` },
];

function cloudData(): CloudData {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 8, minutes)).toISOString();
  const thread = (id: string, minutes: number, extra: Partial<CloudThread> = {}): CloudThread => ({
    id,
    name: null,
    agentId: "default",
    createdAt: at(minutes),
    lastRunAt: at(minutes + 1),
    archived: false,
    ...extra,
  });
  const data: CloudData = {
    threads: new Map([
      [
        intelligenceUserId(owner),
        [
          thread(ids.formerMain, 1),
          thread(ids.sideA, 2, { name: "Launch plan" }),
          thread(ids.sideArchived, 3, { name: "Old idea", archived: true }),
          thread(ids.sideFlaky, 4),
          thread(ids.sideMore, 5),
        ],
      ],
      [intelligenceUserId(project), [thread(ids.projectMain, 6), thread(ids.projectSide, 7)]],
      [intelligenceUserId(projectOwner(owner, deletedProject)), [thread(ids.deletedSide, 8)]],
    ]),
    hidden: new Map([
      [ids.main, thread(ids.main, 9)],
      [ids.sideFromTask, thread(ids.sideFromTask, 10)],
    ]),
    messages: new Map(),
    failMessages: new Set([ids.sideFlaky]),
    failList: new Set(),
    requests: [],
    unauthorized: 0,
  };
  for (const [index, id] of Object.values(ids).entries())
    data.messages.set(id, [...turn(1, id), ...(index % 2 ? turn(2, id) : [])]);
  // An activity message and a reasoning-free plain conversation keep their shapes too.
  data.messages.get(ids.sideA)?.push({
    id: `${ids.sideA}-act`,
    role: "activity",
    activityType: "report",
    content: { title: "Weekly" },
  });
  return data;
}

function fakeCloud(data: CloudData) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://cloud.test");
    data.requests.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      data.unauthorized++;
      return json(res, 401, { error: "unauthorized" });
    }
    const userId = url.searchParams.get("userId") ?? "";
    if (req.method === "GET" && url.pathname === "/api/threads") {
      if (data.failList.has(userId)) return json(res, 503, { error: "busy" });
      const all = (data.threads.get(userId) ?? []).filter(
        (thread) => url.searchParams.get("includeArchived") === "true" || !thread.archived,
      );
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + 2);
      return json(res, 200, {
        threads: page,
        joinCode: "join",
        nextCursor: start + 2 < all.length ? String(start + 2) : null,
      });
    }
    const match = url.pathname.match(/^\/api\/threads\/([^/]+)(\/messages)?$/);
    if (req.method === "GET" && match) {
      const id = decodeURIComponent(match[1] ?? "");
      const owned =
        (data.threads.get(userId) ?? []).find((thread) => thread.id === id) ??
        (userId === intelligenceUserId(owner) ? data.hidden.get(id) : undefined);
      if (!owned) return json(res, 404, { error: "not found" });
      if (!match[2]) return json(res, 200, { thread: owned });
      if (data.failMessages.has(id)) {
        res.writeHead(502, { "Content-Type": "text/html" });
        return res.end("<html>Bad gateway</html>");
      }
      return json(res, 200, { messages: data.messages.get(id) ?? [] });
    }
    json(res, 404, { error: "no route" });
  });
}

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

let directory: string, db: Store, server: Server, cloudUrl: string;
let created: Awaited<ReturnType<typeof createApp>>;
let token: string;
let data: CloudData;

const client = () =>
  new CopilotKitIntelligence({ apiKey, apiUrl: cloudUrl, wsUrl: "ws://127.0.0.1:1" });

async function wireMessages(threadId: string, project?: string) {
  const response = await created.app.request(`/api/copilotkit/threads/${threadId}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(project ? { "X-OpenMuse-Project": project } : {}),
    },
  });
  assert.equal(response.status, 200, threadId);
  return ((await response.json()) as { messages: WireMessage[] }).messages;
}

before(async () => {
  data = cloudData();
  server = fakeCloud(data);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cloudUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  directory = await mkdtemp(join(tmpdir(), "openmuse-cloud-migration-"));
  db = await createStore({ dataDir: join(directory, "postgres") });
  // What a pre-v0.5 database holds: the main chat records (the default project's replaced one
  // once), a live project and its main chat, a task delegated from a side chat the cloud list
  // leaves out, and a report on a thread the cloud no longer has. A deleted project left nothing.
  await db.put(owner, "conversation-settings", {
    id: "main",
    threadId: ids.main,
    existing: false,
    formerIds: [ids.formerMain],
  });
  await db.put(owner, "projects", {
    id: projectId,
    name: "Launch",
    deleting: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  await db.put(project, "conversation-settings", {
    id: "main",
    threadId: ids.projectMain,
    existing: false,
  });
  await db.put(owner, "tasks", { id: randomUUID(), originThreadId: ids.sideFromTask });
  await db.put(owner, "chat-reports", {
    id: randomUUID(),
    threadId: ids.goneFromCloud,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  created = await createApp(db, config(directory));
  const session = await created.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});

after(async () => {
  await created?.chat.close();
  await db?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a database with conversations starts pending; without a key that is a fact, not silence", async () => {
  assert.equal((await readMarker(db))?.status, "pending");
  assert.deepEqual(await cloudThreadsFact(db, false, owner), { state: "no-key" });
  // Only the first space's conversations were ever in the cloud: another space sees no fact and
  // its key is never sent to the cloud.
  const otherSpace = `space:${randomUUID()}`;
  await db.put(otherSpace, "conversation-settings", { id: "main", threadId: randomUUID() });
  await db.put(otherSpace, "projects", { id: "other-project", name: "Other" });
  try {
    assert.equal(await cloudThreadsFact(db, false, otherSpace), null);
    assert.equal(await cloudThreadsFact(db, true, otherSpace), null);
    assert.ok((await migrationOwners(db)).every((item) => item.startsWith(owner)));
  } finally {
    await db.purgeOwner(otherSpace);
  }
  const lines: string[] = [];
  const started = await startCloudMigration(
    db,
    created.chat.store,
    undefined,
    () => {
      throw new Error("no client without a key");
    },
    { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: () => {} },
  );
  assert.equal(started.state, "no-key");
  assert.deepEqual(lines, ["以前的对话还在 CopilotKit 云上，没搬回来：配置里没有云 key"]);
  const workspace = (await (
    await created.app.request("/api/workspace", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { runtime: { cloudThreads?: unknown } };
  assert.deepEqual(workspace.runtime.cloudThreads, { state: "no-key" });
});

test("the first run copies what it can and records the rest as failed, with the reason", async () => {
  const summary = await migrateCloudThreads(db, created.chat.store, client());
  assert.equal(summary.complete, false);
  assert.equal(summary.failed, 1);
  assert.equal(summary.reason, "CopilotKit 云暂时出错");
  assert.equal(summary.owners, 2, "the default project and the live project; not the deleted one");
  assert.equal(data.unauthorized, 0);
  assert.equal(
    data.requests.some((request) => request.includes(ids.deletedSide)),
    false,
  );
  assert.equal((await readMarker(db))?.status, "pending");
  assert.deepEqual(await cloudThreadsFact(db, true, owner), {
    state: "failed",
    pending: 1,
    reason: "CopilotKit 云暂时出错",
  });

  // Every copied thread holds the cloud's messages in the cloud's order, ids unchanged.
  for (const [threadId, scope] of [
    [ids.main, undefined],
    [ids.formerMain, undefined],
    [ids.sideA, undefined],
    [ids.sideArchived, undefined],
    [ids.sideFromTask, undefined],
    [ids.sideMore, undefined],
    [ids.projectMain, projectId],
    [ids.projectSide, projectId],
  ] as const) {
    const local = await wireMessages(threadId, scope);
    assert.deepEqual(
      local.map((message) => message.id),
      (data.messages.get(threadId) ?? []).map((message) => message.id),
      threadId,
    );
  }
  // Tool calls, tool results and activity keep their shapes.
  const sideA = await wireMessages(ids.sideA);
  assert.deepEqual(sideA[1], {
    id: `${ids.sideA}-a1`,
    role: "assistant",
    content: "",
    toolCalls: [{ id: `${ids.sideA}-c1`, name: "search_mail", args: '{"q":"invoice"}' }],
  });
  assert.deepEqual(sideA[2], {
    id: `${ids.sideA}-t1`,
    role: "tool",
    content: '{"results":[]}',
    toolCallId: `${ids.sideA}-c1`,
  });
  assert.equal(sideA.at(-1)?.role, "activity");

  // Owners, names, the archived flag and run times come along.
  const rows = await chatDatabase(db).sql<{
    id: string;
    owner: string;
    name: string | null;
    archived: boolean;
    last_run_at: string | null;
  }>("SELECT id, owner, name, archived, last_run_at::text FROM chat_threads ORDER BY id");
  const row = (id: string) => rows.find((item) => item.id === id);
  assert.equal(row(ids.projectSide)?.owner, project);
  assert.equal(row(ids.sideA)?.name, "Launch plan");
  assert.equal(row(ids.sideArchived)?.archived, true);
  assert.equal(row(ids.sideFlaky), undefined, "a failed thread writes nothing");
  assert.ok(row(ids.main)?.last_run_at);
  // A thread this server knew that the cloud does not have is reported, not failed.
  const migration = await chatDatabase(db).sql<{ thread_id: string; status: string }>(
    "SELECT thread_id, status FROM chat_migration",
  );
  assert.equal(migration.find((item) => item.thread_id === ids.goneFromCloud)?.status, "missing");
  assert.equal(migration.find((item) => item.thread_id === ids.sideFlaky)?.status, "failed");
});

test("a thread chatted on before it was copied gets the cloud history first", async () => {
  // Someone continued the conversation locally while it was not copied yet.
  const run = await created.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: ids.sideFlaky,
      runId: randomUUID(),
      messages: [{ id: "local-u1", role: "user", content: "Show my calendar" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  assert.equal(run.status, 200);
  await run.text();
  data.failMessages.clear();
  const before = data.requests.length;
  const summary = await migrateCloudThreads(db, created.chat.store, client());
  assert.equal(summary.complete, true);
  assert.equal(summary.failed, 0);
  // Done threads are not read again: only the lists, the unlisted known ids already resolved are
  // skipped, and the one failed thread's messages.
  const again = data.requests.slice(before).filter((request) => request.endsWith("/messages"));
  assert.deepEqual(again, [`GET /api/threads/${ids.sideFlaky}/messages`]);

  const local = (await wireMessages(ids.sideFlaky)).map((message) => message.id);
  const cloud = (data.messages.get(ids.sideFlaky) ?? []).map((message) => message.id);
  assert.deepEqual(local.slice(0, cloud.length), cloud);
  assert.equal(local[cloud.length], "local-u1");

  // The replay a reload sees: the import run first, then the local one.
  const connect = await created.app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: ids.sideFlaky,
      runId: randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const events = (await connect.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as BaseEvent & { runId?: string });
  const starts = events.filter((event) => event.type === EventType.RUN_STARTED);
  assert.equal(starts[0]?.runId, cloudImportRunId(ids.sideFlaky));
  assert.equal(events[1]?.type, EventType.MESSAGES_SNAPSHOT);
});

test("complete: counted, marked, idempotent, and the key is never used again", async () => {
  assert.equal(await migrationComplete(db), true);
  const marker = await readMarker(db);
  const cloudThreads = [...data.threads.entries()]
    .filter(([user]) => user !== intelligenceUserId(projectOwner(owner, deletedProject)))
    .flatMap(([, threads]) => threads);
  const copied = [...cloudThreads, ...data.hidden.values()];
  const messages = copied.reduce(
    (sum, thread) => sum + (data.messages.get(thread.id)?.length ?? 0),
    0,
  );
  assert.deepEqual(
    {
      owners: marker?.owners,
      threads: marker?.threads,
      archived: marker?.archived,
      messages: marker?.messages,
      missing: marker?.missing,
    },
    { owners: 2, threads: copied.length, archived: 1, messages, missing: 1 },
  );
  assert.equal(await cloudThreadsFact(db, true, owner), null);
  const health = await migrationHealth(db);
  assert.equal(health.status, "done");
  assert.equal(health.failed, 0);

  // Running it again changes nothing.
  const runs = await chatDatabase(db).sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_runs",
  );
  const summary = await migrateCloudThreads(db, created.chat.store, client());
  assert.equal(summary.complete, true);
  assert.equal(summary.threads, copied.length);
  assert.deepEqual(
    await chatDatabase(db).sql<{ n: number }>("SELECT count(*)::int AS n FROM chat_runs"),
    runs,
  );

  // At start, a complete copy builds no client and reads nothing from the cloud.
  const before = data.requests.length;
  const lines: string[] = [];
  const started = await startCloudMigration(
    db,
    created.chat.store,
    apiKey,
    () => {
      throw new Error("the cloud client must not be built after the copy is complete");
    },
    { log: (line) => lines.push(line), warn: () => {}, error: () => {} },
  );
  assert.equal(started.state, "done");
  assert.deepEqual(lines, ["以前的对话已经全部搬回，CPK_INTELLIGENCE_API_KEY 可以从配置里删掉"]);
  assert.equal(data.requests.length, before);
});

test("an owner whose cloud list cannot be read keeps the copy pending with its known threads", async () => {
  const other = await createStore();
  try {
    const app = await createApp(other, config(directory));
    try {
      await other.put(owner, "conversation-settings", { id: "main", threadId: "t-unreadable" });
      // createApp ran on an empty database (marked complete); start this one over as pending.
      await other.remove("system", "chat-migration", "cloud");
      await initMigrationMarker(other);
      assert.equal((await readMarker(other))?.status, "pending");
      data.failList.add(intelligenceUserId(owner));
      const summary = await migrateCloudThreads(other, app.chat.store, client());
      assert.equal(summary.complete, false);
      assert.equal(summary.reason, "CopilotKit 云暂时出错");
      assert.deepEqual(await cloudThreadsFact(other, true, owner), {
        state: "failed",
        pending: 1,
        reason: "CopilotKit 云暂时出错",
      });
    } finally {
      await app.chat.close();
    }
  } finally {
    data.failList.clear();
    await other.close();
  }
});

test("a stored copy that does not match the cloud id by id is not counted as done", async () => {
  const other = await createStore();
  try {
    const app = await createApp(other, config(directory));
    try {
      const threadId = ids.sideMore;
      await other.put(owner, "conversation-settings", { id: "main", threadId: ids.main });
      await other.remove("system", "chat-migration", "cloud");
      await initMigrationMarker(other);
      // An import run left with other messages (as a copy of an older state would be).
      const stale = await app.chat.store.importThread({
        owner,
        threadId,
        agentId: "default",
        name: null,
        archived: false,
        createdAt: null,
        lastRunAt: null,
        runId: cloudImportRunId(threadId),
        events: [
          { type: EventType.RUN_STARTED, threadId, runId: cloudImportRunId(threadId) } as BaseEvent,
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [{ id: "older", role: "user", content: "Older" }],
          } as BaseEvent,
          {
            type: EventType.RUN_FINISHED,
            threadId,
            runId: cloudImportRunId(threadId),
          } as BaseEvent,
        ],
        messageIds: ["older"],
      });
      assert.notEqual(stale, "forbidden");
      const summary = await migrateCloudThreads(other, app.chat.store, client());
      assert.equal(summary.complete, false);
      const rows = await chatDatabase(other).sql<{ status: string; error: string | null }>(
        "SELECT status, error FROM chat_migration WHERE thread_id=$1",
        [threadId],
      );
      assert.deepEqual(rows, [{ status: "failed", error: "搬过来的消息和云上的对不上" }]);
      assert.equal((await readMarker(other))?.status, "pending");
    } finally {
      await app.chat.close();
    }
  } finally {
    await other.close();
  }
});
