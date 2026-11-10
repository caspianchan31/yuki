// v1.7.2 提示只带近的 (apps/server/src/engine/history-window.ts): the newest turns up to a budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import {
  historyBudgetKb,
  historyWindowMiddleware,
  mediaPartBytes,
  olderMessageBytes,
  omittedTurns,
  stepsNotShown,
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
  // too small for anything but the last turn: the last turn stays whole, however big, and of
  // the turn before only what was asked and how it ended (v1.7.3: it used to be nothing at all)
  const out = windowHistory(messages, 100);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "tool"],
  );
  assert.match((out[0] as { content: string }).content, /^\[Of the turn below only what was asked/);
  assert.match((out[0] as { content: string }).content, /\n\na x/);
  assert.equal((out[2] as { content: string }).content, "b");
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
  // the turn before, asked and answered, stays (its long words shortened); nothing before it
  assert.equal(out.providerMessages.length, 3);
  assert.ok(String(out.providerMessages[0]?.content).startsWith(stepsNotShown));
  assert.equal(out.providerMessages[2]?.content, "now");
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
  const cut = windowHistory(messages, words - 100);
  assert.equal(cut.length, 3, "the photo's turn, asked and answered, and the new question");
  assert.match(JSON.stringify(cut[0]?.content), /2 earlier messages/);
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
  // Each unknown part is 12 KB of UTF-8: neither earlier turn fits 8 KB, and an unknown part is
  // not shortened (only text is). Of the turn before, what was asked stays; it has no final text.
  const kept = windowHistory(messages, 8 * 1024);
  assert.deepEqual(
    kept.map((m) => m.role),
    ["user", "user"],
  );
  assert.ok(!JSON.stringify(kept).includes(long.slice(0, 50)));
});

// v1.7.4 不断片: 2026-11-10 in a long conversation, one long tool result in the turn before the
// newest message pushed the whole conversation out: 707 messages went to the model as 1.
test("one long tool result in the turn before does not push the conversation out of the window", () => {
  const huge = "结果".repeat(40_000); // 240 KB of UTF-8
  const messages: ModelMessage[] = [];
  for (let turn = 0; turn < 30; turn++)
    messages.push(user(`第 ${turn} 件事`), assistant(`第 ${turn} 件做好了`));
  messages.push(user("把那个表格整理一下"), call("c1"), result("c1", huge), assistant("整理好了"));
  messages.push(user("接着做下一步"));
  const out = windowHistory(messages, 32 * 1024);
  const text = JSON.stringify(out);
  assert.ok(out.length > 10, `the conversation is still there (${out.length} messages)`);
  assert.ok(
    text.includes("把那个表格整理一下") && text.includes("整理好了"),
    "the turn before, whole",
  );
  assert.ok(text.includes("第 29 件做好了"), "and the turns before it, as the budget allows");
  assert.match(text, /the rest of this, about \d+ KB, is not shown/, "the long result, its start");
  const tool = out.find((m) => m.role === "tool") as { content: string };
  assert.ok(Buffer.byteLength(tool.content) <= olderMessageBytes, "shortened to its start");
  assert.ok(Buffer.byteLength(text) < 40 * 1024, "within the budget, give or take the notes");
  // every tool call still has its result right after it
  out.forEach((m, i) => {
    if ((m as { toolCalls?: unknown[] }).toolCalls?.length) assert.equal(out[i + 1]?.role, "tool");
  });
  assert.equal(out.at(-1)?.content, "接着做下一步");
});

test("the turn being worked on is never shortened, however long its tool results", () => {
  const huge = "y".repeat(100_000);
  const messages = [user("before"), assistant("ok"), user("go"), call("c1"), result("c1", huge)];
  const out = windowHistory(messages, 8 * 1024);
  assert.equal((out.at(-1) as { content: string }).content, huge);
});

test("a tool call's long arguments in an older turn are replaced by a note that is still JSON", () => {
  const args = JSON.stringify({ text: "z".repeat(50_000) });
  const messages: ModelMessage[] = [
    user("write it"),
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "w", type: "function", function: { name: "write", arguments: args } }],
    },
    result("w", "written"),
    assistant("done"),
    user("thanks, next"),
  ];
  const out = windowHistory(messages, 8 * 1024);
  const sent = out.find((m) => (m as { toolCalls?: unknown[] }).toolCalls) as {
    toolCalls: { function: { arguments: string } }[];
  };
  assert.deepEqual(JSON.parse(sent.toolCalls[0]?.function.arguments ?? ""), { notShown: "49 KB" });
  assert.equal(out[out.indexOf(sent as ModelMessage) + 1]?.role, "tool");
});
