import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  DesktopHeldError,
  DesktopSession,
  type ComputerService as OpenComputerService,
} from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

// The open build's hold on its one shared computer (computer.open.ts), on a real store: the
// methods only touch `db`, so a bare object with the prototype's methods is enough.
let db: Store;
let directory: string;
let computer: Pick<OpenComputerService, "hold" | "releaseHold" | "holdOf">;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "yuki-open-hold-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const { ComputerService } = await import("../apps/server/src/computer.ts");
  const bare = Object.create(ComputerService.prototype) as OpenComputerService & { db: Store };
  Object.defineProperty(bare, "db", { value: db });
  computer = bare;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("v1.7 抢电脑的规则 (open build): one driver at a time on the shared computer, whatever the owner key", async () => {
  await computer.hold("space:p1", "task:t1", "登录 example.com");
  assert.equal((await computer.holdOf("space"))?.holder, "task:t1");
  // another run, even under another owner key (the hall's chat): refused with the title
  await assert.rejects(
    computer.hold("space", "thread:th1", "对话"),
    (error: Error) => error instanceof DesktopHeldError && error.hold.title === "登录 example.com",
  );
  // the same run renews freely; release frees it; the next run takes it
  await computer.hold("space:p1", "task:t1", "登录 example.com");
  await computer.releaseHold("space:p1", "task:t1");
  assert.equal(await computer.holdOf("space"), null);
  await computer.hold("space", "thread:th1", "对话");
  assert.equal((await computer.holdOf("space:p1"))?.holder, "thread:th1");
  // another run's release leaves it alone; `over` takes it anyway
  await computer.releaseHold("space", "task:t9");
  assert.equal((await computer.holdOf("space"))?.holder, "thread:th1");
  await computer.hold("space", "owner", "你在登录", { over: true });
  assert.equal((await computer.holdOf("space"))?.holder, "owner");
  await computer.releaseHold("space", "owner");
});

test("a DesktopSession takes it for its run and lets go at the end", async () => {
  const session = new DesktopSession(computer, "thread:th2", "对话");
  await session.take("space");
  assert.equal((await computer.holdOf("space"))?.holder, "thread:th2");
  const other = new DesktopSession(computer, "task:t3", "填表");
  await assert.rejects(other.take("space"), DesktopHeldError);
  await session.release();
  assert.equal(await computer.holdOf("space"), null);
  await other.take("space");
  await other.release();
  assert.equal(await computer.holdOf("space"), null);
});
