// The live workspace signs in with one admin account instead of a shared
// access key. Setup happens once with the code from the server log; sessions are bearer
// tokens; a password change ends every other session; the sample workspace stays open.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { firstUserId } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { processCredentialKey } from "../apps/server/src/credentials/crypto.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { PROJECT_HEADER } from "../packages/domain/src/projects.ts";

let db: Store, directory: string;
const base = (dataDir: string): Config => ({
  mode: "live",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  encryptionKey: randomBytes(32).toString("base64"),
  setupCode: "test-setup-code",
});
type Server = Awaited<ReturnType<typeof createApp>>;
const servers: Server[] = [];
async function boot(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(directory, "app-"));
  const server = await createApp(
    db,
    { ...base(dataDir), ...overrides },
    { credentialKey: processCredentialKey() },
  );
  servers.push(server);
  return server;
}
const call = async (
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await server.app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const resetAdmin = async () => {
  await db.remove("system", "auth", "admin");
  // The users, spaces and members made from it go with it.
  for (const kind of ["sessions", "users", "usernames", "spaces", "memberships", "invites"])
    for (const record of await db.list<{ id: string }>("system", kind))
      await db.remove("system", kind, record.id);
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-sign-in-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  for (const server of servers) await server.agent.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a live workspace asks for setup, refuses the wrong code, then signs in by password", async () => {
  await resetAdmin();
  const server = await boot();
  assert.deepEqual((await call(server, "GET", "/api/auth/status")).body, {
    mode: "live",
    configured: false,
    setupRequired: true,
  });
  // Nothing opens before setup: no credential-free session, no sign-in.
  assert.equal((await call(server, "POST", "/api/session", {})).status, 401);
  assert.equal((await call(server, "GET", "/api/workspace")).status, 401);
  const wrongCode = await call(server, "POST", "/api/auth/setup", {
    username: "caspian",
    password: "correct horse battery",
    code: "nope",
  });
  assert.equal(wrongCode.status, 403);
  const badName = await call(server, "POST", "/api/auth/setup", {
    username: "has space",
    password: "correct horse battery",
    code: "test-setup-code",
  });
  assert.equal(badName.status, 422);
  const shortPassword = await call(server, "POST", "/api/auth/setup", {
    username: "caspian",
    password: "short",
    code: "test-setup-code",
  });
  assert.equal(shortPassword.status, 422);
  const setup = await call(server, "POST", "/api/auth/setup", {
    username: "caspian",
    password: "correct horse battery",
    code: "test-setup-code",
  });
  assert.equal(setup.status, 201);
  assert.equal(setup.body.username, "caspian");
  assert.equal(setup.body.mode, "live");
  assert.ok(typeof setup.body.token === "string" && setup.body.token.length > 20);
  // The setup session already opens the workspace.
  assert.equal(
    (await call(server, "GET", "/api/workspace", undefined, bearer(setup.body.token))).status,
    200,
  );
  assert.deepEqual((await call(server, "GET", "/api/auth/status")).body, {
    mode: "live",
    configured: true,
    setupRequired: false,
  });
  // Setup is a one-time thing.
  const again = await call(server, "POST", "/api/auth/setup", {
    username: "other",
    password: "another password",
    code: "test-setup-code",
  });
  assert.equal(again.status, 409);

  const wrongPassword = await call(server, "POST", "/api/session", {
    username: "caspian",
    password: "wrong password",
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error, "Username or password is incorrect");
  const wrongUser = await call(server, "POST", "/api/session", {
    username: "someone",
    password: "correct horse battery",
  });
  assert.equal(wrongUser.status, 401);
  const signIn = await call(server, "POST", "/api/session", {
    username: "caspian",
    password: "correct horse battery",
  });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.body.username, "caspian");
  const token = signIn.body.token as string;
  assert.equal((await call(server, "GET", "/api/workspace", undefined, bearer(token))).status, 200);
  // Auth routes ignore the project header (a stale project must not block a sign-out).
  assert.equal(
    (
      await call(
        server,
        "POST",
        "/api/auth/logout",
        {},
        {
          ...bearer(token),
          [PROJECT_HEADER]: "00000000-0000-4000-8000-000000000000",
        },
      )
    ).status,
    204,
  );
  assert.equal((await call(server, "GET", "/api/workspace", undefined, bearer(token))).status, 401);
});

