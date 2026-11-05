// Fork: wait_until lets a background run pace its own task. The run ends, the task is
// `scheduled` to run again after the minutes with the note in `state.wait`, and the worker picks
// it up when due. A one-off task then ends normally on finish_task; a repeating task's waiting
// run resumes once and its interval starts after it. Run now, pause/resume, cancel and the
// schedule controls work on a waiting task, and automatic continuation never follows a wait.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { waitNote } from "../apps/server/src/engine/model.ts";
import {
  type AgentNotification,
  currentWait,
  type TaskWait,
  taskWait,
  waitUntilSchema,
} from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

const owner = "wait-until-owner";
const resumeNote = "paused itself earlier with wait_until";
const continuation = "continues the task automatically";
/** In the first run after a wait only: pick up where the note leaves off. */
const freshNote = "Pick up the task where that note leaves off";
/** In later runs of the same task: the note's done steps stand, its next step may be done. */
const pastNote = "the next step it names may already have been done";
/** The old later-run hint that sent the model to a missing or older lastUpdate. */
const staleHint = /outdated|not by that note/;
/** The run started before the wait was over: the person chose Run now or Resume. */
const ranEarly = "The person chose to run it now";
/** In later runs: what the note says was done before the wait stays true. */
const doneStands = "Its note is still true about what was done before that wait";

async function app(t: TestContext, overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-wait-until-"));
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
    ...overrides,
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, db };
}
type App = Awaited<ReturnType<typeof app>>;
/** The task message (the user-role message) of a model request body. */
function taskMessage(body: string) {
  const { input } = JSON.parse(body) as {
    input: { role?: string; content: string | { text?: string }[] }[];
  };
  const message = input.find((item) => item.role === "user");
  assert.ok(message, "the request has a task message");
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");
}
/** The system instructions of a model request body (priorState is in there, as data). */
const instructions = (body: string) =>
  String((JSON.parse(body) as { instructions: string }).instructions);

/** Runs one worker tick and returns the model request bodies that run sent. */
async function tick({ server }: App, requests: { body: string }[]) {
  const from = requests.length;
  await server.agent.worker.tick();
  return requests.slice(from).map((request) => request.body);
}
/** Moves a waiting task's resume time (and its wait record with it) into the past. */
async function due({ server, db }: App, id: string) {
  const task = await server.agent.getTask(owner, id);
  const past = "2020-01-01T00:00:00.000Z";
  const wait = taskWait(task);
  const moved = await db.compareAndSwap(
    owner,
    "tasks",
    id,
    { status: task.status },
    {
      nextRunAt: past,
      ...(wait ? { state: { ...task.state, wait: { ...wait, until: past } } } : {}),
    },
  );
  assert.ok(moved, "the task did not change in between");
}
const near = (iso: string | undefined, minutes: number) => {
  const delta = Date.parse(iso ?? "") - (Date.now() + minutes * 60000);
  return Math.abs(delta) < 5000;
};

test("wait_until takes whole minutes from 1 to 1440 and a note", () => {
  assert.deepEqual(waitUntilSchema.parse({ minutes: 1, note: " Posted 1 of 3 " }), {
    minutes: 1,
    note: "Posted 1 of 3",
  });
  assert.equal(waitUntilSchema.parse({ minutes: 1440, note: "x" }).minutes, 1440);
  for (const bad of [
    { minutes: 0, note: "x" },
    { minutes: 1441, note: "x" },
    { minutes: 1.5, note: "x" },
    { minutes: 30, note: "  " },
    { minutes: 30 },
  ])
    assert.equal(waitUntilSchema.safeParse(bad).success, false, JSON.stringify(bad));
  // A wait is current only while its resume time is still the task's next run.
  const wait: TaskWait = { minutes: 5, note: "n", since: "a", until: "2026-10-10T02:40:00.000Z" };
  const task = { status: "scheduled" as const, nextRunAt: wait.until, state: { wait } };
  assert.deepEqual(currentWait(task), wait);
  const paused = { ...task, status: "paused" as const };
  assert.equal(currentWait(paused), null);
  assert.deepEqual(taskWait(paused), wait);
  assert.equal(currentWait({ ...task, nextRunAt: "2026-10-10T03:00:00.000Z" }), null);
  assert.equal(currentWait({ ...task, state: {} }), null);
});

