import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  ChatStore,
  CursorError,
  chatDatabase,
  indexRows,
  storableText,
  toJsonb,
} from "../apps/server/src/chat/chat-store.ts";
import {
  messageIdsOf,
  messagesFromEvents,
  persistedRunEvents,
  stateFromEvents,
  toWireMessages,
} from "../apps/server/src/chat/events.ts";
import type { Store } from "../apps/server/src/db.ts";
import { createChatTestStore } from "./helpers/chat-database.ts";

let db: Store;
let chats: ChatStore;

before(async () => {
  db = await createChatTestStore();
  chats = await ChatStore.open(db);
});

after(async () => {
  await db.close();
});

const ev = (event: Record<string, unknown>) => event as unknown as BaseEvent;

/** Begins and closes a run directly through the store, like the runner does. */
async function storeRun(
  threadId: string,
  runId: string,
  text: string,
  options: { userText?: string } = {},
) {
  const newMessages = options.userText
    ? [{ id: `${runId}-user`, role: "user" as const, content: options.userText }]
    : [];
  const started = persistedRunEvents([], { threadId, runId, newMessages })[0] as BaseEvent;
  const begun = await chats.beginRun({
    threadId,
    runId,
    instanceId: "test",
    started,
    staleAfterMs: 30_000,
  });
  assert.equal(begun.status, "begun");
  const events = persistedRunEvents(
    [
      ev({ type: EventType.RUN_STARTED, threadId, runId }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: `${runId}-a`, role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: `${runId}-a`, delta: text }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: `${runId}-a` }),
      ev({ type: EventType.STATE_SNAPSHOT, snapshot: { lastRun: runId } }),
      ev({ type: EventType.RUN_FINISHED, threadId, runId }),
    ],
    { threadId, runId, newMessages },
  );
  const closed = await chats.closeRun({
    threadId,
    runId,
    status: "finished",
    events,
    messageIds: messageIdsOf(events),
  });
  assert.deepEqual(closed, { closed: true, released: true });
}

test("open is idempotent and creates the chat tables", async () => {
  const again = await ChatStore.open(db);
  assert.ok(again);
  const tables = await chatDatabase(db).sql<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_name LIKE 'chat_%' ORDER BY 1",
  );
  assert.deepEqual(
    tables.map((row) => row.name),
    [
      "chat_events",
      "chat_feedback",
      "chat_messages",
      "chat_migration",
      "chat_runs",
      "chat_threads",
    ],
  );
  // The sweep's scan of running runs is indexed.
  const indexes = await chatDatabase(db).sql<{ name: string; definition: string }>(
    "SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE tablename='chat_runs'",
  );
  const definition = (name: string) => indexes.find((index) => index.name === name)?.definition;
  assert.match(definition("chat_runs_running") ?? "", /\(thread_id\) WHERE \(status = 'running'/);
});

test("ensureThread creates once and refuses another owner's id", async () => {
  assert.equal(await chats.ensureThread("alice", "ensure-1", "default"), "ok");
  assert.equal(await chats.ensureThread("alice", "ensure-1", "default"), "ok");
  assert.equal(await chats.ensureThread("bob", "ensure-1", "default"), "forbidden");
  assert.equal(await chats.threadOwner("ensure-1"), "alice");
  assert.equal(await chats.threadOwner("ensure-missing"), null);
});

