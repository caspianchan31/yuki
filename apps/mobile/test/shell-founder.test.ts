// The 创始人 panel's logic: GET /api/founder read
// defensively, a project moved up or down in the owner's order, job and task words, one card per
// project with the overview's counts, the loop line, and the chat report's speaker line.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import { projectToRead } from "../../../packages/client/src/shell/accounts/accounts-core.ts";
import {
  activityWhy,
  cardState,
  countsLine,
  founderCard,
  founderCards,
  founderJobWord,
  founderLoopTask,
  founderRefOf,
  founderState,
  loopLine,
  moveInOrder,
  normalizeFounder,
  priorityNote,
  priorityRows,
  quietCard,
  reportSpeaker,
  showsFounderSection,
  speakerInitial,
  splitQuiet,
  taskStatusWord,
} from "../../../packages/client/src/shell/founder/founder-core.ts";
import {
  jobRowLine,
  jobToolLine,
  jobToolView,
} from "../../../packages/client/src/shell/jobs/jobs-core.ts";
import type { ProjectOverview } from "../../../packages/client/src/shell/model.ts";
import { serverText } from "../../../packages/client/src/shell/strings.ts";

const payload = {
  founder: {
    environmentId: "env-f",
    name: "Nova_Harrison",
    persona: { who: { value: "founder", source: "owner" } },
    goal: "grow",
    plan: 3,
    loop: { taskId: "loop-1", status: "scheduled", nextRunAt: "2026-10-15T10:00:00.000Z" },
  },
  priorities: [
    { projectId: "p2", name: "Beta", rank: 2, set: true },
    { projectId: "p1", name: "Alpha", rank: 1, set: true },
    { projectId: "p3", name: "Gamma", rank: 3, set: false },
    { name: "no id" },
  ],
  projects: [
    {
      projectId: "p3",
      name: "Gamma",
      founderJobs: [],
      actions7d: 0,
      stuck: [{ taskId: "t9", title: "Post daily", status: "failed" }],
    },
    {
      projectId: "p1",
      name: "Alpha",
      founderJobs: [
        {
          jobId: "j1",
          title: "Write launch post",
          status: "taken",
          due: { text: "周五", at: null },
        },
        { jobId: "j2", title: "Reply comments", status: "assigned", due: null },
        { title: "no id" },
      ],
      actions7d: 4,
      stuck: [],
    },
    { projectId: "p2", name: "Beta", founderJobs: "x", actions7d: "y", stuck: null },
  ],
};

const overview: ProjectOverview[] = [
  {
    id: "p1",
    name: "Alpha",
    accounts: 2,
    counts: { needsYou: 1, running: 2, queued: 0, waiting: 3, scheduled: 0, failed7d: 0 },
    lastActivityAt: null,
  },
  {
    id: null,
    name: "未分组",
    accounts: 1,
    counts: { needsYou: 0, running: 0, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 },
    lastActivityAt: null,
  },
];

test("GET /api/founder reads defensively", () => {
  const data = normalizeFounder(payload);
  assert.ok(data);
  assert.deepEqual(data.founder, {
    environmentId: "env-f",
    name: "Nova_Harrison",
    goal: "grow",
    plan: 3,
    loop: { taskId: "loop-1", status: "scheduled", nextRunAt: "2026-10-15T10:00:00.000Z" },
  });
  // By rank; a row without an id is dropped.
  assert.deepEqual(
    data.priorities.map((item) => item.projectId),
    ["p1", "p2", "p3"],
  );
  const alpha = data.projects.find((item) => item.projectId === "p1");
  assert.deepEqual(alpha?.founderJobs, [
    { jobId: "j1", title: "Write launch post", status: "taken", due: "周五" },
    { jobId: "j2", title: "Reply comments", status: "assigned", due: null },
  ]);
  const beta = data.projects.find((item) => item.projectId === "p2");
  assert.deepEqual(beta, {
    projectId: "p2",
    name: "Beta",
    actions7d: 0,
    founderJobs: [],
    stuck: [],
  });

  // No founder, no loop, nonsense.
  const none = normalizeFounder({ founder: null, priorities: [], projects: [] });
  assert.deepEqual(none, { founder: null, priorities: [], projects: [] });
  assert.equal(normalizeFounder({ founder: { name: "x" } })?.founder, null);
  assert.equal(
    normalizeFounder({ founder: { environmentId: "e", name: "n", loop: null } })?.founder?.loop,
    null,
  );
  assert.equal(normalizeFounder(null), null);
  assert.equal(normalizeFounder("x"), null);
  assert.equal(normalizeFounder({ other: 1 }), null);
});

