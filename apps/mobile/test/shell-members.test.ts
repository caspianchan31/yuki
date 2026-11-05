// The members bar's model: each member's state from what its
// tasks do, the one line under its name, the order (founder, the accounts here or each project,
// the 运营专员), and an incident kept for hours read as 「桌面没响应 2 小时了」, not as all well.
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountLine,
  accountMember,
  accountState,
  members,
  projectMember,
} from "../../../packages/client/src/shell/members/members-core.ts";

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
  const card = accountMember(running, now, true);
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
  const needs = account({ flags: ["desktopError"], incident: { kind: "desktop", since: "x" } });
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

test("the order: the accounts here or each project, then the 运营专员", () => {
  const inProject = members({
    hall: false,
    ops: "acmeskills 运营专员",
    accounts: [account({ id: "a2", name: "Pine_Example_3" }), account()],
    projects: [],
    now,
    stalled: false,
  });
  assert.deepEqual(
    inProject.map((m) => [m.name, m.kind]),
    [
      ["Pine_Example_3", "account"],
      ["Nova_Harrison", "account"],
      ["acmeskills 运营专员", "ops"],
    ],
  );
  const counts = { needsYou: 0, running: 1, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 };
  const inHall = members({
    hall: true,
    ops: "Yuki",
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
      ["acmeskills", "project", "1 个在跑"],
      ["Yuki", "ops", "答你的话"],
    ],
  );
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
