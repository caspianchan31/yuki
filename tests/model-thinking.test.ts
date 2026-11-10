// v1.7.2 回复先开口 (apps/server/src/engine/model-thinking.ts): MODEL_THINKING, the fields per
// provider, and the fetch that adds them to Chat Completions requests only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  thinkingFetch,
  thinkingFields,
  thinkingSetting,
} from "../apps/server/src/engine/model-thinking.ts";

const ark = "https://ark.cn-beijing.volces.com/api/v3";

test("the setting: off by default, the levels, and a refused value", () => {
  assert.equal(thinkingSetting({}), "off");
  assert.equal(thinkingSetting({ MODEL_THINKING: " Low " }), "low");
  assert.equal(thinkingSetting({ MODEL_THINKING: "on" }), "on");
  assert.throws(() => thinkingSetting({ MODEL_THINKING: "yes" }), /MODEL_THINKING must be one of/);
});

test("the fields: Ark takes thinking.type, others reasoning_effort only for a level; on adds nothing", () => {
  assert.deepEqual(thinkingFields("off", ark), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingFields("off", "https://api.deepseek.com/v1"), {});
  assert.deepEqual(thinkingFields("off", undefined), {});
  assert.deepEqual(thinkingFields("on", ark), {});
  assert.deepEqual(thinkingFields("low", ark), {
    thinking: { type: "enabled" },
    reasoning_effort: "low",
  });
  assert.deepEqual(thinkingFields("minimal", "https://api.openai.com/v1"), {
    reasoning_effort: "minimal",
  });
});

test("the fetch adds the fields to a Chat Completions body once, and leaves everything else alone", async () => {
  const sent: { url: string; body: unknown }[] = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = thinkingFetch("off", ark, base);
  await f(`${ark}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.deepEqual(sent[0].body, { model: "m", messages: [], thinking: { type: "disabled" } });
  // a request that already says is left as it is
  await f(`${ark}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [], thinking: { type: "enabled" } }),
  });
  assert.deepEqual(sent[1].body, { model: "m", messages: [], thinking: { type: "enabled" } });
  // not a chat completion: untouched
  await f(`${ark}/images/generations`, { method: "POST", body: JSON.stringify({ prompt: "x" }) });
  assert.deepEqual(sent[2].body, { prompt: "x" });
  // nothing to add: the body goes as it is (the call is still noted)
  await thinkingFetch(
    "on",
    ark,
    base,
  )(`${ark}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.deepEqual(sent[3].body, { model: "m", messages: [] });
});

test("requestShape says where a request's bytes are", async () => {
  const { requestShape } = await import("../apps/server/src/engine/model-thinking.ts");
  const line = requestShape({
    messages: [
      { role: "system", content: "s".repeat(2048) },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ],
    tools: [{ type: "function", function: { name: "a", description: "d".repeat(1024) } }],
  });
  assert.match(
    line,
    /^system 2 KB, history 2 msgs 0 KB \(user 1, assistant 1\), tools 1 1 KB \[a 1\.1K\]$/,
  );
});

test("the log's sizes are bytes of UTF-8, the unit MODEL_HISTORY_KB is in", async () => {
  const { requestShape } = await import("../apps/server/src/engine/model-thinking.ts");
  const han = "\u4e2d".repeat(1024); // 1024 characters, 3 KB on the wire
  assert.match(
    requestShape({
      messages: [
        { role: "system", content: han },
        { role: "user", content: han },
      ],
    }),
    /^system 3 KB, history 1 msgs 3 KB /,
  );
  const lines: string[] = [];
  const info = console.info;
  console.info = (line: string) => void lines.push(line);
  try {
    const base = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await thinkingFetch(
      "on",
      ark,
      base,
    )(`${ark}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: han.repeat(2) }] }),
    });
  } finally {
    console.info = info;
  }
  assert.match(lines[0] ?? "", /^\[model\] m 6 KB /);
});