test("a project moves one place up or down; the ends and unknown ids stay put", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual(moveInOrder(order, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInOrder(order, "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveInOrder(order, "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(order, "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(order, "z", 1), ["a", "b", "c"]);
  assert.deepEqual(order, ["a", "b", "c"], "the input is not changed");
});

test("job and task states read in the shell's words", () => {
  assert.equal(founderJobWord("assigned"), "已派");
  assert.equal(founderJobWord("taken"), "在做");
  assert.equal(founderJobWord("declined"), "没接");
  assert.equal(founderJobWord("done"), "做完了");
  assert.equal(founderJobWord("odd"), "odd");
  assert.equal(taskStatusWord("waiting_input"), "等你回答");
  assert.equal(taskStatusWord("failed"), "失败");
});

test("one card per project in the owner's order, with the overview's counts", () => {
  const data = normalizeFounder(payload);
  assert.ok(data);
  const cards = founderCards(data, overview);
  assert.deepEqual(
    cards.map((card) => [card.rank, card.name]),
    [
      [1, "Alpha"],
      [2, "Beta"],
      [3, "Gamma"],
    ],
  );
  const [alpha, beta, gamma] = cards;
  assert.deepEqual(alpha?.counts, { needsYou: 1, running: 2, waiting: 3 });
  assert.equal(
    countsLine(alpha?.counts ?? { needsYou: 0, running: 0, waiting: 0 }, false),
    "需要你 1 · 运行 2 · 等待 3",
  );
  // No worker heartbeat: nothing runs.
  assert.equal(
    countsLine(alpha?.counts ?? { needsYou: 0, running: 0, waiting: 0 }, true),
    "需要你 1 · 后台停着 · 等待 3",
  );
  assert.equal(
    countsLine({ needsYou: 0, running: 0, waiting: 1 }, true),
    "需要你 0 · 运行 0 · 等待 1",
  );
  assert.equal(alpha?.actions7d, 4);
  assert.deepEqual(
    alpha?.jobs.map((job) => job.line),
    ["Write launch post · 周五 · 在做", "Reply comments · 已派"],
  );
  assert.equal(beta?.counts, null, "a project the overview does not list has no counts");
  assert.deepEqual(gamma?.stuck, [
    { taskId: "t9", title: "Post daily", line: "Post daily · 失败" },
  ]);
  // No overview yet: no counts anywhere.
  assert.ok(founderCards(data, null).every((card) => card.counts === null));
  // A project the order does not list comes last.
  const extra = founderCards(
    {
      ...data,
      projects: [
        { projectId: "p9", name: "New", founderJobs: [], actions7d: 0, stuck: [] },
        ...data.projects,
      ],
    },
    overview,
  );
  assert.equal(extra.at(-1)?.projectId, "p9");
});

test("the loop line says 此刻 and 下次", () => {
  const clock = (iso: string) => (iso.startsWith("2026") ? "18:00" : "");
  assert.deepEqual(
    loopLine({ taskId: "l", status: "scheduled", nextRunAt: "2026-10-15T10:00:00Z" }, clock, false),
    {
      now: "已排期",
      next: "18:00",
    },
  );
  assert.deepEqual(loopLine({ taskId: "l", status: "running", nextRunAt: null }, clock, false), {
    now: "运行中",
    next: "未排",
  });
  // No worker heartbeat: a running loop does not move; a scheduled one still says when.
  assert.deepEqual(loopLine({ taskId: "l", status: "running", nextRunAt: null }, clock, true), {
    now: "后台停着",
    next: "未排",
  });
  assert.equal(
    loopLine({ taskId: "l", status: "scheduled", nextRunAt: "2026-10-15T10:00:00Z" }, clock, true)
      ?.now,
    "已排期",
  );
  assert.equal(loopLine(null, clock, false), null);
});

test("a report speaks as its account; the founder is tagged; the default desktop is unchanged", () => {
  assert.deepEqual(reportSpeaker({ name: "Nova_Harrison", view: {} }), {
    name: "Nova_Harrison",
    initial: "N",
    founder: false,
  });
  assert.deepEqual(reportSpeaker({ name: "pop", view: { founder: true } }), {
    name: "pop",
    initial: "P",
    founder: true,
  });
  assert.equal(reportSpeaker(null), null);
  assert.equal(reportSpeaker({ name: "  " }), null);
  assert.equal(speakerInitial("宇神"), "宇");
  assert.equal(speakerInitial("@alpha"), "A");
  assert.equal(speakerInitial("😀x"), "😀");
});

test("the account view keeps the founder flag only when it is set", () => {
  const base = { id: "e1", name: "a", status: "running", projectId: null };
  assert.equal(normalizeEnvironment({ ...base, founder: true }).founder, true);
  assert.equal("founder" in normalizeEnvironment(base), false);
  assert.equal("founder" in normalizeEnvironment({ ...base, founder: "yes" }), false);
});

test("the founder's 409 reads in plain Chinese", () => {
  assert.equal(
    serverText(
      "The founder belongs to the space, in no project: move this account to 未分组 first",
    ),
    "创始人属于整个空间，不在任何群里：先把这个号退回未分组。",
  );
});

test("the priority list shows the top five; the rest fold (never just one)", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  assert.deepEqual(priorityRows(ids, false), { shown: ids.slice(0, 5), hidden: 3 });
  assert.deepEqual(priorityRows(ids, true), { shown: ids, hidden: 0 });
  assert.deepEqual(priorityRows(ids.slice(0, 6), false), { shown: ids.slice(0, 6), hidden: 0 });
  assert.deepEqual(priorityRows(ids.slice(0, 3), false), { shown: ids.slice(0, 3), hidden: 0 });
  assert.deepEqual(priorityRows([], false), { shown: [], hidden: 0 });
});

test("a card's state comes first: 卡住 n, 需要你 n, never 一切正常; quiet projects fold", () => {
  const data = normalizeFounder(payload);
  assert.ok(data);
  const [alpha, beta, gamma] = founderCards(data, overview);
  assert.ok(alpha && beta && gamma);
  assert.deepEqual(cardState(alpha), {
    chips: [{ tone: "amber", label: "需要你 1" }],
    fine: false,
  });
  assert.deepEqual(cardState(gamma), { chips: [{ tone: "red", label: "卡住 1" }], fine: false });
  // A server that does not say whether anything acts: no chip, and never 「一切正常」.
  assert.deepEqual(cardState(beta), { chips: [], fine: false });
  assert.equal(quietCard(beta), true, "no job, no action, nothing stuck, nothing for you");
  assert.equal(quietCard(alpha), false);
  assert.equal(quietCard(gamma), false);
  const { active, quiet } = splitQuiet([alpha, beta, gamma]);
  assert.deepEqual(
    active.map((card) => card.name),
    ["Alpha", "Gamma"],
  );
  assert.deepEqual(
    quiet.map((card) => card.name),
    ["Beta"],
  );
  assert.equal(quietCard({ ...beta, actions7d: 2 }), false, "activity alone keeps it shown");
  assert.equal(
    quietCard({ ...beta, counts: { needsYou: 1, running: 0, waiting: 0 } }),
    false,
    "something waiting on the owner keeps it shown",
  );
});

test("a job given to the founder says 派给了创始人 …", () => {
  const data = normalizeFounder(payload);
  const founder = founderRefOf(data);
  assert.deepEqual(founder, { environmentId: "env-f", name: "Nova_Harrison" });
  assert.equal(founderRefOf(normalizeFounder({ founder: null, priorities: [] })), null);
  const made = jobToolView({
    jobId: "j1",
    title: "推 AcmeGame",
    accounts: [{ name: "nova_harrison", status: "assigned" }],
  });
  assert.equal(
    jobToolLine("create_job", made, founder),
    "新活「推 AcmeGame」派给了创始人 nova_harrison。",
  );
  assert.equal(jobToolLine("create_job", made, null), "新活「推 AcmeGame」派给了 nova_harrison。");
  const two = jobToolView({
    jobId: "j1",
    title: "推 S",
    accounts: [
      { name: "Pop", status: "assigned" },
      { name: "Nova_Harrison", status: "assigned" },
    ],
  });
  assert.equal(
    jobToolLine("assign_job", two, founder),
    "「推 S」现在派给 Pop、创始人 Nova_Harrison。",
  );
  assert.equal(
    jobToolLine("assign_job", { ...two, insisted: ["Nova_Harrison"] }, founder),
    "「推 S」又派给了创始人 Nova_Harrison：它会知道你看过它的理由。",
  );
  // The live panel's row: by the account id, so a renamed founder still reads as the founder.
  const row = jobRowLine(
    {
      id: "j1",
      title: "推 S",
      brief: "",
      due: null,
      everyone: false,
      assignees: [
        {
          envId: "env-f",
          name: "Renamed",
          status: "taken",
          reason: null,
          note: null,
          ownerInsisted: false,
          at: "",
          live: true,
        },
      ],
      status: "open",
      origin: null,
      createdAt: "",
      updatedAt: "",
      doneAt: null,
      archivedAt: null,
      closedReason: null,
      version: 1,
    },
    founder,
  );
  assert.equal(row.detail, "派给创始人 Renamed · 1 个在做");
});

// The 创始人 panel is folded into the founder's card.
test("创始人 leads to the founder's own card; only the founder's card holds the founder section", () => {
  const data = normalizeFounder(payload);
  assert.deepEqual(founderCard(data?.founder), { kind: "account", environmentId: "env-f" });
  assert.equal(founderCard(null), null);
  assert.equal(founderCard(normalizeFounder({ founder: null, priorities: [] })?.founder), null);
  const ref = { environmentId: "env-f" };
  assert.equal(showsFounderSection({ id: "env-f" }, ref), true);
  assert.equal(showsFounderSection({ id: "env-x", view: { founder: true } }, null), true);
  assert.equal(showsFounderSection({ id: "env-x", view: {} }, ref), false);
  assert.equal(showsFounderSection({ id: "env-x" }, { environmentId: null }), false);
});

test("the founder's card opens from any project: an account in no project is read in 未分组", () => {
  // In this project's topology: its own project.
  assert.equal(projectToRead({ projectId: "p1" }, "p1"), "p1");
  // Not in it (the founder, in no project): 未分组.
  assert.equal(projectToRead(undefined, "p1"), null);
  // Already in 未分组 and not there: gone.
  assert.equal(projectToRead(undefined, null), undefined);
});

// The founder layer tells the truth: her loop's real state, 「没人在做」 per
// project with why, and an order the owner never set.
const at = Date.parse("2026-10-20T01:00:00Z");
const founderWith = (loop: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
  const data = normalizeFounder({
    founder: { environmentId: "env-f", name: "Nova", goal: null, plan: null, loop, ...extra },
    priorities: [],
    projects: [],
  });
  assert.ok(data?.founder);
  return data.founder;
};

test("the founder's state is her loop's: running, waiting, stopped with why, or 没在经营", () => {
  // A loop that failed days ago is still stopped, in plain words, never 「创始人」 or idle.
  const failed = founderWith({
    taskId: "loop",
    status: "failed",
    nextRunAt: null,
    updatedAt: "2026-10-18T04:00:39Z",
    error: "empty_stream",
    attempts: 110,
  });
  assert.deepEqual(failed.loop, {
    taskId: "loop",
    status: "failed",
    nextRunAt: null,
    updatedAt: "2026-10-18T04:00:39Z",
    error: "empty_stream",
    attempts: 110,
  });
  const stopped = founderState(failed, at, false);
  assert.equal(stopped.state, "needs");
  assert.equal(stopped.line, "经营停了");
  assert.match(stopped.detail ?? "", /^经营停了：/);
  assert.ok(!/empty_stream/.test(stopped.detail ?? ""), "the reason is in the owner's words");
  assert.equal(stopped.phase?.stopped, true);
  assert.equal(founderLoopTask(failed)?.input.accountLoop, true);
  // Paused: the owner's own decision, never a need; it reads as paused.
  const paused = founderState(
    founderWith({ taskId: "loop", status: "paused", nextRunAt: null }),
    at,
    false,
  );
  assert.deepEqual([paused.state, paused.line], ["idle", "已暂停"]);
  // Running; with no worker heartbeat it does not move.
  const running = founderWith({ taskId: "loop", status: "running", nextRunAt: null });
  assert.deepEqual(
    [founderState(running, at, false).state, founderState(running, at, false).line],
    ["running", "正在做"],
  );
  assert.deepEqual(
    [founderState(running, at, true).state, founderState(running, at, true).line],
    ["waiting", "后台停着"],
  );
  // Waiting for its next run: when.
  const until = "2026-10-20T02:30:00Z";
  const waiting = founderState(
    founderWith({
      taskId: "loop",
      status: "scheduled",
      nextRunAt: until,
      state: { wait: { minutes: 90, note: "n", since: "2026-10-20T01:00:00Z", until } },
    }),
    at,
    false,
  );
  assert.equal(waiting.state, "waiting");
  assert.match(waiting.line, /继续（等待）$/);
  // Retrying an infrastructure incident by itself: 卡住, with what fails.
  const blocked = founderState(
    founderWith({
      taskId: "loop",
      status: "scheduled",
      nextRunAt: until,
      state: { incident: { kind: "model", since: "2026-10-20T00:00:00Z" } },
    }),
    at,
    false,
  );
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.line, /^模型服务连不上 1 小时了$/);
  // No loop: 没在经营 when she has nothing to work on, else 停着 (unknown is never a need).
  assert.deepEqual(
    [founderState(founderWith(null, { hasWork: false }), at, false).line],
    ["没在经营"],
  );
  assert.equal(founderState(founderWith(null, { hasWork: false }), at, false).state, "needs");
  assert.deepEqual(
    [
      founderState(founderWith(null), at, false).state,
      founderState(founderWith(null), at, false).line,
    ],
    ["idle", "停着"],
  );
  // A loop the system ended (no goal, no job left) reads as no loop.
  assert.equal(
    founderState(
      founderWith({ taskId: "loop", status: "succeeded", nextRunAt: null }, { hasWork: false }),
      at,
      false,
    ).line,
    "没在经营",
  );
});

test("a project where nothing acts says 没人在做 and why, never 一切正常", () => {
  const data = normalizeFounder({
    founder: null,
    priorities: [
      { projectId: "a", name: "Acting", rank: 1, set: false },
      { projectId: "n", name: "Nobody", rank: 2, set: false },
      { projectId: "s", name: "Silent", rank: 3, set: false },
      { projectId: "i", name: "Idle", rank: 4, set: false },
    ],
    projects: [
      {
        projectId: "a",
        name: "Acting",
        founderJobs: [],
        actions7d: 3,
        stuck: [],
        working: 1,
        lastActionAt: "2026-10-19T20:00:00Z",
        idle: [],
        activity: "acting",
      },
      {
        projectId: "n",
        name: "Nobody",
        founderJobs: [],
        actions7d: 0,
        stuck: [],
        working: 0,
        lastActionAt: null,
        idle: [],
        activity: "nobody",
      },
      {
        projectId: "s",
        name: "Silent",
        founderJobs: [],
        actions7d: 0,
        stuck: [],
        working: 1,
        lastActionAt: null,
        idle: [],
        activity: "silent",
      },
      {
        projectId: "i",
        name: "Idle",
        founderJobs: [],
        actions7d: 0,
        stuck: [],
        working: 0,
        lastActionAt: "2026-10-13T17:49:00Z",
        idle: ["Pine_Example_3"],
        activity: "nobody",
      },
    ],
  });
  assert.ok(data);
  const overviewOf = (id: string, needsYou: number): ProjectOverview => ({
    id,
    name: id,
    accounts: 1,
    counts: { needsYou, running: 0, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 },
    lastActivityAt: null,
  });
  const cards = founderCards(
    data,
    [overviewOf("a", 0), overviewOf("n", 0), overviewOf("s", 0), overviewOf("i", 1)],
    at,
  );
  const [acting, nobody, silent, idle] = cards;
  assert.ok(acting && nobody && silent && idle);
  assert.deepEqual(cardState(acting), { chips: [], fine: true });
  assert.deepEqual(cardState(nobody).chips, [{ tone: "grey", label: "没人在做" }]);
  assert.equal(nobody.why, "没有号在经营，也没有在跑的任务");
  assert.deepEqual(cardState(silent).chips, [{ tone: "grey", label: "没人在做" }]);
  assert.equal(silent.why, "在跑，但还没在网站上做过事");
  assert.deepEqual(
    cardState(idle).chips.map((chip) => chip.label),
    ["需要你 1", "没人在做"],
  );
  assert.equal(idle.why, "Pine_Example_3 没在经营");
  // A silent project stays shown; a project with nothing at all folds under 没人在做.
  const { active, quiet } = splitQuiet(cards);
  assert.deepEqual(
    active.map((card) => card.name),
    ["Acting", "Silent", "Idle"],
  );
  assert.deepEqual(
    quiet.map((card) => card.name),
    ["Nobody"],
  );
  // Days since the last action, at least one.
  assert.equal(
    activityWhy(
      {
        projectId: "x",
        name: "x",
        founderJobs: [],
        actions7d: 0,
        stuck: [],
        activity: "silent",
        lastActionAt: "2026-10-16T00:00:00Z",
      },
      at,
    ),
    "在跑，但 4 天没在网站上做事",
  );
  assert.equal(activityWhy({ ...data.projects[0], activity: "acting" }, at), null);
  // Unset priorities read 「未设置（按名称）」; once any is placed there is no note.
  assert.equal(priorityNote(data.priorities), "未设置（按名称）");
  assert.equal(priorityNote([{ set: true }, { set: false }]), null);
  assert.equal(priorityNote([]), null);
});
