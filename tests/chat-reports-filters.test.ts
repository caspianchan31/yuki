// GET /api/chat-reports without a threadId lists the whole
// project's reports across every conversation, `taskId` keeps one task's (in any
// conversation), both together keep both. No answer carries task limits any more (fork, report
// line): waits and automatic continuations have none.
// Paging, ordering and the cursor are those of the per-thread list (report-back.md).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore, pageIndexes, pageIndexStatement, type Store } from "../apps/server/src/db.ts";
import type { ChatReport } from "../packages/domain/src/agent.ts";
import { PROJECT_HEADER, projectOwner } from "../packages/domain/src/projects.ts";

const base: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "/unused",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
};

async function app(t: TestContext, overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-chat-report-filters-"));
  const db = await createStore();
  const server = await createApp(db, { ...base, dataDir: directory, ...overrides });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const token = (await server.auth.session()).token;
  const owner = await server.auth.owner(`Bearer ${token}`);
  const get = async (query: string, project?: string) => {
    const response = await server.app.request(`/api/chat-reports${query ? `?${query}` : ""}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(project ? { [PROJECT_HEADER]: project } : {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    return {
      status: response.status,
      body,
      ids: ((body?.reports ?? []) as ChatReport[]).map((report) => report.id),
    };
  };
  return { server, db, owner, token, get };
}

const at = (i: number) => new Date(Date.UTC(2026, 9, 10, 8) + i * 1000).toISOString();
/** A stored report with a fixed createdAt, so the order is known. */
async function put(
  db: Store,
  owner: string,
  i: number,
  threadId: string,
  taskId: string,
  createdAt = at(i),
) {
  await db.put(owner, "chat-reports", {
    id: `r${String(i).padStart(2, "0")}`,
    owner,
    taskId,
    taskTitle: `Task ${taskId}`,
    threadId,
    kind: "report",
    title: "Update",
    text: `Report ${i}`,
    links: [],
    createdAt,
    readAt: null,
    afterMessageId: null,
  });
}
const r = (...numbers: number[]) => numbers.map((i) => `r${String(i).padStart(2, "0")}`);

test("without a threadId the list is the project's latest reports across every conversation", async (t) => {
  const { db, owner, get } = await app(t);
  // Three conversations, two tasks; one task reports to two conversations.
  const layout: [string, string][] = [
    ["main", "task-a"],
    ["side", "task-b"],
    ["main", "task-a"],
    ["other", "task-a"],
    ["side", "task-b"],
    ["main", "task-b"],
  ];
  for (const [i, [thread, task]] of layout.entries()) await put(db, owner, i, thread, task);

  const all = await get("");
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.ids, r(0, 1, 2, 3, 4, 5), "oldest first, every conversation");
  assert.ok(!("owner" in all.body.reports[0]), "the owner stays on the server");
  assert.deepEqual((await get("limit=2")).ids, r(4, 5), "the latest `limit`");

  // One task's reports, in whatever conversation they were posted.
  assert.deepEqual((await get("taskId=task-a")).ids, r(0, 2, 3));
  assert.deepEqual((await get("taskId=task-b&limit=2")).ids, r(4, 5));
  assert.deepEqual((await get("taskId=nope")).ids, []);
  // Both filters: that task's reports in that conversation.
  assert.deepEqual((await get("threadId=main&taskId=task-a")).ids, r(0, 2));
  assert.deepEqual((await get("threadId=side&taskId=task-a")).ids, []);
  // The per-conversation list is unchanged.
  assert.deepEqual((await get("threadId=main")).ids, r(0, 2, 5));
  assert.deepEqual((await get("threadId=side")).ids, r(1, 4));

  // Empty or oversized filters are refused like a bad threadId always was.
  for (const bad of ["threadId=", "taskId=", "taskId=%20", `taskId=${"x".repeat(201)}`])
    assert.equal((await get(bad)).status, 422, bad);
});

test("project-wide and task lists page with the same cursor rules", async (t) => {
  const { db, owner, get } = await app(t);
  for (let i = 0; i < 12; i++) await put(db, owner, i, i % 2 ? "odd" : "even", i % 3 ? "t1" : "t0");
  // Equal timestamps sort by id and never fall between pages.
  const tie = at(20);
  for (const i of [20, 21, 22]) await put(db, owner, i, "ties", "t1", tie);

  assert.deepEqual((await get("limit=3")).ids, r(20, 21, 22));
  // after: the first `limit` created at or after it.
  assert.deepEqual((await get(`after=${encodeURIComponent(at(9))}&limit=4`)).ids, r(9, 10, 11, 20));
  assert.deepEqual((await get(`after=${encodeURIComponent(tie)}`)).ids, r(20, 21, 22));
  // before (+ beforeId): the latest `limit` strictly before.
  assert.deepEqual(
    (await get(`before=${encodeURIComponent(tie)}&beforeId=r22&limit=2`)).ids,
    r(20, 21),
  );
  assert.deepEqual((await get(`before=${encodeURIComponent(tie)}&limit=3`)).ids, r(9, 10, 11));
  assert.deepEqual((await get(`before=${encodeURIComponent(at(3))}`)).ids, r(0, 1, 2));
  // Walking back page by page with the oldest report of each page reaches every report once.
  const seen: string[] = [];
  let page = await get("limit=4");
  while (page.ids.length) {
    seen.unshift(...page.ids);
    const oldest = (page.body.reports as ChatReport[])[0];
    page = await get(
      `limit=4&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
    );
  }
  assert.deepEqual(seen, r(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22));

  // The task filter pages the same way.
  assert.deepEqual((await get("taskId=t0")).ids, r(0, 3, 6, 9));
  assert.deepEqual((await get(`taskId=t0&after=${encodeURIComponent(at(4))}`)).ids, r(6, 9));
  assert.deepEqual(
    (await get(`taskId=t0&before=${encodeURIComponent(at(9))}&limit=2`)).ids,
    r(3, 6),
  );
  assert.deepEqual(
    (await get(`taskId=t1&threadId=ties&before=${encodeURIComponent(tie)}&beforeId=r21`)).ids,
    r(20),
  );
  // Without a limit the newest 50; the same 422s as the per-thread list.
  for (let i = 30; i < 90; i++) await put(db, owner, i, "bulk", "t2");
  assert.equal((await get("")).ids.length, 50);
  assert.equal((await get("taskId=t2&limit=100")).ids.length, 60);
  for (const bad of [`after=${tie}&before=${tie}`, "beforeId=r01", "limit=101", "limit=0"])
    assert.equal((await get(bad)).status, 422, bad);
});

