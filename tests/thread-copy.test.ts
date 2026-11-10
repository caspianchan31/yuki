import assert from "node:assert/strict";
import { test } from "node:test";
import { clearLastSeen, type LastSeenStorage } from "../packages/client/src/last-seen.ts";
import {
  dropThreadCopy,
  readThreadCopy,
  replayCaughtUp,
  threadCopiesKept,
  threadCopyMessages,
  writeThreadCopy,
} from "../packages/client/src/thread-copy.ts";

function storage(): LastSeenStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}
const said = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${from + i}`,
    role: i % 2 ? "assistant" : "user",
    content: `第 ${from + i} 句`,
  }));

test("a conversation's last messages are kept per space and project, and read back as they were", () => {
  const s = storage();
  writeThreadCopy(s, "space|project", "t1", said(4));
  assert.deepEqual(readThreadCopy(s, "space|project", "t1"), said(4));
  assert.equal(readThreadCopy(s, "space|other", "t1"), undefined, "another project sees nothing");
  assert.equal(readThreadCopy(s, "space|project", "t2"), undefined);
  // Only the newest are kept of a long conversation.
  writeThreadCopy(s, "space|project", "t1", said(threadCopyMessages + 30));
  const kept = readThreadCopy(s, "space|project", "t1");
  assert.equal(kept?.length, threadCopyMessages);
  assert.equal(kept?.at(-1)?.id, `m${threadCopyMessages + 29}`);
});

test("only the conversations opened last keep a copy; a sign-out leaves none", () => {
  const s = storage();
  for (let i = 0; i < threadCopiesKept + 2; i++) writeThreadCopy(s, "a|b", `t${i}`, said(2));
  assert.equal(readThreadCopy(s, "a|b", "t0"), undefined);
  assert.equal(readThreadCopy(s, "a|b", "t1"), undefined);
  assert.ok(readThreadCopy(s, "a|b", "t2"));
  // Opening one again keeps it among the last.
  writeThreadCopy(s, "a|b", "t2", said(2));
  writeThreadCopy(s, "a|b", "new", said(2));
  assert.ok(readThreadCopy(s, "a|b", "t2"));
  assert.equal(readThreadCopy(s, "a|b", "t3"), undefined);
  dropThreadCopy(s, "a|b", "new");
  assert.equal(readThreadCopy(s, "a|b", "new"), undefined);
  clearLastSeen(s);
  assert.equal(s.map.size, 0);
});

test("a copy too old, of another shape, or empty counts as nothing; nothing is written without messages", () => {
  const s = storage();
  writeThreadCopy(s, "a|b", "t", said(2), 1_000);
  assert.equal(readThreadCopy(s, "a|b", "t", 1_000 + 8 * 24 * 60 * 60 * 1000), undefined);
  s.map.set(
    "openmuse.lastSeen.v1:a|b:thread:x",
    JSON.stringify({ at: Date.now(), value: [{ text: "?" }] }),
  );
  assert.equal(readThreadCopy(s, "a|b", "x"), undefined);
  writeThreadCopy(s, "a|b", "empty", []);
  assert.equal(readThreadCopy(s, "a|b", "empty"), undefined);
});

test("the screen leaves the copy when the replay reaches its last message, or the load is over", () => {
  const copy = said(4);
  assert.equal(
    replayCaughtUp(undefined, [], true, false),
    true,
    "no copy: the server's list at once",
  );
  assert.equal(replayCaughtUp(copy, [], true, false), false, "nothing replayed yet");
  assert.equal(replayCaughtUp(copy, said(3), true, false), false, "the replay is behind the copy");
  assert.equal(
    replayCaughtUp(copy, said(4), true, false),
    true,
    "it reached the copy's last message",
  );
  // A reply still running: the load stays open, yet its words show as soon as the copy is passed.
  assert.equal(replayCaughtUp(copy, said(6), true, true), true);
  // The copy's last message was taken back elsewhere: the end of the load hands over all the same.
  assert.equal(replayCaughtUp(copy, said(2), false, true), true);
  // Loading again after a failure (not loaded): the copy stays on screen.
  assert.equal(replayCaughtUp(copy, [], false, false), false);
});
