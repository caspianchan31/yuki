// What this device last read is kept per space and project, at most 7 days and
// 512 KB an entry; anything unreadable counts as nothing; a sign-out clears it all.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLastSeen,
  lastSeenMaxAgeMs,
  lastSeenMaxChars,
  lastSeenScope,
  readLastSeen,
  writeLastSeen,
} from "../../../packages/client/src/last-seen.ts";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    map,
  };
};

test("kept per space and project; read back until it is 7 days old", () => {
  const storage = memory();
  const a = lastSeenScope("s1", null);
  const b = lastSeenScope("s1", "p1");
  assert.notEqual(a, b);
  writeLastSeen(storage, a, "accounts", [{ id: "x" }], 1000);
  assert.deepEqual(readLastSeen(storage, a, "accounts", 2000), [{ id: "x" }]);
  assert.equal(readLastSeen(storage, b, "accounts", 2000), undefined, "another project's");
  assert.equal(readLastSeen(storage, a, "accounts", 1000 + lastSeenMaxAgeMs + 1), undefined);
});

test("too big is not kept (and drops an older copy); junk reads as nothing", () => {
  const storage = memory();
  const scope = lastSeenScope("s1", null);
  writeLastSeen(storage, scope, "agent", { small: true });
  writeLastSeen(storage, scope, "agent", "x".repeat(lastSeenMaxChars + 10));
  assert.equal(readLastSeen(storage, scope, "agent"), undefined);
  storage.setItem("openmuse.lastSeen.v1:s1|-:bad", "{not json");
  assert.equal(readLastSeen(storage, scope, "bad"), undefined);
  assert.equal(readLastSeen(null, scope, "agent"), undefined);
});

test("a sign-out clears every entry of the app and nothing else", () => {
  const storage = memory();
  writeLastSeen(storage, lastSeenScope("s1", null), "accounts", []);
  writeLastSeen(storage, lastSeenScope("s2", "p"), "overview", []);
  storage.setItem("openmuse.session", "keep");
  clearLastSeen(storage);
  assert.deepEqual([...storage.map.keys()], ["openmuse.session"]);
});