test("the project-wide list stays inside the request's project", async (t) => {
  const { server, db, owner, token, get } = await app(t);
  const created = await server.app.request("/api/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Reddit" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json()) as { id: string };
  const scoped = projectOwner(owner, project.id);
  await put(db, scoped, 1, "thread-p", "task-p");
  await put(db, scoped, 2, "thread-q", "task-p");
  await put(db, owner, 3, "thread-d", "task-d");

  assert.deepEqual((await get("", project.id)).ids, r(1, 2));
  assert.deepEqual((await get("taskId=task-p", project.id)).ids, r(1, 2));
  assert.deepEqual((await get("")).ids, r(3), "the default project sees only its own");
  assert.deepEqual((await get("taskId=task-p")).ids, []);
  const signedOut = await server.app.request("/api/chat-reports");
  assert.equal(signedOut.status, 401);
});

test("no list carries task limits: waits and automatic continuations have none", async (t) => {
  const plain = await app(t);
  // AGENT_MAX_WAITS and AGENT_AUTO_CONTINUE_RUNS are gone (docs/report-back.md): neither
  // is read, and no limit reaches the client.
  const keys = ["AGENT_AUTO_CONTINUE_RUNS", "AGENT_MAX_WAITS", "CPK_INTELLIGENCE_API_KEY"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.AGENT_MAX_WAITS = "1";
  process.env.AGENT_AUTO_CONTINUE_RUNS = "0";
  const read = readConfig();
  assert.ok(!("agentMaxWaits" in read));
  assert.ok(!("agentAutoContinueRuns" in read));
  for (const query of ["", "threadId=t", "taskId=k", "limit=1"])
    assert.deepEqual(Object.keys((await plain.get(query)).body), ["reports"], query);
});

test("task and project-wide pages are served by their own indexes", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  const raw = (db as unknown as { db: { query: Query } }).db;
  const query = raw.query.bind(raw);
  const plans: string[] = [];
  const statements: string[] = [];
  raw.query = async (sql, params) => {
    if (/^SELECT data FROM records WHERE owner=\$1 AND kind=\$2/.test(sql)) {
      statements.push(sql);
      plans.push(
        (await query(`EXPLAIN ${sql}`, params)).rows
          .map((row) => String(row["QUERY PLAN"]))
          .join("\n"),
      );
    }
    return query(sql, params);
  };
  await query("SET enable_seqscan = off");
  const owner = "index-owner";
  for (let i = 0; i < 20; i++) await put(db, owner, i, `thread-${i % 4}`, `task-${i % 5}`);
  const page = { order: "createdAt", limit: 5 };
  assert.deepEqual(
    (await db.listPage<{ id: string }>(owner, "chat-reports", page)).map((row) => row.id),
    r(15, 16, 17, 18, 19),
  );
  await db.listPage(owner, "chat-reports", { ...page, after: at(3) });
  await db.listPage(owner, "chat-reports", { ...page, before: { value: at(9), id: "r09" } });
  const task = { ...page, field: "taskId", value: "task-2" };
  assert.deepEqual(
    (await db.listPage<{ id: string }>(owner, "chat-reports", task)).map((row) => row.id),
    r(2, 7, 12, 17),
  );
  await db.listPage(owner, "chat-reports", { ...task, after: at(3) });
  // Both filters: the thread's index (or the task's) narrows it; never a scan.
  assert.deepEqual(
    (
      await db.listPage<{ id: string }>(owner, "chat-reports", {
        ...page,
        field: "threadId",
        value: "thread-0",
        also: { taskId: "task-0" },
      })
    ).map((row) => row.id),
    r(0),
  );
  assert.equal(plans.length, 6);
  for (const plan of plans.slice(0, 3)) assert.match(plan, /records_chat_reports_owner_page/, plan);
  for (const plan of plans.slice(3, 5)) assert.match(plan, /records_chat_reports_task_page/, plan);
  assert.match(plans[5], /records_chat_reports_(?:page|task_page)/, plans[5]);
  // The latest and `after` pages come straight from the index, without sorting.
  for (const i of [0, 1, 3, 4]) assert.doesNotMatch(plans[i], /Sort/, plans[i]);
  // A one-field call still sends the statement report-back always sent.
  await db.listPage(owner, "chat-reports", { ...page, field: "threadId", value: "thread-1" });
  assert.equal(
    statements.at(-1),
    'SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4 ORDER BY (data->>$5) COLLATE "C" DESC,id COLLATE "C" DESC LIMIT $6',
  );
  await assert.rejects(
    db.listPage(owner, "chat-reports", { ...page, field: "threadId" }),
    /both field and value/,
  );
});

test("the page indexes keep their statements and add the task and project-wide ones", () => {
  const statements = pageIndexes.map(pageIndexStatement);
  assert.deepEqual(statements, [
    `CREATE INDEX IF NOT EXISTS records_chat_reports_page ON records (owner,(data->>'threadId'),((data->>'createdAt') COLLATE "C"),(id COLLATE "C")) WHERE kind='chat-reports'`,
    `CREATE INDEX IF NOT EXISTS records_run_events_page ON records (owner,(data->>'taskId'),((data->>'date') COLLATE "C"),(id COLLATE "C")) WHERE kind='run-events'`,
    `CREATE INDEX IF NOT EXISTS records_chat_reports_task_page ON records (owner,(data->>'taskId'),((data->>'createdAt') COLLATE "C"),(id COLLATE "C")) WHERE kind='chat-reports'`,
    `CREATE INDEX IF NOT EXISTS records_chat_reports_owner_page ON records (owner,((data->>'createdAt') COLLATE "C"),(id COLLATE "C")) WHERE kind='chat-reports'`,
  ]);
});
