// A reply whose model request the infrastructure
// stopped is tried once more by itself, as the same reply, with what it did so far kept
// (apps/server/src/engine/reply-retry.ts). The client words the retry and the final failure in
// Chinese (packages/client/src/conversation-run.ts, tested in apps/mobile/test).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, Observable, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { stoppedByInfrastructure } from "../apps/server/src/engine/model.ts";
import {
  continued,
  replyMessages,
  replyRetryEvent,
  withOneRetry,
} from "../apps/server/src/engine/reply-retry.ts";
import { modelFixture } from "./helpers/model.ts";

const input: RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "看看桌面" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};
const event = (value: Record<string, unknown>) => value as unknown as BaseEvent;
const firstAttempt = [
  event({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
  event({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "我先" }),
  event({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "看一眼。" }),
  event({
    type: EventType.TOOL_CALL_START,
    toolCallId: "c1",
    toolCallName: "use_desktop",
    parentMessageId: "m1",
  }),
  event({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"action":"screenshot"}' }),
  event({ type: EventType.TOOL_CALL_END, toolCallId: "c1" }),
  event({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "c1",
    messageId: "t1",
    role: "tool",
    content: '{"ok":true}',
  }),
  // The failure cut this call off: no end, no result.
  event({ type: EventType.TOOL_CALL_START, toolCallId: "c2", toolCallName: "use_desktop" }),
  event({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c2", delta: '{"action":"left_cl' }),
];
const failure = event({ type: EventType.RUN_ERROR, message: "400 Upstream request failed" });

/** An attempt that sends `events`, then fails with `error` (as BuiltInAgent: RUN_ERROR, then
 * the observable errors), or completes. */
function attempt(events: BaseEvent[], error?: BaseEvent) {
  return new Observable<BaseEvent>((subscriber) => {
    for (const item of events) subscriber.next(item);
    if (error) {
      subscriber.next(error);
      subscriber.error(new Error(String((error as { message?: unknown }).message)));
    } else subscriber.complete();
  });
}
const collect = (source: Observable<BaseEvent>) =>
  new Promise<{ events: BaseEvent[]; error?: string; completed: boolean }>((resolve) => {
    const events: BaseEvent[] = [];
    source.subscribe({
      next: (item) => events.push(item),
      error: (error) => resolve({ events, error: String(error), completed: false }),
      complete: () => resolve({ events, completed: true }),
    });
  });
const types = (events: BaseEvent[]) => events.map((item) => item.type);
const options = { transient: stoppedByInfrastructure, delayMs: 5 };

test("a transient failure is tried once more as the same reply, with what it did so far", async () => {
  const inputs: RunAgentInput[] = [];
  const source = withOneRetry(
    (attemptInput) => {
      inputs.push(attemptInput);
      return inputs.length === 1
        ? attempt(firstAttempt, failure)
        : attempt([
            event({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
            event({
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: "m2",
              role: "assistant",
              delta: "好了。",
            }),
            event({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" }),
          ]);
    },
    input,
    options,
  );
  const outcome = await collect(source);
  assert.equal(outcome.completed, true, outcome.error);
  // One start, every first-attempt event once, the cut-off call closed, the retry line, then
  // the retry's events without its start; no RUN_ERROR.
  assert.deepEqual(types(outcome.events), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_CHUNK,
    EventType.TEXT_MESSAGE_CHUNK,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.CUSTOM,
    EventType.TEXT_MESSAGE_CHUNK,
    EventType.RUN_FINISHED,
  ]);
  const retry = outcome.events.find((item) => item.type === EventType.CUSTOM) as BaseEvent & {
    name: string;
    value: { message: string };
  };
  assert.deepEqual(
    [retry.name, retry.value],
    [replyRetryEvent, { message: "400 Upstream request failed" }],
  );
  // The second attempt is the same run, continuing from the conversation plus the reply's own
  // text, its answered tool call and the result; the call the failure cut off is not there.
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].runId, "r1");
  assert.deepEqual(
    inputs[1].messages.map((message) => [message.role, message.id]),
    [
      ["user", "u1"],
      ["assistant", "m1"],
      ["tool", "t1"],
    ],
  );
  const assistant = inputs[1].messages[1] as { content?: string; toolCalls?: { id: string }[] };
  assert.equal(assistant.content, "我先看一眼。");
  assert.deepEqual(
    assistant.toolCalls?.map((call) => call.id),
    ["c1"],
  );
});

test("a failure that is not transient, and a second one, end the reply as before", async () => {
  let starts = 0;
  const refused = event({ type: EventType.RUN_ERROR, message: "401 authentication_error" });
  const once = await collect(
    withOneRetry(
      () => {
        starts++;
        return attempt(firstAttempt.slice(0, 3), refused);
      },
      input,
      options,
    ),
  );
  assert.deepEqual(
    [starts, once.completed, once.events.at(-1)?.type],
    [1, false, EventType.RUN_ERROR],
  );
  assert.match(once.error ?? "", /authentication_error/);
  starts = 0;
  const twice = await collect(
    withOneRetry(
      () => {
        starts++;
        return attempt(starts === 1 ? firstAttempt.slice(0, 3) : [firstAttempt[0]], failure);
      },
      input,
      options,
    ),
  );
  assert.equal(starts, 2, "one retry, never more");
  assert.equal(twice.completed, false);
  assert.equal(types(twice.events).filter((type) => type === EventType.CUSTOM).length, 1);
  assert.equal(types(twice.events).filter((type) => type === EventType.RUN_STARTED).length, 1);
  assert.equal(twice.events.at(-1)?.type, EventType.RUN_ERROR);
});

test("unsubscribing during the wait starts nothing more", async () => {
  let starts = 0;
  const subscription = withOneRetry(
    () => {
      starts++;
      return attempt(firstAttempt.slice(0, 3), failure);
    },
    input,
    { ...options, delayMs: 20 },
  ).subscribe({ error: () => {} });
  subscription.unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(starts, 1);
});

test("the reply's messages so far: text folded, answered calls kept, a cut-off call left out", () => {
  const messages = replyMessages(firstAttempt);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant", "tool"],
  );
  // A call without a result on its own message: the message goes with it.
  const alone = replyMessages([
    event({ type: EventType.TOOL_CALL_START, toolCallId: "c9", toolCallName: "use_desktop" }),
  ]);
  assert.deepEqual(alone, []);
  // The conversation's own messages are never doubled.
  const next = continued(
    { ...input, messages: [...input.messages, { id: "m1", role: "assistant", content: "x" }] },
    firstAttempt,
  );
  assert.deepEqual(
    next.messages.map((message) => message.id),
    ["u1", "m1", "t1"],
  );
});

async function app(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-reply-retry-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { config, server };
}

test("a chat reply whose model request the relay failed upstream goes on after one retry", async (t) => {
  // Request 0 calls a tool; request 1 (after the tool's result) fails with the relay's upstream
  // line, which the provider SDK does not retry (a 400); request 2 is the retry's.
  const { requests } = await modelFixture(
    t,
    (index) => (index === 0 ? { name: "agent_status", arguments: {} } : { text: "都正常。" }),
    {
      errorStatus: (index) => (index === 1 ? 400 : undefined),
      errorBody: () => ({ message: "Upstream request failed", type: "upstream_error" }),
    },
  );
  const { config, server } = await app(t);
  const conversation = new ConversationAgent(config, server.agent, "local-user");
  conversation.retryDelayMs = 10;
  conversation.threadId = "retry-chat";
  conversation.setMessages([{ id: randomUUID(), role: "user", content: "看看进度" }]);
  // Through runAgent, so the client's own pipeline (chunk transform, event verification) takes
  // the sequence as the chat runner would.
  const events: BaseEvent[] = [];
  const result = await conversation.runAgent(
    { runId: randomUUID() },
    { onEvent: ({ event: item }) => void events.push(item) },
  );
  assert.equal(requests.length, 3, "one retry after the upstream failure");
  assert.match(requests[2].body, /agent_status/, "the retry carries the tool call made so far");
  assert.equal(types(events).filter((type) => type === EventType.RUN_STARTED).length, 1);
  assert.equal(types(events).filter((type) => type === EventType.RUN_ERROR).length, 0);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const retry = events.find((item) => item.type === EventType.CUSTOM) as
    | { name?: string }
    | undefined;
  assert.equal(retry?.name, replyRetryEvent);
  const text = result.newMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("");
  assert.match(text, /都正常/);
});

test("a chat reply whose retry fails too ends with that error, once", async (t) => {
  const { requests } = await modelFixture(t, () => ({ text: "never" }), {
    errorStatus: () => 400,
    errorBody: () => ({ message: "Upstream request failed", type: "upstream_error" }),
  });
  const { config, server } = await app(t);
  const conversation = new ConversationAgent(config, server.agent, "local-user");
  conversation.retryDelayMs = 10;
  const outcome = await collect(
    conversation.run({
      threadId: "retry-chat-2",
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content: "看看进度" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  );
  assert.equal(requests.length, 2);
  assert.equal(types(outcome.events).filter((type) => type === EventType.CUSTOM).length, 1);
  const errors = outcome.events.filter((item) => item.type === EventType.RUN_ERROR);
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as { message?: unknown }).message), /Upstream request failed/);
});

test("the events of a reply are never sent twice: lastValueFrom sees each once", async (t) => {
  const { requests } = await modelFixture(
    t,
    (index) => (index === 0 ? { name: "agent_status", arguments: {} } : { text: "完成。" }),
    {
      errorStatus: (index) => (index === 1 ? 400 : undefined),
      errorBody: () => ({ message: "Upstream request failed", type: "upstream_error" }),
    },
  );
  const { config, server } = await app(t);
  const conversation = new ConversationAgent(config, server.agent, "local-user");
  conversation.retryDelayMs = 10;
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "retry-chat-3",
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "看看进度" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
  assert.equal(requests.length, 3);
  assert.equal(
    events.filter((item) => item.type === EventType.TOOL_CALL_RESULT).length,
    1,
    "the tool ran once and its result went out once",
  );
});