test("waitNote: a due run waits again if needed; Run now skips the rest", () => {
  const now = new Date("2026-10-10T03:00:00.000Z");
  const wait = (until: string): TaskWait => ({
    minutes: 30,
    note: "Posted 1 of 2; post the second",
    since: "2026-10-10T02:30:00.000Z",
    until,
  });
  const due = waitNote(wait("2026-10-10T03:00:00.000Z"), now);
  assert.ok(!due.includes(ranEarly));
  assert.ok(!due.includes("Posted 1 of 2"), "the note stays in priorState, out of the message");
  assert.ok(waitNote(wait("2026-10-10T03:20:00.000Z"), now).includes(ranEarly), "Run now");
  // There is no limit on waits, so no run is ever told the person was asked about one.
  assert.ok(!due.includes("limit") && !due.includes("was asked instead"));
});

test("a one-off task waits, runs again when due with the note, and finish_task ends it", async (t) => {
  const note = "Posted 1 of 3 to r/example; post the next one.";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 30, note } }
      : { name: "finish_task", arguments: { summary: "Posted all three." } },
  );
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, {
    prompt: "Post three updates, 30 minutes apart",
  });

  const first = await tick(ctx, requests);
  assert.equal(first.length, 1, "the run ends at the wait");
  assert.ok(first[0].includes("wait_until"), "the model is offered the tool");
  assert.ok(first[0].includes("1440"), "with its bounds");
  let detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.ok(near(detail.task.nextRunAt, 30), detail.task.nextRunAt);
  const wait = detail.task.state.wait as TaskWait;
  assert.equal(wait.note, note);
  assert.equal(wait.minutes, 30);
  assert.equal(wait.until, detail.task.nextRunAt);
  assert.equal(detail.task.state.lastUpdate, note, "the note is the latest progress record");
  assert.deepEqual(currentWait(detail.task), wait);
  assert.ok(!detail.task.question);
  assert.equal(detail.task.repeatMinutes, null);
  assert.equal(detail.task.state.autoContinued, undefined, "no automatic continuation");
  const waiting = detail.events.find((event) => event.title === "Waiting 30 minutes");
  assert.equal(waiting?.kind, "status");
  assert.ok(waiting?.detail.includes(note));
  assert.ok(waiting?.detail.includes(`Resumes at ${wait.until}`));
  assert.ok(!detail.events.some((event) => /automatic/i.test(event.title)));
  // A wait asks nothing of the user.
  const notices = await ctx.db.list<AgentNotification>(owner, "notifications");
  assert.equal(notices.filter((notice) => notice.taskId === task.id).length, 0);

  // Not due yet: nothing runs.
  assert.equal((await tick(ctx, requests)).length, 0);

  await due(ctx, task.id);
  const resumed = await tick(ctx, requests);
  assert.equal(resumed.length, 1);
  assert.ok(resumed[0].includes(resumeNote), "the next run is told it resumes after a wait");
  assert.ok(taskMessage(resumed[0]).includes("priorState.wait.note"), "pointed to the note");
  // The model wrote the note, maybe from page content: it stays data in priorState.
  assert.ok(instructions(resumed[0]).includes(note), "the note is in priorState");
  assert.ok(!taskMessage(resumed[0]).includes(note), "and not in the task message");
  assert.ok(resumed[0].includes("Post three updates, 30 minutes apart"), "same prompt");
  assert.ok(!resumed[0].includes(continuation));
  assert.ok(!resumed[0].includes(ranEarly), "the wait ran its course");
  detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.result, "Posted all three.");
  assert.equal(currentWait(detail.task), null);
  assert.equal(detail.task.runs, 0, "a one-off task never counts repeating runs");
  // It is finished for good: nothing reschedules or runs it again.
  assert.equal((await tick(ctx, requests)).length, 0);
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
  const done = await ctx.db.list<AgentNotification>(owner, "notifications");
  assert.equal(done.filter((notice) => notice.title === task.title).length, 1);
});

