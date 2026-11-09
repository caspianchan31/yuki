// v1.6 生成图片: the verdict comes from the gateway (its record of the model, else real tries),
// is kept, and the drawing lands as an attachment (and on the computer when there is one).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AttachmentStore, attachmentIdsOf } from "../apps/server/src/chat/attachment-store.ts";
import type { Store } from "../apps/server/src/db.ts";
import {
  abilityFromRecord,
  ImageGeneration,
  imageSettingsFromEnv,
  imageUrlInChat,
  parseImageExtra,
  sniffImage,
  stripProvider,
} from "../apps/server/src/image-generation.ts";
import {
  drawPicture,
  imageInstructions,
  pictureFileName,
} from "../apps/server/src/picture-tool.ts";
import { generatedImages } from "../packages/domain/src/chat-attachments.ts";
import { createChatTestStore } from "./helpers/chat-database.ts";

// A 1x1 PNG (the smallest valid one), as gateways hand pictures back.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Call = { url: string; method: string; body: unknown };
type Loose = Record<string, unknown>;
/** A gateway that answers by path; records every call. */
function gateway(answers: Record<string, (body: unknown) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const key = Object.keys(answers).find((candidate) => path.endsWith(candidate));
    if (!key) return new Response("not found", { status: 404 });
    return answers[key]?.(body) ?? new Response("", { status: 500 });
  };
  return { calls, fetchImpl };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const settings = { chatModel: "openai/chatty", baseUrl: "https://gw.test/v1", apiKey: "k" };

let db: Store;
before(async () => {
  db = await createChatTestStore();
});
after(async () => {
  await db.close();
});

test("the bare model id, and what a gateway record says about pictures", () => {
  assert.equal(stripProvider("openai/doubao-seed-2.1-pro"), "doubao-seed-2.1-pro");
  assert.equal(stripProvider("doubao-seedream-4-0"), "doubao-seedream-4-0");
  assert.equal(stripProvider("vendor/x"), "vendor/x");
  assert.equal(abilityFromRecord({ api_supported: { "images/generations": true } }), "images-api");
  assert.equal(abilityFromRecord({ api_supported: { "chat/completions": true } }), "none");
  assert.equal(
    abilityFromRecord({ architecture: { output_modalities: ["text", "image"] } }),
    "chat-images",
  );
  assert.equal(abilityFromRecord({ output_modalities: ["text"] }), "none");
  assert.equal(abilityFromRecord({ id: "x", object: "model" }), null);
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.from("hello world!")), null);
  assert.equal(
    imageUrlInChat({ choices: [{ message: { images: [{ image_url: { url: "data:x" } }] } }] }),
    "data:x",
  );
  assert.equal(
    imageUrlInChat({
      choices: [{ message: { content: [{ type: "image_url", image_url: { url: "https://p" } }] } }],
    }),
    "https://p",
  );
  assert.equal(imageUrlInChat({ choices: [{ message: { content: "words" } }] }), null);
});

test("IMAGE_EXTRA: a JSON object that rides along in every images request", async () => {
  assert.deepEqual(parseImageExtra('{"watermark": false}'), { watermark: false });
  assert.equal(parseImageExtra("[1]"), undefined);
  assert.equal(parseImageExtra("not json"), undefined);
  assert.equal(parseImageExtra(""), undefined);
  assert.deepEqual(
    imageSettingsFromEnv({
      MODEL: "openai/chatty",
      IMAGE_MODEL: "drawer",
      IMAGE_BASE_URL: "https://gw.test/v1",
      IMAGE_API_KEY: "k",
      IMAGE_EXTRA: '{"watermark": false, "model": "ignored"}',
    } as NodeJS.ProcessEnv).extra,
    { watermark: false, model: "ignored" },
  );
  // No record at all (a gateway without /models): the try carries the extra fields, and the
  // request's own fields win over them.
  const gw = gateway({
    "/images/generations": () => json({ data: [{ b64_json: png.toString("base64") }] }),
  });
  const images = new ImageGeneration(
    null,
    { ...settings, model: "drawer", extra: { watermark: false, model: "ignored" } },
    { fetch: gw.fetchImpl },
  );
  const verdict = await images.ability();
  assert.deepEqual(
    { can: verdict.can, how: verdict.can && verdict.how, source: verdict.can && verdict.source },
    { can: true, how: "images-api", source: "probe" },
  );
  const sent = gw.calls.filter((call) => call.method === "POST").map((call) => call.body as Loose);
  assert.ok(sent.length >= 1);
  for (const body of sent) {
    assert.equal(body.watermark, false);
    assert.equal(body.model, "drawer");
  }
  const made = await images.generate({ prompt: "a dot" });
  assert.equal(made.mimeType, "image/png");
  const last = gw.calls.at(-1)?.body as Loose;
  assert.deepEqual(
    { watermark: last.watermark, model: last.model, prompt: last.prompt },
    { watermark: false, model: "drawer", prompt: "a dot" },
  );
});

