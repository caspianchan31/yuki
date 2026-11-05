// The account's time zone: the check, the record under the space's owner, the endpoints, and the
// order routines pick a zone in (account, then member computer, then project computer, then
// Asia/Shanghai).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  parseAccountSettings,
  readAccountZone,
  saveAccountZone,
} from "../apps/server/src/account-settings.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Routines } from "../apps/server/src/engine/routines.ts";
import { canonicalZone, pickRoutineZone } from "../packages/domain/src/routines.ts";

test("canonicalZone accepts IANA names and refuses everything else", () => {
  assert.equal(canonicalZone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(canonicalZone(" america/los_angeles "), "America/Los_Angeles");
  assert.equal(canonicalZone("UTC"), "UTC");
  assert.equal(canonicalZone("utc"), "UTC");
  for (const bad of [
    "",
    "  ",
    "CST",
    "+08:00",
    "Mars/Olympus",
    "Asia/",
    "../etc",
    null,
    8,
    undefined,
  ])
    assert.equal(canonicalZone(bad), null, String(bad));
  assert.equal(canonicalZone("Asia/Shanghai".padEnd(80, "x")), null);
});

test("parseAccountSettings answers 400 for a bad zone", () => {
  assert.deepEqual(parseAccountSettings({ timezone: "europe/paris" }), {
    timezone: "Europe/Paris",
  });
  for (const body of [{}, { timezone: "nope" }, null, "Asia/Shanghai"])
    assert.throws(
      () => parseAccountSettings(body),
      (error: { status?: number }) => error.status === 400,
    );
});

test("pickRoutineZone takes the first set zone, else Asia/Shanghai", () => {
  assert.equal(pickRoutineZone("Europe/Paris", "Asia/Tokyo", "America/New_York"), "Europe/Paris");
  assert.equal(pickRoutineZone(null, " Asia/Tokyo ", "America/New_York"), "Asia/Tokyo");
  assert.equal(pickRoutineZone(undefined, "", "America/New_York"), "America/New_York");
  assert.equal(pickRoutineZone(null, undefined), "Asia/Shanghai");
  assert.equal(pickRoutineZone(), "Asia/Shanghai");
});

test("the zone is one record per space, read from any scope of it", async () => {
  const db = await createStore();
  try {
    const project = "owner/proj:11111111-1111-4111-8111-111111111111";
    assert.equal(await readAccountZone(db, project), null);
    await saveAccountZone(db, project, "Asia/Tokyo");
    assert.equal(await readAccountZone(db, "owner"), "Asia/Tokyo");
    assert.equal(await readAccountZone(db, `${project}#env:x`), "Asia/Tokyo");
    assert.equal(await readAccountZone(db, "other"), null);
  } finally {
    await db.close();
  }
});

test("routines' clock zone: the account's first, then the computers', then the default", async () => {
  const db = await createStore();
  try {
    const computers = new Map<string, string | null>();
    const service = {
      db,
      computer: {
        settings: {
          view: async (owner: string) => {
            if (!computers.has(owner)) throw new Error("unreadable");
            return { timezone: computers.get(owner) };
          },
        },
      },
    };
    const routines = new Routines(service as never);
    assert.equal(await routines.zoneFor("owner", null), "Asia/Shanghai");
    computers.set("owner", "Europe/Paris");
    assert.equal(await routines.zoneFor("owner", null), "Europe/Paris");
    await saveAccountZone(db, "owner", "Asia/Tokyo");
    assert.equal(await routines.zoneFor("owner", null), "Asia/Tokyo");
    assert.equal(await routines.zoneFor("owner", "env1"), "Asia/Tokyo");
  } finally {
    await db.close();
  }
});

test("GET and PUT /api/account-settings", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-account-settings-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = (await session.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = async () => (await server.app.request("/api/account-settings", { headers })).json();
  assert.deepEqual(await read(), { timezone: null });
  const put = await server.app.request("/api/account-settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ timezone: "asia/shanghai" }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { timezone: "Asia/Shanghai" });
  assert.deepEqual(await read(), { timezone: "Asia/Shanghai" });
  const bad = await server.app.request("/api/account-settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ timezone: "Mars/Base" }),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await read(), { timezone: "Asia/Shanghai" });
});

test("member notes are dated in the account's time zone", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-note-zone-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = "zone-owner";
  assert.equal((await server.agent.memberRef(owner, "yuki"))?.timezone, null);
  await saveAccountZone(db, owner, "Asia/Tokyo");
  assert.equal((await server.agent.memberRef(owner, "yuki"))?.timezone, "Asia/Tokyo");
});
