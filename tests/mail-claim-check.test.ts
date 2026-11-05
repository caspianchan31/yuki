// What a prepared email says about the person needs a source the
// person gave (claim-check.ts). A statement without one sends the draft back to the task instead of
// to review; a supported one passes; a check that does not work marks the review instead of
// holding the email; a draft sent back as often as the limit goes to review with them shown.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { claimReturnLimit } from "../apps/server/src/engine/model.ts";
import {
  answerForLog,
  checkClaims,
  parseClaims,
  unreadPrefix,
  unsupportedClaims,
} from "../apps/server/src/mail/claim-check.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { chatCompletionsFixture, modelFixture } from "./helpers/model.ts";

const prompt = "我们做木制玩具，想把产品卖给海外的店";
const email = {
  name: "prepare_email",
  arguments: {
    to: ["buyer@shop.example"],
    subject: "Wooden toys",
    body: "Hello,\n\nWe make wooden toys and hold every safety certificate.\n\nBest regards",
  },
};
const supported = { statement: "We make wooden toys", evidence: "我们做木制玩具" };
const madeUp = { statement: "We hold every safety certificate", evidence: "" };
/** The check's answer: the JSON object in text, here inside a code fence as models often write. */
const claims = (...list: object[]) => ({
  text: `\`\`\`json\n${JSON.stringify({ claims: list })}\n\`\`\``,
});
const noTools = (body: string) => !(JSON.parse(body) as { tools?: unknown[] }).tools?.length;

test("a statement is supported only by words that are really in a source", () => {
  const sources = [
    { label: "the person's task", text: prompt },
    { label: "memory", text: "Ships from the coast.\nSamples on request." },
  ];
  assert.deepEqual(
    unsupportedClaims(
      [
        supported,
        // Copied across a line break and with other punctuation: still the source's words.
        {
          statement: "Ships from the coast; samples on request",
          evidence: "ships from the coast samples on request",
        },
        madeUp,
        { statement: "Ten years of experience", evidence: "ten years of experience" },
      ],
      sources,
    ),
    ["We hold every safety certificate", "Ten years of experience"],
  );
});

/** A task with `prompt` in a sample workspace whose model answers by request index. */
async function run(
  t: TestContext,
  reply: Parameters<typeof modelFixture>[1],
  options: Parameters<typeof modelFixture>[2] = {},
) {
  const { requests } = await modelFixture(t, reply, options);
  const directory = await mkdtemp(join(tmpdir(), "openmuse-claim-check-"));
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
  const created = await server.agent.createTask("owner", { prompt });
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", created.id);
  const actions = await db.list<ActionProposal>("owner", "actions");
  return { requests, task: task as AgentTask, actions };
}

test("an email with a statement no source supports goes back to the task, not to review", async (t) => {
  const { requests, task, actions } = await run(t, (index) =>
    index === 0
      ? email
      : index === 1
        ? claims(supported, madeUp)
        : { name: "ask_user", arguments: { question: "Which certificates do you hold?" } },
  );
  assert.ok(requests[1].body.includes("You check an email"), "the second request is the check");
  assert.ok(noTools(requests[1].body), "the check answers in text, with no tool to call");
  assert.ok(requests[1].body.includes(prompt), "the check reads the person's words");
  const result = requests[2].body;
  assert.ok(result.includes("unsupported_claims"), "the task is told");
  assert.ok(result.includes(madeUp.statement));
  assert.equal(task.status, "waiting_input", task.error ?? undefined);
  assert.equal(actions.length, 0, "no review card");
  assert.equal(task.state.claimReturns, 1);
});

test("an email whose statements all have a source goes to review, marked checked", async (t) => {
  const { requests, task, actions } = await run(t, (index) =>
    index === 0 ? email : claims(supported),
  );
  assert.equal(requests.length, 2, "the check is one request");
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "awaiting_review");
  assert.deepEqual(actions[0].claimCheck, { status: "checked", unsupported: [] });
});

test("a check that fails does not hold the email: it goes to review marked unchecked", async (t) => {
  const { requests, task, actions } = await run(t, (index) => (index === 0 ? email : undefined), {
    // A refusal is not retried by the provider SDK; the check tries once more, then gives up.
    errorStatus: (index) => (index === 1 || index === 2 ? 400 : undefined),
  });
  assert.equal(requests.length, 3, "two attempts at the check");
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].claimCheck?.status, "unchecked");
});

test("a check that gives no list of statements is unchecked too", async (t) => {
  const { task, actions } = await run(t, (index) => (index === 0 ? email : undefined));
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.equal(actions[0].claimCheck?.status, "unchecked");
});

test("a draft sent back as often as the limit goes to review with its statements shown", async (t) => {
  // Each attempt is two requests: the task's prepare_email, then the check.
  const { task, actions } = await run(t, (index) =>
    index % 2 === 0 ? email : claims(supported, madeUp),
  );
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].claimCheck, {
    status: "checked",
    unsupported: [madeUp.statement],
  });
  assert.equal(task.state.claimReturns, undefined, "the next email starts with its own returns");
  assert.ok(claimReturnLimit > 0);
});