test("listThreads: ran threads only, newest first, paginated, owner and agent scoped", async () => {
  const owner = "lister";
  await chats.ensureThread(owner, "list-never-ran", "default");
  for (const id of ["list-a", "list-b", "list-c", "list-d", "list-e"]) {
    await chats.ensureThread(owner, id, "default");
    await storeRun(id, `${id}-run`, "hi");
  }
  await chats.ensureThread(owner, "list-other-agent", "helper");
  await storeRun("list-other-agent", "list-other-agent-run", "hi");
  await chats.ensureThread("someone-else", "list-foreign", "default");
  await storeRun("list-foreign", "list-foreign-run", "hi");
  // A new run on list-b moves it to the top.
  await storeRun("list-b", "list-b-run-2", "again");

  const all = await chats.listThreads(owner, { agentId: "default" });
  assert.deepEqual(
    all.threads.map((thread) => thread.id),
    ["list-b", "list-e", "list-d", "list-c", "list-a"],
  );
  assert.equal(all.nextCursor, null);
  const first = all.threads[0];
  assert.ok(first);
  assert.equal(first.agentId, "default");
  assert.equal(first.organizationId, "");
  assert.equal(first.createdById, "");
  assert.equal(first.name, null);
  assert.equal(first.archived, false);
  assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(first.lastRunAt ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await chats.listThreads(owner, { agentId: "default", limit: 2, cursor });
    seen.push(...result.threads.map((thread) => thread.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  assert.deepEqual(seen, ["list-b", "list-e", "list-d", "list-c", "list-a"]);

  const helper = await chats.listThreads(owner, { agentId: "helper" });
  assert.deepEqual(
    helper.threads.map((thread) => thread.id),
    ["list-other-agent"],
  );
  const foreign = await chats.listThreads("someone-else", { agentId: "default" });
  assert.deepEqual(
    foreign.threads.map((thread) => thread.id),
    ["list-foreign"],
  );
});

test("list cursors do not depend on the database's DateStyle", async (t) => {
  const owner = "datestyle";
  for (const id of ["style-a", "style-b", "style-c"]) {
    await chats.ensureThread(owner, id, "default");
    await storeRun(id, `${id}-run`, "hi");
  }
  // Two threads at the same instant: the id orders them.
  await chatDatabase(db).sql(
    "UPDATE chat_threads SET last_run_at=(SELECT last_run_at FROM chat_threads WHERE id='style-a') WHERE id='style-b'",
  );
  // The stored instants, to the millisecond (as a JavaScript Date holds them).
  const instants = new Map(
    (
      await chatDatabase(db).sql<{ id: string; created: string; run: string }>(
        `SELECT id, floor(extract(epoch FROM created_at) * 1000)::bigint::text AS created,
          floor(extract(epoch FROM last_run_at) * 1000)::bigint::text AS run
        FROM chat_threads WHERE owner=$1`,
        [owner],
      )
    ).map((row) => [
      row.id,
      {
        createdAt: new Date(Number(row.created)).toISOString(),
        lastRunAt: new Date(Number(row.run)).toISOString(),
      },
    ]),
  );
  t.after(() => chatDatabase(db).sql("SET DateStyle = 'ISO, MDY'"));
  for (const style of ["ISO, MDY", "SQL, DMY", "Postgres, MDY", "German"]) {
    await chatDatabase(db).sql(`SET DateStyle = '${style}'`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await chats.listThreads(owner, { agentId: "default", limit: 1, cursor });
      for (const thread of result.threads) {
        seen.push(thread.id);
        assert.deepEqual(
          { createdAt: thread.createdAt, lastRunAt: thread.lastRunAt },
          instants.get(thread.id),
          `${style}: ${thread.id}`,
        );
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    assert.deepEqual(seen, ["style-c", "style-b", "style-a"], style);
    const renamed = await chats.updateThread(owner, "style-a", "default", { name: style });
    assert.equal(renamed?.lastRunAt, instants.get("style-a")?.lastRunAt, style);
  }
});

test("stored text never carries NUL characters or unpaired surrogates", async () => {
  const value = {
    "key \uD800": ["\uDC00 low", "pair \uD83D\uDE00 kept", "nul \u0000"],
    nested: { "\u0000": "high at the end \uD83D" },
  };
  const rows = await chatDatabase(db).sql<{ value: unknown }>("SELECT $1::jsonb AS value", [
    toJsonb(value),
  ]);
  assert.deepEqual(rows[0]?.value, {
    "key \uFFFD": ["\uFFFD low", "pair \uD83D\uDE00 kept", "nul \uFFFD"],
    nested: { "\uFFFD": "high at the end \uFFFD" },
  });
  assert.equal(storableText("plain \uD83D\uDE00"), "plain \uD83D\uDE00");
  await chats.ensureThread("alice", "t-odd-name", "default");
  const renamed = await chats.updateThread("alice", "t-odd-name", "default", {
    name: "a\u0000b\uD83D",
  });
  assert.equal(renamed?.name, "a\uFFFDb\uFFFD");
});

test("listThreads rejects bad cursors with CursorError", async () => {
  for (const cursor of [
    "%%%",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ k: "yesterday", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "2026-13-45 99:00:00+00", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "2026-01-01 00:00:00+00", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "-1", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "1".repeat(19), id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "1760000000000000" })).toString("base64url"),
  ]) {
    await assert.rejects(
      chats.listThreads("lister", { agentId: "default", cursor }),
      (error: Error) => error instanceof CursorError && error.name === "CursorError",
      cursor,
    );
  }
});

test("updateThread renames, archives and unarchives; listing honours includeArchived", async () => {
  const owner = "updater";
  await chats.ensureThread(owner, "upd-1", "default");
  await storeRun("upd-1", "upd-1-run", "hello");
  const renamed = await chats.updateThread(owner, "upd-1", "default", { name: "Trip plans" });
  assert.equal(renamed?.name, "Trip plans");
  assert.equal(renamed?.archived, false);
  const archived = await chats.updateThread(owner, "upd-1", "default", { archived: true });
  assert.equal(archived?.archived, true);
  assert.equal(archived?.name, "Trip plans");
  assert.deepEqual((await chats.listThreads(owner, { agentId: "default" })).threads, []);
  const withArchived = await chats.listThreads(owner, {
    agentId: "default",
    includeArchived: true,
  });
  assert.deepEqual(
    withArchived.threads.map((thread) => [thread.id, thread.archived]),
    [["upd-1", true]],
  );
  const restored = await chats.updateThread(owner, "upd-1", "default", { archived: false });
  assert.equal(restored?.archived, false);
  assert.equal((await chats.listThreads(owner, { agentId: "default" })).threads.length, 1);

  assert.equal(await chats.updateThread("intruder", "upd-1", "default", { name: "x" }), null);
  assert.equal(await chats.updateThread(owner, "upd-1", "other-agent", { name: "x" }), null);
  assert.equal(await chats.updateThread(owner, "upd-missing", "default", { name: "x" }), null);
  assert.equal((await chats.updateThread(owner, "upd-1", "default", {}))?.name, "Trip plans");
});

test("deleteThread cascades runs and journal, refuses while running, scopes by owner", async () => {
  const owner = "deleter";
  await chats.ensureThread(owner, "del-1", "default");
  await storeRun("del-1", "del-1-run", "bye");
  assert.equal(await chats.deleteThread("intruder", "del-1", "default"), "not_found");
  assert.equal(await chats.deleteThread(owner, "del-1", "other-agent"), "not_found");

  // While a run holds the lock the thread cannot be deleted.
  const begun = await chats.beginRun({
    threadId: "del-1",
    runId: "del-1-live",
    instanceId: "test",
    started: persistedRunEvents([], {
      threadId: "del-1",
      runId: "del-1-live",
      newMessages: [],
    })[0] as BaseEvent,
    staleAfterMs: 30_000,
  });
  assert.equal(begun.status, "begun");
  await chats.appendJournal("del-1-live", 0, [
    ev({ type: EventType.RUN_STARTED, threadId: "del-1", runId: "del-1-live" }),
  ]);
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "running");

  await chats.closeRun({
    threadId: "del-1",
    runId: "del-1-live",
    status: "finished",
    events: [],
    messageIds: [],
  });
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "deleted");
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "not_found");
  const leftovers = await chatDatabase(db).sql<{ runs: number; journal: number }>(
    `SELECT (SELECT count(*) FROM chat_runs WHERE thread_id='del-1')::int AS runs,
      (SELECT count(*) FROM chat_events WHERE run_id IN ('del-1-run','del-1-live'))::int AS journal`,
  );
  assert.deepEqual(leftovers[0], { runs: 0, journal: 0 });
});

