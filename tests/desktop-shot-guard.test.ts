// v1.5 (open core): a reply that says it took or shows a screenshot of the computer, but in which no
// computer_screenshot ran, gets one (desktop-shot-guard.ts): the person sees the picture the words
// promise, as an ordinary computer_screenshot card, whatever the model and the conversation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { from, lastValueFrom, toArray } from "rxjs";
import {
  promisesScreenshot,
  type Shooter,
  screenshotPromiseGuard,
} from "../apps/server/src/desktop-shot-guard.ts";

function desktop(fails = false) {
  const kept: string[] = [];
  const fake = {
    kept,
    drivenBy: "member",
    screenshot: async () => {
      if (fails) throw new Error("the display is gone");
      return "iVBORw0KGgo=";
    },
    keepShot: (png: string) => {
      kept.push(png);
      return "shot_abcdefghijklmnop";
    },
  };
  return fake as typeof fake & Shooter;
}

function reply(text: string, chunked = false, extra: BaseEvent[] = []): BaseEvent[] {
  const words = chunked
    ? [{ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: text }]
    : [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: text },
        { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      ];
  return [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    ...extra,
    ...words,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
  ] as BaseEvent[];
}

const through = (events: BaseEvent[], shooter: Shooter) =>
  lastValueFrom(from(events).pipe(screenshotPromiseGuard(shooter), toArray()));

test("a reply that says it shows a screenshot but took none gets one, before it finishes", async () => {
  const computer = desktop();
  const out = await through(reply("这是当前电脑屏幕截图：百度首页已打开。"), computer);
  const types = out.map((event) => event.type);
  assert.deepEqual(types.slice(-5), [
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
    EventType.RUN_FINISHED,
  ]);
  const start = out.at(-5) as unknown as {
    toolCallName: string;
    parentMessageId: string;
    toolCallId: string;
  };
  assert.equal(start.toolCallName, "computer_screenshot");
  assert.equal(start.parentMessageId, "m1", "the card belongs to the reply");
  const result = out.at(-2) as unknown as { toolCallId: string; content: string };
  assert.equal(result.toolCallId, start.toolCallId);
  assert.equal(JSON.parse(result.content).shotId, "shot_abcdefghijklmnop");
  assert.deepEqual(computer.kept, ["iVBORw0KGgo="], "the picture is kept for the chat");
});

test("text that arrives in chunks counts too", async () => {
  const out = await through(reply("Here is a screenshot of the screen.", true), desktop());
  assert.ok(out.some((event) => event.type === EventType.TOOL_CALL_RESULT));
});

test("a reply that took a screenshot, or promised none, is left as it is", async () => {
  const took = reply("这是截图。", false, [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "computer_screenshot",
    } as BaseEvent,
  ]);
  const computer = desktop();
  assert.deepEqual(await through(took, computer), took);
  const plain = reply("已打开百度：https://www.baidu.com/");
  assert.deepEqual(await through(plain, computer), plain);
  assert.deepEqual(computer.kept, []);
});

test("a screenshot that fails is logged and the reply ends as it was", async () => {
  const events = reply("截图如下。");
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    assert.deepEqual(await through(events, desktop(true)), events);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /\[screenshot promise\] the display is gone/);
});

test("the words that promise a picture of the screen", () => {
  for (const said of ["这是当前电脑屏幕截图", "我截屏给你看", "Here's a screenshot", "screen shot"])
    assert.ok(promisesScreenshot.test(said), said);
  for (const said of ["已打开百度", "网页标题是 Example Domains", "I opened the page"])
    assert.ok(!promisesScreenshot.test(said), said);
});