test("a first attempt that fails is tried once more", async (t) => {
  const { task, actions } = await run(t, (index) => (index === 0 ? email : claims(supported)), {
    errorStatus: (index) => (index === 1 ? 400 : undefined),
  });
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.deepEqual(actions[0].claimCheck, { status: "checked", unsupported: [] });
});

test("the check works through a Chat Completions gateway, as in production", async (t) => {
  const previous = process.env.OPENAI_CHAT_COMPLETIONS;
  process.env.OPENAI_CHAT_COMPLETIONS = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_CHAT_COMPLETIONS;
    else process.env.OPENAI_CHAT_COMPLETIONS = previous;
  });
  const { requests } = await chatCompletionsFixture(t, () => claims(supported, madeUp));
  const check = await checkClaims("openai/fixture", email.arguments, [
    { label: "the person's task", text: prompt },
  ]);
  assert.deepEqual(check, { status: "checked", unsupported: [madeUp.statement] });
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /\/chat\/completions$/);
  assert.ok(noTools(requests[0].body));
});

const one = [{ statement: "We make toys", evidence: "我们做玩具" }];
const wrapped: [string, string][] = [
  ["the asked object", '{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}]}'],
  [
    "a json fence",
    '```json\n{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}]}\n```',
  ],
  ["a bare fence", '```\n{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}]}\n```'],
  [
    "prose around it, braces in the prose",
    'Here is the list {as asked}:\n{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}]}\nThat is all.',
  ],
  ["a top-level array", '[{"statement":"We make toys","evidence":"我们做玩具"}]'],
  [
    "another key for the list",
    '{"statements":[{"statement":"We make toys","evidence":"我们做玩具"}]}',
  ],
  ["other keys for the item", '{"claims":[{"claim":"We make toys","quote":"我们做玩具"}]}'],
  [
    "the list one level down",
    '{"result":{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}]}}',
  ],
  ["the only array under any key", '{"found":[{"text":"We make toys","source":"我们做玩具"}]}'],
  [
    "a brace inside a string",
    '{"claims":[{"statement":"We make toys","evidence":"我们做玩具"}],"note":"a } here"}',
  ],
];
for (const [name, answer] of wrapped)
  test(`the list is read from ${name}`, () => {
    assert.deepEqual(parseClaims(answer), one);
  });

test("an empty list is an answer: no statement about the sender, so the email passes", () => {
  for (const answer of ['{"claims":[]}', "[]", '```json\n{"claims": []}\n```', "None found: []"])
    assert.deepEqual(parseClaims(answer), [], answer);
  assert.deepEqual(unsupportedClaims([], [{ label: "memory", text: "" }]), []);
});

test("statements as plain strings have no evidence; unreadable items are dropped", () => {
  assert.deepEqual(parseClaims('{"claims":["We hold every certificate", 7, {"statement":""}]}'), [
    { statement: "We hold every certificate" },
  ]);
  assert.deepEqual(parseClaims('{"claims":[{"statement":"A","evidence":null}]}'), [
    { statement: "A", evidence: null },
  ]);
});

test("an answer with no list in it is none", () => {
  for (const answer of [
    "",
    "No statements.",
    '{"claims":"none"}',
    '[1, 2, {"x": 1}]',
    // Cut off: a partial list is not trusted.
    '{"claims":[{"statement":"A","evidence":""},{"statement":"B"',
  ])
    assert.equal(parseClaims(answer), null, answer);
});

test("an answer the check cannot read leaves its start in the API log, keys masked", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const answer = `I cannot help with that. sk-abc123secret ${"x".repeat(1000)}`;
  await modelFixture(t, () => ({ text: answer }));
  const check = await checkClaims("openai/fixture", email.arguments, [
    { label: "the person's task", text: prompt },
  ]);
  assert.equal(check.status, "unchecked");
  const logged = warnings.filter(([prefix]) => prefix === unreadPrefix);
  assert.equal(logged.length, 2, "one line per attempt");
  const entry = logged[0][1] as { attempt: number; length: number; start: string; events: object };
  assert.equal(entry.attempt, 1);
  assert.equal(entry.length, answer.length);
  assert.ok(entry.start.startsWith("I cannot help with that."));
  assert.ok(entry.start.length <= 500);
  assert.ok(!entry.start.includes("abc123secret"));
  assert.ok(Object.keys(entry.events).length, "the stream's event types are kept");
  assert.equal(answerForLog("short"), "short");
});

test("an email with no statement about the person goes to review, marked checked", async (t) => {
  const { task, actions } = await run(t, (index) => (index === 0 ? email : { text: "[]" }));
  assert.equal(task.status, "waiting_approval", task.error ?? task.question);
  assert.deepEqual(actions[0].claimCheck, { status: "checked", unsupported: [] });
});
