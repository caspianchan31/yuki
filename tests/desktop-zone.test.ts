// v1.5.1: the members' computer showed UTC on its clock whatever 设置 → 时区 said. The desktop now
// starts in the account time zone of the owner who starts it or used the computer last
// (desktop-computer.ts); the computer checks the name before it uses it (desktopd.py's valid_zone).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopComputer } from "../apps/server/src/desktop-computer.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

test("the desktop starts in the account's time zone of whoever uses the computer", async () => {
  const agent = new FakeAgent();
  const zones = new Map<string, string>([["owner", "Asia/Shanghai"]]);
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    sweepMs: null,
    zone: async (owner) => zones.get(owner) ?? null,
  });
  // Nobody has used it yet: it starts as before, in the computer's own zone.
  await computer.start();
  assert.deepEqual(agent.starts.at(-1), {});
  await computer.stop();
  // The person opened 设置 → 电脑 (a snapshot) and the computer paused since: the next start, by a
  // member's tool with no owner of its own, runs in that person's zone.
  await computer.snapshot("owner");
  await computer.start();
  assert.deepEqual(agent.starts.at(-1), { timezone: "Asia/Shanghai" });
  await computer.stop();
  // Started by someone with no zone set: no zone is sent.
  await computer.start("someone-else");
  assert.deepEqual(agent.starts.at(-1), {});
});

test("a zone that cannot be read leaves the start as it was", async () => {
  const agent = new FakeAgent();
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    sweepMs: null,
    zone: async () => {
      throw new Error("settings unavailable");
    },
  });
  await computer.start("owner");
  assert.deepEqual(agent.starts.at(-1), {});
  assert.equal(agent.running, true);
});
