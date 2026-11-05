// The desktop panel's pure rules — when 重建桌面 is offered, where the
// control calls go (scoped to an account's desktop), what the status line says after a rebuild,
// and the refusal while a run holds the desktop, in the owner's words.
import assert from "node:assert/strict";
import test from "node:test";
import {
  controlPath,
  desktopExists,
  workspaceStatusText,
} from "../../../packages/client/src/computer-workspace-core.ts";
import { scopeComputerPath } from "../../../packages/client/src/environments.ts";
import { serverText, t } from "../../../packages/client/src/shell/strings.ts";
import type { ComputerSnapshot } from "../../../packages/domain/src/computer.ts";

const snapshot = (over: Partial<ComputerSnapshot> = {}): ComputerSnapshot => ({
  enabled: true,
  provider: "desktop",
  status: "stopped",
  workspacePath: "/workspace",
  network: "enabled",
  commands: [],
  ...over,
});

test("重建桌面 is offered only for a desktop that exists", () => {
  assert.equal(desktopExists(undefined), false);
  assert.equal(desktopExists(snapshot({ status: "running", created: true })), true);
  assert.equal(desktopExists(snapshot({ status: "stopped", created: true })), true);
  // Never created (or just destroyed): nothing to rebuild until the next start.
  assert.equal(desktopExists(snapshot({ status: "stopped", created: false })), false);
  assert.equal(desktopExists(snapshot({ status: "running", created: false })), false);
  // An older server says nothing about creation: its status decides.
  assert.equal(desktopExists(snapshot({ status: "stopped" })), true);
  assert.equal(desktopExists(snapshot({ status: "unconfigured", created: true })), false);
  assert.equal(desktopExists(snapshot({ status: "error", created: true })), false);
  assert.equal(desktopExists(snapshot({ enabled: false, created: true })), false);
});

test("the confirm posts to the destroy path, scoped to the account's desktop", () => {
  assert.equal(controlPath("destroy"), "/api/computer/destroy");
  assert.equal(controlPath("start"), "/api/computer/start");
  assert.equal(controlPath("stop"), "/api/computer/stop");
  assert.equal(
    scopeComputerPath(controlPath("destroy"), "env-1"),
    "/api/environments/env-1/computer/destroy",
  );
});

test("after a rebuild the status line says the desktop is not created yet", () => {
  assert.equal(
    workspaceStatusText(snapshot({ status: "stopped", created: false })),
    t.computer.notCreated,
  );
  assert.equal(
    workspaceStatusText(snapshot({ status: "stopped", created: true })),
    t.computer.stopped,
  );
  assert.equal(workspaceStatusText(snapshot({ status: "stopped" })), t.computer.stopped);
  assert.equal(
    workspaceStatusText(snapshot({ status: "running", created: true })),
    t.computer.running,
  );
  assert.match(t.computer.notCreated, /启动/);
});

test("a rebuild refused while a run holds the desktop reads in plain words", () => {
  assert.equal(
    serverText("Desktop in use by 发一帖：离线可玩的小游戏"),
    "桌面正被「发一帖：离线可玩的小游戏」用着，等它空出来再试。",
  );
  assert.equal(
    serverText("Desktop in use by task 12"),
    "桌面正被「task 12」用着，等它空出来再试。",
  );
});

test("the rebuild strings are Chinese and name what happens", () => {
  const c = t.computer;
  for (const text of [c.rebuild, c.rebuildConfirm, c.rebuildNow, c.notCreated])
    assert.doesNotMatch(text, /[A-Za-z]{2,}/, text);
  assert.match(c.rebuildConfirm, /登录/);
  assert.match(c.rebuildConfirm, /时区/);
  assert.match(c.rebuildConfirm, /模板/);
});
