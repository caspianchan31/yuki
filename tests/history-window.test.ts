// v1.7.2 提示只带近的 (apps/server/src/engine/history-window.ts): the newest turns up to a budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import {
  historyBudgetKb,
  historyWindowMiddleware,
  mediaPartBytes,
  omittedTurns,
  windowHistory,
} from "../apps/server/src/engine/history-window.ts";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });
const call = (id: string): ModelMessage => ({
  role: "assistant",
  content: null,
  toolCalls: [{ id, type: "function", function: { name: "look", arguments: "{}" } }],
});
const result = (id: string, text: string): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content: text,
});
const big = "x".repeat(900);

test("within the budget the messages are the very same array", () => {
  const messages = [user("be good"), user("hi"), assistant("hello")];
  assert.equal(windowHistory(messages, 10_000), messages);
  assert.equal(windowHistory(messages, 0), messages, "0 is everything");
});

test("over the budget, the newest whole turns stay and the oldest kept turn opens with what is gone", () => {
  const messages: ModelMessage[] = [
    user(`one ${big}`),
    assistant(big),
    user(`two ${big}`),
    call("c1"),
    result("c1", big),
    assistant(big),
    user("three"),
    assistant("short"),
    user("four?"),
  ];
  // room for the last two turns (three + four) but not the turn with the tool call
  const out = windowHistory(messages, 3000);
  assert.deepEqual(out, [user(`${omittedTurns(6)}\n\nthree`), assistant("short"), user("four?")]);
});

test("the cut never splits a tool call from its result, and the newest user message always stays", () => {
  const messages: ModelMessage[] = [
    user(`a ${big}`),
    call("c1"),
    result("c1", big),
    assistant(big),
    user("b"),
    call("c2"),
    result("c2", big),
  ];
  // too small for anything but the last turn: the last turn stays whole, however big
  const out = windowHistory(messages, 100);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(
    (out[0] as { content: string }).content,
    `${omittedTurns(4)}

b`,
  );
  // a budget that would cut inside the first turn's tool exchange still cuts at a user message
  const mid = windowHistory(messages, 2500);
  assert.equal(mid[0]?.role, "user");
});

test("the setting: default 32, a whole number, 0 allowed", () => {
  assert.equal(historyBudgetKb({}), 32);
  assert.equal(historyBudgetKb({ MODEL_HISTORY_KB: "0" }), 0);
  assert.equal(historyBudgetKb({ MODEL_HISTORY_KB: " 96 " }), 96);
  assert.throws(() => historyBudgetKb({ MODEL_HISTORY_KB: "lots" }), /MODEL_HISTORY_KB/);
});

test("the middleware changes providerMessages only, and says nothing when all fits", () => {
  const mw = historyWindowMiddleware(1);
  const small = [user("hi")];
  assert.equal(mw.onConfig?.({} as never, { messages: small } as never), undefined);
  const many = [user(big), assistant(big), user("now")];
  const out = mw.onConfig?.({} as never, { messages: many } as never) as {
    providerMessages: ModelMessage[];
  };
  assert.equal(out.providerMessages.length, 1);
  assert.match(String(out.providerMessages[0]?.content), /^\[2 earlier messages/);
});

// A picture far above any budget: 400 KB of base64.
const base64 = "A".repeat(400_000);
const picture = { type: "image", source: { type: "data", value: base64, mimeType: "image/jpeg" } };

test("a picture in an earlier turn counts a small fixed cost, so its turn stays", () => {
  const messages = [
    user("before"),
    assistant("ok"),
    { role: "user", content: [{ type: "text", content: "what is in this photo?" }, picture] },
    assistant("a red car"),
    user("what colour is the car in it?"),
  ] as ModelMessage[];
  assert.equal(windowHistory(messages, 32 * 1024), messages);
  // Still a cost: a budget with room for the words alone but not the part cuts before the photo.
  const words = Buffer.byteLength(JSON.stringify(messages)) - base64.length;
  assert.ok(mediaPartBytes > 0 && mediaPartBytes <= 1024);
  assert.equal(windowHistory(messages, words - 100).length, 1);
});

test("a screenshot in the current turn's tool result does not drop the earlier turns", () => {
  const shot = (id: string): ModelMessage =>
    ({
      role: "tool",
      toolCallId: id,
      content: [{ type: "text", content: '{"ok":true}' }, picture],
    }) as ModelMessage;
  const messages: ModelMessage[] = [
    user("the form: name Ada, city Turin"),
    assistant("noted"),
    user("fill the form with what we agreed above"),
    call("c1"),
    shot("c1"),
    call("c2"),
    shot("c2"),
  ];
  assert.equal(windowHistory(messages, 32 * 1024), messages);
  // Every kind of part that is not text counts the same, whatever its source.
  const kinds = ["audio", "video", "document"].map((type) => ({ ...picture, type }));
  const mixed = [user("earlier"), { role: "user", content: kinds }] as ModelMessage[];
  assert.equal(windowHistory(mixed, 4 * 1024), mixed);
});

test("the budget is bytes of UTF-8: Chinese counts three bytes a character", () => {
  const han = "\u4e2d".repeat(1000); // 1000 characters, 3000 bytes
  const messages = [user(han), assistant(han), user(han), assistant("ok"), user("now")];
  // 5000 would hold both earlier turns by characters (about 3100); by bytes only the newer one.
  const out = windowHistory(messages, 5000);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.match(String(out[0]?.content), /^\[2 earlier messages/);
});

test("a part of a kind the window does not know is counted in full, never flat", () => {
  const long = "字".repeat(4000);
  const messages = [
    user("one"),
    {
      role: "assistant",
      content: [{ type: "thinking", content: long }],
    } as unknown as ModelMessage,
    user("two"),
    { role: "assistant", content: [{ type: "reasoning", text: long }] } as unknown as ModelMessage,
    user("three"),
  ];
  // Each unknown part is 12 KB of UTF-8: neither earlier turn fits 8 KB.
  const kept = windowHistory(messages, 8 * 1024);
  assert.equal(kept.length, 1);
});
