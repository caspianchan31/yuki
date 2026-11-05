// The built web app served beside the API (apps/server/src/web-static.ts): a file under the
// folder as it is, the index page for any other path that is not the API, and nothing outside it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { mountWeb, webFile } from "../apps/server/src/web-static.ts";

async function site() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "yuki-web-")));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<html>app</html>");
  await writeFile(join(dir, "assets", "app-1a2b.js"), "console.log(1)");
  await writeFile(join(dir, "..secret.txt"), "no");
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  mountWeb(app, dir);
  return { dir, app, done: () => rm(dir, { recursive: true, force: true }) };
}

test("files are served as they are, assets for a year, any other path gets the app", async () => {
  const { app, done } = await site();
  try {
    const script = await app.request("/assets/app-1a2b.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    const index = await app.request("/");
    assert.equal(await index.text(), "<html>app</html>");
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.equal(await (await app.request("/projects/abc")).text(), "<html>app</html>");
    assert.equal(await (await app.request("/assets/missing.js")).text(), "<html>app</html>");
  } finally {
    await done();
  }
});

test("the API is never answered with the app", async () => {
  const { app, done } = await site();
  try {
    assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true });
    assert.equal((await app.request("/api/unknown")).status, 404);
  } finally {
    await done();
  }
});

test("a path cannot leave the folder", async () => {
  const { dir, done } = await site();
  try {
    for (const path of [
      "/../etc/passwd.txt",
      "/%2e%2e/etc/passwd.txt",
      "/assets/../../x.js",
      "/a%00.js",
    ])
      assert.equal(await webFile(dir, path), null, path);
    assert.equal(await webFile(dir, "/assets/app-1a2b.js"), join(dir, "assets", "app-1a2b.js"));
    assert.equal(await webFile(dir, "/%"), null);
  } finally {
    await done();
  }
});
