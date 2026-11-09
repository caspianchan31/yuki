// v1.6 回顾: a conversation's frames from its events, share links (made, current, revoked,
// expired) and the public routes a link opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { replayFrames, replayShotIds } from "../apps/server/src/chat/replay.ts";
import { replayPublicRoutes } from "../apps/server/src/chat/replay-routes.ts";
import { ReplayShares } from "../apps/server/src/chat/replay-shares.ts";
import type { ThreadStore } from "../apps/server/src/chat/types.ts";
import { createStore } from "../apps/server/src/db.ts";

const shotId = "AbCdEfGhIjKlMnOpQrStUv";

/** A short conversation: the person asks, the member opens a page, takes a picture, replies. */
function sampleEvents(): BaseEvent[] {
  const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;
  return [
    ev({
      type: EventType.RUN_STARTED,
      threadId: "t1",
      runId: "r1",
      input: { messages: [{ id: "u1", role: "user", content: "帮我看看这个网站" }] },
    }),
    ev({ type: EventType.TEXT_MESSAGE_START, messageId: "a1", role: "assistant" }),
    ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a1", delta: "好，我去看。" }),
    ev({ type: EventType.TEXT_MESSAGE_END, messageId: "a1" }),
    ev({
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "computer_browser",
      parentMessageId: "a1",
    }),
    ev({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "c1",
      delta: JSON.stringify({ action: "open", url: "https://example.com", secret: "no" }),
    }),
    ev({ type: EventType.TOOL_CALL_END, toolCallId: "c1" }),
    ev({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "c1",
      messageId: "m1",
      role: "tool",
      content: JSON.stringify({
        url: "https://example.com/",
        title: "Example Domain",
        text: "the whole page text that must not travel",
      }),
    }),
    ev({
      type: EventType.TOOL_CALL_START,
      toolCallId: "c2",
      toolCallName: "computer_screenshot",
      parentMessageId: "a1",
    }),
    ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c2", delta: "{}" }),
    ev({ type: EventType.TOOL_CALL_END, toolCallId: "c2" }),
    ev({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "c2",
      messageId: "m2",
      role: "tool",
      content: JSON.stringify({ screenshot: "attached", shotId, control: "member" }),
    }),
    ev({
      type: EventType.TOOL_CALL_START,
      toolCallId: "c3",
      toolCallName: "delegate_task",
      parentMessageId: "a1",
    }),
    ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c3", delta: "{}" }),
    ev({ type: EventType.TOOL_CALL_END, toolCallId: "c3" }),
    ev({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "c3",
      messageId: "m3",
      role: "tool",
      content: JSON.stringify({ error: "not a step" }),
    }),
    ev({ type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" }),
    ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "看完了，是个示例站。" }),
    ev({ type: EventType.TEXT_MESSAGE_END, messageId: "a2" }),
    ev({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" }),
  ];
}

test("frames: what was said and each computer step, in order; results stay out", () => {
  const frames = replayFrames(sampleEvents());
  assert.deepEqual(
    frames.map((f) => f.kind),
    ["person", "member", "step", "step", "member"],
  );
  assert.deepEqual(frames[0], { kind: "person", text: "帮我看看这个网站" });
  assert.deepEqual(frames[1], { kind: "member", text: "好，我去看。" });
  const open = frames[2];
  assert.equal(open.kind, "step");
  if (open.kind !== "step") return;
  assert.equal(open.tool, "computer_browser");
  assert.deepEqual(open.args, { action: "open", url: "https://example.com" }, "only shown args");
  assert.deepEqual(open.page, { url: "https://example.com/", title: "Example Domain" });
  assert.equal(open.failed, false);
  assert.ok(!JSON.stringify(frames).includes("whole page text"), "a result's text is not a frame");
  const shot = frames[3];
  assert.equal(shot.kind === "step" && shot.shotId, shotId);
  assert.deepEqual([...replayShotIds(frames)], [shotId]);
});

test("frames: a failed step is marked; a conversation with no steps is text only", () => {
  const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;
  const events: BaseEvent[] = [
    ev({ type: EventType.TOOL_CALL_START, toolCallId: "x", toolCallName: "run_computer_command" }),
    ev({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "x",
      delta: JSON.stringify({ command: "ls" }),
    }),
    ev({ type: EventType.TOOL_CALL_END, toolCallId: "x" }),
    ev({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "x",
      messageId: "mx",
      role: "tool",
      content: JSON.stringify({ status: "failed" }),
    }),
  ];
  const [step] = replayFrames(events);
  assert.equal(step?.kind === "step" && step.failed, true);
  assert.deepEqual(
    replayFrames([
      ev({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "a",
        role: "assistant",
        delta: "只说话",
      }),
    ]),
    [{ kind: "member", text: "只说话" }],
  );
});

test("share links: made, current, replaced, revoked, expired; a bad token is nothing", async () => {
  let now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const shares = await ReplayShares.open(await createStore(), { now: () => now });
  assert.equal(await shares.current("o", "t1"), null);
  const first = await shares.create("o", "t1");
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expiresAt, new Date(now + 30 * 24 * 60 * 60_000).toISOString());
  assert.equal((await shares.current("o", "t1"))?.token, first.token);
  assert.equal((await shares.byToken(first.token))?.threadId, "t1");
  assert.equal(await shares.byToken("short"), null, "a malformed token is null without a query");
  assert.equal(await shares.byToken("A".repeat(43)), null, "an unknown token is null");
  const second = await shares.create("o", "t1");
  assert.equal(await shares.byToken(first.token), null, "a new link replaces the old one");
  assert.equal((await shares.current("o", "t1"))?.token, second.token);
  assert.equal(await shares.current("other", "t1"), null, "another owner sees nothing");
  assert.equal(await shares.revoke("o", "t1"), 1);
  assert.equal(await shares.byToken(second.token), null, "revoked");
  assert.equal(await shares.current("o", "t1"), null);
  const third = await shares.create("o", "t1", 1);
  now += 25 * 60 * 60_000;
  assert.equal(await shares.byToken(third.token), null, "expired a day later");
});

test("public routes: a live link answers frames and its pictures, nothing else", async () => {
  const shares = await ReplayShares.open(await createStore());
  const share = await shares.create("owner-1", "t1");
  const threads = {
    threadEvents: async (owner: string, threadId: string) =>
      owner === "owner-1" && threadId === "t1" ? sampleEvents() : null,
    updateThread: async () => ({ name: "看网站" }),
  } as unknown as ThreadStore;
  const app = replayPublicRoutes(shares, threads, (id) =>
    id === shotId ? Buffer.from("PNGBYTES") : null,
  );
  const ok = await app.request(`/${share.token}`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { name: string; frames: unknown[]; expiresAt: string };
  assert.equal(body.name, "看网站");
  assert.equal(body.frames.length, 5);
  assert.equal(body.expiresAt, share.expiresAt);
  const png = await app.request(`/${share.token}/shots/${shotId}`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await png.arrayBuffer()).toString(), "PNGBYTES");
  const other = await app.request(`/${share.token}/shots/ZzZzZzZzZzZzZzZzZzZzZz`);
  assert.equal(other.status, 404, "a picture the replay does not show is not served");
  await shares.revoke("owner-1", "t1");
  assert.equal((await app.request(`/${share.token}`)).status, 404, "revoked: gone");
  assert.equal((await app.request(`/${share.token}/shots/${shotId}`)).status, 404);
  assert.equal((await app.request("/not-a-token")).status, 404);
});
