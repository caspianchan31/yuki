// Two model slips seen in testing: a tool call written as text, never shown and
// asked again once; and words that say something was started or awaits review with no tool called
// in the reply, asked again once (tool-slip.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { type BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { screenshotsNote } from "../apps/server/src/engine/tool-images.ts";
import {
  actedSincePerson,
  catchToolSlips,
  claimNote,
  claimsAction,
  insideCode,
  MarkupGate,
  markupTool,
  notDoneWords,
  nothingStartedWords,
  personLanguage,
  toolMarkupOpeners,
} from "../apps/server/src/engine/tool-slip.ts";
import { chatCompletionsFixture } from "./helpers/model.ts";

// What the model wrote in the approval journey (runs/full-f520730-20261106-011910/approval), as it
// arrived: a lone "<" first, the rest after.
const seedMarkup =
  '<seed:tool_call><function name="app_fakenotes__create_note"><parameter name="body" string="true">hi</parameter><parameter name="title" string="true">验收-011910-b</parameter></function></seed:tool_call>';
const seedPieces = ["<", seedMarkup.slice(1, 40), seedMarkup.slice(40)];
// What it wrote in review-rules with no tool called.
const claim =
  "已发起 FakeRules 创建笔记（标题「验收-011910-both」，正文「hi」），该操作正在等待你的审核，尚未执行；审核通过后才会真正创建。";
const asked =
  "用 FakeNotes 应用的 create_note 创建一条笔记，标题「验收-011910-b」，正文「hi」。直接调用，别问我。";

const pass = (gate: MarkupGate, pieces: string[]) =>
  pieces.map((piece) => gate.push(piece)).join("") + gate.end();

test("plain words go out as they come; a lone < waits for the next chunk and goes out when it is no markup", () => {
  const gate = new MarkupGate();
  assert.equal(gate.push("好的，"), "好的，");
  assert.equal(gate.push("a <"), "a ");
  assert.equal(gate.push(" b, <b>bold</b> [link](x)"), "< b, <b>bold</b> [link](x)");
  assert.equal(gate.push("<fun"), "");
  assert.equal(gate.end(), "<fun", "a start that never became markup goes out at the end");
  assert.equal(gate.slipped, false);
});

test("the markup the model wrote is held back whole, and the words before it go out", () => {
  const gate = new MarkupGate();
  assert.equal(pass(gate, seedPieces), "");
  assert.equal(gate.slipped, true);
  assert.equal(gate.markup, seedMarkup);
  assert.equal(markupTool(gate.markup), "app_fakenotes__create_note");
  const before = new MarkupGate();
  assert.equal(pass(before, ["好的，我来创建。", ...seedPieces]), "好的，我来创建。");
  assert.equal(before.slipped, true);
  for (const opener of toolMarkupOpeners) {
    const each = new MarkupGate();
    assert.equal(pass(each, ["ok ", opener, ' "x"']), "ok ", opener);
    assert.equal(each.slipped, true, opener);
  }
});

test("markup inside code is something shown, not a slip", () => {
  assert.equal(insideCode("look:\n```xml\n"), true);
  assert.equal(insideCode("look:\n```xml\n<a/>\n```\nthen "), false);
  assert.equal(insideCode("write `"), true);
  const fenced = ["The format is:\n```\n", seedMarkup, "\n```\nThat is all."];
  const gate = new MarkupGate();
  assert.equal(pass(gate, fenced), fenced.join(""));
  assert.equal(gate.slipped, false);
  const inline = new MarkupGate();
  assert.equal(pass(inline, ["Use `", "<tool_call>", "` tags."]), "Use `<tool_call>` tags.");
  assert.equal(inline.slipped, false);
});

test("what counts as words that say something was started or waits for review", () => {
  assert.equal(claimsAction(claim), true);
  assert.equal(claimsAction("已提交，等你确认。"), true);
  assert.equal(claimsAction("要我创建这条笔记吗？等你确认。"), false);
  assert.equal(claimsAction("要我发起吗？发起后需要等待你的审核。"), false);
  assert.equal(claimsAction("创建后会等待你的批准。"), false);
  assert.equal(claimsAction("Once sent, it will be awaiting your approval."), false);
  assert.equal(claimsAction("It is awaiting your approval."), true);
  assert.equal(claimsAction("今天天气不错。"), false);
});