test("Run now skips the wait; pause and resume keep it; cancel stops the task", async (t) => {
  const { requests } = await modelFixture(t, (index) => ({
    name: "wait_until",
    arguments: { minutes: index === 0 ? 30 : 45, note: `Wait ${index + 1}` },
  }));
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Comment twice, an hour apart" });
  await tick(ctx, requests);
  assert.equal((await server.agent.getTask(owner, task.id)).status, "scheduled");

  // Run now: the task is queued at once and the next tick runs it, wait or not.
  const queued = await server.agent.control(owner, task.id, "run");
  assert.equal(queued.status, "queued");
  assert.equal(currentWait(queued), null);
  await assert.rejects(() => server.agent.control(owner, task.id, "run"), /not waiting/);
  const ran = await tick(ctx, requests);
  assert.equal(ran.length, 1);
  assert.ok(ran[0].includes(resumeNote), "the run after Run now is told about the wait");
  assert.ok(ran[0].includes("Wait 1"), "with the skipped wait's note");
  assert.ok(ran[0].includes(ranEarly), "and told the person chose to run it now");
  let saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "scheduled");
  assert.ok(near(saved.nextRunAt, 45));
  assert.equal(saved.state.waits, 2, "Run now does not reset the count of waits");
  const detail = await server.agent.detail(owner, task.id);
  assert.ok(detail.events.some((event) => event.title === "Run requested"));

  // Pause during the wait, then resume: it goes back to the same wait instead of running.
  const nextRunAt = saved.nextRunAt;
  assert.equal((await server.agent.control(owner, task.id, "pause")).status, "paused");
  assert.equal((await tick(ctx, requests)).length, 0);
  const resumed = await server.agent.control(owner, task.id, "resume");
  assert.equal(resumed.status, "scheduled");
  assert.equal(resumed.nextRunAt, nextRunAt);
  assert.equal((await tick(ctx, requests)).length, 0, "still waiting");
  // Resumed after the wait would have ended: it runs now.
  await server.agent.control(owner, task.id, "pause");
  await due(ctx, task.id);
  assert.equal((await server.agent.control(owner, task.id, "resume")).status, "queued");
  assert.equal((await tick(ctx, requests)).length, 1);

  // Cancel a waiting task: it never runs again.
  saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "scheduled");
  const cancelled = await server.agent.control(owner, task.id, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, "Stopped by you.");
  await due(ctx, task.id);
  assert.equal((await tick(ctx, requests)).length, 0);
  await assert.rejects(() => server.agent.control(owner, task.id, "run"), /not waiting/);
});

test("a repeating task's wait moves only its next run; the run resumes and then repeats", async (t) => {
  const note = "Replied to 2 of 4 comments";
  let call = 0;
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 5, note } }
      : { name: "finish_task", arguments: { summary: `Done (call ${++call})` } },
  );
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, {
    title: "Reply to comments",
    prompt: "Reply to new comments, five minutes apart",
    repeatMinutes: 60,
  });
  await tick(ctx, requests);
  let detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.ok(near(detail.task.nextRunAt, 5), "the wait, not the 60-minute interval");
  assert.equal(detail.task.runs, 0, "the run is not finished");
  assert.equal(detail.task.state.runOpen, true);
  assert.equal((detail.task.state.wait as TaskWait).note, note);
  assert.ok(detail.events.some((event) => event.title === "Waiting 5 minutes"));

  await due(ctx, task.id);
  const resumed = await tick(ctx, requests);
  assert.ok(resumed[0].includes(resumeNote) && resumed[0].includes(note));
  detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled");
  assert.equal(detail.task.runs, 1);
  assert.equal(detail.task.result, "Done (call 1)");
  assert.ok(near(detail.task.nextRunAt, 60), "back on the interval");
  assert.equal(currentWait(detail.task), null);
  assert.equal(detail.events.filter((event) => event.title === "Run 1 started").length, 1);
  assert.ok(detail.events.some((event) => /^Run 1 finished/.test(event.title)));

  // The next run starts fresh, without the old note.
  await due(ctx, task.id);
  const fresh = await tick(ctx, requests);
  assert.ok(!fresh[0].includes(resumeNote));
  detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.runs, 2);
  assert.equal(detail.task.state.wait, undefined);
});

