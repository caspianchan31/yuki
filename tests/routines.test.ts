// v1.4 routines (docs/routines.md): triggers and their next run in the member's time zone, the
// limit of 50 per member, the history of the last 20 runs, edit, test run, and the mail trigger
// (one run per new matching message, never for old mail, a failing inbox fails with its reason).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { Mail } from "../packages/domain/src/index.ts";
import {
  defaultRoutineZone,
  mailIsNew,
  mailMatches,
  nextRoutineRun,
  routineLimitSentence,
  routineRunNote,
  routineWhenLine,
} from "../packages/domain/src/routines.ts";
import { modelFixture } from "./helpers/model.ts";

const config = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  model: "openai/fixture",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const owner = "routine-owner";
async function harness(t: Parameters<typeof modelFixture>[0], reply = "Done", finish: object = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-routines-"));
  const db = await createStore();
  let run = 0;
  const model = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: `${reply} ${++run}`, ...finish },
  }));
  const server = await createApp(db, config(directory));
  const due = (id: string) =>
    db.compareAndSwap(
      owner,
      "tasks",
      id,
      { status: "scheduled" },
      { nextRunAt: "2020-01-01T00:00:00Z" },
    );
  const get = (id: string) => server.agent.getTask(owner, id);
  const close = async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { server, db, due, get, close, requests: model.requests };
}
const mail = (id: string, date: string, over: Partial<Mail> = {}): Mail => ({
  id,
  threadId: id,
  from: "boss@example.com",
  sender: "Boss",
  to: ["me@example.com"],
  subject: `Subject ${id}`,
  body: `Body of ${id}`,
  date,
  unread: true,
  label: "Inbox",
  attachments: [],
  ...over,
});

test("next run: every, daily and weekly in the member's zone, mail has none", () => {
  const from = new Date("2026-11-03T00:00:00Z"); // 09:00 in Tokyo, 08:00 in Shanghai
  assert.equal(
    nextRoutineRun({ type: "every", minutes: 90 }, "UTC", from),
    "2026-11-03T01:30:00.000Z",
  );
  assert.equal(
    nextRoutineRun({ type: "daily", at: "09:30" }, "Asia/Tokyo", from),
    "2026-11-03T00:30:00.000Z",
  );
  // The clock has passed today in Tokyo (09:00 now): tomorrow.
  assert.equal(
    nextRoutineRun({ type: "daily", at: "09:00" }, "Asia/Tokyo", from),
    "2026-11-04T00:00:00.000Z",
  );
  // The same clock is another instant in another zone.
  assert.equal(
    nextRoutineRun({ type: "daily", at: "09:00" }, "Asia/Shanghai", from),
    "2026-11-03T01:00:00.000Z",
  );
  // Is a Tuesday: the next Monday/Wednesday at 09:00 New York (EST, UTC-5).
  assert.equal(
    nextRoutineRun({ type: "weekly", at: "09:00", days: [1, 3] }, "America/New_York", from),
    "2026-11-04T14:00:00.000Z",
  );
  assert.equal(
    nextRoutineRun({ type: "weekly", at: "09:00", days: [1] }, "America/New_York", from),
    "2026-11-09T14:00:00.000Z",
  );
  // Daylight saving: the New York clock jumps; 09:00 stays 09:00 local.
  assert.equal(
    nextRoutineRun(
      { type: "daily", at: "09:00" },
      "America/New_York",
      new Date("2026-03-08T15:00:00Z"),
    ),
    "2026-03-09T13:00:00.000Z",
  );
  assert.equal(nextRoutineRun({ type: "mail" }, "UTC", from), null);
  assert.equal(nextRoutineRun({ type: "daily", at: "09:00" }, "Mars/Base", from), null);
});

