import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MuseApiClient } from "../packages/client/src/api-client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("v1.7 启动链瘦身: a GET answered with an ETag is asked again conditionally, and a 304 gives the kept body", async () => {
  const seen: { url: string; ifNoneMatch: string | null; method: string }[] = [];
  let version = 1;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    seen.push({ url, ifNoneMatch: headers.get("if-none-match"), method: init?.method ?? "GET" });
    const tag = `W/"v${version}"`;
    if (url.endsWith("/api/agent") && headers.get("if-none-match") === tag)
      return new Response(null, { status: 304, headers: { etag: tag } });
    if (url.endsWith("/api/agent"))
      return new Response(JSON.stringify({ tasks: [version] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: tag,
          "cache-control": "private, no-cache",
        },
      });
    if (url.endsWith("/api/plain"))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ made: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const api = new MuseApiClient("http://x", "token", null);
  assert.deepEqual(await api.request("/api/agent"), { tasks: [1] });
  assert.equal(seen[0].ifNoneMatch, null);
  // the same read again: conditional, 304, the kept body
  assert.deepEqual(await api.request("/api/agent"), { tasks: [1] });
  assert.equal(seen[1].ifNoneMatch, 'W/"v1"');
  // the answer changed: a new body and a new tag
  version = 2;
  assert.deepEqual(await api.request("/api/agent"), { tasks: [2] });
  assert.deepEqual(await api.request("/api/agent"), { tasks: [2] });
  assert.equal(seen[3].ifNoneMatch, 'W/"v2"');
  // an answer without an ETag is never asked conditionally; a POST never is
  await api.request("/api/plain");
  await api.request("/api/plain");
  assert.equal(seen[5].ifNoneMatch, null);
  await api.request("/api/agent/tasks", { prompt: "x" });
  assert.equal(seen[6].method, "POST");
  assert.equal(seen[6].ifNoneMatch, null);
});
