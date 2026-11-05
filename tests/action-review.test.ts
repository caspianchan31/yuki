// The action review and where a proposal
// waits. The server decides from the reviewer's JSON text (askFirst match, autoAllow match or
// low risk, a message to people never by the reviewer's judgment alone, a failure asks, review
// off asks); a chat-started task's proposal never expires, a background one expires after 30
// minutes; an expired card's 总是允许 saves the rule only; a routine's draft never goes by a rule
// or the review, never expires, and its run does not wait on it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { backgroundReviewMs } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  reviewRuleId,
  reviewRulesKind,
  ruleKindOf,
  settleDueReview,
} from "../apps/server/src/engine/review-window.ts";
import {
  decideReview,
  needsModel,
  parseReviewAnswer,
  parseReviewSettings,
  readReviewSettings,
  saveReviewSettings,
} from "../apps/server/src/review/action-review.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal, ReviewSettings } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";

const event = {
  name: "prepare_event",
  arguments: {
    title: "Team lunch",
    start: "2026-12-01T12:00:00-08:00",
    end: "2026-12-01T13:00:00-08:00",
  },
};
const email = {
  name: "prepare_email",
  arguments: { to: ["buyer@shop.example"], subject: "Hello", body: "Hello,\n\nA short note." },
};
const claims = { text: '{"claims":[]}' };
const verdict = (value: object) => ({ text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` });
const isReview = (body: string) => body.includes("You review an action");
const done = { name: "ask_user", arguments: { question: "Anything else?" } };
const settings = (value: Partial<ReviewSettings>): ReviewSettings => ({
  actionReview: true,
  askFirst: [],
  autoAllow: [],
  ...value,
});

type Prepared = Awaited<ReturnType<typeof run>>;
/** A task in a sample workspace whose model answers by request index. */
async function run(
  t: TestContext,
  reply: Parameters<typeof modelFixture>[1],
  options: {
    review?: ReviewSettings;
    before?: (
      server: Awaited<ReturnType<typeof createApp>>,
      db: Awaited<ReturnType<typeof createStore>>,
    ) => Promise<void>;
    task?: { originThreadId?: string; repeatMinutes?: number; routine?: boolean };
    fixture?: Parameters<typeof modelFixture>[2];
  } = {},
) {
  const { requests } = await modelFixture(t, reply, options.fixture ?? {});
  const directory = await mkdtemp(join(tmpdir(), "openmuse-action-review-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  if (options.review) await saveReviewSettings(db, "owner", options.review);
  await options.before?.(server, db);
  const spec = options.task ?? {};
  const created = await server.agent.createTask(
    "owner",
    { prompt: "Do the job", ...(spec.repeatMinutes ? { repeatMinutes: spec.repeatMinutes } : {}) },
    undefined,
    false,
    { originThreadId: spec.originThreadId },
  );
  if (spec.routine)
    await db.compareAndSwap("owner", "tasks", created.id, {}, { routine: { name: "daily" } });
  await server.agent.worker.tick();
  const task = (await server.agent.getTask("owner", created.id)) as AgentTask;
  const actions = await db.list<ActionProposal>("owner", "actions");
  return { requests, task, actions, db, server };
}
const reviews = (r: Prepared) => r.requests.filter((request) => isReview(request.body));

test("decision order: askFirst wins, then autoAllow or a low-risk allow, else ask", () => {
  const s = settings({ askFirst: ["no money"], autoAllow: ["calendar lunches"] });
  const answer = (over: object = {}) => ({
    decision: "allow" as const,
    lowRisk: true,
    reason: "fine",
    matchedAskFirst: [] as number[],
    matchedAutoAllow: [] as number[],
    ...over,
  });
  const decide = (a: ReturnType<typeof answer> | null, kind = "calendar.create", always = false) =>
    decideReview({ settings: s, kind, alwaysAllow: always, answer: a });
  assert.equal(
    decide(answer({ matchedAskFirst: [1], matchedAutoAllow: [1] })).outcome,
    "ask",
    "ask wins a conflict",
  );
  assert.equal(
    decide(answer({ matchedAskFirst: [1] }), "calendar.create", true).outcome,
    "ask",
    "even over 总是允许",
  );
  assert.deepEqual(decide(answer({ matchedAutoAllow: [1], lowRisk: false, decision: "ask" })), {
    outcome: "run",
    by: "review",
    reason: "fine",
  });
  assert.equal(decide(answer()).outcome, "run", "low risk allow");
  assert.equal(decide(answer({ lowRisk: false })).outcome, "ask");
  assert.equal(decide(answer({ decision: "ask" })).outcome, "ask");
  assert.equal(
    decide(answer(), "email.send").outcome,
    "ask",
    "a message is never let through by judgment alone",
  );
  assert.equal(
    decide(answer({ matchedAutoAllow: [1] }), "email.send").outcome,
    "run",
    "but by an autoAllow sentence",
  );
  assert.deepEqual(decide(null, "email.send", true), { outcome: "run", by: "rule" });
  assert.equal(decide(null).outcome, "ask");
  assert.deepEqual(
    decideReview({ settings: s, kind: "x", alwaysAllow: false, answer: null, failed: true }),
    {
      outcome: "ask",
      failed: true,
    },
  );
  assert.equal(
    decideReview({
      settings: settings({ actionReview: false }),
      kind: "calendar.create",
      alwaysAllow: false,
      answer: answer(),
    }).outcome,
    "ask",
    "review off asks",
  );
});

test("the model is asked only when its answer can change the outcome", () => {
  assert.equal(needsModel(settings({ actionReview: false }), "calendar.create", false), false);
  assert.equal(needsModel(settings({}), "calendar.create", false), true);
  assert.equal(
    needsModel(settings({}), "email.send", false),
    false,
    "a message with no autoAllow sentence",
  );
  assert.equal(needsModel(settings({ autoAllow: ["x"] }), "email.send", false), true);
  assert.equal(needsModel(settings({}), "email.send", true), false);
  assert.equal(needsModel(settings({ askFirst: ["x"] }), "email.send", true), true);
});

test("the reviewer's answer is read from text, tolerantly", () => {
  const sizes = { askFirst: 2, autoAllow: 1 };
  const text =
    '{"decision":"ALLOW","lowRisk":true,"reason":"ok","matchedAskFirst":["2",9],"matchedAutoAllow":1}';
  for (const wrapped of [text, `\`\`\`json\n${text}\n\`\`\``, `Sure {here}: ${text} done`]) {
    const parsed = parseReviewAnswer(wrapped, sizes);
    assert.equal(parsed?.decision, "allow");
    assert.deepEqual(parsed?.matchedAskFirst, [2], "numbers outside the list are dropped");
    assert.deepEqual(parsed?.matchedAutoAllow, [1]);
  }
  assert.equal(parseReviewAnswer("no idea", sizes), null);
  assert.equal(parseReviewAnswer('{"decision":"maybe"}', sizes), null);
});

