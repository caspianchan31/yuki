// v1.6: the pictures members take of the computer are kept on disk and survive a restart; they go
// after the retention, when the folder is past its cap (oldest first), or with their conversation.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ShotStore, shotIdsOf } from "../apps/server/src/desktop-shots-store.ts";

const png = (text: string) => Buffer.from(text).toString("base64");

async function folder(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-shots-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a kept picture is read back, by its id only", async (t) => {
  const dir = await folder(t);
  const store = new ShotStore(dir, { pruneEveryMs: null });
  const id = store.keep(png("first"));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(store.read(id)?.toString(), "first");
  assert.equal(store.read("no-such-picture-0000"), null, "an unknown id is nothing");
  assert.equal(store.read("../../etc/passwd"), null, "a path is not an id");
  assert.equal(store.read(""), null);
});

test("a picture survives a restart: a new store over the same folder still has it", async (t) => {
  const dir = await folder(t);
  const id = new ShotStore(dir, { pruneEveryMs: null }).keep(png("kept"));
  const later = new ShotStore(dir, { pruneEveryMs: null });
  assert.equal(later.read(id)?.toString(), "kept");
});

test("prune: a picture older than the retention goes, a younger one stays", async (t) => {
  const dir = await folder(t);
  let now = 1_700_000_000_000;
  const store = new ShotStore(dir, {
    retentionMs: 60_000,
    now: () => now,
    pruneEveryMs: null,
  });
  const old = store.keep(png("old"));
  const fresh = store.keep(png("fresh"));
  // The file's mtime is the clock the prune reads; make the old one two minutes old.
  const past = new Date(now - 120_000);
  await utimes(join(dir, `${old}.png`), past, past);
  const present = new Date(now);
  await utimes(join(dir, `${fresh}.png`), present, present);
  await store.prune();
  assert.equal(store.read(old), null, "two minutes old, retention one minute: gone");
  assert.equal(store.read(fresh)?.toString(), "fresh");
  now += 61_000;
  await store.prune();
  assert.equal(store.read(fresh), null, "past the retention later: gone too");
});

test("prune: past the folder's cap the oldest pictures go first", async (t) => {
  const dir = await folder(t);
  const now = 1_700_000_000_000;
  const store = new ShotStore(dir, {
    retentionMs: 365 * 24 * 60 * 60_000,
    maxBytes: 12,
    now: () => now,
    pruneEveryMs: null,
  });
  const ids = ["aaaaa", "bbbbb", "ccccc"].map((text) => store.keep(png(text)));
  for (const [i, id] of ids.entries()) {
    const at = new Date(now - (3 - i) * 1000);
    await utimes(join(dir, `${id}.png`), at, at);
  }
  await store.prune();
  assert.equal(store.read(ids[0]), null, "the oldest of three 5-byte pictures, cap 12: gone");
  assert.equal(store.read(ids[1])?.toString(), "bbbbb");
  assert.equal(store.read(ids[2])?.toString(), "ccccc");
});

test("prune ignores files that are not kept pictures", async (t) => {
  const dir = await folder(t);
  const store = new ShotStore(dir, { retentionMs: 1, pruneEveryMs: null });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "notes.txt"), "keep me");
  await writeFile(join(dir, "x.png"), "too short an id");
  await store.prune();
  assert.deepEqual((await readdir(dir)).sort(), ["notes.txt", "x.png"]);
});

test("remove: a deleted conversation's pictures go, unknown ids are nothing", async (t) => {
  const dir = await folder(t);
  const store = new ShotStore(dir, { pruneEveryMs: null });
  const a = store.keep(png("a"));
  const b = store.keep(png("b"));
  assert.equal(await store.remove([a, "never-kept-00000000", "../x", a]), 1);
  assert.equal(store.read(a), null);
  assert.equal(store.read(b)?.toString(), "b");
});

test("shotIdsOf: the ids a conversation's screenshot results name", () => {
  const events = [
    { type: "TOOL_CALL_START", toolCallName: "computer_screenshot" },
    {
      type: "TOOL_CALL_RESULT",
      content: JSON.stringify({
        screenshot: "attached",
        shotId: "AbCdEfGhIjKlMnOpQrStUv",
        control: "member",
      }),
    },
    { type: "TOOL_CALL_RESULT", content: JSON.stringify({ ok: true }) },
    { type: "TEXT_MESSAGE_CONTENT", delta: '"shotId":"not-a-result-event-0000"' },
    {
      type: "TOOL_CALL_RESULT",
      content: JSON.stringify({ shotId: "AbCdEfGhIjKlMnOpQrStUv" }),
    },
  ];
  assert.deepEqual(shotIdsOf(events), ["AbCdEfGhIjKlMnOpQrStUv"]);
});
