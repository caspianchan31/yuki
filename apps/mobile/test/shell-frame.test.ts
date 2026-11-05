// The shell frame's pure parts: project rows and badges, the project forms'
// Chinese errors, the conversation switcher and thread bar and the down bar.
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../../packages/client/src/api-response.ts";
import { type ProjectView, projectsFailure } from "../../../packages/client/src/projects-core.ts";
import { memberConversationId } from "../../../packages/client/src/shell/chat/member-thread.ts";
import {
  checkProjectName,
  countsFromShell,
  projectBadges,
  projectErrorText,
  projectRows,
  providerErrorText,
  rowCountText,
  unknownProjectIds,
} from "../../../packages/client/src/shell/frame/project-rows.ts";
import { clockWithSeconds, downBarText } from "../../../packages/client/src/shell/frame/strip.ts";
import {
  forgetThreadNames,
  rememberThreads,
  sideThreadRows,
  subscribeThreadNames,
  threadBarLabel,
  threadNames,
} from "../../../packages/client/src/shell/frame/thread-rows.ts";
import {
  otherProjectsNeedsYou,
  type ProjectCounts,
  type ProjectOverview,
  type ShellCounts,
} from "../../../packages/client/src/shell/model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";

const counts = (overrides: Partial<ProjectCounts> = {}): ProjectCounts => ({
  needsYou: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  scheduled: 0,
  failed7d: 0,
  ...overrides,
});
const shell = (overrides: Partial<ShellCounts> = {}): ShellCounts => ({
  needsYou: 0,
  waitingOnYou: 0,
  failed: 0,
  running: 0,
  waiting: 0,
  scheduled: 0,
  ...overrides,
});
const overview = (
  id: string | null,
  name: string,
  accounts: number,
  c: Partial<ProjectCounts> = {},
  lastActivityAt: string | null = null,
): ProjectOverview => ({ id, name, accounts, counts: counts(c), lastActivityAt });
const project = (id: string, name: string, environments = 0, deleting = false): ProjectView => ({
  id,
  name,
  environments,
  deleting,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const P4 = "44444444-4444-4444-8444-444444444444";

test("a project row shows only 「等你 n」 (failures included), amber; nothing else is a chip", () => {
  assert.deepEqual(
    projectBadges(
      counts({ needsYou: 3, failed7d: 1, running: 1, queued: 2, waiting: 1, scheduled: 4 }),
    ).map((badge) => [badge.key, badge.tone, badge.label]),
    [["needs", "amber", "等你 3"]],
  );
  // Only a failure: still 等你 1; going on but nothing for the owner: no chip.
  assert.deepEqual(
    projectBadges(counts({ needsYou: 1, failed7d: 1 })).map((badge) => badge.label),
    ["等你 1"],
  );
  assert.deepEqual(projectBadges(counts({ running: 2, waiting: 1, scheduled: 3 })), []);
  assert.deepEqual(projectBadges(counts()), []);
});

test("the local shell counts read in N1's shape", () => {
  assert.deepEqual(
    countsFromShell(
      shell({ needsYou: 3, waitingOnYou: 2, failed: 1, running: 2, waiting: 1, scheduled: 1 }),
    ),
    { needsYou: 3, running: 2, queued: 0, waiting: 1, scheduled: 1, failed7d: 1 },
  );
});

test("project rows: Yuki first, then needs, then latest activity; current from local counts", () => {
  const rows = projectRows({
    overview: [
      overview(P1, "acmegame", 1, { running: 1 }, "2026-10-10T06:00:00.000Z"),
      overview(P2, "acmeskills", 2, { waiting: 1 }, "2026-10-10T07:00:00.000Z"),
      overview(P3, "长期测试", 1, { needsYou: 1, failed7d: 1, scheduled: 1 }, null),
      overview(null, "", 1),
    ],
    projects: [
      project(P1, "acmegame", 1),
      project(P2, "acmeskills", 2),
      project(P3, "长期测试", 1),
    ],
    projectsAvailable: true,
    current: P1,
    // The local view of the current project is fresher: a desktop error makes it need you.
    currentCounts: shell({ needsYou: 1, waitingOnYou: 1, running: 1 }),
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.countLabel, row.badges.map((badge) => badge.label)]),
    [
      // The hall leads; then both that need you, the later activity first.
      ["Yuki", "1 个未分配", []],
      ["acmegame", "1 个成员", ["等你 1"]],
      ["长期测试", "1 个成员", ["等你 1"]],
      ["acmeskills", "2 个成员", []],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.current),
    [false, true, false, false],
  );
  assert.equal(rows[1].needsYou, 1);
});

test("from another project, the hall's 需要你 (a pending review there) shows on its row and in the total", () => {
  // N1 counts the hall (id null) like any project: its review awaiting the owner is 1.
  const list = [overview(P1, "acmeskills", 2), overview(null, "", 1, { needsYou: 1 })];
  const rows = projectRows({
    overview: list,
    projects: [project(P1, "acmeskills", 2)],
    projectsAvailable: true,
    current: P1,
    currentCounts: shell(),
  });
  const hall = rows.find((row) => row.id === null);
  assert.equal(hall?.needsYou, 1);
  assert.deepEqual(
    hall?.badges.map((badge) => badge.label),
    ["等你 1"],
  );
  // The sidebar's 需要你 total: this project's own + every other project's, the hall included.
  assert.equal(otherProjectsNeedsYou(list, P1), 1);
  // In the hall, its own number is the local one (not counted twice).
  assert.equal(otherProjectsNeedsYou(list, null), 0);
});

test("project rows merge the list: renamed names, new and half-deleted projects, deleted ones dropped", () => {
  const rows = projectRows({
    overview: [
      overview(P1, "old name", 1, {}, "2026-10-10T06:00:00.000Z"),
      overview(P2, "gone elsewhere", 0, { needsYou: 2 }),
      overview(null, "", 0),
    ],
    projects: [
      project(P1, "new name", 1),
      project(P3, "just made", 0),
      project(P4, "half", 2, true),
    ],
    projectsAvailable: true,
    current: null,
    currentCounts: shell({ needsYou: 1, waitingOnYou: 1 }),
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.deleting]),
    [
      [null, "Yuki", false],
      [P1, "new name", false],
      [P4, "half", true],
      [P3, "just made", false],
    ],
  );
  const byId = (id: string | null) => rows.find((row) => row.id === id);
  // The default project is current here: its local counts show.
  assert.deepEqual(
    byId(null)?.badges.map((badge) => badge.label),
    ["等你 1"],
  );
  assert.equal(byId(null)?.countLabel, "0 个未分配");
  assert.equal(byId(P4)?.countLabel, "2 个成员");
  assert.equal(byId(P3)?.countLabel, "0 个成员");
});

