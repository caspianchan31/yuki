// v1.5: this version's rules, said again right before the person's latest words on every model call
// of a chat reply (engine/current-rules.ts), on the provider's copy of the context only: a long
// conversation whose older replies did things differently (a screenshot claimed, none shown) no
// longer teaches the model the old way, and nobody has to start the conversation over.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import {
  currentRulesMiddleware,
  currentRulesTag,
  olderRepliesRule,
  rulesNote,
  withCurrentRules,
} from "../apps/server/src/engine/current-rules.ts";

const history = (): ModelMessage[] => [
  { role: "user", content: "打开百度" },
  { role: "assistant", content: "已打开百度" },
  { role: "user", content: "在电脑里截图给我看" },
  {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "c1", type: "function", function: { name: "computer_browser", arguments: "{}" } },
    ],
  },
  { role: "tool", content: '{"title":"百度一下"}', toolCallId: "c1" },
];

test("the rules ride on the latest user message, whatever came after it", () => {
  const messages = history();
  const before = structuredClone(messages);
  const result = withCurrentRules(messages, [olderRepliesRule, "Show the screen with a tool."]);
  assert.deepEqual(messages, before, "the input is not modified");
  assert.notEqual(result, messages);
  const said = result[2]?.content as string;
  assert.ok(said.startsWith("在电脑里截图给我看\n\n"), said);
  assert.ok(said.includes(`<${currentRulesTag}>`) && said.includes(`</${currentRulesTag}>`));
  assert.ok(
    said.includes(`- ${olderRepliesRule}`) && said.includes("- Show the screen with a tool."),
  );
  for (const at of [0, 1, 3, 4])
    assert.equal(result[at], messages[at], `message ${at} is the same`);
});

test("a user message made of parts gets the note as one more text part", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", content: "看看这个" }] },
  ];
  const result = withCurrentRules(messages, ["Rule."]);
  const parts = result[0]?.content as { type: string; content: string }[];
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: "text", content: "看看这个" });
  assert.equal(parts[1]?.content, rulesNote(["Rule."]));
});

test("nothing to add: no rules, no user message, or the note already there", () => {
  const messages = history();
  assert.equal(withCurrentRules(messages, []), messages);
  const assistantOnly: ModelMessage[] = [{ role: "assistant", content: "hi" }];
  assert.equal(withCurrentRules(assistantOnly, ["Rule."]), assistantOnly);
  const once = withCurrentRules(messages, ["Rule."]);
  assert.equal(withCurrentRules(once, ["Rule."]), once, "said once per model call, not twice");
});

test("the middleware sets only the provider's copy, reading the rules at every model call", () => {
  let rules = [olderRepliesRule];
  const middleware = currentRulesMiddleware(() => rules);
  const messages = history();
  const first = middleware.onConfig?.({} as never, { messages } as never) as {
    providerMessages: ModelMessage[];
  };
  assert.ok(String(first.providerMessages[2]?.content).includes(olderRepliesRule));
  assert.equal(messages[2]?.content, "在电脑里截图给我看", "the stored history is untouched");
  // A copy another middleware already made is the one it adds to.
  const pruned = [...messages];
  const second = middleware.onConfig?.(
    {} as never,
    {
      messages,
      providerMessages: pruned,
    } as never,
  ) as { providerMessages: ModelMessage[] };
  assert.notEqual(second.providerMessages, pruned);
  rules = [];
  assert.equal(middleware.onConfig?.({} as never, { messages } as never), undefined);
});