test("the settings hold 20 sentences each; more is a 422", async (t) => {
  const twenty = Array.from({ length: 20 }, (_, i) => `rule ${i}`);
  assert.equal(
    parseReviewSettings({ actionReview: true, askFirst: twenty, autoAllow: [] }).askFirst.length,
    20,
  );
  assert.throws(
    () =>
      parseReviewSettings({ actionReview: true, askFirst: [], autoAllow: [...twenty, "one more"] }),
    (error: { status?: number }) => error.status === 422,
  );
  const { server } = await run(t, () => undefined);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = (await session.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const get = await server.app.request("/api/review-settings", { headers });
  assert.deepEqual(await get.json(), { actionReview: true, askFirst: [], autoAllow: [] });
  const put = await server.app.request("/api/review-settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ actionReview: false, askFirst: [" a "], autoAllow: ["b"] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await server.app.request("/api/review-settings", { headers })).json(), {
    actionReview: false,
    askFirst: ["a"],
    autoAllow: ["b"],
  });
  const over = await server.app.request("/api/review-settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ actionReview: true, askFirst: [...twenty, "x"], autoAllow: [] }),
  });
  assert.equal(over.status, 422);
});

test("the settings are one per space: a project's scope reads and writes the space's", async () => {
  const db = await createStore();
  try {
    const project = "owner/proj:11111111-1111-4111-8111-111111111111";
    // An earlier build kept one row per scope: a project's row is never read.
    await db.put(project, "review-settings", {
      id: "default",
      actionReview: true,
      askFirst: [],
      autoAllow: [],
    });
    await saveReviewSettings(db, "owner", { actionReview: false, askFirst: [], autoAllow: [] });
    assert.equal((await readReviewSettings(db, project)).actionReview, false);
    assert.equal((await readReviewSettings(db, `${project}#env:x`)).actionReview, false);
    await saveReviewSettings(db, project, { actionReview: true, askFirst: ["a"], autoAllow: [] });
    assert.deepEqual(await readReviewSettings(db, "owner"), {
      actionReview: true,
      askFirst: ["a"],
      autoAllow: [],
    });
    assert.equal((await readReviewSettings(db, "other")).actionReview, true);
  } finally {
    await db.close();
  }
});