test("repeated wrong passwords lock the client out for a minute", async () => {
  await resetAdmin();
  const server = await boot();
  await call(server, "POST", "/api/auth/setup", {
    username: "admin",
    password: "correct horse battery",
    code: "test-setup-code",
  });
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await call(server, "POST", "/api/session", { username: "admin", password: `wrong-${i}` }))
        .status,
      401,
    );
  const locked = await call(server, "POST", "/api/session", {
    username: "admin",
    password: "correct horse battery",
  });
  assert.equal(locked.status, 429);
});

test("changing the password ends the other sessions and needs the current password", async () => {
  await resetAdmin();
  const server = await boot();
  const setup = await call(server, "POST", "/api/auth/setup", {
    username: "admin",
    password: "correct horse battery",
    code: "test-setup-code",
  });
  const other = await call(server, "POST", "/api/session", {
    username: "admin",
    password: "correct horse battery",
  });
  const wrong = await call(
    server,
    "POST",
    "/api/auth/password",
    { current: "not it", next: "a brand new password" },
    bearer(other.body.token),
  );
  assert.equal(wrong.status, 403);
  const tooShort = await call(
    server,
    "POST",
    "/api/auth/password",
    { current: "correct horse battery", next: "short" },
    bearer(other.body.token),
  );
  assert.equal(tooShort.status, 422);
  const changed = await call(
    server,
    "POST",
    "/api/auth/password",
    { current: "correct horse battery", next: "a brand new password" },
    bearer(other.body.token),
  );
  assert.equal(changed.status, 200);
  const fresh = changed.body.token as string;
  // The setup session and the old token are gone; the fresh one works; the new password signs in.
  assert.equal(
    (await call(server, "GET", "/api/workspace", undefined, bearer(setup.body.token))).status,
    401,
  );
  assert.equal(
    (await call(server, "GET", "/api/workspace", undefined, bearer(other.body.token))).status,
    401,
  );
  assert.equal((await call(server, "GET", "/api/workspace", undefined, bearer(fresh))).status, 200);
  // The admin record older code signs in with (a rollback) has the new password, not the old one.
  const admin = await db.get<{ hash: string; salt: string }>("system", "auth", "admin");
  const user = await db.get<{ hash: string; salt: string }>("system", "users", firstUserId);
  assert.deepEqual(
    { hash: admin?.hash, salt: admin?.salt },
    { hash: user?.hash, salt: user?.salt },
  );
  assert.equal(
    (
      await call(server, "POST", "/api/session", {
        username: "admin",
        password: "correct horse battery",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(server, "POST", "/api/session", {
        username: "admin",
        password: "a brand new password",
      })
    ).status,
    200,
  );
});

test("the environment can create the admin account on first start", async () => {
  await resetAdmin();
  const server = await boot({ adminUsername: "ops", adminPassword: "from the environment" });
  assert.equal((await call(server, "GET", "/api/auth/status")).body.setupRequired, false);
  const signIn = await call(server, "POST", "/api/session", {
    username: "ops",
    password: "from the environment",
  });
  assert.equal(signIn.status, 200);
  // A later start with other values changes nothing.
  const later = await boot({ adminUsername: "intruder", adminPassword: "another password" });
  assert.equal(
    (
      await call(later, "POST", "/api/session", {
        username: "intruder",
        password: "another password",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(later, "POST", "/api/session", {
        username: "ops",
        password: "from the environment",
      })
    ).status,
    200,
  );
});

test("the sample workspace still opens without credentials", async () => {
  await resetAdmin();
  const server = await boot({ mode: "sample", encryptionKey: undefined, setupCode: undefined });
  assert.deepEqual((await call(server, "GET", "/api/auth/status")).body, {
    mode: "sample",
    configured: true,
    setupRequired: false,
  });
  const session = await call(server, "POST", "/api/session", {});
  assert.equal(session.status, 200);
  assert.equal(session.body.username, null);
  assert.equal(
    (await call(server, "GET", "/api/workspace", undefined, bearer(session.body.token))).status,
    200,
  );
  assert.equal(
    (await call(server, "POST", "/api/auth/setup", { username: "a", password: "12345678" })).status,
    409,
  );
});