test("a gateway record that names the model's APIs settles it without a try", async () => {
  const yes = gateway({
    "/models/chatty": () => json({ id: "chatty", api_supported: { "images/generations": true } }),
  });
  const can = await new ImageGeneration(null, settings, { fetch: yes.fetchImpl }).ability();
  assert.deepEqual(
    { can: can.can, how: can.can && can.how, source: can.can && can.source },
    { can: true, how: "images-api", source: "metadata" },
  );
  assert.ok(
    yes.calls.every((call) => call.method === "GET"),
    "nothing was drawn",
  );

  const no = gateway({
    "/models/chatty": () => json({ id: "chatty", api_supported: { "chat/completions": true } }),
  });
  const cannot = await new ImageGeneration(null, settings, { fetch: no.fetchImpl }).ability();
  assert.equal(cannot.can, false);
  assert.match(!cannot.can ? cannot.why : "", /chatty/);
  assert.match(!cannot.can ? cannot.why : "", /chat\/completions/);
  assert.ok(no.calls.every((call) => call.method === "GET"));
});

test("without a telling record, the tries decide: images endpoint, then the chat model's reply", async () => {
  // Nothing anywhere: both tries fail, with the gateway's words in the why.
  const none = gateway({
    "/models/chatty": () => new Response("", { status: 404 }),
    "/models": () => json({ data: [{ id: "chatty", object: "model" }] }),
    "/images/generations": () =>
      json({ error: { message: "The model chatty does not support images" } }, 404),
    "/chat/completions": () => json({ choices: [{ message: { content: "I cannot draw" } }] }),
  });
  const cannot = await new ImageGeneration(null, settings, { fetch: none.fetchImpl }).ability();
  assert.equal(cannot.can, false);
  assert.match(!cannot.can ? cannot.why : "", /does not support images/);
  assert.match(!cannot.can ? cannot.why : "", /只回了文字/);
  assert.deepEqual(
    none.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "GET /v1/models/chatty",
      "GET /v1/models",
      "POST /v1/images/generations",
      "POST /v1/chat/completions",
    ],
  );
  const probe = none.calls[2]?.body as { model: string; n: number; response_format: string };
  assert.equal(probe.model, "chatty");
  assert.equal(probe.n, 1);
  // The images endpoint answers: images-api, by a try; a picture then comes as base64.
  const api = gateway({
    "/models/draw": () => new Response("", { status: 404 }),
    "/models": () => json({ data: [] }),
    "/images/generations": (body) =>
      json({
        data: [
          {
            b64_json: png.toString("base64"),
            revised_prompt: String((body as { prompt: string }).prompt),
          },
        ],
      }),
  });
  const images = new ImageGeneration(
    null,
    { ...settings, model: "draw" },
    { fetch: api.fetchImpl },
  );
  const can = await images.ability();
  assert.deepEqual(
    { can: can.can, how: can.can && can.how, source: can.can && can.source },
    { can: true, how: "images-api", source: "probe" },
  );
  const made = await images.generate({ prompt: "一只猫", size: "wide" });
  assert.equal(made.mimeType, "image/png");
  assert.equal(made.model, "draw");
  assert.ok(Buffer.from(made.bytes).equals(png));
  const drawn = api.calls.at(-1)?.body as { prompt: string; size: string };
  assert.deepEqual([drawn.prompt, drawn.size], ["一只猫", "1536x1024"]);
  // With IMAGE_MODEL set, the chat model's reply is never probed.
  assert.ok(api.calls.every((call) => !call.url.endsWith("/chat/completions")));
  // The chat model draws in its replies (a data URL in `images`): chat-images.
  const chat = gateway({
    "/models/chatty": () => new Response("", { status: 404 }),
    "/models": () => json({}),
    "/images/generations": () => new Response("", { status: 404 }),
    "/chat/completions": () =>
      json({
        choices: [
          {
            message: {
              content: "",
              images: [{ image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }],
            },
          },
        ],
      }),
  });
  const chatty = new ImageGeneration(null, settings, { fetch: chat.fetchImpl });
  const verdict = await chatty.ability();
  assert.equal(verdict.can && verdict.how, "chat-images");
  const drawnByChat = await chatty.generate({ prompt: "一只狗" });
  assert.ok(Buffer.from(drawnByChat.bytes).equals(png));
  const ask = chat.calls.at(-1)?.body as { modalities: string[]; messages: { content: string }[] };
  assert.deepEqual(ask.modalities, ["text", "image"]);
  assert.equal(ask.messages[0]?.content, "一只狗");
});

