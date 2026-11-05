import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactEvents, EventType } from "@ag-ui/client";
import { messagesFromEvents } from "../apps/server/src/chat/events.ts";

describe("streamed reply text", () => {
  it("joins text chunks into the reply as they arrive", () => {
    const messages = messagesFromEvents([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        role: "assistant",
        delta: "我先",
      },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "看一眼。" },
    ] as never);
    assert.equal(messages[0]?.content, "我先看一眼。");
  });

  it("still joins the chunks after the stored run is compacted", () => {
    const stored = compactEvents([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        role: "assistant",
        delta: "我先",
      },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "看一眼。" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ] as never);
    const messages = messagesFromEvents(stored);
    assert.equal(messages.find((message) => message.id === "m1")?.content, "我先看一眼。");
  });
});
