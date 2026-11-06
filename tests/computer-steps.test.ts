// v1.5.1: a reply's folded 过程 shows each step on the members' computer as one line
// (packages/client/src/shell/chat/computer-steps.ts). Before, the computer's tools had no card in
// the chat, so 「过程 · N 步」 opened on nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopComputer } from "../apps/server/src/desktop-computer.ts";
import { desktopTools } from "../apps/server/src/desktop-tools.ts";
import {
  computerStepFailed,
  computerStepText,
  computerStepTools,
} from "../packages/client/src/shell/chat/computer-steps.ts";
import { isResultTool } from "../packages/client/src/shell/chat/reply-core.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

test("every tool of the members' computer shows in the chat: the screenshot as its card, every other as a line", async () => {
  const computer = new DesktopComputer(
    await createStore(),
    desktopConfig,
    new FakeAgent().asAgent(),
    {
      sweepMs: null,
    },
  );
  const names = desktopTools(computer, { scope: "chat:t1", owner: () => "owner" }).map(
    (tool) => tool.name,
  );
  const lines = new Set<string>([
    ...computerStepTools.map((tool) => tool.name),
    "run_computer_command",
  ]);
  for (const name of names) {
    if (isResultTool(name)) assert.equal(name, "computer_screenshot", name);
    else assert.ok(lines.has(name), `${name} has no line in the chat's 过程`);
  }
});

test("a step's line says what the member did, in plain words", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["computer_status", {}, "看了电脑的状态"],
    ["start_computer", {}, "打开了电脑"],
    [
      "run_computer_command",
      { command: "cat /workspace/todo.txt" },
      "在电脑里运行 cat /workspace/todo.txt",
    ],
    ["list_computer_files", {}, "看了 /workspace 里有哪些文件"],
    ["read_computer_file", { path: "/workspace/购物清单.txt" }, "读了 /workspace/购物清单.txt"],
    ["write_computer_file", { path: "notes.md" }, "写了 notes.md"],
    [
      "computer_browser",
      { action: "open", url: "https://example.com" },
      "在浏览器里打开 https://example.com",
    ],
    [
      "computer_browser",
      { action: "click", text: "More information" },
      "在网页上点了「More information」",
    ],
    [
      "computer_desktop",
      { action: "open", app: "editor", path: "/workspace/todo.txt" },
      "用文本编辑器打开 /workspace/todo.txt",
    ],
    ["computer_desktop", { action: "open", app: "files" }, "打开了文件管理器"],
    ["computer_desktop", { action: "look", app: "mousepad" }, "看了「mousepad」的界面"],
    ["computer_desktop", { action: "click", snapshot: "s2", n: 3 }, "在软件里点了第 3 项"],
    [
      "computer_desktop",
      { action: "type", snapshot: "s2", n: 7, text: "买牛奶" },
      "在软件里输入「买牛奶」",
    ],
    ["computer_desktop", { action: "press", key: "ctrl+s" }, "按了 ctrl+s"],
    ["computer_desktop", { action: "dance" }, "在电脑上做了一步"],
  ];
  for (const [name, args, line] of cases) assert.equal(computerStepText(name, args), line, name);
  // Long text stays on one short line.
  const typed = computerStepText("computer_desktop", {
    action: "type",
    text: `${"字".repeat(80)}\n第二行`,
  });
  assert.ok(typed.length < 60 && !typed.includes("\n"), typed);
});

test("a step that did not work says so", () => {
  assert.equal(computerStepFailed({ error: "The person is driving the computer" }), true);
  assert.equal(computerStepFailed({ failure: "That number is gone; look again" }), true);
  for (const status of ["failed", "timed_out", "interrupted"])
    assert.equal(computerStepFailed({ status }), true, status);
  assert.equal(computerStepFailed({ status: "succeeded", stdout: "ok" }), false);
  assert.equal(computerStepFailed({ snapshot: "s3", elements: [] }), false);
  assert.equal(computerStepFailed(undefined), false);
});
