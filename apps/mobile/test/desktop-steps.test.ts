// A reply's consecutive desktop steps are one
// block in the conversation (shell/chat/core.ts `desktopFold`): each step in plain words, the
// block's line while it works and once the reply ended, and the calls the runtime refused
// (the model's arguments did not fit the tool) left out of the conversation altogether.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantSays,
  desktopFold,
  desktopRunView,
  desktopStepOf,
  withoutRejectedCalls,
} from "../../../packages/client/src/shell/chat/core.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import { toolInputRejected } from "../../../packages/domain/src/agent.ts";

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const shot = (receiptId: string, who = "Nova_Harrison") =>
  JSON.stringify({
    status: "succeeded",
    action: "desktop screenshot (0, 0) down 3",
    receiptId,
    environment: { id: "env-1", name: who },
  });
const rejected = JSON.stringify({
  error:
    'Input validation failed for tool use_desktop: Validation failed: Invalid option: expected one of "up"|"down"|"left"|"right"',
});

// ───────────────────────────── steps ─────────────────────────────

test("a desktop step reads in plain words, never the receipt's command line", () => {
  const screenshot = desktopStepOf(call("d1", "use_desktop", { action: "screenshot" }), shot("r1"));
  assert.deepEqual(screenshot, {
    id: "d1",
    kind: "screenshot",
    words: "看一眼屏幕",
    done: true,
    failed: false,
    receiptId: "r1",
    who: "Nova_Harrison",
  });
  const words = (args: unknown) => desktopStepOf(call("d", "use_desktop", args), undefined)?.words;
  assert.equal(words({ action: "left_click", coordinate: [640, 400] }), "点击");
  assert.equal(words({ action: "double_click" }), "双击");
  assert.equal(words({ action: "right_click" }), "右键点击");
  assert.equal(words({ action: "mouse_move", coordinate: [1, 2] }), "移动鼠标");
  // Key names are safe to show; typed text never is (it may be a password).
  assert.equal(words({ action: "key", text: "ctrl+l" }), "按 ctrl+l");
  assert.equal(words({ action: "type", text: "hunter2" }), "输入文字");
  assert.equal(words({ action: "scroll", scroll_direction: "down", scroll_amount: 3 }), "向下滚动");
  assert.equal(words({ action: "scroll", scroll_direction: "sideways" }), "滚动页面");
  assert.equal(words({ action: "wait", duration: 2 }), "等一下");
  assert.equal(words({ action: "send" }), "发送");
  assert.equal(words({ action: "click_control", name: "回复" }), "点「回复」");
  assert.equal(words({ action: "click_control" }), "点控件");
  // The action not known yet (arguments still streaming) or unknown: a desktop step all the same.
  assert.equal(words('{"act'), "桌面操作");
  assert.equal(words({ action: "drag" }), "桌面操作");
  for (const step of Object.values(t.desktop.steps)) assert.doesNotMatch(step, /desktop|\(0, 0\)/);
});

test("the desktop browser opened from a command is a step; other commands and tools are not", () => {
  const command = (text: string) =>
    desktopStepOf(
      call("c", "run_computer_command", { command: text, operationId: "o" }),
      undefined,
    );
  assert.equal(
    command("openmuse-browser https://example.com/post/1 >/dev/null 2>&1 &")?.kind,
    "open_page",
  );
  assert.equal(command("  openmuse-browser page")?.kind, "pages");
  assert.equal(command("openmuse-browser page")?.words, "看打开的网页");
  assert.equal(command("ls /workspace"), null);
  assert.equal(desktopStepOf(call("s", "search_web", { query: "x" }), undefined), null);
  assert.equal(desktopStepOf({ function: { name: "use_desktop" } }, undefined), null);
});

test("a step's result says whether it is done, failed, and which desktop it was", () => {
  const running = desktopStepOf(call("d1", "use_desktop", { action: "screenshot" }), undefined);
  assert.deepEqual(
    [running?.done, running?.failed, running?.receiptId, running?.who],
    [false, false, null, null],
  );
  const failed = desktopStepOf(
    call("d2", "use_desktop", { action: "left_click" }),
    JSON.stringify({ error: "Start the computer first" }),
  );
  assert.deepEqual([failed?.done, failed?.failed, failed?.receiptId], [true, true, null]);
  const object = desktopStepOf(call("d3", "use_desktop", { action: "wait" }), { receiptId: "r3" });
  assert.deepEqual([object?.done, object?.receiptId, object?.who], [true, "r3", null]);
});

