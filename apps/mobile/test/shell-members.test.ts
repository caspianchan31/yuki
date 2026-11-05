// The members bar's model: each member's state from what its
// tasks do, the one line under its name, the order (founder, the accounts here or each project,
// the 运营专员), and an incident kept for hours read as 「桌面没响应 2 小时了」, not as all well.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFounder } from "../../../packages/client/src/shell/founder/founder-core.ts";
import {
  accountLine,
  accountMember,
  accountRoutine,
  accountState,
  founderMember,
  members,
  projectMember,
} from "../../../packages/client/src/shell/members/members-core.ts";
import { absentPacing, normalizePacing } from "../../../packages/client/src/shell/model.ts";

const now = Date.parse("2026-10-17T02:00:00Z");
const phase = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  label: "",
  needsYou: false,
  ended: false,
  ...over,
});
const account = (over: Record<string, unknown> = {}) =>
  ({
    id: "a1",
    name: "Nova_Harrison",
    flags: [],
    incident: null,
    now: null,
    tasks: [],
    next: null,
    desktop: "stopped",
    view: {},
    pacing: absentPacing,
    ...over,
  }) as never;

test("an account's state and line follow its live tasks", () => {
  assert.equal(accountState(account()), "idle");
  assert.equal(accountLine(account(), now), "停着");
  // A paused routine reads 已暂停 (its phase word, as in 此刻), not 停着; a running desktop with
  // nothing running on it is not 正在做.
  const paused = account({
    desktop: "running",
    now: {
      entry: { phase: phase("pause", { label: "已暂停" }), task: { title: "日常运营" } },
      more: 0,
    },
  });
  assert.equal(accountState(paused), "idle");
  assert.equal(accountLine(paused, now), "已暂停");
  assert.equal(accountLine(account({ desktop: "running" }), now), "停着");
  const running = account({
    now: { entry: { phase: phase("run"), task: { title: "发帖" } }, more: 0 },
  });
  assert.equal(accountState(running), "running");
  assert.equal(accountLine(running, now), "正在做");
  // Queued is not 正在做: it waits for the worker (the face row, the table and 进度汇报 agree).
  const queued = account({
    now: {
      entry: { phase: phase("queue", { label: "排队中" }), task: { title: "日常运营" } },
      more: 0,
    },
  });
  assert.equal(accountState(queued), "waiting");
  assert.equal(accountLine(queued, now), "排队中");
  // With no worker heartbeat (the red bar) a run is not 正在做: nothing moves.
  assert.equal(accountState(running, true), "waiting");
  assert.equal(accountLine(running, now, true), "后台停着");
  assert.equal(accountLine(queued, now, true), "排队中");
  const card = accountMember(running, now, false, true);
  assert.deepEqual([card.state, card.line], ["waiting", "后台停着"]);
  const waiting = account({
    now: { entry: { phase: phase("sched"), task: { title: "x" } }, more: 0 },
    next: { at: "2026-10-17T02:10:00Z", label: "02:10 再跑" },
  });
  assert.equal(accountState(waiting), "waiting");
  assert.equal(accountLine(waiting, now), "02:10 再跑");
  const blocked = account({
    now: { entry: { phase: phase("sched"), task: { title: "x" } }, more: 0 },
    incident: { kind: "desktop", since: "2026-10-16T23:30:00Z" },
  });
  assert.equal(accountState(blocked), "blocked");
  assert.equal(accountLine(blocked, now), "桌面没响应 2 小时 30 分了");
  const needs = account({ flags: ["proxyDown"], incident: { kind: "desktop", since: "x" } });
  assert.equal(accountState(needs), "needs");
  assert.ok(accountLine(needs, now).length > 0);
  const asked = account({
    now: {
      entry: { phase: phase("input", { needsYou: true, label: "等你回答" }), task: { title: "x" } },
      more: 0,
    },
  });
  assert.equal(accountState(asked), "needs");
  assert.equal(accountLine(asked, now), "等你回答");
});