test("a low-risk action the reviewer allows runs at once, marked review, with the reason", async (t) => {
  const r = await run(t, (index) =>
    index === 0
      ? event
      : index === 1
        ? verdict({ decision: "allow", lowRisk: true, reason: "A plain lunch" })
        : done,
  );
  assert.equal(reviews(r).length, 1);
  assert.ok(!(JSON.parse(reviews(r)[0].body) as { tools?: unknown[] }).tools?.length, "no tools");
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].status, "succeeded");
  assert.equal(r.actions[0].autoApproved, "review");
  assert.equal(r.actions[0].reviewReason, "A plain lunch");
  assert.notEqual(r.task.status, "waiting_approval");
  assert.ok(r.requests[2].body.includes("succeeded"), "the run is told it went");
});

test("an askFirst match asks, and wins a conflict with autoAllow", async (t) => {
  const r = await run(
    t,
    (index) =>
      index === 0
        ? event
        : verdict({
            decision: "allow",
            lowRisk: true,
            reason: "both",
            matchedAskFirst: [1],
            matchedAutoAllow: [1],
          }),
    { review: settings({ askFirst: ["lunches"], autoAllow: ["lunches"] }) },
  );
  assert.equal(r.actions[0].status, "awaiting_review");
  assert.equal(r.actions[0].autoApproved, undefined);
  assert.equal(r.task.status, "waiting_approval");
});

test("an autoAllow match runs it even when the reviewer calls it risky", async (t) => {
  const r = await run(
    t,
    (index) =>
      index === 0
        ? event
        : index === 1
          ? verdict({ decision: "ask", lowRisk: false, reason: "matches", matchedAutoAllow: [1] })
          : done,
    { review: settings({ autoAllow: ["team lunches"] }) },
  );
  assert.equal(r.actions[0].autoApproved, "review");
});

test("a review that fails or cannot be read asks, after one retry", async (t) => {
  const failing = await run(t, (index) => (index === 0 ? event : undefined), {
    fixture: { errorStatus: (index) => (index === 1 || index === 2 ? 400 : undefined) },
  });
  assert.equal(reviews(failing).length, 2, "the review is asked, then asked once more");
  assert.equal(failing.requests.length, 3, "two attempts");
  assert.equal(failing.actions[0].status, "awaiting_review");
  assert.equal(failing.task.status, "waiting_approval");
  const unreadable = await run(t, (index) =>
    index === 0 ? event : { text: "I think it is fine" },
  );
  assert.equal(unreadable.actions[0].status, "awaiting_review");
});

test("review off asks every action", async (t) => {
  const r = await run(
    t,
    (index) => (index === 0 ? event : verdict({ decision: "allow", lowRisk: true, reason: "x" })),
    {
      review: settings({ actionReview: false }),
    },
  );
  assert.equal(r.requests.length, 1, "no review request");
  assert.equal(r.actions[0].status, "awaiting_review");
});