test("the person's language and whether this reply called a tool come from the messages", () => {
  const rules = "\n\n<current-rules>\n- Do things the way your tools say now.\n</current-rules>";
  assert.equal(personLanguage([{ role: "user", content: asked + rules }]), "zh");
  assert.equal(personLanguage([{ role: "user", content: `make a note${rules}` }]), "en");
  const call = (name: string) => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c", type: "function", function: { name, arguments: "{}" } }],
  });
  const person = { role: "user", content: asked };
  const routes = new Set(["route_request"]);
  assert.equal(actedSincePerson([person], routes), false);
  assert.equal(actedSincePerson([person, call("route_request")], routes), false);
  assert.equal(actedSincePerson([call("app_x"), person], routes), false, "an earlier reply's");
  const carrier = { role: "user", content: [{ type: "text", content: screenshotsNote }] };
  assert.equal(
    actedSincePerson([person, call("computer_mouse"), { role: "tool" }, carrier], routes),
    true,
    "a screenshot carrier is not the person's words",
  );
});

// --- the wrapper, on scripted turns -------------------------------------------------------------

const started = { type: EventType.RUN_STARTED, runId: "r" };
const finished = (finishReason = "stop") => ({ type: EventType.RUN_FINISHED, finishReason });
function textTurn(pieces: string[], id = "m1") {
  let content = "";
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
    ...pieces.map((delta) => {
      content += delta;
      return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta, content };
    }),
    { type: EventType.TEXT_MESSAGE_END, messageId: id },
  ];
}
const callChunks = (name: string, id = "call-1") => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, toolName: name },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" },
  { type: EventType.TOOL_CALL_END, toolCallId: id, toolCallName: name, input: {} },
];
const turn = (...parts: unknown[][]) => parts.flat();

function fake(turns: unknown[][]) {
  let calls = 0;
  const options: { messages: { role: string; content: unknown }[] }[] = [];
  const inner = {
    name: "fake",
    calls: () => calls,
    chatStream: async function* (o: unknown) {
      options.push(o as (typeof options)[number]);
      const next = turns[Math.min(calls, turns.length - 1)] ?? [];
      calls++;
      yield* next;
    },
  };
  return { inner, options };
}
async function collect(stream: AsyncIterable<unknown>) {
  const out: { type: string; [key: string]: unknown }[] = [];
  for await (const chunk of stream) out.push(chunk as (typeof out)[number]);
  return out;
}
const words = (out: { type: string; delta?: unknown }[]) =>
  out
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((chunk) => String(chunk.delta))
    .join("");
const count = (out: { type: string }[], type: string) =>
  out.filter((chunk) => chunk.type === type).length;
const person = (content = asked) => ({ messages: [{ role: "user", content }] });

/** One text message per turn, closed right before the turn's end; `content` is the words so far. */
function wellFormed(out: { type: string; content?: unknown; delta?: unknown }[]) {
  assert.equal(count(out, EventType.RUN_STARTED), 1);
  assert.equal(count(out, EventType.RUN_FINISHED), 1);
  assert.equal(out.at(-1)?.type, EventType.RUN_FINISHED);
  const starts = count(out, EventType.TEXT_MESSAGE_START);
  assert.equal(starts, count(out, EventType.TEXT_MESSAGE_END));
  assert.ok(starts <= 1);
  if (starts) assert.equal(out.at(-2)?.type, EventType.TEXT_MESSAGE_END);
  let so = "";
  for (const chunk of out)
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      so += String(chunk.delta);
      assert.equal(chunk.content, so);
    }
}

