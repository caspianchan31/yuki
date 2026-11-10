import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Auth, identityKeepMs } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store;
let reads = 0;
let gate: Promise<void> | undefined;
const config = { mode: "sample" } as Config;

before(async () => {
  db = await createStore();
  const get = db.get.bind(db);
  // Counts the session reads, and can hold one back.
  db.get = (async (owner: string, kind: string, id: string) => {
    if (kind === "sessions") {
      reads += 1;
      if (gate) await gate;
    }
    return get(owner, kind, id);
  }) as Store["get"];
});
after(() => db.close());

function auth(ttl: string) {
  const before = process.env.IDENTITY_CACHE_TTL_MS;
  process.env.IDENTITY_CACHE_TTL_MS = ttl;
  try {
    return new Auth(db, config, "test-signing-key");
  } finally {
    process.env.IDENTITY_CACHE_TTL_MS = before;
  }
}
const bearer = async (a: Auth) => `Bearer ${(await a.session()).token}`;

test("a session that checked out is not read again for a short while; at 0 it is read every time", async () => {
  const kept = auth("30000");
  const token = await bearer(kept);
  reads = 0;
  const first = await kept.user(token);
  assert.deepEqual(await kept.user(token), first);
  await Promise.all([kept.user(token), kept.user(token), kept.user(token)]);
  assert.equal(reads, 1);
  const none = auth("0");
  reads = 0;
  await none.user(token);
  await none.user(token);
  assert.equal(reads, 2);
});

test("a sign-out counts for the very next request", async () => {
  const kept = auth("30000");
  const token = await bearer(kept);
  await kept.user(token);
  await kept.logout(token);
  await assert.rejects(kept.user(token), /Session expired/);
});

test("a read that began before a sign-out does not bring the session back", async () => {
  const kept = auth("30000");
  const token = await bearer(kept);
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const early = kept.user(token);
  // The sign-out lands while that read is still on its way.
  const leaving = kept.logout(token);
  gate = undefined;
  release();
  await leaving;
  // Whatever the early read answers (it began while the session was there), it is not kept.
  await early.catch(() => undefined);
  await assert.rejects(kept.user(token), /Session expired/);
});

test("a session past its end is refused even when remembered, and only sessions that check out are kept", async () => {
  const kept = auth("30000");
  const token = await bearer(kept);
  await kept.user(token);
  const real = Date.now;
  Date.now = () => real() + 400 * 24 * 60 * 60 * 1000;
  try {
    await assert.rejects(kept.user(token), /Session expired/);
  } finally {
    Date.now = real;
  }
  reads = 0;
  await assert.rejects(kept.user("Bearer nothing-like-a-session"), /Session expired/);
  await assert.rejects(kept.user("Bearer nothing-like-a-session"), /Session expired/);
  assert.equal(reads, 2, "a token that does not check out is asked every time, never kept");
});

test("IDENTITY_CACHE_TTL_MS: 30 s unless set, a whole number from 0 to 300000", () => {
  assert.equal(identityKeepMs({}), 30_000);
  assert.equal(identityKeepMs({ IDENTITY_CACHE_TTL_MS: " 0 " }), 0);
  assert.equal(identityKeepMs({ IDENTITY_CACHE_TTL_MS: "5000" }), 5000);
  for (const bad of ["30s", "-1", "1.5", "900000"])
    assert.throws(() => identityKeepMs({ IDENTITY_CACHE_TTL_MS: bad }), /IDENTITY_CACHE_TTL_MS/);
});
