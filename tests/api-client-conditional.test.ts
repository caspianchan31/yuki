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

test("v1.7.2: two readers of one path at the same moment share one request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ n: calls }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const api = new MuseApiClient("http://x", "token", null);
  const [one, two] = await Promise.all([api.request("/api/slow"), api.request("/api/slow")]);
  assert.deepEqual(one, two);
  assert.equal(calls, 1);
  // once answered, the next read is a request of its own
  await api.request("/api/slow");
  assert.equal(calls, 2);
});

/** A fetch mock whose answers are released by hand, so a test decides what is in flight. */
function heldFetch() {
  const calls: { method: string; url: string; answer: (body: unknown, status?: number) => void }[] =
    [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        answer: (body, status = 200) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          ),
      });
    })) as typeof fetch;
  return calls;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("v1.7.2 审查: a read sent after a write never joins a read that was in flight before it", async () => {
  const calls = heldFetch();
  const api = new MuseApiClient("http://x", "token", null);
  const before = api.request("/api/agent");
  // the write goes to another path: it still may change what /api/agent answers
  const write = api.request("/api/agent/tasks", { prompt: "x" });
  await tick();
  // a read sent while the write is under way is a request of its own
  const during = api.request("/api/agent");
  await tick();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET"],
  );
  calls[1].answer({ made: true });
  await write;
  // and so is the refresh after the write: neither earlier read is known to have seen it
  const after = api.request("/api/agent");
  const alsoAfter = api.request("/api/agent");
  await tick();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET", "GET"],
  );
  // the newest read is answered first; the older ones settling late must not unhook it
  calls[3].answer({ tasks: ["new"] });
  assert.deepEqual(await after, { tasks: ["new"] });
  assert.deepEqual(await alsoAfter, { tasks: ["new"] });
  const latest = api.request("/api/agent");
  calls[0].answer({ tasks: [] });
  calls[2].answer({ tasks: ["maybe"] });
  assert.deepEqual(await before, { tasks: [] });
  assert.deepEqual(await during, { tasks: ["maybe"] });
  const joined = api.request("/api/agent");
  await tick();
  assert.equal(calls.length, 5, "the read still in flight is shared, not dropped by an older one");
  calls[4].answer({ tasks: ["new"] });
  assert.deepEqual(await latest, await joined);
});

test("v1.7.2 审查: a failed write also separates the reads around it", async () => {
  const calls = heldFetch();
  const api = new MuseApiClient("http://x", "token", null);
  const before = api.request("/api/agent");
  const write = api.request("/api/agent/tasks/1", undefined, "DELETE");
  await tick();
  calls[1].answer({ error: "nope" }, 500);
  await assert.rejects(write, /nope/);
  const after = api.request("/api/agent");
  await tick();
  assert.equal(calls.length, 3);
  calls[0].answer({ n: 0 });
  calls[2].answer({ n: 1 });
  assert.deepEqual(await before, { n: 0 });
  assert.deepEqual(await after, { n: 1 });
});

test("v1.7.2 审查: with no write between them reads still share, and a failure is not kept", async () => {
  const calls = heldFetch();
  const api = new MuseApiClient("http://x", "token", null);
  const one = api.request("/api/agent");
  await tick();
  const two = api.request("/api/agent");
  const other = api.request("/api/other");
  await tick();
  assert.deepEqual(
    calls.map((call) => call.url),
    ["http://x/api/agent", "http://x/api/other"],
  );
  // the shared read fails: both sharers see it, the next read asks again
  calls[0].answer({ error: "down" }, 503);
  await assert.rejects(one, /down/);
  await assert.rejects(two, /down/);
  const again = api.request("/api/agent");
  await tick();
  assert.equal(calls.length, 3);
  calls[2].answer({ ok: true });
  calls[1].answer({ ok: "other" });
  assert.deepEqual(await again, { ok: true });
  assert.deepEqual(await other, { ok: "other" });
});

test("v1.7.2 审查: a write through another project's client also separates this client's reads", async () => {
  const gates: (() => void)[] = [];
  let reads = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET")
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    reads += 1;
    const answer = reads;
    await new Promise<void>((resolve) => gates.push(resolve));
    return new Response(JSON.stringify({ answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const here = new MuseApiClient("http://x", "token", "project-a");
  const there = new MuseApiClient("http://x", "token", "project-b");
  const before = here.request<{ answer: number }>("/api/environments");
  await there.request("/api/environments/one", { name: "moved" }, "PATCH");
  const after = here.request<{ answer: number }>("/api/environments");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "the read after the other client's write is its own request");
  for (const open of gates) open();
  assert.deepEqual([(await before).answer, (await after).answer], [1, 2]);
});