test("the schedule controls keep a waiting task's wait", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index < 2
      ? { name: "wait_until", arguments: { minutes: 20, note: `Step ${index + 1} done` } }
      : { name: "finish_task", arguments: { summary: "All done." } },
  );
  const ctx = await app(t);
  const { server } = ctx;
  // A repeating task told to stop repeating during its wait finishes that run as a one-off.
  const repeating = await server.agent.createTask(owner, {
    prompt: "Daily job",
    repeatMinutes: 60,
  });
  await tick(ctx, requests);
  let saved = await server.agent.getTask(owner, repeating.id);
  const nextRunAt = saved.nextRunAt;
  saved = await server.agent.updateTask(owner, repeating.id, { repeatMinutes: null });
  assert.equal(saved.status, "scheduled", "not completed while its run waits");
  assert.equal(saved.nextRunAt, nextRunAt);
  assert.ok(currentWait(saved));

  // A one-off task made to repeat during its wait keeps the wait; the resumed run is run 1.
  const once = await server.agent.createTask(owner, { prompt: "Two-step job" });
  await tick(ctx, requests);
  saved = await server.agent.getTask(owner, once.id);
  const onceNext = saved.nextRunAt;
  saved = await server.agent.updateTask(owner, once.id, { repeatMinutes: 120 });
  assert.equal(saved.status, "scheduled");
  assert.equal(saved.nextRunAt, onceNext);
  assert.equal(saved.state.runOpen, true);

  await due(ctx, repeating.id);
  await due(ctx, once.id);
  const bodies = await tick(ctx, requests);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.includes(resumeNote)));
  const stopped = await server.agent.getTask(owner, repeating.id);
  assert.equal(stopped.status, "succeeded", "finished as a one-off");
  const repeatsNow = await server.agent.getTask(owner, once.id);
  assert.equal(repeatsNow.status, "scheduled");
  assert.equal(repeatsNow.runs, 1);
  assert.ok(near(repeatsNow.nextRunAt, 120));
});

test("a wait is a real outcome: no automatic continuation, the counter resets, the answer stays", async (t) => {
  const note = "Posted the first comment; post the second.";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "ask_user", arguments: { question: "Which account?" } }
      : index < 3
        ? { name: "set_plan", arguments: { steps: ["Open the thread", "Post a comment"] } }
        : index === 3
          ? { name: "wait_until", arguments: { minutes: 10, note } }
          : { name: "finish_task", arguments: { summary: "Both comments posted." } },
  );
  const ctx = await app(t, { agentMaxSteps: 2 });
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Post two comments" });
  await tick(ctx, requests);
  assert.equal((await server.agent.getTask(owner, task.id)).status, "waiting_input");
  await server.agent.answer(owner, task.id, "Use the main account");

  // Two plan steps hit the cap without a completion call: continued automatically.
  await tick(ctx, requests);
  let saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.autoContinued, 1);

  // The continued run waits: the wait stands, auto-continue does not touch it.
  const continued = await tick(ctx, requests);
  assert.ok(continued[0].includes(continuation));
  let detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.ok(near(detail.task.nextRunAt, 10));
  assert.equal(detail.task.state.autoContinued, 0, "a wait resets the counter");
  assert.equal(detail.task.state.answer, "Use the main account", "the answer is kept");
  assert.ok(!detail.task.question);
  assert.equal(
    detail.events.filter((event) => event.title === "Continuing automatically").length,
    1,
    "the waiting run was not continued again",
  );
  assert.ok(!detail.events.some((event) => /^Waiting for you/.test(event.title)));

  await due(ctx, task.id);
  const resumed = await tick(ctx, requests);
  assert.ok(resumed[0].includes("Additional answer: Use the main account"));
  assert.ok(resumed[0].includes(resumeNote));
  assert.ok(!resumed[0].includes(continuation), "the run after a wait is not a continuation");
  detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "succeeded");
  saved = detail.task;
  assert.equal(saved.result, "Both comments posted.");
});

test("an out-of-range wait is refused to the model and nothing is scheduled", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 0, note: "too short" } }
      : index === 1
        ? { name: "wait_until", arguments: { minutes: 1441, note: "too long" } }
        : { name: "finish_task", arguments: { summary: "Done without waiting." } },
  );
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Do it" });
  const bodies = await tick(ctx, requests);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[1].includes("Input validation failed for tool wait_until"));
  assert.ok(bodies[2].includes("Input validation failed for tool wait_until"));
  const detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "succeeded");
  assert.equal(detail.task.state.wait, undefined);
  assert.ok(!detail.events.some((event) => /^Waiting/.test(event.title)));
});