test("project rows keep N1's rows when the project list is not available", () => {
  const rows = projectRows({
    overview: [overview(P1, "acmegame", 1, { running: 1 }), overview(null, "", 2)],
    projects: [],
    projectsAvailable: false,
    current: null,
    currentCounts: null,
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.countLabel]),
    [
      ["Yuki", "2 个未分配"],
      ["acmegame", "1 个成员"],
    ],
  );
});

test("project rows add Yuki when N1 has no default row", () => {
  const rows = projectRows({
    overview: [overview(P1, "acmegame", 1)],
    projects: [project(P1, "acmegame", 1)],
    projectsAvailable: true,
    current: P1,
    currentCounts: null,
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.countLabel]),
    [
      [null, null],
      [P1, "1 个成员"],
    ],
  );
});

test("without N1 the rows have names and account counts, no badges, Yuki first", () => {
  const rows = projectRows({
    overview: null,
    projects: [project(P2, "acmeskills", 2), project(P1, "acmegame", 1, true)],
    projectsAvailable: true,
    current: P2,
    currentCounts: shell({ needsYou: 4, waitingOnYou: 4 }),
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.countLabel, row.badges.length, row.current, row.deleting]),
    [
      ["Yuki", null, 0, false, false],
      ["acmeskills", "2 个成员", 0, true, false],
      ["acmegame", "1 个成员", 0, false, true],
    ],
  );
  assert.equal(rowCountText(rows[1], true), "2 个成员 · 当前");
  assert.equal(rowCountText(rows[1], false), "2 个成员");
  assert.equal(rowCountText(rows[0], true), "");
});