test("a picture by URL is fetched; an error answer is the gateway's words", async () => {
  const byUrl = gateway({
    "/models/draw": () => json({ id: "draw", api_supported: { "images/generations": true } }),
    "/images/generations": () => json({ data: [{ url: "https://cdn.test/p.jpg" }] }),
    "/p.jpg": () => new Response(png, { headers: { "content-type": "image/jpeg" } }),
  });
  const images = new ImageGeneration(
    null,
    { ...settings, model: "draw" },
    { fetch: byUrl.fetchImpl },
  );
  const made = await images.generate({ prompt: "x" });
  // The bytes say PNG whatever the header says.
  assert.equal(made.mimeType, "image/png");
  const failing = gateway({
    "/models/draw": () => json({ id: "draw", api_supported: { "images/generations": true } }),
    "/images/generations": () => json({ error: { message: "content policy" } }, 400),
  });
  const refused = new ImageGeneration(
    null,
    { ...settings, model: "draw" },
    { fetch: failing.fetchImpl },
  );
  await assert.rejects(refused.generate({ prompt: "x" }), /400 content policy/);
  // A gateway that cannot be reached: cannot for now, marked transient, asked again in minutes.
  let now = Date.parse("2026-11-08T10:00:00Z");
  const down: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const unreachable = new ImageGeneration(
    null,
    { ...settings, model: "draw" },
    { fetch: down, now: () => now },
  );
  const offline = await unreachable.ability();
  assert.equal(offline.can, false);
  assert.equal(!offline.can && offline.transient, true);
  assert.match(!offline.can ? offline.why : "", /没连上/);
  now += 11 * 60_000;
  const retried = await unreachable.ability();
  assert.notEqual(
    retried.checkedAt,
    offline.checkedAt,
    "a transient verdict is checked again after ten minutes",
  );
  // Nothing configured: cannot, and says what is missing.
  const bare = await new ImageGeneration(null, {}, { fetch: byUrl.fetchImpl }).ability();
  assert.equal(bare.can, false);
  assert.match(!bare.can ? bare.why : "", /MODEL/);
});

test("the verdict is kept a day, in memory and in the records, and known() never waits", async () => {
  let now = Date.parse("2026-11-08T10:00:00Z");
  const gw = gateway({
    "/models/chatty": () => json({ id: "chatty", api_supported: { "images/generations": true } }),
  });
  const first = new ImageGeneration(db, settings, { fetch: gw.fetchImpl, now: () => now });
  assert.equal(first.known(), null, "nothing known before the check answers");
  const verdict = await first.ability();
  assert.equal(verdict.can, true);
  assert.equal(first.known()?.can, true);
  const calls = gw.calls.length;
  await first.ability();
  assert.equal(gw.calls.length, calls, "memory serves the second ask");
  // Another process (a new instance on the same database) reads the kept verdict.
  const second = new ImageGeneration(db, settings, { fetch: gw.fetchImpl, now: () => now });
  assert.deepEqual(await second.ability(), verdict);
  assert.equal(gw.calls.length, calls, "the records served it");
  // A day later it is checked again.
  now += 25 * 60 * 60_000;
  const again = await second.ability();
  assert.notEqual(again.checkedAt, verdict.checkedAt);
  assert.ok(gw.calls.length > calls);
  // Another model and gateway: another verdict.
  const other = new ImageGeneration(
    db,
    { ...settings, model: "other" },
    {
      fetch: gateway({ "/models/other": () => json({ id: "other", output_modalities: ["text"] }) })
        .fetchImpl,
      now: () => now,
    },
  );
  assert.equal((await other.ability()).can, false);
  assert.equal((await second.ability()).can, true);
});