// Review fix: only the first run after the wait picks up where the note leaves off. A later run of
// the same task (automatic continuation, after a question or an approval) is told the note's next
// step may already be done, so it does not repeat it (a duplicate post).
test("only the first run after a wait is told to continue from its note", async (t) => {
  const note = "Posted 1 of 3; post the next one";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 30, note } }
      : index < 3
        ? { name: "set_plan", arguments: { steps: ["Post #2", "Wait", "Post #3"] } }
        : index === 3
          ? { name: "ask_user", arguments: { question: "Which flair for #3?" } }
          : { name: "finish_task", arguments: { summary: "Posted all three." } },
  );
  const ctx = await app(t, { agentMaxSteps: 2 });
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Post three updates" });
  await tick(ctx, requests);
  await due(ctx, task.id);

  // The run after the wait gets the note as its instruction and marks the wait resumed.
  const resumed = await tick(ctx, requests);
  assert.equal(resumed.length, 2, "two plan steps, then the step cap");
  assert.ok(resumed[0].includes(freshNote), "the first run after the wait continues from it");
  assert.ok(!resumed[0].includes(pastNote));
  let saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "queued", "continued automatically");
  const wait = saved.state.wait as TaskWait;
  assert.ok(wait.resumedAt, "the wait is marked resumed when its run starts");
  assert.equal(taskWait(saved), null, "a resumed wait is no longer a wait");

  // The automatic continuation: the old note is history, not an instruction.
  const continued = await tick(ctx, requests);
  assert.equal(continued.length, 1);
  assert.ok(continued[0].includes(continuation));
  assert.ok(!continued[0].includes(freshNote), "continuation run includes stale wait note");
  assert.ok(!continued[0].includes(resumeNote));
  assert.ok(continued[0].includes(pastNote), "it is told the next step may already be done");
  assert.doesNotMatch(continued[0], staleHint);
  saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "waiting_input");
  assert.equal((saved.state.wait as TaskWait).resumedAt, wait.resumedAt, "marked once");

  // After an answer too.
  await server.agent.answer(owner, task.id, "Use the Update flair");
  const answered = await tick(ctx, requests);
  assert.ok(answered[0].includes("Additional answer: Use the Update flair"));
  assert.ok(!answered[0].includes(freshNote));
  assert.ok(answered[0].includes(pastNote));
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
});

// Review fix: a one-off task paused during its wait and then made to repeat keeps its open run:
// resume continues it (note, answer and operations kept) as run 1 instead of starting over.
test("a one-off task paused in its wait and made to repeat keeps its run open", async (t) => {
  const note = "Posted 1 of 2; post the second";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 30, note } }
      : { name: "finish_task", arguments: { summary: "Posted both." } },
  );
  const ctx = await app(t);
  const { server, db } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Post twice, 30 minutes apart" });
  await tick(ctx, requests);
  // Some work the first run cached and an answer it was given stay with the open run.
  let saved = await server.agent.getTask(owner, task.id);
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "scheduled" },
    { state: { ...saved.state, answer: "Use r/example", operations: { k: "posted #1" } } },
  );
  assert.equal((await server.agent.control(owner, task.id, "pause")).status, "paused");
  saved = await server.agent.updateTask(owner, task.id, { repeatMinutes: 120 });
  assert.equal(saved.status, "paused");
  assert.equal(saved.state.runOpen, true, "the paused waiting run stays open");
  assert.ok(taskWait(saved), "and keeps its wait");

  await server.agent.control(owner, task.id, "resume");
  const ran = await tick(ctx, requests);
  assert.equal(ran.length, 1);
  assert.ok(ran[0].includes(freshNote), "resumed run sees wait note");
  assert.ok(ran[0].includes(note));
  assert.ok(ran[0].includes("Additional answer: Use r/example"), "the answer is kept");
  assert.ok(ran[0].includes("posted #1"), "the operations cache is kept");
  assert.ok(ran[0].includes(ranEarly), "the person cut the wait short");
  const detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.runs, 1, "the resumed run is run 1");
  assert.ok(near(detail.task.nextRunAt, 120));
  assert.ok(!detail.events.some((event) => event.title === "Run 1 started"), "not restarted");
  assert.ok(detail.events.some((event) => /^Run 1 finished/.test(event.title)));
});

// Re-review fix: Repeat this task tapped while the run that then waits is still running (the UI
// offers it on a running task). The task had no wait yet, so updateTask wrote nothing; the run
// after the wait used to be a fresh run 1 with a wiped state and the bare prompt, so the model
// started the job over (post #1 again). wait() now leaves the run open whatever the repeat
// setting is when it ends.
/** A one-off task whose model call `at` taps Repeat this task (every 60 minutes) while its run is
 * still running and then calls wait_until; the calls before it wait too, later calls finish. */