test("review off still lets a 总是允许 rule send", async (t) => {
  const r = await run(t, (index) => (index === 0 ? event : done), {
    review: settings({ actionReview: false }),
    before: async (_server, db) => {
      await db.put("owner", reviewRulesKind, {
        id: reviewRuleId(null, "calendar.create"),
        mode: "always",
        at: new Date().toISOString(),
      });
    },
  });
  assert.equal(r.actions[0].autoApproved, "rule");
});

test("a message to people is never let through by the reviewer's judgment alone", async (t) => {
  // With an autoAllow sentence the reviewer is asked; its low-risk allow does not send.
  const judged = await run(
    t,
    (index) =>
      index === 0
        ? email
        : index === 1
          ? claims
          : verdict({ decision: "allow", lowRisk: true, reason: "harmless" }),
    { review: settings({ autoAllow: ["calendar lunches"] }) },
  );
  assert.equal(reviews(judged).length, 1);
  assert.equal(judged.actions[0].status, "awaiting_review");
  assert.equal(judged.actions[0].draft, true);
  // Without any autoAllow sentence the reviewer is not even asked.
  const plain = await run(t, (index) => (index === 0 ? email : claims));
  assert.equal(reviews(plain).length, 0);
  assert.equal(plain.actions[0].status, "awaiting_review");
  // An autoAllow sentence it names lets the message go.
  const named = await run(
    t,
    (index) =>
      index === 0
        ? email
        : index === 1
          ? claims
          : index === 2
            ? verdict({ decision: "ask", lowRisk: false, reason: "matches", matchedAutoAllow: [1] })
            : done,
    { review: settings({ autoAllow: ["short notes to buyers"] }) },
  );
  assert.equal(named.actions[0].status, "succeeded");
  assert.equal(named.actions[0].autoApproved, "review");
});

test("a chat-started task's proposal never expires; a background one expires after 30 minutes", async (t) => {
  const chat = await run(t, (index) => (index === 0 ? event : undefined), {
    task: { originThreadId: "11111111-1111-4111-8111-111111111111" },
  });
  const background = await run(t, (index) => (index === 0 ? event : undefined));
  const repeating = await run(t, (index) => (index === 0 ? event : undefined), {
    task: { originThreadId: "11111111-1111-4111-8111-111111111111", repeatMinutes: 60 },
  });
  const [c, b, p] = [chat.actions[0], background.actions[0], repeating.actions[0]];
  assert.equal(c.noExpiry, true);
  assert.equal(b.noExpiry, undefined);
  assert.equal(Date.parse(b.expiresAt) - Date.parse(b.createdAt), backgroundReviewMs);
  assert.equal(p.noExpiry, undefined, "a repeating task is background even when a chat started it");
  const late = Date.now() + 365 * 24 * 3600_000;
  assert.equal(await settleDueReview(chat.db, "owner", c.id, late), null);
  assert.equal((await settleDueReview(background.db, "owner", b.id, late))?.status, "expired");
});

test("an expired card's 总是允许 saves the rule and runs nothing", async (t) => {
  const r = await run(t, (index) => (index === 0 ? event : undefined));
  const action = r.actions[0];
  await r.db.compareAndSwap(
    "owner",
    "actions",
    action.id,
    {},
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
  );
  const result = await r.server.agent.setReviewRule("owner", action.id, "always");
  assert.equal(result.rule.mode, "always");
  assert.equal(result.action.status, "expired");
  assert.equal(result.action.result, undefined);
  assert.equal(result.action.autoApproved, undefined);
  const saved = await r.db.get<{ mode: string }>(
    "owner",
    reviewRulesKind,
    reviewRuleId(null, "calendar.create"),
  );
  assert.equal(saved?.mode, "always");
});

