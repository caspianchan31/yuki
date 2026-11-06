// The members' computer as the open service drives it (apps/server/src/desktop-computer.ts):
// the live view's one-time ticket and who it lets drive, the idle pause and its resume, and the
// receipts of commands (every command leaves one; the same operation never runs twice).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import {
  DesktopComputer,
  desktopOf,
  personDrivesNote,
  workspacePath,
} from "../apps/server/src/desktop-computer.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

async function setup(options: { idleMs?: number } = {}) {
  const agent = new FakeAgent();
  let now = 1_000_000;
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    now: () => now,
    idleMs: options.idleMs ?? 15 * 60_000,
    sweepMs: null,
  });
  return {
    agent,
    computer,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const ticketOf = (url: string) => url.match(/\/api\/computer\/live\/([A-Za-z0-9_-]+)\//)?.[1] ?? "";

test("the live view needs a running computer, and its address carries a ticket the owner got", async () => {
  const { agent, computer } = await setup();
  await assert.rejects(
    () => computer.liveView("owner"),
    (error: AppError) => error.status === 409,
  );
  agent.running = true;
  const view = await computer.liveView("owner");
  assert.equal(view.control, "member");
  const ticket = ticketOf(view.url);
  assert.ok(ticket.length >= 20, "a long ticket");
  assert.equal(computer.liveOwner(ticket), "owner");
  assert.equal(computer.liveOwner(`${ticket}x`), null);
  assert.equal(computer.liveOwner("short"), null);
  const url = new URL(view.url);
  assert.equal(url.origin, "http://localhost:8787");
  // The service's own viewer page; its starter finds the websocket next to it.
  assert.equal(url.pathname, `/api/computer/live/${ticket}/view.html`);
  assert.equal(url.searchParams.get("view_only"), "1");
});

test("a ticket is the same while it holds, another owner gets another, and it expires", async () => {
  const { agent, computer, advance } = await setup();
  agent.running = true;
  const first = ticketOf((await computer.liveView("a")).url);
  assert.equal(ticketOf((await computer.liveView("a")).url), first);
  const other = ticketOf((await computer.liveView("b")).url);
  assert.notEqual(other, first);
  assert.equal(computer.liveOwner(other), "b");
  advance(31 * 60_000);
  assert.equal(computer.liveOwner(first), null);
  assert.equal(computer.liveOwner(other), null);
  const renewed = ticketOf((await computer.liveView("a")).url);
  assert.notEqual(renewed, first);
});

test("the view is read-only until the person takes over; the websocket goes to the matching server", async () => {
  const { agent, computer } = await setup();
  agent.running = true;
  const ticket = ticketOf((await computer.liveView("owner")).url);
  const watching = await computer.liveTarget(ticket);
  assert.deepEqual(
    [watching?.driver, watching?.token, watching?.host, watching?.port],
    ["member", agent.live.view, "computer", 6080],
  );
  const driving = await computer.setControl("owner", { by: "person" });
  assert.equal(driving.control, "person");
  assert.equal(new URL(driving.url).searchParams.get("view_only"), "0");
  assert.equal(ticketOf(driving.url), ticket, "the same ticket: the frame is not reloaded for it");
  assert.equal((await computer.liveTarget(ticket))?.token, agent.live.control);
  await computer.setControl("owner", { by: "member" });
  assert.equal((await computer.liveTarget(ticket))?.token, agent.live.view);
  assert.equal(await computer.liveTarget("nonsense-nonsense-nonsense"), null);
});

test("taking over needs a running computer and a well-formed request; it closes open frames", async () => {
  const { agent, computer } = await setup();
  await assert.rejects(
    () => computer.setControl("owner", { by: "person" }),
    (error: AppError) => error.status === 409,
  );
  agent.running = true;
  await assert.rejects(() => computer.setControl("owner", { by: "root" }));
  await assert.rejects(() => computer.setControl("owner", { by: "person", extra: 1 }));
  let closed = 0;
  computer.holdSocket({ driver: "member", close: () => closed++ });
  await computer.setControl("owner", { by: "person" });
  assert.equal(closed, 1, "the frame reconnects with the other server");
  await computer.setControl("owner", { by: "person" });
  assert.equal(closed, 1, "nothing changed, nothing closed");
});

test("while the person drives, a member's browser step is refused with the reason", async () => {
  const { agent, computer } = await setup();
  agent.running = true;
  await computer.setControl("owner", { by: "person" });
  await assert.rejects(
    () => computer.browse({ action: "read" }),
    (error: AppError) => error.status === 409 && error.message === personDrivesNote,
  );
  assert.deepEqual(agent.browserActions, []);
  await computer.setControl("owner", { by: "member" });
  assert.equal((await computer.browse({ action: "read" })).title, "Example");
});

test("an idle computer pauses after its limit, keeps awake while used, and starts again on use", async () => {
  const { agent, computer, advance } = await setup({ idleMs: 10 * 60_000 });
  await computer.execute("owner", { command: "echo ok" });
  assert.equal(agent.running, true);
  advance(9 * 60_000);
  assert.equal(await computer.pauseIfIdle(), false, "not yet");
  computer.touch();
  advance(9 * 60_000);
  assert.equal(await computer.pauseIfIdle(), false, "use restarted the wait");
  advance(2 * 60_000);
  assert.equal(await computer.pauseIfIdle(), true);
  assert.equal(agent.running, false);
  assert.equal(await computer.pauseIfIdle(), false, "already paused: nothing to stop");
  assert.equal(agent.calls.filter((call) => call === "stop").length, 1);
  // The next use brings it back by itself.
  const again = await computer.execute("owner", { command: "echo back" });
  assert.equal(again.status, "succeeded");
  assert.equal(agent.running, true);
  assert.equal(agent.calls.filter((call) => call === "start").length, 2);
});

test("pausing ends the person's control and closes the live frames", async () => {
  const { agent, computer, advance } = await setup({ idleMs: 60_000 });
  await computer.start();
  await computer.setControl("owner", { by: "person" });
  let closed = 0;
  computer.holdSocket({ driver: "person", close: () => closed++ });
  advance(2 * 60_000);
  assert.equal(await computer.pauseIfIdle(), true);
  assert.equal(computer.drivenBy, "member");
  assert.equal(closed, 1);
  assert.equal(agent.running, false);
});

test("two starts at once start the desktop once", async () => {
  const { agent, computer } = await setup();
  await Promise.all([computer.start(), computer.start(), computer.start()]);
  assert.equal(agent.calls.filter((call) => call === "start").length, 1);
});

test("a command leaves a receipt with its output and exit; failures and limits are said as they are", async () => {
  const { agent, computer } = await setup();
  const ok = await computer.execute("owner", { command: "echo ok" });
  assert.deepEqual(
    [ok.status, ok.exitCode, ok.stdout, ok.cwd, ok.truncated],
    ["succeeded", 0, "ok\n", "/workspace", false],
  );
  assert.ok(ok.completedAt);
  agent.result = { stdout: "", stderr: "boom", exitCode: 2, timedOut: false, truncated: false };
  const failed = await computer.execute("owner", { command: "false" });
  assert.deepEqual([failed.status, failed.exitCode, failed.stderr], ["failed", 2, "boom"]);
  agent.result = { stdout: "…", stderr: "", exitCode: null, timedOut: true, truncated: true };
  const slow = await computer.execute("owner", { command: "sleep 99" });
  assert.deepEqual([slow.status, slow.exitCode, slow.truncated], ["timed_out", undefined, true]);
  const receipts = await computer.commands("owner");
  assert.equal(receipts.length, 3);
  assert.deepEqual(await computer.commands("someone else"), []);
});

test("an interrupted command says so and asks for the workspace to be inspected", async () => {
  const { agent, computer } = await setup();
  agent.execError = new AppError("The computer does not answer.", 503);
  const lost = await computer.execute("owner", { command: "make" });
  assert.equal(lost.status, "interrupted");
  assert.match(lost.stderr, /does not answer/);
  assert.match(lost.stderr, /Inspect the workspace/);
});

test("the same operation never runs twice, and an operation ID belongs to one command", async () => {
  const { agent, computer } = await setup();
  const first = await computer.execute("owner", { command: "echo one" }, { idempotencyKey: "k1" });
  const again = await computer.execute("owner", { command: "echo one" }, { idempotencyKey: "k1" });
  assert.equal(again.id, first.id);
  assert.equal(agent.execs.length, 1);
  await assert.rejects(
    () => computer.execute("owner", { command: "echo two" }, { idempotencyKey: "k1" }),
    (error: AppError) => error.status === 409,
  );
  const other = await computer.execute("owner", { command: "echo one" }, { idempotencyKey: "k2" });
  assert.notEqual(other.id, first.id);
});

test("commands run in /workspace only, and an empty or oversized command is refused", async () => {
  const { agent, computer } = await setup();
  for (const cwd of ["/etc", "/workspace/../etc", "../x", "/workspacex"]) {
    await assert.rejects(
      () => computer.execute("owner", { command: "ls", cwd }),
      (error: AppError) => error.status === 400,
      cwd,
    );
  }
  await assert.rejects(() => computer.execute("owner", { command: "   " }));
  await assert.rejects(() => computer.execute("owner", { command: "x".repeat(16001) }));
  assert.equal(agent.execs.length, 0);
  await computer.execute("owner", { command: "ls", cwd: "sub/dir" });
  assert.equal(agent.execs[0].cwd, "/workspace/sub/dir");
});

test("workspacePath keeps every path inside /workspace", () => {
  assert.equal(workspacePath("a.txt"), "/workspace/a.txt");
  assert.equal(workspacePath("/workspace"), "/workspace");
  assert.equal(workspacePath("/workspace/a/../b/"), "/workspace/b");
  for (const bad of [
    "/etc/passwd",
    "../a",
    "a/../../b",
    "/workspace/../x",
    "a\0b",
    "/workspacex/a",
  ])
    assert.throws(() => workspacePath(bad), AppError, bad);
});

test("the snapshot says running or paused, who drives, and recent receipts; an unreachable computer is an error", async () => {
  const { agent, computer } = await setup();
  let snapshot = await computer.snapshot("owner");
  assert.deepEqual(
    [snapshot.enabled, snapshot.provider, snapshot.status, snapshot.control],
    [true, "desktop", "stopped", "member"],
  );
  await computer.execute("owner", { command: "echo ok" });
  await computer.setControl("owner", { by: "person" });
  snapshot = await computer.snapshot("owner");
  assert.deepEqual(
    [snapshot.status, snapshot.control, snapshot.commands.length],
    ["running", "person", 1],
  );
  agent.stateError = new AppError("The computer does not answer.", 503);
  snapshot = await computer.snapshot("owner");
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.message ?? "", /does not answer/);
});

test("files are read and written through the helper, inside /workspace, within the size limit", async () => {
  const { agent, computer } = await setup();
  await computer.write("notes/a.txt", "hi");
  assert.deepEqual(agent.fileRequests[0], {
    operation: "write",
    path: "/workspace/notes/a.txt",
    text: "hi",
  });
  await computer.read("/workspace/notes/a.txt");
  await computer.list(undefined);
  await computer.mkdir("notes/new");
  assert.deepEqual(
    agent.fileRequests.map((request) => request.operation),
    ["write", "read", "list", "mkdir"],
  );
  await assert.rejects(
    () => computer.write("big.txt", "x".repeat(256 * 1024 + 1)),
    (error: AppError) => error.status === 413,
  );
  await assert.rejects(() => computer.read("/etc/passwd"));
  await assert.rejects(
    () => computer.writePdf("a.pdf", new TextEncoder().encode("not a pdf")),
    (error: AppError) => error.status === 422,
  );
});

test("desktopOf finds the container behind the open service and nothing else", async () => {
  const { computer } = await setup();
  assert.equal(desktopOf({ container: computer }), computer);
  assert.equal(desktopOf({ container: {} }), null);
  assert.equal(desktopOf({}), null);
});

test("screenshots for the chat: the newest 20 are kept, each for an hour", async () => {
  const { computer, advance } = await setup();
  const ids = Array.from({ length: 21 }, (_, i) =>
    computer.keepShot(Buffer.from(`png${i}`).toString("base64")),
  );
  assert.equal(new Set(ids).size, 21, "every picture has its own id");
  assert.equal(computer.shotOf(ids[0]), null, "the oldest of 21 is no longer kept");
  assert.equal(computer.shotOf(ids[20])?.toString(), "png20");
  assert.equal(computer.shotOf("no-such-picture-0000"), null);
  advance(61 * 60_000);
  assert.equal(computer.shotOf(ids[20]), null, "an hour later it is gone");
});