async function repeatTappedMidRun(t: TestContext, at: number) {
  const notes = Array.from({ length: at + 1 }, (_, i) => `Posted #${i + 1}; post #${i + 2} next`);
  let ctx: App | undefined;
  let id = "";
  const seen: string[] = [];
  const { requests } = await modelFixture(t, async (index) => {
    const running = ctx;
    if (index === at && running) {
      seen.push((await running.server.agent.getTask(owner, id)).status);
      await running.server.agent.updateTask(owner, id, { repeatMinutes: 60 });
    }
    return index <= at
      ? { name: "wait_until", arguments: { minutes: 30, note: notes[index] } }
      : { name: "finish_task", arguments: { summary: "Posted all." } };
  });
  ctx = await app(t);
  const { server } = ctx;
  id = (await server.agent.createTask(owner, { prompt: "Post three times, 30 minutes apart" })).id;
  for (let run = 0; run <= at; run++) {
    if (run > 0) await due(ctx, id);
    assert.equal((await tick(ctx, requests)).length, 1);
  }
  assert.deepEqual(seen, ["running"], "Repeat this task was tapped during the run");
  const saved = await server.agent.getTask(owner, id);
  assert.equal(saved.repeatMinutes, 60);
  assert.equal(saved.state.runOpen, true, "the run that waited stays open");
  assert.equal((saved.state.wait as TaskWait).note, notes[at]);
  return { ctx, id, requests, note: notes[at], saved };
}
/** The next run continues the open run as run 1 with its note instead of starting over. */
async function checkContinuedAsRun1({
  ctx,
  id,
  requests,
  note,
}: Awaited<ReturnType<typeof repeatTappedMidRun>>) {
  const resumed = await tick(ctx, requests);
  assert.equal(resumed.length, 1);
  assert.ok(resumed[0].includes(resumeNote), "not the bare prompt");
  assert.ok(resumed[0].includes(freshNote), "it picks up where the note leaves off");
  assert.ok(taskMessage(resumed[0]).includes("priorState.wait.note"), "pointed to the note");
  assert.ok(instructions(resumed[0]).includes(`"note":${JSON.stringify(note)}`), "note kept");
  assert.ok(instructions(resumed[0]).includes(`"lastUpdate":${JSON.stringify(note)}`));
  const detail = await ctx.server.agent.detail(owner, id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.runs, 1, "the run that waited is run 1");
  assert.equal(detail.task.result, "Posted all.");
  assert.ok(near(detail.task.nextRunAt, 60), "then the interval");
  assert.equal(detail.task.state.runOpen, false, "and that run is closed");
  assert.ok(detail.events.some((event) => event.title === "Repeats every 60 min"));
  assert.ok(
    !detail.events.some((event) => /^Run \d+ started$/.test(event.title)),
    "no fresh run was started",
  );
  assert.ok(detail.events.some((event) => /^Run 1 finished/.test(event.title)));
  return resumed[0];
}

test("Repeat this task during the run that calls wait_until continues that run as run 1", async (t) => {
  const run = await repeatTappedMidRun(t, 0);
  assert.equal(run.saved.status, "scheduled", run.saved.error ?? run.saved.question);
  assert.ok(near(run.saved.nextRunAt, 30), "the wait, not the 60-minute interval");
  assert.ok(currentWait(run.saved));
  await due(run.ctx, run.id);
  await checkContinuedAsRun1(run);
});

test("Repeat this task during the run after a wait, which waits again, continues it as run 1", async (t) => {
  const run = await repeatTappedMidRun(t, 1);
  assert.equal(run.saved.status, "scheduled", run.saved.error ?? run.saved.question);
  assert.ok(near(run.saved.nextRunAt, 30), "the second wait, not the interval");
  assert.equal(run.saved.state.waits, 2);
  await due(run.ctx, run.id);
  await checkContinuedAsRun1(run);
});

test("Stop repeating on a task that never repeated changes nothing", async (t) => {
  const { requests } = await modelFixture(t, () => ({
    name: "wait_until",
    arguments: { minutes: 30, note: "Step 1 done" },
  }));
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "One-off job" });
  await tick(ctx, requests);
  const before = await server.agent.getTask(owner, task.id);
  const after = await server.agent.updateTask(owner, task.id, { repeatMinutes: null });
  assert.deepEqual(after, before);
  const detail = await server.agent.detail(owner, task.id);
  assert.ok(!detail.events.some((event) => event.title === "Repeating stopped"));
  assert.ok(currentWait(detail.task));
});

// Waits have no limit. The owner sees a wait as the task's state and can
// pause or cancel the task; nothing turns a wait into a question, and AGENT_MAX_WAITS is gone.
test("AGENT_MAX_WAITS is not read: waits have no limit of the server's own", (t) => {
  const keys = ["AGENT_MAX_WAITS", "CPK_INTELLIGENCE_API_KEY"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const value of ["1", "100", "many"]) {
    process.env.AGENT_MAX_WAITS = value;
    const config = readConfig();
    assert.ok(!("agentMaxWaits" in config), value);
  }
});