test("a routine's draft waits in the chat: no rule or review sends it, it never expires, the run does not wait", async (t) => {
  const r = await run(t, (index) => (index === 0 ? email : index === 1 ? claims : done), {
    task: { routine: true, repeatMinutes: 60 },
    review: settings({ autoAllow: ["everything"] }),
    before: async (_server, db) => {
      await db.put("owner", reviewRulesKind, {
        id: reviewRuleId(null, "email.send"),
        mode: "always",
        at: new Date().toISOString(),
      });
    },
  });
  const draft = r.actions[0];
  assert.equal(draft.status, "awaiting_review");
  assert.equal(draft.fromRoutine, true);
  assert.equal(draft.noExpiry, true);
  assert.equal(reviews(r).length, 0, "the review is not asked");
  assert.notEqual(r.task.status, "waiting_approval");
  assert.equal(r.task.actionId ?? null, null);
  assert.ok(r.requests[2].body.includes("draft_waiting"), "the run is told the draft is waiting");
  const late = Date.now() + 365 * 24 * 3600_000;
  assert.equal(await settleDueReview(r.db, "owner", draft.id, late), null);
  await assert.rejects(r.server.agent.setReviewRule("owner", draft.id, "always"), /waits/);
  // 发送 sends it although the run is over.
  const sent = await r.server.actions.decide("owner", draft.id, draft.hash, "approve");
  assert.equal(sent.status, "succeeded");
});

test("总是允许 on an app's call is kept for that app's tool only", () => {
  const call = (app: string, tool: string) =>
    ({ kind: "app.call", data: { app, appName: app, tool, arguments: {} } }) as Pick<
      ActionProposal,
      "kind" | "data"
    >;
  assert.equal(ruleKindOf(call("notion", "update_page")), "app.call:notion__update_page");
  assert.notEqual(
    ruleKindOf(call("notion", "update_page")),
    ruleKindOf(call("github", "create_issue")),
  );
  assert.notEqual(
    ruleKindOf(call("notion", "update_page")),
    ruleKindOf(call("notion", "delete_page")),
  );
  assert.equal(
    ruleKindOf({ kind: "calendar.create", data: {} } as Pick<ActionProposal, "kind" | "data">),
    "calendar.create",
  );
});

test("a declined or expired message is final: no new message to the same people in the run", async (t) => {
  const again = {
    name: "prepare_email",
    arguments: {
      to: ["Buyer@shop.example"],
      subject: "Hello again",
      body: "Hello,\n\nA reworded note.",
    },
  };
  const other = {
    name: "prepare_email",
    arguments: { to: ["someone@else.example"], subject: "Hi", body: "Hi, a different note." },
  };
  const finish = { name: "finish_task", arguments: { summary: "It did not go out." } };
  const script = [email, claims, again, other, claims, finish];
  const r = await run(t, (index) => script[index]);
  assert.equal(r.task.status, "waiting_approval");
  const first = r.actions[0];
  await r.server.actions.decide("owner", first.id, first.hash, "deny");
  await r.server.agent.worker.tick();
  // The reworded message to the same address (case aside) is refused with the reason, no card.
  const refused = r.requests.find((request) => request.body.includes("Hello again"));
  assert.ok(refused);
  const followUp = r.requests.find((request) => request.body.includes("that is final"));
  assert.ok(followUp, "the run reads that the send is final");
  const actions = (await r.db.list<ActionProposal>("owner", "actions")).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  assert.ok(!actions.some((action) => JSON.stringify(action.data).includes("Hello again")));
  // Another recipient is not held to it.
  assert.ok(actions.some((action) => JSON.stringify(action.data).includes("someone@else.example")));
});

test("an expired message is final too, and a declined event can still be prepared again", async (t) => {
  const again = {
    name: "prepare_email",
    arguments: { to: ["buyer@shop.example"], subject: "Second try", body: "Hello again, buyer." },
  };
  const moved = {
    name: "prepare_event",
    arguments: { ...event.arguments, title: "Team lunch, moved" },
  };
  const script = [
    email,
    claims,
    again,
    moved,
    { name: "finish_task", arguments: { summary: "k" } },
  ];
  const r = await run(t, (index) => script[index]);
  const first = r.actions[0];
  await r.db.compareAndSwap("owner", "actions", first.id, {}, { status: "expired" });
  await r.server.agent.worker.tick();
  const actions = await r.db.list<ActionProposal>("owner", "actions");
  assert.ok(!actions.some((action) => JSON.stringify(action.data).includes("Second try")));
  assert.ok(
    actions.some((action) => action.kind === "calendar.create"),
    "non-messages are not held to it",
  );
});
