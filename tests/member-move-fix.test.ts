// v1.4 acceptance fixes: a member's own conversation follows her into (and out of) a group, and a
// member being deleted no longer holds her name.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { HandlerHookContext } from "@copilotkit/runtime/v2";
import { ChatStore } from "../apps/server/src/chat/chat-store.ts";
import { chatRuntimeHooks } from "../apps/server/src/chat/runtime-hooks.ts";
import { memberConversationId } from "../packages/domain/src/member-thread.ts";
import { projectOwner } from "../packages/domain/src/projects.ts";
import { type Harness, harness } from "./helpers/sign-in-harness.ts";

async function group(h: Harness, name: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.db.put(h.owner, "projects", {
    id,
    name,
    deleting: false,
    createdAt: now,
    updatedAt: now,
  });
  return { id, owner: projectOwner(h.owner, id) };
}

test("a member's conversation opens in the group she joined, and back out of it", async (t) => {
  const h = await harness(t);
  const store = await ChatStore.open(h.db);
  const g = await group(h, "运营组");
  const ann = await h.environments.create(h.owner, { name: "Ann" });
  const threadId = memberConversationId(ann.id);
  assert.equal(await store.ensureThread(h.owner, threadId, "default"), "ok");
  const other = await store.ensureThread("other-space", "another-thread", "default");
  assert.equal(other, "ok");

  await h.environments.assign(g.owner, ann.id, g.id);
  assert.equal(await store.threadOwner(threadId), g.owner, "joining takes the conversation along");
  assert.equal(await store.threadOwner("another-thread"), "other-space");

  // Left through the group's own scope (the API moves her out as the project's owner).
  await h.environments.assign(g.owner, ann.id, null);
  assert.equal(await store.threadOwner(threadId), h.owner, "leaving takes it back");
});

test("a conversation that stayed behind is adopted when the group's chat opens it", async (t) => {
  const h = await harness(t);
  const store = await ChatStore.open(h.db);
  const g = await group(h, "运营组");
  const threadId = memberConversationId(randomUUID());
  await store.ensureThread(h.owner, threadId, "default");
  const plain = randomUUID();
  await store.ensureThread(h.owner, plain, "default");
  const hooks = chatRuntimeHooks({
    owner: async () => g.owner,
    threads: store,
    runs: { claim: async () => ({ ok: true }), release: async () => {} } as never,
  });
  const connect = (id: string) =>
    hooks.onBeforeHandler({
      request: new Request("http://localhost/api/copilotkit/agent/default/connect", {
        method: "POST",
        body: JSON.stringify({ threadId: id }),
      }),
      route: { method: "agent/connect", agentId: "default" },
    } as unknown as HandlerHookContext);
  await connect(threadId);
  assert.equal(await store.threadOwner(threadId), g.owner);
  // Only a member's own conversation moves; any other conversation of the space stays 404.
  await assert.rejects(
    async () => connect(plain),
    (response: Response) => response.status === 404,
  );
  assert.equal(await store.threadOwner(plain), h.owner);
});

test("a member being deleted no longer holds her name", async (t) => {
  const h = await harness(t);
  const ann = await h.environments.create(h.owner, { name: "Ann" });
  await assert.rejects(() => h.environments.create(h.owner, { name: "ann" }), /already exists/);
  // A delete that could not finish (the desktop provider failed) leaves the record marked.
  await h.db.compareAndSwap(
    h.owner,
    "environments",
    ann.id,
    { deleting: false },
    { deleting: true, updatedAt: new Date().toISOString() },
  );
  // Just marked: the delete may still be running, the name stays taken.
  await assert.rejects(() => h.environments.create(h.owner, { name: "Ann" }), /already exists/);
  await h.db.compareAndSwap(
    h.owner,
    "environments",
    ann.id,
    { deleting: true },
    { updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
  );
  const again = await h.environments.create(h.owner, { name: "Ann" });
  assert.notEqual(again.id, ann.id);
});

test("with computers off, deleting a member completes and frees her name", async (t) => {
  const h = await harness(t);
  const ann = await h.environments.create(h.owner, { name: "Ann" });
  // The harness's computer is on; turn it off the way COMPUTER_ENABLED=false does (staging).
  (h.config as { computerEnabled: boolean }).computerEnabled = false;
  await h.environments.remove(h.owner, ann.id);
  assert.equal(await h.environments.find(h.owner, ann.id), null, "the record is gone, not stuck");
  const again = await h.environments.create(h.owner, { name: "Ann" });
  assert.notEqual(again.id, ann.id);
});
