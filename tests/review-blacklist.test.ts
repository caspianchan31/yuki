// A background review waits 30 minutes and, unanswered,
// expires unsent; a decline stops it; 「以后总是允许」 sends at once and 「以后都先问我」 waits.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ActionService, backgroundReviewMs } from "../apps/server/src/actions.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { settleDueReview } from "../apps/server/src/engine/review-window.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
const email = {
  kind: "email.send" as const,
  data: {
    to: ["sam@example.com"],
    subject: "Visit",
    body: "See attached.",
    cc: [],
    bcc: [],
    attachmentIds: [],
  },
};
function service(clock: { now: number }, sent: string[]) {
  return new ActionService(db, {
    execute: async () => {
      sent.push("sent");
      return "sent ok";
    },
    connected: async () => true,
    now: () => clock.now,
  });
}

test("a background review waits 30 minutes; unanswered, it expires unsent", async () => {
  const clock = { now: Date.parse("2026-10-26T00:00:00Z") };
  const sent: string[] = [];
  const actions = service(clock, sent);
  const owner = "window-owner";
  const proposal = await actions.propose(owner, email);
  assert.equal(backgroundReviewMs, 30 * 60_000);
  assert.equal(Date.parse(proposal.expiresAt) - clock.now, backgroundReviewMs);
  // Before the window ends nothing happens.
  clock.now += backgroundReviewMs - 1;
  assert.equal(await settleDueReview(db, owner, proposal.id, clock.now), null);
  assert.equal(sent.length, 0);
  clock.now += 1;
  const settled = await settleDueReview(db, owner, proposal.id, clock.now);
  assert.equal(settled?.status, "expired");
  assert.equal(sent.length, 0);
});

test("a review past its time cannot be approved", async () => {
  const clock = { now: Date.parse("2026-10-26T00:00:00Z") };
  const sent: string[] = [];
  const actions = service(clock, sent);
  const owner = "late-owner";
  const proposal = await actions.propose(owner, email);
  clock.now += backgroundReviewMs;
  await assert.rejects(actions.decide(owner, proposal.id, proposal.hash, "approve"), /expired/i);
  assert.equal(sent.length, 0);
});

test("a decline in the window stops it", async () => {
  const clock = { now: Date.parse("2026-10-26T00:00:00Z") };
  const sent: string[] = [];
  const actions = service(clock, sent);
  const owner = "deny-window-owner";
  const declined = await actions.propose(owner, email);
  await actions.decide(owner, declined.id, declined.hash, "deny");
  clock.now += backgroundReviewMs;
  assert.equal(
    (await settleDueReview(db, owner, declined.id, clock.now))?.status ?? "denied",
    "denied",
  );
  assert.equal(sent.length, 0);
});

test("「以后总是允许」 sends at once, without waiting for the window", async () => {
  const clock = { now: Date.parse("2026-10-26T00:00:00Z") };
  const sent: string[] = [];
  const actions = service(clock, sent);
  const owner = "rule-owner";
  const proposal = await actions.propose(owner, email);
  const done = await actions.approveUnrefused(owner, proposal.id, "rule");
  assert.equal(done.status, "succeeded");
  assert.equal(done.autoApproved, "rule");
  assert.equal(sent.length, 1);
});

test("the owner's rule is kept for the action's account, else the project; the account's comes first", async (t) => {
  const { harness } = await import("./helpers/sign-in-harness.ts");
  const { reviewRuleFor } = await import("../apps/server/src/engine/review-window.ts");
  const h = await harness(t);
  const alice = await h.account("Alice");
  const owner = h.owner;
  const task = await h.agent.createTask(owner, {
    prompt: "回复客户邮件",
    input: { environmentId: alice.id },
  });
  const proposal = await h.agent.actions.propose(owner, email, `rule:${task.id}`, task.id);
  const asked = await h.agent.setReviewRule(owner, proposal.id, "ask");
  assert.equal(asked.scope, "account");
  assert.equal(asked.action.askFirst, true);
  assert.equal((await reviewRuleFor(h.db, owner, alice.id, "email.send"))?.mode, "ask");
  // Another account has no rule of its own, and the project has none.
  assert.equal(await reviewRuleFor(h.db, owner, "other", "email.send"), null);
  // A task on the default desktop sets the project's.
  const plain = await h.agent.createTask(owner, { prompt: "发一封邮件" });
  const second = await h.agent.actions.propose(owner, email, `rule:${plain.id}`, plain.id);
  // The card shows while its task waits on it (an action runs only for a task that is).
  await h.db.compareAndSwap(
    owner,
    "tasks",
    plain.id,
    {},
    {
      status: "waiting_approval",
      actionId: second.id,
    },
  );
  const always = await h.agent.setReviewRule(owner, second.id, "always");
  assert.equal(always.scope, "project");
  assert.equal(always.action.autoApproved, "rule");
  assert.equal((await reviewRuleFor(h.db, owner, "other", "email.send"))?.mode, "always");
  // The account's own rule still wins over the project's.
  assert.equal((await reviewRuleFor(h.db, owner, alice.id, "email.send"))?.mode, "ask");
});