test("the when-line and the mail filters", () => {
  assert.equal(routineWhenLine({ type: "every", minutes: 30 }), "每 30 分钟");
  assert.equal(routineWhenLine({ type: "every", minutes: 120 }), "每 2 小时");
  assert.equal(routineWhenLine({ type: "daily", at: "09:00" }), "每天 09:00");
  assert.equal(
    routineWhenLine({ type: "weekly", at: "08:30", days: [3, 1, 1] }),
    "每周一、三 08:30",
  );
  assert.equal(routineWhenLine({ type: "mail" }), "收到新邮件时");
  assert.equal(
    routineWhenLine({ type: "mail", from: "boss", subjectHas: "发票" }),
    "收到新邮件时（发件人含「boss」，主题含「发票」）",
  );
  const trigger = { type: "mail" as const, from: "BOSS", subjectHas: "invoice" };
  assert.ok(mailMatches(trigger, { from: "boss@x.com", subject: "Your Invoice" }));
  assert.ok(!mailMatches(trigger, { from: "other@x.com", subject: "Your Invoice" }));
  assert.ok(!mailMatches(trigger, { from: "boss@x.com", subject: "Hello" }));
  const cursor = { at: "2026-11-03T10:00:00.000Z", ids: ["a"] };
  assert.ok(!mailIsNew(cursor, { id: "b", date: "2026-11-03T09:59:00Z" }));
  assert.ok(!mailIsNew(cursor, { id: "a", date: "2026-11-03T10:00:00Z" }));
  assert.ok(mailIsNew(cursor, { id: "b", date: "2026-11-03T10:00:00Z" }));
  assert.ok(mailIsNew(cursor, { id: "c", date: "2026-11-03T10:00:01Z" }));
});

test("a clock routine waits for its clock in the account's zone, and the run records its cause", async (t) => {
  const h = await harness(t);
  const zone = defaultRoutineZone; // no computer, so no zone of her own
  try {
    const account = await h.server.environments.create(owner, {
      name: "Tokyo",
    });
    const made = await h.server.agent.routines.create(owner, {
      name: "晨报",
      instruction: "整理昨天的情况",
      trigger: { type: "daily", at: "09:00" },
      input: { environmentId: account.id },
    });
    assert.equal(made.status, "scheduled");
    assert.equal(made.repeatMinutes, 1440);
    const expected = nextRoutineRun({ type: "daily", at: "09:00" }, zone, new Date());
    assert.equal(made.nextRunAt, expected);
    // Not due: a tick changes nothing.
    await h.server.agent.worker.tick();
    assert.equal((await h.get(made.id)).runs, 0);
    // Test: runs now, recorded as a test, and the clock is kept.
    const queued = await h.server.agent.control(owner, made.id, "run");
    assert.equal(queued.status, "queued");
    assert.deepEqual((queued.input.run as { cause: string }).cause, "test");
    await h.server.agent.worker.tick();
    let task = await h.get(made.id);
    assert.equal(task.status, "scheduled", task.error ?? task.question);
    assert.equal(task.runs, 1);
    assert.equal(task.routine?.history.length, 1);
    assert.equal(task.routine?.history[0]?.cause, "test");
    assert.equal(task.routine?.history[0]?.status, "succeeded");
    assert.equal(task.routine?.history[0]?.summary, "Done 1");
    assert.ok(!("run" in task.input), "the cause is cleared with the run");
    assert.ok(task.nextRunAt && Date.parse(task.nextRunAt) > Date.now());
    // The next, scheduled run has the cause schedule.
    await h.due(made.id);
    await h.server.agent.worker.tick();
    task = await h.get(made.id);
    assert.equal(task.routine?.history[0]?.cause, "schedule");
    assert.equal(task.routine?.history.length, 2);
    // Pause and resume go back to waiting for the clock; they do not run now.
    await h.server.agent.control(owner, made.id, "pause");
    const resumed = await h.server.agent.control(owner, made.id, "resume");
    assert.equal(resumed.status, "scheduled");
    assert.equal(resumed.nextRunAt, expected);
    await h.server.agent.worker.tick();
    assert.equal((await h.get(made.id)).runs, 2);
  } finally {
    await h.close();
  }
});

test("a member has at most 50 routines; the 51st is refused, others and deleted ones do not count", async (t) => {
  const h = await harness(t);
  try {
    const account = await h.server.environments.create(owner, { name: "Ann" });
    const make = (n: number, environmentId?: string) =>
      h.server.agent.routines.create(owner, {
        name: `例行 ${n}`,
        instruction: "做点事",
        trigger: { type: "daily", at: "08:00" },
        input: environmentId ? { environmentId } : {},
      });
    const first = await make(0);
    for (let n = 1; n < 50; n++) await make(n);
    await assert.rejects(
      () => make(50),
      (error: Error) => error.message === routineLimitSentence,
    );
    // Another member's routines are counted apart.
    await make(0, account.id);
    // Deleting one makes room.
    await h.server.agent.control(owner, first.id, "cancel");
    await make(51);
    await assert.rejects(() => make(52), /最多 50 个例行/);
  } finally {
    await h.close();
  }
});