test("deleteThread cascades a running run's journal rows", async () => {
  await chats.ensureThread("cascade", "del-2", "default");
  await chats.beginRun({
    threadId: "del-2",
    runId: "del-2-live",
    instanceId: "test",
    started: persistedRunEvents([], {
      threadId: "del-2",
      runId: "del-2-live",
      newMessages: [],
    })[0] as BaseEvent,
    staleAfterMs: 30_000,
  });
  await chats.appendJournal("del-2-live", 0, [
    ev({ type: EventType.RUN_STARTED, threadId: "del-2", runId: "del-2-live" }),
  ]);
  // Forced release (as if the lock were cleared) lets the row go; its run and journal cascade.
  await chatDatabase(db).sql("UPDATE chat_threads SET run_id=NULL WHERE id='del-2'");
  assert.equal(await chats.deleteThread("cascade", "del-2", "default"), "deleted");
  const rows = await chatDatabase(db).sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_events WHERE run_id='del-2-live'",
  );
  assert.equal(rows[0]?.n, 0);
});

test("threadEvents is owner scoped and compacts closed runs into messages and state", async () => {
  const owner = "reader";
  await chats.ensureThread(owner, "read-1", "default");
  await storeRun("read-1", "read-1-r1", "Hello", { userText: "Hi" });
  await storeRun("read-1", "read-1-r2", "Again", { userText: "More" });
  assert.equal(await chats.threadEvents("intruder", "read-1"), null);
  assert.equal(await chats.threadEvents(owner, "read-missing"), null);
  const events = await chats.threadEvents(owner, "read-1");
  assert.ok(events);
  assert.deepEqual(events.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  const messages = toWireMessages(messagesFromEvents(events));
  assert.deepEqual(messages, [
    { id: "read-1-r1-user", role: "user", content: "Hi" },
    { id: "read-1-r1-a", role: "assistant", content: "Hello" },
    { id: "read-1-r2-user", role: "user", content: "More" },
    { id: "read-1-r2-a", role: "assistant", content: "Again" },
  ]);
  assert.deepEqual(stateFromEvents(events), { lastRun: "read-1-r2" });
  // A thread that never ran has no events.
  await chats.ensureThread(owner, "read-empty", "default");
  assert.deepEqual(await chats.threadEvents(owner, "read-empty"), []);
});

test("claim, begin and release statements guard the lock", async () => {
  const claim = (owner: string, runId: string) =>
    chats.claimRun({
      owner,
      threadId: "lock-1",
      agentId: "default",
      runId,
      instanceId: "test",
      staleAfterMs: 30_000,
    });
  assert.equal((await claim("locker", "r1")).claimed, true);
  const busy = await claim("locker", "r2");
  assert.equal(busy.claimed, false);
  assert.equal(busy.holder, "r1");
  assert.equal(busy.stale, false);
  const foreign = await claim("intruder", "r3");
  assert.equal(foreign.claimed, false);
  assert.equal(foreign.owner, "locker");
  assert.equal(await chats.isLocked("lock-1"), true);
  assert.equal(await chats.releaseClaim("lock-1", "r2"), false);
  assert.equal(await chats.releaseClaim("lock-1", "r1"), true);
  assert.equal(await chats.isLocked("lock-1"), false);
  assert.equal(await chats.isLocked("lock-missing"), false);
});

test("releasing a claim deletes a thread row that never ran; ran, named or archived rows stay", async () => {
  const claim = (threadId: string, runId: string) =>
    chats.claimRun({
      owner: "keeper",
      threadId,
      agentId: "default",
      runId,
      instanceId: "test",
      staleAfterMs: 30_000,
    });
  // A refused first run (unknown agent, invalid body) leaves no row behind.
  assert.equal((await claim("rel-new", "n1")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-new", "n1"), true);
  assert.equal(await chats.threadOwner("rel-new"), null);
  // A thread that has run keeps its row and history; only the lock is released.
  await chats.ensureThread("keeper", "rel-ran", "default");
  await storeRun("rel-ran", "ran-1", "kept");
  assert.equal((await claim("rel-ran", "ran-2")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-ran", "ran-2"), true);
  assert.equal(await chats.threadOwner("rel-ran"), "keeper");
  assert.equal(await chats.isLocked("rel-ran"), false);
  assert.equal((await chats.historicMessageIds("rel-ran")).length > 0, true);
  // A renamed or archived thread that has not run yet keeps its row.
  for (const [id, patch] of [
    ["rel-named", { name: "Plans" }],
    ["rel-archived", { archived: true }],
  ] as const) {
    await chats.ensureThread("keeper", id, "default");
    await chats.updateThread("keeper", id, "default", patch);
    assert.equal((await claim(id, `${id}-run`)).claimed, true);
    assert.equal(await chats.releaseClaim(id, `${id}-run`), true);
    assert.equal(await chats.threadOwner(id), "keeper");
    assert.equal(await chats.isLocked(id), false);
  }
  // A release for another run id changes nothing.
  assert.equal((await claim("rel-other", "o1")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-other", "o2"), false);
  assert.equal(await chats.isLocked("rel-other"), true);
  assert.equal(await chats.releaseClaim("rel-other", "o1"), true);
});

test("a message that only calls a tool counts as known through the tool call's parent", () => {
  const ids = messageIdsOf([
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "search",
      parentMessageId: "m-tool",
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m-text", role: "assistant" } as BaseEvent,
  ]);
  assert.deepEqual(ids.sort(), ["m-text", "m-tool"]);
});

// v1.6 聊天基础动作 ---------------------------------------------------------------------------

test("supersedeFrom hides the stretch from the conversation; the next run adopts it", async () => {
  await chats.ensureThread("sup", "sup-1", "default");
  await storeRun("sup-1", "s-r1", "first answer", { userText: "first question" });
  await storeRun("sup-1", "s-r2", "second answer", { userText: "second question" });
  await storeRun("sup-1", "s-r3", "third answer", { userText: "third question" });
  // Unknown thread, another owner, a message no run brought in.
  assert.equal(await chats.supersedeFrom("sup", "sup-missing", "s-r2-user"), "not_found");
  assert.equal(await chats.supersedeFrom("other", "sup-1", "s-r2-user"), "not_found");
  assert.equal(await chats.supersedeFrom("sup", "sup-1", "nope"), "no_message");
  // Locked while a reply holds the thread.
  assert.equal(
    (
      await chats.claimRun({
        threadId: "sup-1",
        runId: "s-hold",
        instanceId: "test",
        agentId: "default",
        owner: "sup",
        staleAfterMs: 30_000,
      })
    ).claimed,
    true,
  );
  assert.equal(await chats.supersedeFrom("sup", "sup-1", "s-r2-user"), "running");
  assert.equal(await chats.releaseClaim("sup-1", "s-hold"), true);
  // From the second question on: runs 2 and 3 go, run 1 stays.
  assert.equal(await chats.supersedeFrom("sup", "sup-1", "s-r2-user"), "superseded");
  const history = await chats.history("sup-1");
  assert.deepEqual(
    history.messages.map((m) => m.id),
    ["s-r1-user", "s-r1-a"],
  );
  // The superseded person's message is new again (sent again, it is stored again).
  assert.equal(history.ids.has("s-r2-user"), false);
  assert.equal((await chats.historicMessageIds("sup-1")).includes("s-r3-a"), false);
  const events = (await chats.threadEvents("sup", "sup-1")) ?? [];
  assert.equal(messagesFromEvents(events).length, 2);
  const all = (await chats.threadEvents("sup", "sup-1", { superseded: true })) ?? [];
  assert.equal(messagesFromEvents(all).length, 6);
  const connect = await chats.connectHistory("sup-1");
  assert.equal(connect.closed.length, 1);
  assert.deepEqual(
    (await chats.turns("sup", "sup-1"))?.map((turn) => turn.runId),
    ["s-r1"],
  );
  // Not adopted yet: no run has begun since.
  let segments = (await chats.superseded("sup", "sup-1")) ?? [];
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.anchor, null);
  assert.deepEqual(
    messagesFromEvents(segments[0]?.events ?? []).map((m) => m.id),
    ["s-r2-user", "s-r2-a", "s-r3-user", "s-r3-a"],
  );
  // Superseding again changes nothing (only live runs are superseded).
  assert.equal(await chats.supersedeFrom("sup", "sup-1", "s-r2-user"), "no_message");
  // The next run (the question sent again) takes the stretch's place.
  await storeRun("sup-1", "s-r4", "second answer, again", { userText: "second question, edited" });
  segments = (await chats.superseded("sup", "sup-1")) ?? [];
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.anchor, "s-r4");
  assert.deepEqual(
    (await chats.history("sup-1")).messages.map((m) => m.id),
    ["s-r1-user", "s-r1-a", "s-r4-user", "s-r4-a"],
  );
  // The parent of the new run is the last live run, not a superseded one.
  const parent = await chatDatabase(db).sql<{ parent_run_id: string | null }>(
    "SELECT parent_run_id FROM chat_runs WHERE run_id='s-r4'",
  );
  assert.equal(parent[0]?.parent_run_id, "s-r1");
  // Going back on the replacement too: both stretches lead to the run that finally stands there.
  assert.equal(await chats.supersedeFrom("sup", "sup-1", "s-r4-user"), "superseded");
  await storeRun("sup-1", "s-r5", "final answer", { userText: "second question, final" });
  segments = (await chats.superseded("sup", "sup-1")) ?? [];
  assert.equal(segments.length, 1, "consecutive stretches before one run fold together");
  assert.equal(segments[0]?.anchor, "s-r5");
  assert.deepEqual(
    messagesFromEvents(segments[0]?.events ?? []).map((m) => m.id),
    ["s-r2-user", "s-r2-a", "s-r3-user", "s-r3-a", "s-r4-user", "s-r4-a"],
  );
  assert.equal(await chats.superseded("other", "sup-1"), null);
  assert.equal(await chats.superseded("sup", "sup-missing"), null);
});

test("feedback is one verdict per reply, owner scoped, gone with the thread", async () => {
  await chats.ensureThread("fb", "fb-1", "default");
  await storeRun("fb-1", "fb-r1", "an answer", { userText: "a question" });
  assert.deepEqual(await chats.feedback("fb", "fb-1"), {});
  assert.equal(await chats.feedback("other", "fb-1"), null);
  assert.equal(await chats.feedback("fb", "fb-missing"), null);
  assert.equal(await chats.setFeedback("other", "fb-1", "fb-r1-a", "up"), false);
  assert.equal(await chats.setFeedback("fb", "fb-missing", "fb-r1-a", "up"), false);
  assert.equal(await chats.setFeedback("fb", "fb-1", "fb-r1-a", "up"), true);
  assert.deepEqual(await chats.feedback("fb", "fb-1"), { "fb-r1-a": "up" });
  assert.equal(await chats.setFeedback("fb", "fb-1", "fb-r1-a", "down"), true);
  assert.deepEqual(await chats.feedback("fb", "fb-1"), { "fb-r1-a": "down" });
  assert.equal(await chats.setFeedback("fb", "fb-1", "fb-r1-a", null), true);
  assert.deepEqual(await chats.feedback("fb", "fb-1"), {});
  assert.equal(await chats.setFeedback("fb", "fb-1", "fb-r1-a", "up"), true);
  assert.equal(await chats.deleteThread("fb", "fb-1", "default"), "deleted");
  const left = await chatDatabase(db).sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_feedback WHERE thread_id='fb-1'",
  );
  assert.equal(left[0]?.n, 0);
});

// v1.6 搜对话内容 ---------------------------------------------------------------------------

test("closing a run indexes its words; search finds CJK and Latin, newest first, owner scoped", async () => {
  await chats.ensureThread("seeker", "find-1", "default");
  await storeRun("find-1", "f-r1", "回复：暗号是 Pineapple 42", { userText: "请记住这个暗号" });
  await storeRun("find-1", "f-r2", "好的，已经记下了", { userText: "再说一遍 pineapple" });
  await chats.ensureThread("seeker", "find-2", "default");
  await storeRun("find-2", "f-r3", "another answer", { userText: "无关的话" });
  await chats.ensureThread("someone-else", "find-3", "default");
  await storeRun("find-3", "f-r4", "暗号 belongs to another", { userText: "暗号" });

  const hits = await chats.searchMessages("seeker", "暗号");
  assert.deepEqual(
    hits.map((hit) => [hit.threadId, hit.messageId, hit.role]),
    [
      ["find-1", "f-r1-a", "assistant"],
      ["find-1", "f-r1-user", "user"],
    ],
  );
  assert.deepEqual(hits[0]?.snippet, { before: "回复：", match: "暗号", after: "是 Pineapple 42" });
  assert.equal(hits[0]?.archived, false);
  assert.match(hits[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  // Latin by prefix, whatever the case; two phrases must both appear.
  assert.deepEqual(
    (await chats.searchMessages("seeker", "PINE")).map((hit) => hit.messageId).sort(),
    ["f-r1-a", "f-r2-user"],
  );
  assert.deepEqual(
    (await chats.searchMessages("seeker", "暗号 pineapple")).map((hit) => hit.messageId),
    ["f-r1-a"],
  );
  // A single character has no bigram: the substring test alone finds it.
  assert.equal((await chats.searchMessages("seeker", "暗")).length, 2);
  // Bigrams of different words are no hit: 记 and 这 are not next to each other anywhere.
  assert.deepEqual(await chats.searchMessages("seeker", "记这"), []);
  assert.deepEqual(await chats.searchMessages("seeker", "   "), []);
  // Only one's own conversations.
  assert.deepEqual(
    (await chats.searchMessages("someone-else", "暗号")).map((hit) => hit.threadId),
    ["find-3", "find-3"],
  );
  // The limit is kept.
  assert.equal((await chats.searchMessages("seeker", "暗号", { limit: 1 })).length, 1);
});

test("search skips superseded stretches, keeps archived, forgets deleted; the backlog catches up", async () => {
  await chats.ensureThread("seeker2", "find-s", "default");
  await storeRun("find-s", "fs-r1", "one Zebra", { userText: "q1" });
  await storeRun("find-s", "fs-r2", "two Zebra", { userText: "q2" });
  assert.equal((await chats.searchMessages("seeker2", "zebra")).length, 2);
  // Going back on the second question: its stretch leaves the search too.
  assert.equal(await chats.supersedeFrom("seeker2", "find-s", "fs-r2-user"), "superseded");
  assert.deepEqual(
    (await chats.searchMessages("seeker2", "zebra")).map((hit) => hit.messageId),
    ["fs-r1-a"],
  );
  await storeRun("find-s", "fs-r3", "three Zebra", { userText: "q2 again" });
  assert.equal((await chats.searchMessages("seeker2", "zebra")).length, 2);
  // Archived conversations are still searched, and say so.
  await chats.updateThread("seeker2", "find-s", "default", { archived: true });
  const archived = await chats.searchMessages("seeker2", "zebra");
  assert.equal(archived.length, 2);
  assert.equal(archived[0]?.archived, true);
  // A deleted conversation is gone from the search.
  assert.equal(await chats.deleteThread("seeker2", "find-s", "default"), "deleted");
  assert.deepEqual(await chats.searchMessages("seeker2", "zebra"), []);
  // The backlog indexes what is not indexed yet (conversations from before the index).
  await chats.ensureThread("seeker2", "find-b", "default");
  await storeRun("find-b", "fb-r1", "Quokka here", { userText: "hi" });
  await chatDatabase(db).sql("DELETE FROM chat_messages WHERE thread_id='find-b'");
  await chatDatabase(db).sql("UPDATE chat_runs SET indexed_at=NULL WHERE thread_id='find-b'");
  assert.deepEqual(await chats.searchMessages("seeker2", "quokka"), []);
  assert.ok((await chats.indexBacklog(10)) >= 1);
  assert.equal((await chats.searchMessages("seeker2", "quokka")).length, 1);
  assert.equal(await chats.indexBacklog(10), 0);
});

test("indexRows keeps the person's and the members' words, file names included, once each", () => {
  const events = persistedRunEvents(
    [
      ev({ type: EventType.RUN_STARTED, threadId: "ix", runId: "ix-r" }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "ix-a", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "ix-a", delta: "看过了，" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "ix-a", delta: "合同号 HT-2026" }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: "ix-a" }),
      ev({ type: EventType.RUN_FINISHED, threadId: "ix", runId: "ix-r" }),
    ],
    {
      threadId: "ix",
      runId: "ix-r",
      newMessages: [
        {
          id: "ix-user",
          role: "user",
          content: [
            { type: "text", text: "看看这份合同" },
            {
              type: "binary",
              mimeType: "application/pdf",
              id: "AAAAAAAAAAAAAAAAAAAAAA",
              filename: "租房合同.pdf",
            },
          ] as unknown as string,
        },
      ],
    },
  );
  const rows = indexRows(events);
  assert.deepEqual(
    rows.map((row) => [row.id, row.role, row.body]),
    [
      ["ix-user", "user", "看看这份合同 租房合同.pdf"],
      ["ix-a", "assistant", "看过了，合同号 HT-2026"],
    ],
  );
  assert.ok(rows[0]?.tokens.includes("合同"));
  assert.ok(rows[0]?.tokens.includes("pdf"));
  assert.ok(rows[1]?.tokens.includes("ht"));
  assert.ok(rows[1]?.tokens.includes("2026"));
});

test("a search over ten thousand messages answers within a second", async () => {
  const pool =
    "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严";
  const events: BaseEvent[][] = [];
  for (let run = 0; run < 100; run++) {
    const newMessages = [];
    for (let i = 0; i < 100; i++) {
      const n = run * 100 + i;
      let text = "";
      for (let k = 0; k < 30; k++) text += pool[(n * 31 + k * 7 + run) % pool.length];
      if (n === 5000) text += "青蛙王子在这里";
      newMessages.push({ id: `bulk-${n}`, role: "user" as const, content: text });
    }
    events.push(persistedRunEvents([], { threadId: "bulk-1", runId: `bulk-r${run}`, newMessages }));
  }
  await chats.ensureThread("bulky", "bulk-1", "default");
  for (let run = 0; run < 100; run++) {
    await chatDatabase(db).sql(
      "INSERT INTO chat_runs(run_id, thread_id, status, events, message_ids) VALUES ($1, 'bulk-1', 'finished', '[]', '[]')",
      [`bulk-r${run}`],
    );
    await chats.indexRun("bulk-1", `bulk-r${run}`, events[run] ?? []);
  }
  const count = await chatDatabase(db).sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_messages WHERE thread_id='bulk-1'",
  );
  assert.equal(count[0]?.n, 10_000);
  const began = performance.now();
  const hits = await chats.searchMessages("bulky", "青蛙王子");
  const took = performance.now() - began;
  assert.deepEqual(
    hits.map((hit) => hit.messageId),
    ["bulk-5000"],
  );
  assert.ok(took < 1000, `search took ${Math.round(took)} ms`);
  const beganPrefix = performance.now();
  await chats.searchMessages("bulky", "王子");
  assert.ok(performance.now() - beganPrefix < 1000);
});

test("v1.7 打开对话不重放整条历史: a connect replays the newest runs; the older ones page back", async () => {
  await chats.ensureThread("alice", "page-1", "default");
  for (let i = 1; i <= 6; i++)
    await storeRun("page-1", `pr-${i}`, `reply ${i}`, { userText: `ask ${i}` });
  // the newest two runs only
  const two = await chats.connectHistory("page-1", undefined, { lastRuns: 2 });
  assert.equal(two.closed.length, 2);
  const texts = (runs: BaseEvent[][]) =>
    runs
      .flat()
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta);
  assert.deepEqual(texts(two.closed), ["reply 5", "reply 6"]);
  // everything without a limit, and with 0
  assert.equal((await chats.connectHistory("page-1")).closed.length, 6);
  assert.equal((await chats.connectHistory("page-1", undefined, { lastRuns: 0 })).closed.length, 6);
  // the page before the oldest replayed message (ask 5): two runs, then two more, then nothing
  const first = await chats.olderRuns("alice", "page-1", "pr-5-user", { limit: 2 });
  assert.ok(first);
  assert.deepEqual(texts(first.runs), ["reply 3", "reply 4"]);
  assert.equal(first.more, true);
  const second = await chats.olderRuns("alice", "page-1", "pr-3-user", { limit: 2 });
  assert.deepEqual(texts(second?.runs ?? []), ["reply 1", "reply 2"]);
  assert.equal(second?.more, false);
  // back to a given message in one go (a jump from the search)
  const until = await chats.olderRuns("alice", "page-1", "pr-6-user", { untilMessageId: "pr-2-a" });
  assert.deepEqual(texts(until?.runs ?? []), ["reply 2", "reply 3", "reply 4", "reply 5"]);
  assert.equal(until?.more, true);
  // an assistant message id anchors too; an unknown one or another owner gives null
  assert.deepEqual(
    texts((await chats.olderRuns("alice", "page-1", "pr-2-a", { limit: 5 }))?.runs ?? []),
    ["reply 1"],
  );
  assert.equal(await chats.olderRuns("alice", "page-1", "nope"), null);
  assert.equal(await chats.olderRuns("bob", "page-1", "pr-5-user"), null);
});