test("drawPicture keeps the picture as an attachment, copies it to the computer, names the card", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yuki-pictures-"));
  const attachments = new AttachmentStore(dir, { pruneEveryMs: null });
  try {
    const gw = gateway({
      "/models/draw": () => json({ id: "draw", api_supported: { "images/generations": true } }),
      "/images/generations": () => json({ data: [{ b64_json: png.toString("base64") }] }),
    });
    const images = new ImageGeneration(
      null,
      { ...settings, model: "draw" },
      { fetch: gw.fetchImpl },
    );
    const delivered: string[] = [];
    const result = await drawPicture(
      {
        images,
        attachments,
        deliver: async (_owner, name) => {
          delivered.push(name);
          return `/workspace/成品/${name}`;
        },
      },
      "alice",
      { prompt: "春节海报：红底金字", size: "square", name: "春节海报" },
    );
    assert.match(result.image.name, /^春节海报-\d{4}-\d{6}\.png$/);
    assert.equal(result.image.mimeType, "image/png");
    assert.equal(result.image.path, `/workspace/成品/${result.image.name}`);
    assert.deepEqual(delivered, [result.image.name]);
    assert.match(result.note, /card/);
    const kept = await attachments.read("alice", result.image.id);
    assert.ok(kept && Buffer.from(kept.bytes).equals(png));
    assert.equal(kept?.meta.workspacePath, result.image.path);
    assert.equal(
      await attachments.meta("bob", result.image.id),
      null,
      "another space sees nothing",
    );
    // Without a computer the picture stays on the server; the note says no path.
    const hosted = await drawPicture({ images, attachments }, "alice", {
      prompt: "一朵花",
      size: "tall",
    });
    assert.equal(hosted.image.path, null);
    assert.doesNotMatch(hosted.note, /saved at/);
    // The web finds the cards in the reply's tool results; a failed call makes none.
    const calls = [
      { id: "c1", function: { name: "generate_image", arguments: "{}" } },
      { id: "c2", function: { name: "generate_image", arguments: "{}" } },
      { id: "c3", function: { name: "search_web", arguments: "{}" } },
    ];
    const results: Record<string, string> = {
      c1: JSON.stringify(result),
      c2: JSON.stringify({ error: "没画成" }),
      c3: JSON.stringify({ image: { id: result.image.id } }),
    };
    assert.deepEqual(
      generatedImages(calls, (id) => results[id]),
      [{ id: result.image.id, name: result.image.name, mimeType: "image/png" }],
    );
    // A deleted conversation takes the pictures its replies made.
    assert.deepEqual(
      attachmentIdsOf([
        { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: JSON.stringify(result) },
        { type: "TOOL_CALL_RESULT", toolCallId: "c2", content: '{"error":"x"}' },
      ]),
      [result.image.id],
    );
  } finally {
    attachments.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file names and the prompt's words", () => {
  const at = new Date(2026, 10, 8, 14, 32, 5);
  assert.equal(pictureFileName("春节海报", "image/png", at), "春节海报-1108-143205.png");
  assert.equal(pictureFileName('a/b:c*?"<>|\u0001d', "image/jpeg", at), "a b c d-1108-143205.jpg");
  assert.equal(pictureFileName("   ", "image/webp", at), "图片-1108-143205.webp");
  assert.equal(
    pictureFileName("x".repeat(100), "image/gif", at).length,
    40 + "-1108-143205.gif".length,
  );
  assert.match(imageInstructions(null), /still being checked/);
  assert.match(
    imageInstructions({ can: true, how: "images-api", model: "m", source: "probe", checkedAt: "" }),
    /generate_image/,
  );
  const cannot = imageInstructions({ can: false, why: "没有图片接口", model: "m", checkedAt: "" });
  assert.match(cannot, /这个模型不会画图/);
  assert.match(cannot, /没有图片接口/);
});
