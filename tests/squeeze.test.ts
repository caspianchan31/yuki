import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { squeezed } from "../apps/server/src/chat/squeeze.ts";

const ask = (encoding?: string) =>
  new Request("http://x/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: encoding ? { "accept-encoding": encoding } : {},
  });
const stream = (chunks: string[], hold?: Promise<void>) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const [index, chunk] of chunks.entries()) {
          if (index === chunks.length - 1 && hold) await hold;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const path = "/api/copilotkit/agent/default/connect";

test("a conversation's history is sent gzipped to a client that takes gzip, the same bytes inside", async () => {
  const events = Array.from(
    { length: 400 },
    (_, i) => `data: {"type":"TEXT_MESSAGE_CONTENT","delta":"字${i}"}\n\n`,
  );
  const response = squeezed(ask("gzip, deflate, br"), path, stream(events));
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.match(response.headers.get("vary") ?? "", /accept-encoding/i);
  const sent = Buffer.from(await response.arrayBuffer());
  assert.equal(gunzipSync(sent).toString("utf8"), events.join(""));
  assert.ok(sent.length < events.join("").length / 4, "repetitive events shrink a lot");
});

test("what is still being said arrives before the stream ends: each chunk is flushed", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response = squeezed(ask("gzip"), path, stream(["data: first\n\n", "data: last\n\n"], hold));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const got: Buffer[] = [];
  // The first chunk can be read while the second is still held back.
  for (let read = 0; read < 3 && Buffer.concat(got).length < 12; read++) {
    const part = await reader.read();
    if (part.value) got.push(Buffer.from(part.value));
  }
  assert.ok(Buffer.concat(got).length >= 12, "bytes arrived before the end");
  release();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    got.push(Buffer.from(part.value));
  }
  assert.equal(gunzipSync(Buffer.concat(got)).toString("utf8"), "data: first\n\ndata: last\n\n");
});

test("nothing else is touched: no gzip asked, another route, an error, an encoded answer", async () => {
  const plain = stream(["data: a\n\n"]);
  assert.equal(squeezed(ask(), path, plain), plain);
  assert.equal(squeezed(ask("br"), path, plain), plain);
  assert.equal(squeezed(ask("gzip"), "/api/copilotkit/agent/default/run", plain), plain);
  const refused = new Response("no", { status: 409 });
  assert.equal(squeezed(ask("gzip"), path, refused), refused);
  const encoded = new Response("x", { status: 200, headers: { "content-encoding": "br" } });
  assert.equal(squeezed(ask("gzip"), path, encoded), encoded);
});