test("slip 1: a call written as text is never shown; the turn asked again makes the call", async () => {
  const { inner, options } = fake([
    turn([started], textTurn(seedPieces), [finished()]),
    turn([started], callChunks("app_fakenotes__create_note"), [finished("tool_calls")]),
  ]);
  const said: string[] = [];
  const out = await collect(
    catchToolSlips(inner, { say: (line) => said.push(line) }).chatStream(person() as never),
  );
  assert.equal(words(out), "", "no markup reaches the person");
  assert.equal(count(out, EventType.TOOL_CALL_START), 1);
  assert.equal(out.at(-1)?.finishReason, "tool_calls");
  wellFormed(out);
  assert.equal(inner.calls(), 2);
  // Asked again with the note after the person's words; nothing was shown, so no words of its own.
  const again = options[1]?.messages ?? [];
  assert.deepEqual(again.slice(0, -1), person().messages);
  assert.match(
    String(again.at(-1)?.content),
    /wrote a tool call as text.*app_fakenotes__create_note/,
  );
  assert.doesNotMatch(String(again.at(-1)?.content), /<seed|<function/);
  assert.deepEqual(said, [
    "[model turn] tool call written as text (app_fakenotes__create_note): not shown; asked again",
  ]);
});

test("slip 1 twice: the turn ends with plain words that it was not done, in the person's language", async () => {
  for (const [said, language] of [
    [asked, "zh"],
    ["Make a note titled test, body hi. Just call it.", "en"],
  ] as const) {
    const { inner } = fake([turn([started], textTurn(seedPieces), [finished()])]);
    const out = await collect(
      catchToolSlips(inner, { say: () => {} }).chatStream(person(said) as never),
    );
    assert.equal(words(out), notDoneWords[language]);
    assert.equal(count(out, EventType.TOOL_CALL_START), 0);
    assert.equal(out.at(-1)?.finishReason, "stop");
    wellFormed(out);
    assert.equal(inner.calls(), 2, "asked again once, no more");
  }
});

test("words before the markup stay; the retry carries them and its words join after them", async () => {
  const { inner, options } = fake([
    turn([started], textTurn(["好的，我来创建。", ...seedPieces]), [finished()]),
    turn([started], textTurn(["现在真正创建。"], "m2"), callChunks("app_fakenotes__create_note"), [
      finished("tool_calls"),
    ]),
  ]);
  const out = await collect(catchToolSlips(inner, { say: () => {} }).chatStream(person() as never));
  assert.equal(words(out), "好的，我来创建。\n\n现在真正创建。");
  wellFormed(out);
  const again = options[1]?.messages ?? [];
  assert.deepEqual(again.at(-2), { role: "assistant", content: "好的，我来创建。" });
  // The retry's words went out under the turn's one message.
  assert.ok(out.every((chunk) => !("messageId" in chunk) || chunk.messageId === "m1"));
});

test("markup beside a real call is left out and nothing is asked again; markup in code is shown", async () => {
  const beside = fake([
    turn([started], textTurn(["ok", ...seedPieces]), callChunks("app_x"), [finished("tool_calls")]),
  ]);
  const out = await collect(
    catchToolSlips(beside.inner, { say: () => {} }).chatStream(person() as never),
  );
  assert.equal(words(out), "ok");
  assert.equal(beside.inner.calls(), 1);
  wellFormed(out);
  const shown = ["Here is the format:\n```\n", seedMarkup, "\n```"];
  const code = fake([turn([started], textTurn(shown), [finished()])]);
  const out2 = await collect(catchToolSlips(code.inner).chatStream(person() as never));
  assert.equal(words(out2), shown.join(""));
  assert.equal(code.inner.calls(), 1);
});

test("slip 2: words that say it was started, with no call, are asked again and the retry makes the call", async () => {
  const { inner, options } = fake([
    turn([started], textTurn([claim.slice(0, 12), claim.slice(12)]), [finished()]),
    turn([started], textTurn(["这次真正发起。"], "m2"), callChunks("app_fakerules__create_note"), [
      finished("tool_calls"),
    ]),
  ]);
  const said: string[] = [];
  const out = await collect(
    catchToolSlips(inner, { claims: true, say: (line) => said.push(line) }).chatStream(
      person() as never,
    ),
  );
  // Its words were shown as they came; the call follows them.
  assert.equal(words(out), `${claim}\n\n这次真正发起。`);
  assert.equal(count(out, EventType.TOOL_CALL_START), 1);
  assert.equal(out.at(-1)?.finishReason, "tool_calls");
  wellFormed(out);
  const again = options[1]?.messages ?? [];
  assert.deepEqual(again.slice(-2), [
    { role: "assistant", content: claim },
    { role: "user", content: claimNote },
  ]);
  assert.deepEqual(said, [
    "[model turn] said something was started with no tool called: asked again",
  ]);
});

