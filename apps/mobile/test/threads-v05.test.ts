// The client side of conversations on our own server: the cloud-copy fact
// line, and the conversation's latest run carried by the report poll (what lets an open
// conversation show what another member just said).
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeActivity,
  ThreadReports,
} from "../../../packages/client/src/chat-reports-core.ts";
import { cloudThreadsText } from "../../../packages/client/src/shell/frame/cloud-threads.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";

test("the cloud-copy line says how many are left and why, or that there is no key", () => {
  assert.equal(cloudThreadsText(undefined), null);
  assert.equal(
    cloudThreadsText({ state: "failed", pending: 3, reason: "CopilotKit 云暂时出错" }),
    "以前的对话至少还有 3 个没搬回来：CopilotKit 云暂时出错。下次启动会再搬。",
  );
  assert.equal(
    cloudThreadsText({ state: "failed", pending: 0, reason: "连不上 CopilotKit 云" }),
    "以前的对话还没搬完：连不上 CopilotKit 云。下次启动会再搬。",
  );
  assert.equal(cloudThreadsText({ state: "no-key" }), t.cloudThreads.noKey);
  assert.equal(t.threads.formerMainName("2026-10-12"), "旧主聊天 · 到 2026-10-12");
});

test("a report page's thread activity is read defensively", () => {
  assert.equal(normalizeActivity({ reports: [] }), null);
  assert.equal(normalizeActivity(null), null);
  assert.deepEqual(normalizeActivity({ thread: { lastRunId: "r1", running: true } }), {
    lastRunId: "r1",
    running: true,
  });
  assert.deepEqual(normalizeActivity({ thread: { lastRunId: 7 } }), {
    lastRunId: null,
    running: false,
  });
});

test("the report poll publishes the conversation's latest run when it changes", async () => {
  let thread: unknown = { lastRunId: null, running: false };
  const store = new ThreadReports("main", async () => ({ reports: [], thread }));
  let notified = 0;
  store.subscribe(() => {
    notified++;
  });
  assert.equal(store.getActivity(), null);
  await store.refresh();
  assert.deepEqual(store.getActivity(), { lastRunId: null, running: false });
  const first = store.getActivity();
  await store.refresh();
  assert.equal(store.getActivity(), first, "unchanged: the same snapshot, no re-render");
  thread = { lastRunId: "run-2", running: true };
  await store.refresh();
  assert.deepEqual(store.getActivity(), { lastRunId: "run-2", running: true });
  thread = { lastRunId: "run-2", running: false };
  await store.refresh();
  assert.deepEqual(store.getActivity(), { lastRunId: "run-2", running: false });
  assert.equal(notified, 3);
});

test("another member's 开新主聊天: the chat on screen follows the main chat, a side chat stays", async () => {
  const { followMainSelection, followMainVisited } = await import(
    "../../../packages/client/src/local-thread.ts"
  );
  const old = { id: "old-main", existing: true };
  const side = { id: "side", existing: true };
  assert.deepEqual(followMainSelection(old, "old-main", "new-main"), {
    id: "new-main",
    existing: true,
  });
  assert.deepEqual(followMainSelection(side, "old-main", "new-main"), side);
  assert.deepEqual(followMainVisited([old, side], "new-main"), [
    { id: "new-main", existing: true },
    old,
    side,
  ]);
  // Already there (this page's own switch read back by the poll): listed once.
  assert.deepEqual(followMainVisited([{ id: "new-main", existing: true }, old], "new-main"), [
    { id: "new-main", existing: true },
    old,
  ]);
});