test("ids N1 knows and the list does not are re-read", () => {
  assert.deepEqual(unknownProjectIds(null, []), []);
  assert.deepEqual(
    unknownProjectIds(
      [overview(P3, "c", 0), overview(P1, "a", 0), overview(null, "", 0), overview(P2, "b", 0)],
      [project(P1, "a")],
    ),
    [P2, P3],
  );
});

test("project names are checked like the server, the reasons in Chinese", () => {
  assert.deepEqual(checkProjectName("  acmegame  "), { ok: true, name: "acmegame" });
  assert.deepEqual(checkProjectName("   "), { ok: false, error: "名称必填" });
  assert.deepEqual(checkProjectName("x".repeat(65)), { ok: false, error: "名称最多 64 个字" });
  assert.deepEqual(checkProjectName("x".repeat(64)), { ok: true, name: "x".repeat(64) });
  assert.deepEqual(checkProjectName(" Default "), {
    ok: false,
    error: "「Default」是未分组的保留名，换一个",
  });
  assert.equal(checkProjectName("默认").ok, false);
});

test("project errors read in Chinese; server messages stay as they are", () => {
  assert.equal(projectErrorText(new ApiError("Project not found", 404)), t.projects.gone);
  assert.equal(
    projectErrorText(new ApiError("A project with this name already exists", 409)),
    "出错了：A project with this name already exists",
  );
  assert.equal(providerErrorText(null), "");
  assert.equal(
    providerErrorText(projectsFailure("delete", new Error("desktop busy"))),
    "上次删除没完成：desktop busy",
  );
  assert.equal(
    providerErrorText(projectsFailure("delete", new ApiError("Project not found", 404))),
    "上次删除没完成：这个群已经不在了，换一个。",
  );
  assert.equal(
    providerErrorText(projectsFailure("list", new ApiError("Project not found", 404))),
    "这个群已经不在了，换一个。",
  );
  assert.equal(providerErrorText(projectsFailure("list", "network down")), "出错了：network down");
});

test("side chats: unsaved ones numbered first, saved ones by archive state, never the main chat", () => {
  const memberId = memberConversationId("11111111-1111-4111-8111-111111111111");
  const saved = [
    { id: "main", name: null, archived: false },
    { id: "s1", name: "选区讨论", archived: false },
    { id: "s2", name: null, archived: false },
    { id: "s3", name: "旧话题", archived: true },
    { id: memberId, name: "晨报", archived: false },
  ];
  const visited = [{ id: "main" }, { id: "s1" }, { id: "n1" }, { id: "n2" }, { id: memberId }];
  const active = sideThreadRows({
    visited,
    saved,
    mainId: "main",
    selectedId: "n2",
    archived: false,
  });
  assert.deepEqual(
    active.map((row) => [row.id, row.label, row.saved, row.selected]),
    [
      ["n1", "侧聊 1", false, false],
      ["n2", "侧聊 2", false, true],
      ["s1", "选区讨论", true, false],
      ["s2", "未命名对话", true, false],
    ],
  );
  const archived = sideThreadRows({
    visited,
    saved,
    mainId: "main",
    selectedId: "main",
    archived: true,
  });
  assert.deepEqual(
    archived.map((row) => [row.id, row.label, row.archived]),
    [["s3", "旧话题", true]],
  );
});

