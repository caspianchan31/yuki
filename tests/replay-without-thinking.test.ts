import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import {
  compactLeniently,
  messagesFromEvents,
  withoutThinking,
} from "../apps/server/src/chat/events.ts";

const ev = (type: string, more: Record<string, unknown> = {}) => ({ type, ...more }) as BaseEvent;

// A past reply as a thinking model stored it: its thinking a few characters per event.
function pastRun(runId: string, thoughts: number): BaseEvent[] {
  return [
    ev(EventType.RUN_STARTED, {
      threadId: "t",
      runId,
      input: { messages: [{ id: `${runId}-u`, role: "user", content: "问题" }] },
    }),
    ev("REASONING_START", { messageId: `${runId}-r` }),
    ev("REASONING_MESSAGE_START", { messageId: `${runId}-r`, role: "reasoning" }),
    ...Array.from({ length: thoughts }, () =>
      ev("REASONING_MESSAGE_CONTENT", { messageId: `${runId}-r`, delta: "想" }),
    ),
    ev("REASONING_MESSAGE_END", { messageId: `${runId}-r` }),
    ev("REASONING_END", { messageId: `${runId}-r` }),
    ev(EventType.TOOL_CALL_START, {
      toolCallId: `${runId}-c`,
      toolCallName: "look",
      parentMessageId: `${runId}-a`,
    }),
    ev(EventType.TOOL_CALL_ARGS, { toolCallId: `${runId}-c`, delta: "{}" }),
    ev(EventType.TOOL_CALL_END, { toolCallId: `${runId}-c` }),
    ev(EventType.TOOL_CALL_RESULT, {
      toolCallId: `${runId}-c`,
      messageId: `${runId}-t`,
      content: "结果",
    }),
    ev(EventType.TEXT_MESSAGE_START, { messageId: `${runId}-a2`, role: "assistant" }),
    ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: `${runId}-a2`, delta: "答" }),
    ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: `${runId}-a2`, delta: "案" }),
    ev(EventType.TEXT_MESSAGE_END, { messageId: `${runId}-a2` }),
    ev(EventType.RUN_FINISHED, { threadId: "t", runId }),
  ];
}

test("a conversation opens without its past replies' thinking; what was said and done is all there", () => {
  const stored = [...pastRun("r1", 2000), ...pastRun("r2", 3000)];
  const before = compactLeniently(stored);
  const after = compactLeniently(withoutThinking(stored));
  assert.ok(before.length > 5000, "the thinking was thousands of events");
  assert.ok(after.length < 30, `now a handful (${after.length})`);
  assert.equal(
    after.filter((e) => e.type.startsWith("REASONING") || e.type.startsWith("THINKING")).length,
    0,
  );
  const shown = (events: BaseEvent[]) =>
    messagesFromEvents(events)
      .filter((m) => m.role !== "reasoning")
      .map((m) => [m.id, m.role, JSON.stringify((m as { content?: unknown }).content ?? null)]);
  assert.deepEqual(shown(after), shown(before), "every other message, in order, unchanged");
  assert.ok(
    shown(after).some(([, role, content]) => role === "assistant" && content.includes("答案")),
  );
  assert.ok(
    shown(after).some(([, role]) => role === "tool"),
    "the tool's result is kept",
  );
});

test("events without thinking come back as the very same list", () => {
  const plain = pastRun("r3", 0).filter((e) => !e.type.startsWith("REASONING"));
  assert.equal(withoutThinking(plain), plain);
});
