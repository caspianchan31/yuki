// The whole space's 需要你 is one source. The page lists every project's items,
// the current project first, and every 需要你 count (sidebar, tab title, bottom bar) is the number
// of those rows; N1's per-project lines stand for the other projects' items, and its count is
// their number. A project's failures are inside its 需要你, never added on top.
import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMember,
  projectState,
} from "../../../packages/client/src/shell/members/members-core.ts";
import {
  type NeedItem,
  normalizeOverview,
  otherProjectsNeedsYou,
  projectNeedLines,
  spaceNeedCount,
  spaceNeeds,
} from "../../../packages/client/src/shell/model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";

const zero = { needsYou: 0, running: 0, queued: 0, waiting: 0, scheduled: 0, failed7d: 0 };
const line = (key: string, kind: string, title: string, account: string | null = null) => ({
  key,
  kind,
  title,
  account,
});
const overview = normalizeOverview({
  projects: [
    {
      id: "p-alpha",
      name: "Alpha",
      accounts: 2,
      // A stale count: the lines win.
      counts: { ...zero, needsYou: 5, failed7d: 1 },
      needs: [
        line("task:t1", "input", "回复评论", "alice"),
        line("task:t2", "fail", "发帖", "alice"),
        line("account:e1", "account", "bob", "bob"),
      ],
      lastActivityAt: "2026-10-20T01:00:00Z",
    },
    {
      id: "p-beta",
      name: "Beta",
      accounts: 0,
      counts: zero,
      needs: [],
      lastActivityAt: null,
    },
    {
      id: null,
      name: "",
      accounts: 1,
      counts: { ...zero, needsYou: 1 },
      needs: [line("project:sign-ins", "project", "")],
      lastActivityAt: null,
    },
  ],
});
// Only the key matters to the grouping: the current project's items come from needItems.
const local = [{ key: "task:here-1" }, { key: "account:here-2" }] as unknown as NeedItem[];

test("N1's count is the number of its lines", () => {
  assert.ok(overview);
  assert.deepEqual(
    overview.map((row) => [row.id, row.counts.needsYou, row.needs?.length]),
    [
      ["p-alpha", 3, 3],
      ["p-beta", 0, 0],
      [null, 1, 1],
    ],
  );
  assert.equal(overview[0].needs?.[1].kind, "fail");
  assert.equal(overview[0].needs?.[0].account, "alice");
  // An unknown kind reads as unknown, never dropped (the row would go missing from the page).
  const odd = normalizeOverview({
    projects: [{ id: "p", name: "P", counts: zero, needs: [{ kind: "new", title: "x" }] }],
  });
  assert.deepEqual(odd?.[0].needs, [{ key: "need:0", kind: "unknown", title: "x", account: null }]);
  assert.equal(odd?.[0].counts.needsYou, 1);
});

test("a server that only counts: one row per counted item, so rows still equal the count", () => {
  const old = normalizeOverview({
    projects: [{ id: "p-old", name: "Old", accounts: 0, counts: { ...zero, needsYou: 2 } }],
  });
  assert.ok(old);
  assert.equal(old[0].needs, undefined);
  const lines = projectNeedLines(old[0]);
  assert.equal(lines.length, 2);
  assert.deepEqual(new Set(lines.map((item) => item.kind)), new Set(["unknown"]));
  assert.equal(new Set(lines.map((item) => item.key)).size, 2, "keys are unique");
  assert.equal(otherProjectsNeedsYou(old, null), 2);
});

test("the whole space grouped by project: current first, its own items, no empty group", () => {
  assert.ok(overview);
  const groups = spaceNeeds(local, overview, "p-beta");
  assert.deepEqual(
    groups.map((group) => [
      group.projectId,
      group.current,
      group.current ? group.items.length : group.lines.length,
    ]),
    [
      ["p-beta", true, 2],
      ["p-alpha", false, 3],
      [null, false, 1],
    ],
  );
  // The count everywhere is the page's rows.
  assert.equal(spaceNeedCount(groups), 6);
  assert.equal(spaceNeedCount(groups), local.length + otherProjectsNeedsYou(overview, "p-beta"));
});

test("the current project's overview row is never counted: its items are the local ones", () => {
  assert.ok(overview);
  // In Alpha, N1 says 3 but the local needItems (fresher) say 2: the page and the count say 2.
  const groups = spaceNeeds(local, overview, "p-alpha");
  assert.equal(groups[0].current && groups[0].items.length, 2);
  assert.ok(groups.every((group) => group.current || group.projectId !== "p-alpha"));
  assert.equal(spaceNeedCount(groups), 2 + 1);
  // In the hall (营销总群, id null) the others are Alpha only (Beta has nothing).
  const hall = spaceNeeds([], overview, null);
  assert.deepEqual(
    hall.map((group) => group.projectId),
    [null, "p-alpha"],
  );
  assert.equal(spaceNeedCount(hall), 3);
});

test("without N1 the page is the current project alone", () => {
  const groups = spaceNeeds(local, null, "p-beta");
  assert.equal(groups.length, 1);
  assert.equal(spaceNeedCount(groups), 2);
});

test("a project's failures are inside its 需要你: never counted twice in the hall", () => {
  const p = (counts: Partial<typeof zero>) =>
    projectMember({ id: "p", name: "P", accounts: 1, counts: { ...zero, ...counts } }, false);
  assert.equal(p({ needsYou: 2, failed7d: 2 }).line, t.members.projectNeeds(2));
  assert.equal(p({ needsYou: 3, failed7d: 1 }).line, t.members.projectNeeds(3));
  // A failure older than 7 days has left 需要你: failed7d alone never makes it 「等你」.
  assert.notEqual(projectState({ counts: { ...zero, failed7d: 1 } }), "needs");
});

test("another project's row words: kind, project and account", () => {
  assert.equal(t.needs.inboxGroup("营销总群", 2, true), "营销总群 · 当前 · 2");
  assert.equal(t.needs.inboxGroup("Alpha", 3, false), "Alpha · 3");
  assert.equal(
    t.needs.otherLine(["Alpha", "alice", t.needs.otherKind.fail]),
    "Alpha · alice · 停了，等你处理",
  );
  assert.equal(t.needs.otherLine(["Alpha", "", ""]), "Alpha");
  for (const kind of ["input", "approval", "fail", "review", "account", "project", "unknown"])
    assert.ok(t.needs.otherKind[kind], kind);
});