test("the thread bar names the conversation on screen", () => {
  const names = new Map<string, string | null>([
    ["s1", "选区讨论"],
    ["s2", null],
  ]);
  const visited = [{ id: "main" }, { id: "s1" }, { id: "n1" }];
  const label = (selectedId: string) =>
    threadBarLabel({ selectedId, mainId: "main", visited, names });
  assert.equal(label("main"), "主聊天");
  assert.equal(label("s1"), "选区讨论");
  assert.equal(label("s2"), "未命名对话");
  assert.equal(label("n1"), "侧聊 1");
  assert.equal(label("elsewhere"), "侧聊");
});

test("the switcher's thread names reach the thread bar, a new snapshot only on a change", () => {
  let calls = 0;
  const stop = subscribeThreadNames(() => {
    calls++;
  });
  rememberThreads([{ id: "frame-a", name: "A" }]);
  const first = threadNames();
  assert.equal(first.get("frame-a"), "A");
  rememberThreads([{ id: "frame-a", name: "A" }]);
  assert.equal(threadNames(), first);
  rememberThreads([{ id: "frame-a", name: "B" }]);
  assert.notEqual(threadNames(), first);
  assert.equal(threadNames().get("frame-a"), "B");
  assert.equal(calls, 2);
  stop();
  rememberThreads([{ id: "frame-a", name: "C" }]);
  assert.equal(calls, 2);
  // Sign-out forgets every name; the next session starts empty.
  forgetThreadNames();
  assert.equal(threadNames().size, 0);
});

test("the down bar: API unreachable, worker stopped or never seen; never while loading", () => {
  const ok = { down: false, sinceMs: 5_000, lastTickAt: "2026-10-10T06:46:58.000Z" };
  const stopped = { down: true, sinceMs: 3 * 60_000, lastTickAt: "2026-10-10T06:44:02.000Z" };
  assert.equal(downBarText({ agentError: "", ready: true, worker: ok }), null);
  assert.equal(downBarText({ agentError: "", ready: false, worker: stopped }), null);
  assert.equal(
    downBarText({ agentError: "fetch failed", ready: true, worker: ok }),
    t.downBar.apiDown,
  );
  assert.equal(
    downBarText({ agentError: "", workspaceError: "500", ready: false, worker: ok }),
    t.downBar.apiDown,
  );
  assert.equal(
    downBarText({ agentError: "", ready: true, worker: stopped }),
    `后台已停 3 分钟 · 最后心跳 ${clockWithSeconds(stopped.lastTickAt)} · 任务不会推进`,
  );
  // Longer stops keep 分钟 for the minutes (design §3.1: 「后台已停 3 分钟」).
  assert.equal(
    downBarText({ agentError: "", ready: true, worker: { ...stopped, sinceMs: 80 * 60_000 } }),
    `后台已停 1 小时 20 分钟 · 最后心跳 ${clockWithSeconds(stopped.lastTickAt)} · 任务不会推进`,
  );
  assert.equal(
    downBarText({
      agentError: "",
      ready: true,
      worker: { down: true, sinceMs: null, lastTickAt: null },
    }),
    t.downBar.neverSeen,
  );
});

test("heartbeat clock has seconds", () => {
  assert.equal(clockWithSeconds(new Date(2026, 9, 10, 14, 44, 2).toISOString()), "14:44:02");
  assert.equal(clockWithSeconds(null), "");
  assert.equal(clockWithSeconds("not a date"), "");
});

test("the frame's strings never tell the person to type pacing or reporting", () => {
  const all = JSON.stringify(
    { projects: t.projects, live: t.live, threads: t.threads },
    (_, value) => (typeof value === "function" ? String(value) : value),
  );
  for (const banned of ["发完汇报", "汇报给我", "间隔", "分钟", "每天", "批准", "审批"])
    assert.ok(!all.includes(banned), banned);
});