test("the history keeps the last 20 runs, newest first", async (t) => {
  const h = await harness(t, "Run");
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "常跑",
      instruction: "跑一下",
      trigger: { type: "every", minutes: 5 },
    });
    for (let n = 1; n <= 23; n++) {
      await h.server.agent.worker.tick();
      assert.equal((await h.get(made.id)).runs, n);
      await h.due(made.id);
    }
    const task = await h.get(made.id);
    assert.equal(task.routine?.history.length, 20);
    assert.equal(task.routine?.history[0]?.summary, "Run 23");
    assert.equal(task.routine?.history[19]?.summary, "Run 4");
    assert.ok(
      task.routine?.history.every(
        (run) => run.endedAt >= run.startedAt && run.cause === "schedule",
      ),
    );
  } finally {
    await h.close();
  }
});

test("editing changes name, instruction and trigger, moves the next run, and not a running one", async (t) => {
  const h = await harness(t);
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "旧名",
      instruction: "旧指令",
      trigger: { type: "daily", at: "09:00" },
    });
    const edited = await h.server.agent.routines.update(owner, made.id, {
      name: "新名",
      instruction: "新指令",
      trigger: { type: "weekly", at: "07:15", days: [1, 5] },
    });
    assert.equal(edited.title, "新名");
    assert.equal(edited.prompt, "新指令");
    assert.equal(edited.repeatMinutes, 10080);
    assert.deepEqual(edited.routine?.trigger, { type: "weekly", at: "07:15", days: [1, 5] });
    assert.equal(
      edited.nextRunAt,
      nextRoutineRun({ type: "weekly", at: "07:15", days: [1, 5] }, "Asia/Shanghai", new Date()),
    );
    // To a mail trigger: no next run, a cursor starting now.
    const mailed = await h.server.agent.routines.update(owner, made.id, {
      trigger: { type: "mail" },
    });
    assert.equal(mailed.status, "scheduled");
    assert.ok(!mailed.nextRunAt);
    assert.ok(mailed.routine?.mail && Date.parse(mailed.routine.mail.at) <= Date.now());
    await assert.rejects(() => h.server.agent.routines.update(owner, made.id, {}), /没有要改/);
    await assert.rejects(() =>
      h.server.agent.routines.update(owner, made.id, { trigger: { type: "daily", at: "25:00" } }),
    );
    // A routine's time is not changed with the plain repeat endpoint.
    await assert.rejects(
      () => h.server.agent.updateTask(owner, made.id, { repeatMinutes: 5 }),
      /修改/,
    );
    // Not while a run is open.
    await h.server.agent.control(owner, made.id, "run");
    await assert.rejects(
      () => h.server.agent.routines.update(owner, made.id, { name: "x" }),
      /正在跑/,
    );
  } finally {
    await h.close();
  }
});

test("a mail routine fires once per new matching message, never for old mail", async (t) => {
  const h = await harness(t, "Handled");
  try {
    const before = new Date(Date.now() - 3600_000).toISOString();
    await h.db.put(owner, "mail", mail("old", before));
    const made = await h.server.agent.routines.create(owner, {
      name: "老板来信",
      instruction: "把来信整理成要点",
      trigger: { type: "mail", from: "boss" },
    });
    assert.equal(made.status, "scheduled");
    assert.ok(!made.nextRunAt);
    await h.server.agent.worker.tick();
    assert.equal((await h.get(made.id)).runs, 0, "a mail routine never runs by the clock");
    // Old mail does not fire.
    await h.server.agent.routines.pollMail();
    assert.equal((await h.get(made.id)).status, "scheduled");

    const t1 = new Date(Date.now() + 1000).toISOString();
    const t2 = new Date(Date.now() + 2000).toISOString();
    await h.db.put(owner, "mail", mail("m1", t1));
    await h.db.put(owner, "mail", mail("m2", t2, { subject: "Second" }));
    await h.db.put(owner, "mail", mail("other", t2, { from: "spam@example.com", sender: "Spam" }));
    await h.server.agent.routines.pollMail();
    let task = await h.get(made.id);
    assert.equal(task.status, "queued");
    const run = task.input.run as { cause: string; mail: { id: string; subject: string } };
    assert.equal(run.cause, "mail:m1");
    assert.equal(run.mail.subject, "Subject m1");
    // A look while the run is open changes nothing: m2 waits.
    await h.server.agent.routines.pollMail();
    assert.deepEqual((await h.get(made.id)).input.run, task.input.run);

    const from = h.requests.length;
    await h.server.agent.worker.tick();
    task = await h.get(made.id);
    assert.equal(task.status, "scheduled", task.error ?? task.question);
    assert.ok(!task.nextRunAt);
    assert.equal(task.routine?.history[0]?.cause, "mail:m1");
    // The run read the message's facts.
    const sent = h.requests
      .slice(from)
      .map((request) => request.body)
      .join("\n");
    assert.match(sent, /Subject m1/);
    assert.match(sent, /boss@example\.com/);

    // The next look picks m2 (one run per message), and then nothing is left.
    await h.server.agent.routines.pollMail();
    assert.equal((await h.get(made.id)).status, "queued");
    await h.server.agent.worker.tick();
    await h.server.agent.routines.pollMail();
    task = await h.get(made.id);
    assert.equal(task.status, "scheduled");
    assert.equal(task.runs, 2);
    assert.deepEqual(
      task.routine?.history.map((entry) => entry.cause),
      ["mail:m2", "mail:m1"],
    );
  } finally {
    await h.close();
  }
});

