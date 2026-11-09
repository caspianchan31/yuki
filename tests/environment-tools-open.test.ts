import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopHeldError, type DesktopHold } from "../apps/server/src/computer.ts";

const ownerHolder = "owner";

import {
  ChatEnvironment,
  chatHoldTitle,
  desktopHeldReply,
  desktopOwnerReply,
} from "../apps/server/src/environment-tools.ts";

/** The hold of ComputerService (computer.ts) on one desktop, in memory: another holder's
 * unexpired hold refuses, one's own renews, a released or expired one is free. */
function fakeComputer() {
  let hold: DesktopHold | null = null;
  return {
    hold: async (
      _owner: string,
      holder: string,
      title: string,
      options: { over?: boolean } = {},
    ) => {
      if (hold && hold.holder !== holder && !options.over && Date.parse(hold.until) > Date.now())
        throw new DesktopHeldError(hold);
      hold = { id: "hold", holder, title, until: new Date(Date.now() + 600_000).toISOString() };
    },
    releaseHold: async (_owner: string, holder: string) => {
      if (hold?.holder === holder) hold = null;
    },
    current: () => hold,
    container: undefined,
  };
}
const environments = {} as ConstructorParameters<typeof ChatEnvironment>[0];

test("v1.7 抢电脑的规则 (open build): a reply holds the shared computer as a task does, and lets go at its end", async () => {
  const computer = fakeComputer();
  const chat = new ChatEnvironment(environments, computer as never, "owner", "thread-1");
  await chat.take("owner");
  assert.deepEqual(
    { holder: computer.current()?.holder, title: computer.current()?.title },
    { holder: "thread:thread-1", title: chatHoldTitle },
  );
  await chat.take("owner"); // renews, no refusal
  await chat.session.release();
  assert.equal(computer.current(), null);
});

test("another run's hold: the one-sentence refusal at once, or the wait when one is set; the owner's turn never waits", async () => {
  const computer = fakeComputer();
  await computer.hold("owner", "task:t1", "登录 example.com");
  const atOnce = new ChatEnvironment(environments, computer as never, "owner", "thread-2");
  await assert.rejects(atOnce.take("owner"), (error: Error) =>
    error.message.startsWith(desktopHeldReply("登录 example.com")),
  );
  // waiting: released after 500 ms, taken within the 2.5 s allowed
  const waiting = new ChatEnvironment(environments, computer as never, "owner", "thread-3", {
    waitMs: 2500,
  });
  setTimeout(() => void computer.releaseHold("owner", "task:t1"), 500);
  const t0 = Date.now();
  await waiting.take("owner");
  assert.ok(Date.now() - t0 >= 400 && Date.now() - t0 < 2500);
  assert.equal(computer.current()?.holder, "thread:thread-3");
  await waiting.session.release();
  // kept the whole time: refused after the wait, saying how long
  await computer.hold("owner", "task:t2", "填表");
  const still = new ChatEnvironment(environments, computer as never, "owner", "thread-4", {
    waitMs: 1000,
  });
  const t1 = Date.now();
  await assert.rejects(
    still.take("owner"),
    (error: Error) =>
      error.message.startsWith(desktopHeldReply("填表")) && /已等了 1 秒/.test(error.message),
  );
  assert.ok(Date.now() - t1 >= 900);
  // the owner's own turn: at once, whatever the wait
  await computer.hold("owner", ownerHolder, "你在登录", { over: true });
  const t2 = Date.now();
  await assert.rejects(still.take("owner"), (error: Error) =>
    error.message.startsWith(desktopOwnerReply("你在登录")),
  );
  assert.ok(Date.now() - t2 < 300);
});

test("before() holds nothing on a server without a computer", async () => {
  const computer = fakeComputer();
  const chat = new ChatEnvironment(environments, computer as never, "owner", "thread-5");
  await chat.before();
  assert.equal(computer.current(), null);
});