test("a project in the hall stands for its accounts, by its counts", () => {
  const counts = { needsYou: 0, running: 0, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 };
  const p = (over: Partial<typeof counts>, accounts = 1, stalled = false) =>
    projectMember(
      { id: "p1", name: "acmeskills", accounts, counts: { ...counts, ...over } },
      stalled,
    );
  assert.deepEqual([p({ needsYou: 2 }).state, p({ needsYou: 2 }).line], ["needs", "等你 2 件"]);
  // A failure in 需要你 is in needsYou already (taskPhaseCounts): counted once.
  assert.equal(p({ needsYou: 2, failed7d: 1 }).line, "等你 2 件");
  assert.deepEqual([p({ running: 3 }).state, p({ running: 3 }).line], ["running", "3 个在跑"]);
  assert.deepEqual([p({ scheduled: 1 }).state, p({ scheduled: 1 }).line], ["waiting", "等着"]);
  assert.deepEqual([p({}).state, p({}).line], ["idle", "没在跑"]);
  assert.equal(p({}, 0).line, "没有号");
  // With no worker heartbeat nothing reads as running: its runs wait for the worker.
  const stalled = p({ running: 3 }, 1, true);
  assert.deepEqual([stalled.state, stalled.line], ["waiting", "后台停着"]);
  assert.deepEqual(
    [p({ queued: 1 }, 1, true).state, p({ queued: 1 }, 1, true).line],
    ["waiting", "等着"],
  );
});

test("the order: the founder, then the accounts here or each project, then the 运营专员", () => {
  const founder = { name: "Nova_Harrison", environmentId: "a1" };
  const inProject = members({
    hall: false,
    ops: "acmeskills 运营专员",
    founder,
    accounts: [account({ id: "a2", name: "Pine_Example_3" }), account()],
    projects: [],
    now,
    stalled: false,
  });
  assert.deepEqual(
    inProject.map((m) => [m.name, m.kind, m.founder]),
    [
      ["Nova_Harrison", "account", true],
      ["Pine_Example_3", "account", false],
      ["acmeskills 运营专员", "ops", false],
    ],
  );
  const counts = { needsYou: 0, running: 1, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 };
  const inHall = members({
    hall: true,
    ops: "Yuki",
    founder: { name: "Nova_Harrison", environmentId: "a9" },
    accounts: [],
    projects: [
      { id: null, name: "营销总群", accounts: 1, counts },
      { id: "p1", name: "acmeskills", accounts: 1, counts },
    ],
    now,
    stalled: false,
  });
  assert.deepEqual(
    inHall.map((m) => [m.name, m.kind, m.line]),
    [
      ["Nova_Harrison", "account", "创始人"],
      ["acmeskills", "project", "1 个在跑"],
      ["Yuki", "ops", "答你的话"],
    ],
  );
  assert.equal(inHall[0].environmentId, "a9");
});

test("the 经营循环 line: how often it wakes, when it last acted, how many things today", () => {
  const loop = (repeatMinutes: number | null) => ({
    task: { repeatMinutes },
    phase: phase("sched"),
  });
  const ledger = normalizePacing({
    effective: { timezone: "UTC" },
    status: {
      usedToday: { "example.com/post": 2, "example.com/comment": 1, "*": 3 },
      lastActionAt: "2026-10-17T01:46:00Z",
    },
  });
  const clock = new Date("2026-10-17T01:46:00Z");
  const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  assert.equal(
    accountRoutine(account({ tasks: [loop(10)], pacing: ledger }), now),
    `每 10 分钟 · 上次 ${hhmm} · 今天 3 件`,
  );
  // The shortest repeat among its live tasks; `*` repeats the other kinds and is not counted.
  assert.equal(
    accountRoutine(account({ tasks: [loop(1440), loop(60), loop(null)], pacing: ledger }), now),
    `每小时 · 上次 ${hhmm} · 今天 3 件`,
  );
  // A ledger that saw nothing today still says so; no loop, no 「每」.
  const quiet = normalizePacing({ status: { usedToday: {}, lastActionAt: null } });
  assert.equal(accountRoutine(account({ pacing: quiet }), now), "今天 0 件");
  // Nothing known (another project's account, no loop): no line at all.
  assert.equal(accountRoutine(account(), now), null);
  assert.equal(accountRoutine(account({ tasks: [loop(10)] }), now), "每 10 分钟");
  // The card carries it, so the bar draws it under the state line.
  const [member] = members({
    hall: false,
    ops: "x 运营专员",
    founder: null,
    accounts: [account({ tasks: [loop(10)], pacing: ledger })],
    projects: [],
    now,
    stalled: false,
  });
  assert.equal(member.routine, `每 10 分钟 · 上次 ${hhmm} · 今天 3 件`);
});

