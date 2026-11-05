// On the OpenAI-compatible routes the Chat Completions adapter
// turns a tool result's parts into JSON text, so a screenshot never reached the model as an
// image. The middleware moves each step's images into a user message after the step's tool
// results, and leaves everything else as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMiddlewareConfig, ChatMiddlewareContext, ModelMessage } from "@tanstack/ai";
import {
  screenshotFollows,
  screenshotsNote,
  toolImagesAsUserMessages,
  toolImagesMiddleware,
} from "../apps/server/src/engine/tool-images.ts";

const image = (value: string) => ({
  type: "image" as const,
  source: { type: "data" as const, value, mimeType: "image/jpeg" },
});
const text = (content: string) => ({ type: "text" as const, content });

test("a tool result's images become a user message after the step's tool results; text results and the rest stay", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "reply to the post" },
    {
      role: "assistant",
      content: "clicking",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "use_desktop", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "read_page_text", arguments: "{}" } },
      ],
    },
    { role: "tool", toolCallId: "c1", content: [text('{"status":"succeeded"}'), image("AAA")] },
    { role: "tool", toolCallId: "c2", content: '{"text":"words"}' },
    {
      role: "assistant",
      content: "typing",
      toolCalls: [
        { id: "c3", type: "function", function: { name: "use_desktop", arguments: "{}" } },
      ],
    },
    { role: "tool", toolCallId: "c3", content: [text("typed"), image("BBB")] },
  ];
  const before = structuredClone(messages);
  const moved = toolImagesAsUserMessages(messages);
  assert.deepEqual(messages, before, "pure");
  assert.deepEqual(moved, [
    messages[0],
    messages[1],
    { role: "tool", toolCallId: "c1", content: `{"status":"succeeded"}\n${screenshotFollows}` },
    messages[3],
    { role: "user", content: [text(screenshotsNote), image("AAA")] },
    messages[4],
    { role: "tool", toolCallId: "c3", content: `typed\n${screenshotFollows}` },
    { role: "user", content: [text(screenshotsNote), image("BBB")] },
  ]);
  // Two screenshots of one step travel together, after both tool results.
  const twice = toolImagesAsUserMessages([
    messages[1],
    { role: "tool", toolCallId: "c1", content: [image("AAA")] },
    { role: "tool", toolCallId: "c2", content: [text("second"), image("BBB")] },
  ]);
  assert.deepEqual(twice, [
    messages[1],
    { role: "tool", toolCallId: "c1", content: screenshotFollows },
    { role: "tool", toolCallId: "c2", content: `second\n${screenshotFollows}` },
    { role: "user", content: [text(screenshotsNote), image("AAA"), image("BBB")] },
  ]);
  // Nothing to move: the same array.
  const plain: ModelMessage[] = [messages[0], messages[1], messages[3]];
  assert.equal(toolImagesAsUserMessages(plain), plain);
});

test("the middleware sets providerMessages only when something moved, after the pruning's own", () => {
  const middleware = toolImagesMiddleware();
  const ctx = {} as ChatMiddlewareContext;
  const messages: ModelMessage[] = [
    { role: "tool", toolCallId: "c1", content: [text("ok"), image("AAA")] },
  ];
  const result = middleware.onConfig?.(ctx, { messages } as ChatMiddlewareConfig);
  const moved = (result as { providerMessages?: ModelMessage[] } | undefined)?.providerMessages;
  assert.ok(moved, "something moved");
  assert.equal(moved.length, 2);
  assert.equal(moved[1].role, "user");
  const pruned: ModelMessage[] = [{ role: "tool", toolCallId: "c1", content: [text("ok")] }];
  assert.equal(
    middleware.onConfig?.(ctx, { messages, providerMessages: pruned } as ChatMiddlewareConfig),
    undefined,
  );
});

test("the middleware is for the Chat Completions route only", async () => {
  const { chatCompletionsRoute } = await import("../apps/server/src/engine/tanstack-agent.ts");
  const was = process.env.OPENAI_CHAT_COMPLETIONS;
  try {
    process.env.OPENAI_CHAT_COMPLETIONS = "true";
    assert.equal(chatCompletionsRoute("openai/gpt-6"), true);
    assert.equal(chatCompletionsRoute("anthropic/claude-sonnet-5-5"), false);
    process.env.OPENAI_CHAT_COMPLETIONS = "false";
    assert.equal(chatCompletionsRoute("openai/gpt-6"), false);
    delete process.env.OPENAI_CHAT_COMPLETIONS;
    assert.equal(chatCompletionsRoute("openai/gpt-6"), false);
  } finally {
    if (was === undefined) delete process.env.OPENAI_CHAT_COMPLETIONS;
    else process.env.OPENAI_CHAT_COMPLETIONS = was;
  }
});