test("an inbox that cannot be read fails the routine with the reason, once, and fires nothing", async (t) => {
  const h = await harness(t);
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "来信",
      instruction: "看来信",
      trigger: { type: "mail" },
    });
    await h.db.put(owner, "mail", mail("new", new Date(Date.now() + 1000).toISOString()));
    const search = h.server.agent.workspace.searchMail.bind(h.server.agent.workspace);
    h.server.agent.workspace.searchMail = async () => {
      throw new Error("The IMAP server could not be reached");
    };
    await h.server.agent.routines.pollMail();
    await h.server.agent.routines.pollMail();
    let task = await h.get(made.id);
    assert.equal(task.status, "scheduled", "nothing fired from old data");
    assert.equal(task.routine?.history.length, 1, "the same reason is recorded once");
    assert.equal(task.routine?.history[0]?.status, "failed");
    assert.equal(task.routine?.history[0]?.summary, "The IMAP server could not be reached");
    assert.equal(task.error, "The IMAP server could not be reached");
    // The source comes back: the message fires, and the failure is cleared.
    h.server.agent.workspace.searchMail = search;
    await h.server.agent.routines.pollMail();
    task = await h.get(made.id);
    assert.equal(task.status, "queued");
    assert.equal(task.error, null);
    assert.equal(task.routine?.sourceError, null);
  } finally {
    await h.close();
  }
});

