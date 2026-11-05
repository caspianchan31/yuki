// After 7 days without the owner one voice asks in the
// 营销总群 whether to go on; 48 hours with no answer pause every standing loop, marked as waiting for
// him; his word in the hall resumes them all; his presence before that ends the question.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFounder } from "../apps/server/src/accounts/founder.ts";
import {
  awayAfterMs,
  awayAnswerMs,
  checkOwnerAway,
  ownerPresenceKind,
  pausedForOwnerAway,
  resumeAfterAway,
  touchPresence,
} from "../apps/server/src/engine/owner-away.ts";
import type { AgentTask, ChatReport } from "../packages/domain/src/agent.ts";
import { harness, proxy } from "./helpers/sign-in-harness.ts";

const day0 = Date.parse("2026-10-01T00:00:00Z");

async function space(t: Parameters<typeof harness>[0]) {
  const h = await harness(t);
  const ann = await h.environments.create(h.owner, { name: "Ann", proxyUrl: proxy });
  await setFounder(h.db, h.owner, ann.id);
  const bob = await h.environments.create(h.owner, { name: "Bob", proxyUrl: proxy });
  await h.agent.accounts.setGoal(h.owner, bob, "长期经营一个摄影号", { userId: null });
  const loop = await h.agent.loops.ensure(h.owner, bob.id);
  assert.ok(loop);
  return { h, loop };
}
const hallNotices = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.db.list<ChatReport>(h.owner, "chat-reports")).filter(
    (card) => card.notice?.kind === "owner_away",
  );

test("gone 7 days: the founder asks once in the hall; 48 hours later the loops pause for him; his word resumes them", async (t) => {
  const { h, loop } = await space(t);
  // A space never seen starts counting now.
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0), null);
  assert.ok(await h.db.get(h.owner, ownerPresenceKind, "latest"));
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0 + awayAfterMs - 1), null);
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0 + awayAfterMs), "asked");
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0 + awayAfterMs + 1), null, "once");
  const [ask] = await hallNotices(h);
  assert.equal(ask.notice?.account, "Ann");
  assert.match(ask.text, /还继续经营吗/);
  const asked = day0 + awayAfterMs;
  assert.equal(await checkOwnerAway(h.agent, h.owner, asked + awayAnswerMs - 1), null);
  assert.equal(await checkOwnerAway(h.agent, h.owner, asked + awayAnswerMs), "paused");
  const paused = await h.db.get<AgentTask>(h.owner, "tasks", loop.id);
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.state.pausedFor, pausedForOwnerAway);
  assert.equal((await hallNotices(h)).length, 2);
  // Nothing more while paused.
  assert.equal(await checkOwnerAway(h.agent, h.owner, asked + 2 * awayAnswerMs), null);

  const back = await resumeAfterAway(h.agent, h.owner);
  assert.deepEqual(back, { resumed: 1, wasAway: true });
  const resumed = await h.db.get<AgentTask>(h.owner, "tasks", loop.id);
  assert.notEqual(resumed?.status, "paused");
  assert.equal(resumed?.state.pausedFor, undefined);
});

test("seen after the question: nothing pauses, and the count starts over", async (t) => {
  const { h, loop } = await space(t);
  await checkOwnerAway(h.agent, h.owner, day0);
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0 + awayAfterMs), "asked");
  await touchPresence(h.db, h.owner, day0 + awayAfterMs + 3600_000);
  assert.equal(await checkOwnerAway(h.agent, h.owner, day0 + awayAfterMs + awayAnswerMs), null);
  assert.notEqual((await h.db.get<AgentTask>(h.owner, "tasks", loop.id))?.status, "paused");
});
