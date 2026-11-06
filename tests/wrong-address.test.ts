// v1.5.1: a page opened at another address than the site's own (localhost for 127.0.0.1, a LAN
// address) was blank: its scripts were refused like an API call from another site. The page's own
// files now load at any address; the API still refuses another site, naming the site's address,
// and the sign-in says where to open Yuki (packages/client/src/auth-errors.ts).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ApiError } from "../packages/client/src/api-response.ts";
import { authErrorText, wrongPageAddress } from "../packages/client/src/auth-errors.ts";

const elsewhere = { Origin: "http://192.168.1.20:8787" };

test("a page's own files load at any address; the API refuses it and names the site's address", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-address-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://127.0.0.1:8787/api/google/callback",
    allowedOrigins: [],
  };
  const { app } = await createApp(db, config);
  for (const path of ["/", "/assets/index-abc.js", "/assets/index-abc.css"])
    assert.notEqual((await app.request(path, { headers: elsewhere })).status, 403, path);
  const signIn = await app.request("/api/session", {
    method: "POST",
    headers: { ...elsewhere, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(signIn.status, 403);
  assert.deepEqual(await signIn.json(), {
    error: "Origin is not allowed",
    publicUrl: "http://127.0.0.1:8787",
  });
  // A read of the API from another site is refused too; a write of a page's path is no page file.
  assert.equal((await app.request("/api/workspace", { headers: elsewhere })).status, 403);
  assert.equal((await app.request("/", { method: "POST", headers: elsewhere })).status, 403);
  // The site's own address works as before.
  const own = await app.request("/api/session", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8787", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(own.status, 200);
});

test("the sign-in says where to open Yuki when the address was refused", () => {
  const refused = new ApiError("Origin is not allowed", 403, {
    error: "Origin is not allowed",
    publicUrl: "http://127.0.0.1:8787",
  });
  assert.equal(authErrorText(refused), "这个地址打不开 Yuki，请用 http://127.0.0.1:8787 打开。");
  // Any other failure keeps its own words.
  assert.equal(
    authErrorText(new ApiError("Wrong username or password", 401)),
    "Wrong username or password",
  );
  assert.equal(
    authErrorText(
      new ApiError("Waiting for approval", 403, { registration: { state: "pending" } }),
    ),
    "Waiting for approval",
  );
  assert.equal(authErrorText(new Error("offline")), "offline");
});

test("a built page opened at another address than its API's says where to open Yuki", () => {
  // The open core's page is built for its own address (YUKI_PUBLIC_URL); opened at another, its API
  // calls cannot get through, so the gate names the address instead of 连不上服务器.
  assert.equal(
    wrongPageAddress("http://localhost:18787", "http://127.0.0.1:18787"),
    "http://127.0.0.1:18787",
  );
  assert.equal(
    wrongPageAddress("http://192.168.1.20:8787", "http://localhost:8787/"),
    "http://localhost:8787",
  );
  // A site under a path is sent to that path.
  assert.equal(
    wrongPageAddress("https://www.example.com", "https://example.com/yuki"),
    "https://example.com/yuki",
  );
  // At the API's own origin, nothing is said.
  assert.equal(wrongPageAddress("http://127.0.0.1:18787", "http://127.0.0.1:18787"), null);
  assert.equal(wrongPageAddress("https://example.com", "https://example.com/yuki"), null);
  assert.equal(wrongPageAddress("http://127.0.0.1:18787", "not a url"), null);
});