test("a task waits as often as it needs: never a question, never a chat card, never notified", async (t) => {
  const waits = 6;
  const { requests } = await modelFixture(t, (index) =>
    index < waits
      ? { name: "wait_until", arguments: { minutes: 1, note: `Checked ${index + 1} times` } }
      : { name: "finish_task", arguments: { summary: "The reply arrived." } },
  );
  const ctx = await app(t);
  const { server, db } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Wait for a reply" });
  for (let run = 0; run < waits; run++) {
    if (run > 0) await due(ctx, task.id);
    const bodies = await tick(ctx, requests);
    assert.equal(bodies.length, 1);
    const saved = await server.agent.getTask(owner, task.id);
    assert.equal(saved.status, "scheduled", saved.question);
    assert.equal(saved.state.waits, run + 1, "the count is a fact on the task");
    assert.ok(currentWait(saved));
    for (const body of bodies) assert.ok(!body.includes("limit of waits"));
  }
  const detail = await server.agent.detail(owner, task.id);
  assert.ok(!detail.events.some((event) => /^Waiting for you/.test(event.title)));
  assert.equal(
    detail.events.filter((event) => /^Waiting 1 minute$/.test(event.title)).length,
    waits,
    "each wait stays a run event in the timeline",
  );
  // No chat card and no notification for any of them: a wait is state, not a report.
  const cards = (await db.list<{ taskId: string }>(owner, "chat-reports")).filter(
    (card) => card.taskId === task.id,
  );
  assert.equal(cards.length, 0);
  const notices = await db.list<AgentNotification>(owner, "notifications");
  assert.equal(notices.filter((notice) => notice.taskId === task.id).length, 0);
  // The maintenance replay does not report the wait either.
  await (server.agent as unknown as { maintain(): Promise<void> }).maintain();
  assert.equal(
    (await db.list<{ taskId: string }>(owner, "chat-reports")).filter(
      (card) => card.taskId === task.id,
    ).length,
    0,
  );
  await due(ctx, task.id);
  await tick(ctx, requests);
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
});

// Review fix: a run after a post-wait run that failed, was paused or was interrupted is not sent
// to a missing or older progress record. wait() writes the note to lastUpdate too, and the
// message keeps the note's done steps and says its next step may already be done.
test("a run after a failed post-wait run and Retry checks the note's next step", async (t) => {
  const note = "Posted 1 of 2; post the second";
  const { requests } = await modelFixture(
    t,
    (index) =>
      index === 0
        ? { name: "wait_until", arguments: { minutes: 30, note } }
        : { name: "finish_task", arguments: { summary: "Posted both." } },
    { errorStatus: (index) => (index === 1 ? 400 : undefined) },
  );
  const ctx = await app(t);
  const { server } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Post twice" });
  await tick(ctx, requests);
  await due(ctx, task.id);
  const failed = await tick(ctx, requests);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].includes(freshNote));
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.state.lastUpdate, note, "the failed run left no update; the note stands");
  await server.agent.control(owner, task.id, "retry");
  const retried = await tick(ctx, requests);
  assert.ok(!retried[0].includes(freshNote), "the retry is not told to pick up from it");
  assert.ok(retried[0].includes(pastNote));
  assert.ok(taskMessage(retried[0]).includes(doneStands), "the note's done steps stand");
  assert.doesNotMatch(retried[0], staleHint);
  assert.ok(instructions(retried[0]).includes(`"lastUpdate":${JSON.stringify(note)}`));
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
});