// ───────────────────────────── fold ─────────────────────────────

const transcript = [
  { id: "u1", role: "user", content: "看看 Nova 的桌面" },
  { id: "a1", role: "assistant", content: "好，我看一下。" },
  { id: "a2", role: "assistant", toolCalls: [call("d1", "use_desktop", { action: "screenshot" })] },
  { id: "t1", role: "tool", toolCallId: "d1", content: shot("r1") },
  { id: "a3", role: "assistant", content: "打开帖子。" },
  {
    id: "a4",
    role: "assistant",
    toolCalls: [
      call("c1", "run_computer_command", { command: "openmuse-browser https://x.test/p/1" }),
      call("d2", "use_desktop", { action: "left_click", coordinate: [10, 20] }),
    ],
  },
  { id: "t2", role: "tool", toolCallId: "c1", content: JSON.stringify({ status: "succeeded" }) },
  { id: "t3", role: "tool", toolCallId: "d2", content: shot("r2") },
  // Another card between steps stays in place; the run goes on past it.
  { id: "a5", role: "assistant", toolCalls: [call("s1", "search_web", { query: "q" })] },
  { id: "t4", role: "tool", toolCallId: "s1", content: "{}" },
  {
    id: "a6",
    role: "assistant",
    toolCalls: [call("d3", "use_desktop", { action: "key", text: "Return" })],
  },
  {
    id: "t5",
    role: "tool",
    toolCallId: "d3",
    content: JSON.stringify({ error: "Start the computer" }),
  },
  // The person's message ends the reply.
  { id: "u2", role: "user", content: "继续" },
  {
    id: "a7",
    role: "assistant",
    toolCalls: [call("d4", "use_desktop", { action: "scroll", scroll_direction: "down" })],
  },
];

test("all desktop steps of one reply fold into one run, drawn at the first step", () => {
  const fold = desktopFold(transcript);
  const first = fold.get("d1");
  assert.ok(first);
  // A sentence or a search between steps cut one reply's operation into
  // several blocks. Neither ends the run: search_web is not a step, and the step after it is
  // still this run's.
  assert.deepEqual(
    first.steps.map((step) => step.id),
    ["d1", "c1", "d2", "d3"],
  );
  assert.equal(first.at, "d1");
  for (const id of ["c1", "d2", "d3"]) assert.equal(fold.get(id), first);
  assert.equal(fold.get("s1"), undefined);
  // Only the step the block is drawn at draws; the others draw nothing.
  assert.equal([...new Set(fold.values())].filter((run) => run.at !== "d1").length, 1);
  // The person's message ends the reply: the next step is a new run, the newest.
  const second = fold.get("d4");
  assert.ok(second && second !== first);
  assert.deepEqual([second.at, first.newest, second.newest], ["d4", false, true]);
  assert.equal(desktopFold([]).size, 0);
  assert.equal(desktopFold([null, 3, { role: "assistant", toolCalls: "x" }]).size, 0);
});

test("the block's line: live while the reply still adds to it, one line once it ended", () => {
  const fold = desktopFold(transcript);
  const first = fold.get("d1");
  const second = fold.get("d4");
  assert.ok(first && second);
  // The newest run, while the reply runs: the account from the steps' results, the step count,
  // the current action; the latest shot of the run.
  assert.deepEqual(desktopRunView(second, true, "Nova_Harrison"), {
    line: "正在 Nova_Harrison 的桌面上操作 · 第 1 步 · 向下滚动",
    live: true,
    count: 1,
    failed: 0,
    receiptId: null,
    who: "Nova_Harrison",
  });
  // Once no reply runs, a step left without its result is finished, not
  // live: it ended without succeeding.
  assert.equal(desktopRunView(second, false).live, false);
  assert.equal(desktopRunView(second, false).line, "在桌面上做了 1 步 · 1 步没成功");
  // An older run, or the newest once the reply ended: one line (the failed step counted), its
  // latest shot kept.
  assert.deepEqual(desktopRunView(first, true), {
    line: "在桌面上做了 4 步 · 1 步没成功",
    live: false,
    count: 4,
    failed: 1,
    receiptId: "r2",
    who: "Nova_Harrison",
  });
  const done = desktopFold(transcript.slice(0, 8));
  const only = done.get("d2");
  assert.ok(only?.newest);
  assert.equal(desktopRunView(only, true).live, true);
  assert.equal(desktopRunView(only, false).line, "在桌面上做了 3 步");
});