test("slip 2 twice: the retry's words are dropped and one plain line says nothing was started", async () => {
  const { inner } = fake([
    turn([started], textTurn([claim]), [finished()]),
    turn([started], textTurn(["已发起，正在等待你的审核。"], "m2"), [finished()]),
  ]);
  const out = await collect(
    catchToolSlips(inner, { claims: true, say: () => {} }).chatStream(person() as never),
  );
  assert.equal(words(out), `${claim}\n\n${nothingStartedWords.zh}`);
  wellFormed(out);
  assert.equal(inner.calls(), 2);
});

test("slip 2 asked again: an answer of nothing (it spoke of an earlier card) adds nothing", async () => {
  const earlier = "上面那张卡片还在等待你的审核。";
  for (const answer of [[], ["OK"], ["好的。"]]) {
    const { inner } = fake([
      turn([started], textTurn([earlier]), [finished()]),
      turn([started], answer.length ? textTurn(answer, "m2") : [], [finished()]),
    ]);
    const out = await collect(
      catchToolSlips(inner, { claims: true, say: () => {} }).chatStream(person() as never),
    );
    assert.equal(words(out), earlier);
    wellFormed(out);
  }
});

test("slip 2 is not checked after an action in this reply, nor in a task run; the hall's routing is no action", async () => {
  // An earlier turn of the same reply called a tool: the words may be about it.
  const acted = fake([
    turn([started], callChunks("app_fakerules__create_note"), [finished("tool_calls")]),
    turn([started], textTurn([claim]), [finished()]),
  ]);
  const wrapped = catchToolSlips(acted.inner, { claims: true, say: () => {} });
  await collect(wrapped.chatStream(person() as never));
  assert.equal(words(await collect(wrapped.chatStream(person() as never))), claim);
  assert.equal(acted.inner.calls(), 2, "the second turn was not asked again");
  // The hall's routing first: still checked.
  const routed = fake([
    turn([started], callChunks("route_request"), [finished("tool_calls")]),
    turn([started], textTurn([claim]), [finished()]),
    turn([started], callChunks("app_fakerules__create_note", "call-2"), [finished("tool_calls")]),
  ]);
  const hall = catchToolSlips(routed.inner, { claims: true, say: () => {} });
  await collect(hall.chatStream(person() as never));
  const out = await collect(hall.chatStream(person() as never));
  assert.equal(count(out, EventType.TOOL_CALL_START), 1);
  assert.equal(routed.inner.calls(), 3);
  // A task run (claims off) passes such words on.
  const task = fake([turn([started], textTurn([claim]), [finished()])]);
  const out2 = await collect(
    catchToolSlips(task.inner, { say: () => {} }).chatStream(person() as never),
  );
  assert.equal(words(out2), claim);
  assert.equal(task.inner.calls(), 1);
});

test("an ordinary reply passes as it came, chunk for chunk", async () => {
  const pieces = ["你好！", "1 <", " 2 是对的。"];
  const { inner } = fake([turn([started], textTurn(pieces), [finished()])]);
  const out = await collect(catchToolSlips(inner, { claims: true }).chatStream(person() as never));
  assert.deepEqual(
    out.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT).map((c) => c.delta),
    ["你好！", "1 ", "< 2 是对的。"],
  );
  wellFormed(out);
  assert.equal(inner.calls(), 1);
});

test("an error ends the turn as it came, with the words so far closed", async () => {
  const { inner } = fake([
    turn([started], textTurn(["部分"]).slice(0, 2), [{ type: EventType.RUN_ERROR, message: "x" }]),
  ]);
  const out = await collect(catchToolSlips(inner).chatStream(person() as never));
  assert.deepEqual(
    out.map((chunk) => chunk.type),
    [
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_ERROR,
    ],
  );
});

// --- through the agent, on the Chat Completions route (the hosted config's) ---------------------