/** Waits, then interrupts the run after the wait mid-run and lets the task run again. */
async function interruptedPostWaitRun(
  t: TestContext,
  interrupt: (ctx: App, id: string) => Promise<unknown>,
) {
  const note = "Posted 1 of 2; post the second";
  let ctx: App | undefined;
  let id = "";
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0) return { name: "wait_until", arguments: { minutes: 30, note } };
    if (index === 1 && ctx) await interrupt(ctx, id);
    return index === 1
      ? { name: "set_plan", arguments: { steps: ["Post #2"] } }
      : { name: "finish_task", arguments: { summary: "Posted both." } };
  });
  ctx = await app(t);
  const { server } = ctx;
  id = (await server.agent.createTask(owner, { prompt: "Post twice, 30 minutes apart" })).id;
  await tick(ctx, requests);
  await due(ctx, id);
  const interrupted = await tick(ctx, requests);
  assert.equal(interrupted.length, 1);
  assert.ok(interrupted[0].includes(freshNote));
  const saved = await server.agent.getTask(owner, id);
  assert.ok((saved.state.wait as TaskWait).resumedAt, "the run after the wait had started");
  assert.equal(saved.state.lastUpdate, note, "an interrupted run leaves no update of its own");
  return { ctx, id, requests, note, saved };
}
async function checkRunAfterInterruption({
  ctx,
  id,
  requests,
  note,
}: Awaited<ReturnType<typeof interruptedPostWaitRun>>) {
  const again = await tick(ctx, requests);
  assert.equal(again.length, 1);
  assert.ok(!again[0].includes(freshNote), "it is not told to pick up from the note");
  assert.ok(again[0].includes(pastNote), "it is told the note's next step may already be done");
  assert.doesNotMatch(again[0], staleHint);
  // What the note says is done ("Posted 1 of 2") stays true, and the note is still there to read.
  assert.ok(taskMessage(again[0]).includes(doneStands), "the note's done steps stand");
  assert.ok(taskMessage(again[0]).includes("priorState.wait"), "pointed to the note");
  assert.ok(
    instructions(again[0]).includes(`"note":${JSON.stringify(note)}`),
    "kept in priorState",
  );
  // The progress record it is pointed to exists and is not older than the note.
  assert.ok(instructions(again[0]).includes("priorState.lastUpdate"));
  assert.ok(instructions(again[0]).includes(`"lastUpdate":${JSON.stringify(note)}`));
  assert.equal((await ctx.server.agent.getTask(owner, id)).status, "succeeded");
}

test("a run after a post-wait run paused mid-run checks the note's next step", async (t) => {
  const run = await interruptedPostWaitRun(t, ({ server }, id) =>
    server.agent.control(owner, id, "pause"),
  );
  assert.equal(run.saved.status, "paused");
  assert.equal((await run.ctx.server.agent.control(owner, run.id, "resume")).status, "queued");
  await checkRunAfterInterruption(run);
});

test("a run after a post-wait run cut off by a worker restart checks the note's next step", async (t) => {
  const run = await interruptedPostWaitRun(t, async ({ server }, id) =>
    server.agent.worker.abort(owner, id),
  );
  assert.equal(run.saved.status, "queued", "the worker queues an interrupted run again");
  await checkRunAfterInterruption(run);
});

// Review fix: a repeating task told to stop repeating during its wait finishes that run as a
// one-off run; the finished run is closed, so Repeat this task later starts a fresh run instead
// of continuing it with its old answer and wait note.
test("a run finished as a one-off after Stop repeating is closed; Repeat this task starts fresh", async (t) => {
  const note = "Posted 1 of 2; post the second";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 30, note } }
      : { name: "finish_task", arguments: { summary: `Done (call ${index})` } },
  );
  const ctx = await app(t);
  const { server, db } = ctx;
  const task = await server.agent.createTask(owner, { prompt: "Post twice", repeatMinutes: 60 });
  await tick(ctx, requests);
  let saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.state.runOpen, true);
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "scheduled" },
    { state: { ...saved.state, answer: "Use r/example" } },
  );
  saved = await server.agent.updateTask(owner, task.id, { repeatMinutes: null });
  assert.equal(saved.status, "scheduled", "the waiting run still finishes");
  await due(ctx, task.id);
  const last = await tick(ctx, requests);
  assert.ok(last[0].includes(resumeNote));
  saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded", "finished as a one-off");
  assert.equal(saved.state.runOpen, false, "and the run is closed");

  saved = await server.agent.updateTask(owner, task.id, { repeatMinutes: 60 });
  assert.equal(saved.status, "scheduled");
  await due(ctx, task.id);
  const fresh = await tick(ctx, requests);
  assert.equal(fresh.length, 1);
  assert.ok(!fresh[0].includes(resumeNote) && !fresh[0].includes(pastNote), "no old wait note");
  assert.ok(!fresh[0].includes("Additional answer"), "no old answer");
  const detail = await server.agent.detail(owner, task.id);
  assert.equal(detail.task.status, "scheduled", detail.task.error ?? detail.task.question);
  assert.equal(detail.task.state.wait, undefined, "a fresh state");
  assert.equal(detail.task.state.answer, undefined);
  assert.equal(
    detail.events.filter((event) => /^Run \d+ started$/.test(event.title)).length,
    2,
    "a new run was started",
  );
});