// The founder's face reads her real loop, and an account that stopped or has
// nothing to work on says so.
test("the founder outside her conversation reads her real loop, never a fixed idle", () => {
  const ref = { name: "Nova_Harrison", environmentId: "a9" };
  const founderOf = (loop: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    normalizeFounder({
      founder: { environmentId: "a9", name: "Nova_Harrison", loop, ...extra },
      priorities: [],
      projects: [],
    })?.founder ?? null;
  // Not read yet: only her name and 创始人.
  assert.deepEqual([founderMember(ref).state, founderMember(ref).line], ["idle", "创始人"]);
  // Her loop failed two days ago: 要你, 经营停了 (no 7-day expiry for a standing loop).
  const failed = founderOf({
    taskId: "l",
    title: "Nova_Harrison 的日常运营",
    status: "failed",
    nextRunAt: null,
    updatedAt: "2026-10-15T04:00:00Z",
    error: "empty_stream",
  });
  const stopped = founderMember(ref, failed, now, false);
  assert.deepEqual([stopped.state, stopped.line], ["needs", "经营停了"]);
  assert.match(stopped.now ?? "", /^经营停了：/, "why she stopped, in plain words");
  assert.ok(!(stopped.now ?? "").includes("empty_stream"));
  // Running.
  const running = founderMember(
    ref,
    founderOf({ taskId: "l", status: "running", nextRunAt: null }),
    now,
    false,
  );
  assert.deepEqual([running.state, running.line], ["running", "正在做"]);
  // No goal, no job: 没在经营.
  const idle = founderMember(ref, founderOf(null, { hasWork: false }), now, false);
  assert.deepEqual([idle.state, idle.line], ["needs", "没在经营"]);
  // Another founder's data (a switch in between) is not hers.
  const other = normalizeFounder({
    founder: { environmentId: "zz", name: "Other", loop: { taskId: "l", status: "failed" } },
  })?.founder;
  assert.equal(founderMember(ref, other ?? null, now, false).line, "创始人");
  // Through the bar's members(): in a project, where she is not one of the accounts.
  const [face] = members({
    hall: false,
    ops: "x 运营专员",
    founder: ref,
    founderAccount: failed,
    accounts: [],
    projects: [],
    now,
    stalled: false,
  });
  assert.deepEqual([face?.founder, face?.state, face?.line], [true, "needs", "经营停了"]);
});

test("an account whose standing loop stopped, or that is not operating, says so", () => {
  const stoppedLoop = account({
    tasks: [{ phase: phase("fail", { needsYou: true, stopped: true, label: "失败" }), task: {} }],
    now: {
      entry: { phase: phase("fail", { needsYou: true, stopped: true, label: "失败" }), task: {} },
      more: 0,
    },
  });
  assert.deepEqual(
    [accountState(stoppedLoop), accountLine(stoppedLoop, now)],
    ["needs", "经营停了"],
  );
  const pausedLoop = account({
    tasks: [
      { phase: phase("pause", { needsYou: true, stopped: true, label: "已暂停" }), task: {} },
    ],
    now: {
      entry: {
        phase: phase("pause", { needsYou: true, stopped: true, label: "已暂停" }),
        task: {},
      },
      more: 0,
    },
  });
  assert.deepEqual(
    [accountState(pausedLoop), accountLine(pausedLoop, now)],
    ["needs", "经营暂停了"],
  );
  const idle = account({ flags: ["idle"] });
  assert.deepEqual([accountState(idle), accountLine(idle, now)], ["needs", "没在经营"]);
});

test("an account whose standing task runs without acting says so instead of 正在做 / 等着", () => {
  const behind = phase("wait", { behind: { since: "2026-10-13T00:00:00Z", days: 4 } });
  const waiting = account({
    now: { entry: { phase: behind, task: { title: "日常运营" } }, more: 0 },
    tasks: [{ phase: behind, task: { title: "日常运营" } }],
  });
  assert.equal(accountState(waiting), "waiting");
  assert.equal(accountLine(waiting, now), "4 天没在网站上做事");
});