const runAgent = (agent: BuiltInAgent, content = asked) => {
  const input: RunAgentInput = {
    threadId: "slip-fixture",
    runId: "slip-fixture-run",
    messages: [{ id: "m1", role: "user", content }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  return new Promise<{ error?: string; text: string; calls: string[] }>((resolve) => {
    let error: string | undefined;
    let text = "";
    const calls: string[] = [];
    agent.run(input).subscribe({
      next: (event) => {
        if (event.type === EventType.TEXT_MESSAGE_CHUNK && "delta" in event)
          text += String(event.delta ?? "");
        if (event.type === EventType.TOOL_CALL_START && "toolCallName" in event)
          calls.push(String(event.toolCallName));
        if (event.type === EventType.RUN_ERROR && "message" in event) error = String(event.message);
      },
      error: (cause) => resolve({ error: error ?? String(cause), text, calls }),
      complete: () => resolve({ error, text, calls }),
    });
  });
};
function chatCompletionsRoute(t: { after: (fn: () => void) => void }) {
  const previous = process.env.OPENAI_CHAT_COMPLETIONS;
  process.env.OPENAI_CHAT_COMPLETIONS = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_CHAT_COMPLETIONS;
    else process.env.OPENAI_CHAT_COMPLETIONS = previous;
  });
}
function notesAgent(ran: unknown[], checkClaims?: boolean) {
  return tanstackAgent({
    model: "openai/fixture",
    maxSteps: 4,
    checkClaims,
    tools: [
      defineTool({
        name: "app_fakenotes__create_note",
        description: "Create a note",
        parameters: z.object({ title: z.string(), body: z.string() }),
        execute: async (args) => {
          ran.push(args);
          return {
            status: "awaiting_review",
            detail: "The call is waiting for the person's review.",
          };
        },
      }),
    ],
    prompt: "Create notes when asked.",
  });
}
const note = {
  name: "app_fakenotes__create_note",
  arguments: { title: "验收-011910-b", body: "hi" },
};

test("through the agent: the markup the model wrote is not in the reply, and the retry's call runs", async (t) => {
  chatCompletionsRoute(t);
  const { requests } = await chatCompletionsFixture(t, (index) =>
    index === 0 ? { text: seedMarkup, pieces: seedPieces } : index === 1 ? note : undefined,
  );
  const ran: unknown[] = [];
  const outcome = await runAgent(notesAgent(ran, true));
  assert.equal(outcome.error, undefined);
  assert.doesNotMatch(outcome.text, /seed:tool_call|<function|<parameter/);
  assert.deepEqual(outcome.calls, ["app_fakenotes__create_note"]);
  assert.deepEqual(ran, [{ title: "验收-011910-b", body: "hi" }], "the tool ran once");
  assert.match(requests[1]?.body ?? "", /wrote a tool call as text/);
  assert.equal(requests.length, 3, "slip, retry with the call, the reply after the result");
});

test("through the agent: markup twice ends the reply saying it was not done, and nothing ran", async (t) => {
  chatCompletionsRoute(t);
  const { requests } = await chatCompletionsFixture(t, () => ({
    text: seedMarkup,
    pieces: seedPieces,
  }));
  const ran: unknown[] = [];
  const outcome = await runAgent(notesAgent(ran, true));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.text, notDoneWords.zh);
  assert.deepEqual(ran, []);
  assert.equal(requests.length, 2);
});

test("through the agent: words that it was started, with no call, get the call made on the retry", async (t) => {
  chatCompletionsRoute(t);
  const { requests } = await chatCompletionsFixture(t, (index) =>
    index === 0 || index === 3 ? { text: claim } : index === 1 ? note : undefined,
  );
  const ran: unknown[] = [];
  const outcome = await runAgent(notesAgent(ran, true));
  assert.equal(outcome.error, undefined);
  assert.ok(outcome.text.startsWith(claim));
  assert.deepEqual(ran, [{ title: "验收-011910-b", body: "hi" }]);
  assert.ok((requests[1]?.body ?? "").includes(JSON.stringify(claimNote).slice(1, -1)));
  // A task run does not check such words.
  const quiet: unknown[] = [];
  const before = requests.length;
  const task = await runAgent(notesAgent(quiet, false));
  assert.equal(task.text, claim);
  assert.equal(requests.length - before, 1);
});