// ───────────────────────────── refused calls ─────────────────────────────

test("a call the runtime refused is not shown; the model's retry is", () => {
  assert.equal(toolInputRejected(rejected), true);
  assert.equal(toolInputRejected(JSON.parse(rejected)), true);
  assert.equal(
    toolInputRejected("Error executing tool: Input validation failed for tool use_desktop: x"),
    true,
  );
  assert.equal(toolInputRejected(JSON.stringify({ error: "Start the computer first" })), false);
  assert.equal(toolInputRejected(shot("r1")), false);
  assert.equal(toolInputRejected(undefined), false);
  assert.equal(toolInputRejected("not json"), false);
  const results = new Map<string, unknown>([
    ["d1", rejected],
    ["d2", shot("r2")],
    ["d3", JSON.stringify({ error: "Start the computer first" })],
  ]);
  const resultOf = (id: string) => results.get(id);
  const message = {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      call("d1", "use_desktop", { action: "screenshot", scroll_direction: "" }),
      call("d2", "use_desktop", { action: "screenshot" }),
      call("d3", "use_desktop", { action: "left_click" }),
    ],
  };
  const shown = withoutRejectedCalls(message, resultOf);
  assert.deepEqual(
    shown.toolCalls.map((item) => item.id),
    ["d2", "d3"],
  );
  assert.equal(message.toolCalls.length, 3);
  // A reply that was only a refused call is silent; a call still running is kept.
  const only = withoutRejectedCalls({ ...message, toolCalls: [message.toolCalls[0]] }, resultOf);
  assert.equal(assistantSays(only), false);
  const running = { ...message, toolCalls: [call("d9", "use_desktop", { action: "wait" })] };
  assert.equal(withoutRejectedCalls(running, resultOf), running);
  const user = { id: "u1", role: "user", content: "好" };
  assert.equal(withoutRejectedCalls(user, resultOf), user);
  // Folded after that, the refused call is not a step of the run.
  const fold = desktopFold([
    { id: "u1", role: "user", content: "看看" },
    shown,
    { id: "t1", role: "tool", toolCallId: "d2", content: results.get("d2") },
    { id: "t2", role: "tool", toolCallId: "d3", content: results.get("d3") },
  ]);
  assert.equal(fold.get("d1"), undefined);
  assert.equal(fold.get("d2")?.steps.length, 2);
});

test("a refused reply's block reads finished once the reply ended, and through the next reply", () => {
  const held = JSON.stringify({
    error: "她的桌面正被「登录 example.com」用着，等它结束再来. Say exactly this sentence.",
  });
  const refused = [
    { id: "u1", role: "user", content: "去看看" },
    {
      id: "a1",
      role: "assistant",
      toolCalls: [call("d1", "use_desktop", { action: "screenshot" })],
    },
    { id: "t1", role: "tool", toolCallId: "d1", content: held },
    { id: "a2", role: "assistant", content: "她的桌面正被「登录 example.com」用着，等它结束再来" },
  ];
  const run = desktopFold(refused).get("d1");
  assert.ok(run?.newest);
  assert.deepEqual(desktopRunView(run, false, "Alice"), {
    line: "在桌面上做了 1 步 · 1 步没成功",
    live: false,
    count: 1,
    failed: 1,
    receiptId: null,
    who: "Alice",
  });
  // The person speaks again: the reply running now is a later one; the old block stays finished.
  const next = desktopFold([...refused, { id: "u2", role: "user", content: "好了吗" }]).get("d1");
  assert.ok(next && !next.newest);
  assert.equal(desktopRunView(next, true, "Alice").live, false);
  // A refusal whose result never reached the transcript ends the same way once the reply ended.
  const lost = desktopFold([refused[0], refused[1], refused[3]]).get("d1");
  assert.ok(lost);
  assert.equal(desktopRunView(lost, true).live, true);
  assert.equal(desktopRunView(lost, false).line, "在桌面上做了 1 步 · 1 步没成功");
});