test("routines over HTTP: make, edit, test, and the snapshot carries the routine", async (t) => {
  const h = await harness(t);
  try {
    const token = (
      await (
        await h.server.app.request("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()
    ).token as string;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await h.server.app.request(`/api/agent${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const made = await call("POST", "/routines", {
      name: "周报",
      instruction: "写周报",
      trigger: { type: "weekly", at: "17:00", days: [5] },
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.title, "周报");
    assert.equal((await call("POST", "/routines", { name: "x" })).status >= 400, true);
    const edited = await call("PATCH", `/routines/${made.body.id}`, { name: "周报 v2" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.title, "周报 v2");
    const snapshot = await call("GET", "");
    const listed = (snapshot.body.tasks as AgentTask[]).find((task) => task.id === made.body.id);
    assert.equal(listed?.routine?.trigger.type, "weekly");
  } finally {
    await h.close();
  }
});

const reportsOf = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.db.list<{ text: string; title: string }>(owner, "chat-reports")).filter(
    (report) => report.title !== "Connected",
  );

test("a routine run that has nothing new ends quiet: kept in its history, nothing in the chat", async (t) => {
  // One model fixture at a time: each sets the provider the app talks to.
  const reported = async (finish: object, reply: string) => {
    const h = await harness(t, reply, finish);
    try {
      const made = await h.server.agent.routines.create(owner, {
        name: "订单",
        instruction: "看有没有新订单",
        trigger: { type: "every", minutes: 60 },
      });
      await h.due(made.id);
      await h.server.agent.worker.tick();
      const task = await h.get(made.id);
      assert.equal(task.status, "scheduled");
      assert.equal(task.routine?.history[0]?.status, "succeeded");
      assert.match(task.routine?.history[0]?.summary ?? "", new RegExp(reply), "kept in history");
      return {
        reports: (await reportsOf(h)).length,
        notices: (await h.db.list(owner, "notifications")).length,
        asked: h.requests[0]?.body ?? "",
      };
    } finally {
      await h.close();
    }
  };
  const loud = await reported({}, "Found two new orders");
  const quiet = await reported({ quiet: true }, "Nothing new");
  assert.equal(loud.reports, 1, "a run with something to say reports it");
  assert.equal(quiet.reports, 0, "a quiet run posts nothing");
  assert.equal(quiet.notices, 0);
  // The run is told how to stay quiet, and that it speaks casually when there is something.
  assert.match(quiet.asked, /quiet/);
});

test("a routine's run that calls wait_until is told to finish: its schedule brings the next run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-routines-"));
  const db = await createStore();
  const model = await modelFixture(t, (index) =>
    index === 0
      ? { name: "wait_until", arguments: { minutes: 1385, note: "下一轮明早 9 点" } }
      : { name: "finish_task", arguments: { summary: "早安" } },
  );
  const server = await createApp(db, config(directory));
  try {
    const made = await server.agent.routines.create(owner, {
      name: "早安",
      instruction: "跟我说一句早安",
      trigger: { type: "daily", at: "09:00" },
    });
    await db.compareAndSwap(
      owner,
      "tasks",
      made.id,
      { status: "scheduled" },
      { nextRunAt: "2020-01-01T00:00:00Z" },
    );
    await server.agent.worker.tick();
    const task = await server.agent.getTask(owner, made.id);
    assert.equal(task.routine?.history[0]?.status, "succeeded", "the run is in its history");
    assert.ok(!task.state.runOpen, "no run left open");
    assert.ok(!task.state.wait, "no wait of its own");
    assert.match(model.requests[1]?.body ?? "", /comes from its schedule/);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("quiet is only for a routine's run: any other task still reports", async (t) => {
  const h = await harness(t, "Done", { quiet: true });
  try {
    const task = await h.server.agent.createTask(owner, { prompt: "Say hello" });
    await h.server.agent.worker.tick();
    assert.equal((await h.get(task.id)).status, "succeeded");
    assert.equal((await reportsOf(h)).length, 1);
  } finally {
    await h.close();
  }
});

test("an @skill in a routine's instruction is named to the run, which reads it with use_skill", async (t) => {
  const h = await harness(t);
  try {
    await h.server.agent.skills.save(
      owner,
      { name: "Weekly digest", description: "Use this when a digest is due", steps: "1. Collect" },
      "sentence",
    );
    const made = await h.server.agent.routines.create(owner, {
      name: "周报",
      instruction: "每周五 run @Weekly digest and tell me only what changed",
      trigger: { type: "every", minutes: 60 },
    });
    await h.due(made.id);
    await h.server.agent.worker.tick();
    const body = h.requests[0]?.body ?? "";
    assert.match(body, /Weekly digest/);
    assert.match(body, /use_skill/);
    assert.match(body, /指向技能/);
  } finally {
    await h.close();
  }
});

test("the same refused sign-in on two runs in a row pauses the routine and names the app once", async (t) => {
  const h = await harness(t);
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "查邮件",
      instruction: "看邮件",
      trigger: { type: "every", minutes: 60 },
    });
    h.server.agent.skills.list = async () => {
      throw new Error("Google sign-in expired. Connect again.");
    };
    await h.due(made.id);
    await h.server.agent.worker.tick();
    let task = await h.get(made.id);
    assert.equal(task.status, "scheduled", "the first time it is only recorded");
    assert.equal(task.routine?.authBlock?.app, "google");
    assert.equal(task.routine?.history[0]?.status, "failed");
    await h.due(made.id);
    await h.server.agent.worker.tick();
    task = await h.get(made.id);
    assert.equal(task.status, "paused");
    assert.equal(task.routine?.authBlock?.paused, true);
    const told = (await reportsOf(h)).filter((report) => report.text.includes("暂停"));
    assert.equal(told.length, 1, "one message names the app");
    assert.match(told[0]?.text ?? "", /重新连接/);
  } finally {
    await h.close();
  }
});

test("a different failure the second time does not pause the routine", async (t) => {
  const h = await harness(t);
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "查邮件",
      instruction: "看邮件",
      trigger: { type: "every", minutes: 60 },
    });
    let message = "Google sign-in expired. Connect again.";
    h.server.agent.skills.list = async () => {
      throw new Error(message);
    };
    await h.due(made.id);
    await h.server.agent.worker.tick();
    message = "The network dropped";
    await h.due(made.id);
    await h.server.agent.worker.tick();
    const task = await h.get(made.id);
    assert.equal(task.status, "scheduled");
    assert.equal(task.routine?.authBlock ?? null, null);
  } finally {
    await h.close();
  }
});

test("a mail routine whose inbox refuses us at two looks in a row is paused", async (t) => {
  const h = await harness(t);
  try {
    const made = await h.server.agent.routines.create(owner, {
      name: "来信",
      instruction: "看来信",
      trigger: { type: "mail" },
    });
    h.server.agent.workspace.searchMail = async () => {
      throw new Error("The mailbox refused its password (IMAP sign-in failed)");
    };
    await h.server.agent.routines.pollMail();
    assert.equal((await h.get(made.id)).status, "scheduled");
    await h.server.agent.routines.pollMail();
    const task = await h.get(made.id);
    assert.equal(task.status, "paused");
    assert.equal(task.routine?.authBlock?.app, "mailbox");
    assert.match(String((task.state.notice as { body: string }).body), /邮箱/);
  } finally {
    await h.close();
  }
});

test("a connected app's tool that answers 401 as an error result counts as a refused sign-in: two runs pause the routine", async (t) => {
  // The MCP tool returns { error } (it never throws), so the run has to read it from the result.
  const directory = await mkdtemp(join(tmpdir(), "openmuse-routines-"));
  const db = await createStore();
  const model = await modelFixture(t, (index) =>
    index % 2 === 0
      ? { name: "app_fake__lookup", arguments: {} }
      : { name: "finish_task", arguments: { summary: "查不到，登录被拒了" } },
  );
  const server = await createApp(db, config(directory));
  try {
    server.apps.runTools = async () => [
      {
        app: { id: "mcp:fake", name: "Fake" },
        name: "app_fake__lookup",
        description: "[Fake] look something up",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          error:
            'Streamable HTTP error: Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}',
        }),
      },
    ];
    const made = await server.agent.routines.create(owner, {
      name: "查资料",
      instruction: "用 Fake 查资料",
      trigger: { type: "every", minutes: 60 },
    });
    const due = () =>
      db.compareAndSwap(
        owner,
        "tasks",
        made.id,
        { status: "scheduled" },
        { nextRunAt: "2020-01-01T00:00:00Z" },
      );
    await due();
    await server.agent.worker.tick();
    let task = await server.agent.getTask(owner, made.id);
    assert.equal(
      task.routine?.history[0]?.status,
      "failed",
      "the refused run is recorded as failed",
    );
    assert.equal(task.routine?.authBlock?.app, "mcp:fake");
    assert.equal(task.status, "scheduled", "the first time it is only recorded");
    await due();
    await server.agent.worker.tick();
    task = await server.agent.getTask(owner, made.id);
    assert.equal(task.status, "paused");
    assert.equal(task.routine?.authBlock?.paused, true);
    assert.ok(model.requests.length >= 4);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Yuki's own routine (the space's scope, no account) made in her chat runs on its clock and reports in that chat", async (t) => {
  const h = await harness(t, "早安");
  try {
    const made = await h.server.agent.routines.create(
      owner,
      {
        name: "每日早安问候",
        instruction: "跟我说一句早安",
        trigger: { type: "daily", at: "09:00" },
      },
      { originThreadId: "hall-thread" },
    );
    assert.equal(made.status, "scheduled");
    assert.equal(
      made.nextRunAt,
      nextRoutineRun({ type: "daily", at: "09:00" }, "Asia/Shanghai", new Date()),
      "no account and no desktop zone: Beijing time",
    );
    await h.due(made.id);
    await h.server.agent.worker.tick();
    const task = await h.get(made.id);
    assert.equal(task.status, "scheduled", task.error ?? task.question);
    assert.equal(task.routine?.history[0]?.cause, "schedule");
    const reports = (
      await h.db.list<{ threadId: string; taskId: string; title: string }>(owner, "chat-reports")
    ).filter((report) => report.taskId === made.id);
    assert.ok(reports.length > 0, "the run reports");
    assert.ok(reports.every((report) => report.threadId === "hall-thread"));
  } finally {
    await h.close();
  }
});

test("a run is never weighed against the clock in its instruction: a test runs as if it were time", () => {
  const test = routineRunNote("test");
  assert.match(test, /不管现在几点/);
  assert.match(routineRunNote("schedule"), /不要再核对现在几点/);
  assert.doesNotMatch(routineRunNote("mail:1", null), /不管现在几点|不要再核对/);
});
