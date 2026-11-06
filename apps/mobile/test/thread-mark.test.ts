// v1.5.1: the top bar marks a conversation in Yuki's chat that is not the main chat, and an
// archived one as archived (11-06: an archived old chat looked just like the main one).
import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetThreadNames,
  openThreadMark,
  rememberThreads,
  threadNames,
  threadsArchived,
} from "../../../packages/client/src/shell/frame/thread-rows.ts";

test("the top bar marks a conversation that is not the main chat, and an archived one", () => {
  forgetThreadNames();
  rememberThreads([
    { id: "old", name: "旧主聊天 · 到 2026-11-06", archived: true },
    { id: "side", name: null, archived: false },
  ]);
  const known = () => ({ names: threadNames(), archived: threadsArchived() });
  const base = { mainId: "main", visited: [] as { id: string }[] };
  assert.equal(openThreadMark({ ...base, ...known(), selectedId: "main" }), null);
  assert.deepEqual(openThreadMark({ ...base, ...known(), selectedId: "old" }), {
    label: "旧主聊天 · 到 2026-11-06",
    archived: true,
  });
  assert.deepEqual(openThreadMark({ ...base, ...known(), selectedId: "side" }), {
    label: "未命名对话",
    archived: false,
  });
  // Restored: the next list says it is no longer archived.
  const before = threadsArchived();
  rememberThreads([{ id: "old", name: "旧主聊天 · 到 2026-11-06", archived: false }]);
  assert.notEqual(threadsArchived(), before, "a new snapshot after a change");
  assert.equal(openThreadMark({ ...base, ...known(), selectedId: "old" })?.archived, false);
  // A list without the flag leaves what is known.
  rememberThreads([{ id: "side", name: "调研" }]);
  assert.deepEqual(openThreadMark({ ...base, ...known(), selectedId: "side" }), {
    label: "调研",
    archived: false,
  });
  forgetThreadNames();
  assert.equal(threadsArchived().size, 0);
});
