// The stored session and the client-side input rules.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthClient,
  memorySessionStorage,
  readStoredSession,
  SESSION_STORAGE_KEY,
  validPassword,
  validUsername,
  writeStoredSession,
} from "../../../packages/client/src/session-core.ts";

test("a stored session is read back only while it is well-formed and unexpired", () => {
  const storage = memorySessionStorage();
  assert.equal(readStoredSession(storage), null);
  const session = { token: "tok", username: "caspian", expiresAt: 2_000 };
  writeStoredSession(storage, session);
  assert.deepEqual(readStoredSession(storage, 1_000), session);
  assert.equal(readStoredSession(storage, 2_000), null);
  storage.setItem(SESSION_STORAGE_KEY, "{not json");
  assert.equal(readStoredSession(storage), null);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: "", expiresAt: 9e15 }));
  assert.equal(readStoredSession(storage), null);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: "t", expiresAt: 9e15 }));
  assert.deepEqual(readStoredSession(storage), { token: "t", username: null, expiresAt: 9e15 });
  writeStoredSession(storage, null);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
  // A throwing storage never breaks the app.
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readStoredSession(broken), null);
  writeStoredSession(broken, session);
});

test("username and password rules match the server", () => {
  assert.equal(validUsername("  caspian.01 "), "caspian.01");
  assert.ok(typeof validUsername("has space") !== "string");
  assert.ok(typeof validUsername("") !== "string");
  assert.ok(typeof validUsername("x".repeat(33)) !== "string");
  assert.equal(validPassword("12345678"), "12345678");
  assert.ok(typeof validPassword("1234567") !== "string");
});

test("the auth client sends the right requests and reads 204 as done", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/auth/logout")) return new Response(null, { status: 204 });
    if (url.endsWith("/api/auth/status"))
      return Response.json({ mode: "live", configured: false, setupRequired: true });
    if (url.endsWith("/api/session"))
      return Response.json({ error: "Username or password is incorrect" }, { status: 401 });
    return Response.json({ token: "t", username: "u", expiresAt: 1 });
  }) as typeof fetch;
  try {
    const client = new AuthClient("http://api.test");
    assert.deepEqual(await client.status(), {
      mode: "live",
      configured: false,
      setupRequired: true,
    });
    await assert.rejects(
      () => client.signIn({ username: "u", password: "p" }),
      /Username or password is incorrect/,
    );
    assert.equal(await client.signOut("tok"), undefined);
    const setup = await client.setup({ username: "u", password: "p", code: "c" });
    assert.equal(setup.token, "t");
    const logout = calls.find((call) => call.url.endsWith("/api/auth/logout"));
    assert.ok(logout);
    assert.equal((logout.init.headers as Record<string, string>).Authorization, "Bearer tok");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[1].init.method, "POST");
  } finally {
    globalThis.fetch = original;
  }
});
