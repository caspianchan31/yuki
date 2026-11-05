// A model turn with reasoning only is asked again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import {
  answers,
  askAgain,
  askAgainNudge,
  askAgainTimes,
  thinks,
} from "../apps/server/src/engine/ask-again.ts";
import { adapter, reasoningOf } from "../apps/server/src/engine/tanstack-agent.ts";

const started = { type: EventType.RUN_STARTED };
const thought = { type: EventType.THINKING_TEXT_MESSAGE_CONTENT, delta: "hmm" };
const finished = { type: EventType.RUN_FINISHED };
const call = { type: EventType.TOOL_CALL_START, toolCallName: "use_desktop" };
const words = { type: EventType.TEXT_MESSAGE_CONTENT, delta: "Done." };

function fake(turns: unknown[][]) {
  let calls = 0;
  const options: unknown[] = [];
  const inner = {
    name: "fake",
    calls: () => calls,
    chatStream: async function* (o: unknown) {
      options.push(o);
      const turn = turns[Math.min(calls, turns.length - 1)] ?? [];
      calls++;
      yield* turn;
    },
  };
  return { inner, options };
}
async function collect(stream: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

test("a turn with reasoning only is dropped and asked again; the turn that answers streams whole", async () => {
  const { inner, options } = fake([
    [started, thought, finished],
    [started, thought, call, finished],
  ]);
  const said: string[] = [];
  const wrapped = askAgain(inner, askAgainTimes, (line) => said.push(line));
  const out = await collect(
    wrapped.chatStream({ model: "m", messages: [{ role: "user", content: "go" }] }),
  );
  assert.deepEqual(out, [started, thought, call, finished]);
  assert.equal(inner.calls(), 2);
  // The turn asked again carries the nudge as one more user message; the first is as it was.
  assert.deepEqual(options, [
    { model: "m", messages: [{ role: "user", content: "go" }] },
    {
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "user", content: askAgainNudge },
      ],
    },
  ]);
  assert.deepEqual(said, [
    "[model turn] thought only: no words, no tool call; asked again (1 of 2)",
  ]);
  // The other members are the adapter's own, bound to it.
  assert.equal(wrapped.name, "fake");
  assert.equal(wrapped.calls(), 2);
});

test("words answer; an error answers and is never retried; after the last try the turn stands", async () => {
  const a = fake([[started, words, finished]]);
  assert.deepEqual(await collect(askAgain(a.inner, 2, () => {}).chatStream({})), [
    started,
    words,
    finished,
  ]);
  assert.equal(a.inner.calls(), 1);
  const error = { type: EventType.RUN_ERROR, message: "refused" };
  const b = fake([[started, error]]);
  assert.deepEqual(await collect(askAgain(b.inner, 2, () => {}).chatStream({})), [started, error]);
  assert.equal(b.inner.calls(), 1);
  const c = fake([[started, thought, finished]]);
  const said: string[] = [];
  assert.deepEqual(await collect(askAgain(c.inner, 2, (l) => said.push(l)).chatStream({})), [
    started,
    thought,
    finished,
  ]);
  assert.equal(c.inner.calls(), 3, "the first and two more");
  assert.equal(said.length, 2);
  assert.equal(answers({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "" }), false);
  assert.equal(answers({ type: EventType.TOOL_CALL_CHUNK }), true);
  assert.equal(thinks({ type: EventType.REASONING_MESSAGE_CONTENT, delta: "x" }), true);
  assert.equal(thinks({ type: EventType.RUN_STARTED }), false);
});

test("a turn with neither reasoning nor an answer is the model stopping: not asked again", async () => {
  const { inner } = fake([[started, finished]]);
  const said: string[] = [];
  const out = await collect(askAgain(inner, 2, (line) => said.push(line)).chatStream({}));
  assert.deepEqual(out, [started, finished]);
  assert.equal(inner.calls(), 1);
  assert.deepEqual(said, []);
});

test("the Chat Completions adapter reads reasoning_content from a chunk's delta", () => {
  assert.deepEqual(reasoningOf({ choices: [{ delta: { reasoning_content: "hm" } }] }), {
    text: "hm",
  });
  assert.deepEqual(reasoningOf({ choices: [{ delta: { reasoning: "so" } }] }), { text: "so" });
  assert.equal(reasoningOf({ choices: [{ delta: { content: "words" } }] }), undefined);
  assert.equal(reasoningOf({ choices: [] }), undefined);
  assert.equal(reasoningOf(undefined), undefined);
  const before = process.env.OPENAI_CHAT_COMPLETIONS;
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_CHAT_COMPLETIONS = "true";
  process.env.OPENAI_API_KEY ??= "test-key";
  try {
    const chat = adapter("openai/gemini-3-flash") as unknown as {
      extractReasoning: (chunk: unknown) => { text: string } | undefined;
      name: string;
    };
    assert.deepEqual(chat.extractReasoning({ choices: [{ delta: { reasoning_content: "x" } }] }), {
      text: "x",
    });
    assert.equal(chat.name, "openai-chat");
  } finally {
    if (before === undefined) delete process.env.OPENAI_CHAT_COMPLETIONS;
    else process.env.OPENAI_CHAT_COMPLETIONS = before;
    if (key === undefined) delete process.env.OPENAI_API_KEY;
  }
});
