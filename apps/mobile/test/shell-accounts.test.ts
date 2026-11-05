// The accounts unit's pure logic — the global page's merge and groupings,
// the account detail's lines, the two-step move, the pacing form and the editor's
// Chinese messages, and the cross-project directory.
import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentPayload,
  normalizeEnvironment,
} from "../../../packages/client/src/environments.ts";
import {
  accountReportLines,
  computerTabs,
  deleteConfirmed,
  editorError,
  editValue,
  movedTo,
  moveNote,
  movePlan,
  moveTargets,
  regionLine,
  runMove,
  sameItemsOr,
} from "../../../packages/client/src/shell/accounts/accounts-core.ts";
import { AccountsDirectory } from "../../../packages/client/src/shell/accounts/directory.ts";
import {
  type AccountModel,
  type AccountView,
  buildAccountModels,
} from "../../../packages/client/src/shell/model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import type { ChatReport } from "../../../packages/domain/src/agent.ts";
import { environmentNameMax } from "../../../packages/domain/src/environments.ts";
import type { Topology, TopologyEnvironment } from "../../../packages/domain/src/topology.ts";

const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number) => new Date(2026, 9, 10, hours, minutes).toISOString();

function view(
  id: string,
  name: string,
  projectId: string | null,
  overrides: Record<string, unknown> = {},
  _pacing?: unknown,
): AccountView {
  const settings = {
    timezone: "America/Los_Angeles",
    locale: "en-US",
    updatedAt: null,
    ...((overrides.settings as object) ?? {}),
  };
  return {
    ...normalizeEnvironment({
      id,
      name,
      accountLabel: `u/${name}`,
      projectId,
      status: "running",
      ...overrides,
      settings,
    }),
  };
}
const _models = (views: AccountView[]): AccountModel[] =>
  buildAccountModels({ accounts: views, entries: [], now });

function topoEnv(
  id: string,
  name: string,
  projectId: string | null,
  overrides: Partial<TopologyEnvironment> = {},
): TopologyEnvironment {
  return {
    id,
    name,
    accountLabel: null,
    projectId,
    locale: "en-US",
    timezone: "America/Los_Angeles",
    desktop: "stopped",
    ...overrides,
  };
}
const _projects = [
  { id: "p-acmeskills", name: "acmeskills" },
  { id: "p-acmegame", name: "acmegame" },
  { id: "p-manual", name: "人工测试" },
];

test("the two-step note is only for a move out of a project; assigning is one step", () => {
  assert.equal(moveNote("p1"), t.assign.twoSteps);
  assert.equal(moveNote(null), null);
});

test("a move is one PATCH to or from 未分配, two across projects (source header first)", () => {
  assert.deepEqual(movePlan("p1", "p2"), [
    { header: "p1", projectId: null },
    { header: "p2", projectId: "p2" },
  ]);
  assert.deepEqual(movePlan("p1", null), [{ header: "p1", projectId: null }]);
  assert.deepEqual(movePlan(null, "p2"), [{ header: "p2", projectId: "p2" }]);
  assert.deepEqual(movePlan("p1", "p1"), []);
  assert.deepEqual(movePlan(null, null), []);
  assert.deepEqual(
    moveTargets(
      [{ id: "p1", deleting: false }, { id: "p2", deleting: true }, { id: "p3" }],
      "p1",
    ).map((project) => project.id),
    ["p3"],
  );
});

test("a failed second step leaves the account in 未分配 and says so", async () => {
  const sent: string[] = [];
  const ok = async (step: { header: string | null; projectId: string | null }) => {
    sent.push(`${step.header}:${step.projectId}`);
  };
  assert.deepEqual(await runMove(movePlan("p1", "p2"), ok, String), { state: "done" });
  assert.deepEqual(sent, ["p1:null", "p2:p2"]);
  const secondFails = async (step: { header: string | null; projectId: string | null }) => {
    if (step.projectId) throw new Error("boom");
  };
  assert.deepEqual(
    await runMove(movePlan("p1", "p2"), secondFails, (error) => (error as Error).message),
    { state: "stuck", error: "boom" },
  );
  const firstFails = async () => {
    throw new Error("nope");
  };
  assert.deepEqual(
    await runMove(movePlan("p1", "p2"), firstFails, (error) => (error as Error).message),
    { state: "failed", error: "nope" },
  );
  assert.deepEqual(
    await runMove(movePlan(null, "p2"), firstFails, (error) => (error as Error).message),
    { state: "failed", error: "nope" },
  );
  assert.equal(t.assign.stuck, "账号停在未分配：第二步没成功。");
});

test("最近汇报（这个号）: the account's newest three, labels in Chinese, first line, link", () => {
  const report = (overrides: Partial<ChatReport>): ChatReport => ({
    id: "r",
    taskId: "t1",
    taskTitle: "任务",
    threadId: "main",
    kind: "report",
    title: "Update",
    text: "x",
    links: [],
    createdAt: at(14, 0),
    readAt: null,
    ...overrides,
  });
  const lines = accountReportLines(
    [
      report({ id: "r1", title: "Plan v1", createdAt: at(12, 51), text: "选区\n内容形式" }),
      report({
        id: "r2",
        title: "Comment",
        createdAt: at(14, 10),
        text: "\n在 r/IPhoneApps 回复 1 条",
        links: ["https://reddit.com/r/x/comments/1/a/b/"],
      }),
      report({ id: "r3", title: "Reply · over pace", createdAt: at(13, 20) }),
      report({ id: "r4", taskId: "other", createdAt: at(14, 30) }),
      report({ id: "r5", title: "Run 2 finished", createdAt: at(13, 2) }),
    ],
    new Set(["t1"]),
    now,
  );
  assert.deepEqual(
    lines.map((line) => [line.clock, line.label, line.text, line.link]),
    [
      ["14:10", "评论", "在 r/IPhoneApps 回复 1 条", "https://reddit.com/r/x/comments/1/a/b/"],
      ["13:20", "回复 · 超出节奏", "x", null],
      ["13:02", "第 2 轮完成", "x", null],
    ],
  );
  assert.deepEqual(accountReportLines([], new Set(["t1"]), now), []);
  assert.deepEqual(
    lines.map((line) => line.unconfirmed),
    ["", "", ""],
  );
  // An action report without the item's own address says so here too.
  const [missing] = accountReportLines(
    [
      report({
        id: "m",
        text: "在论坛发好了一条。",
        action: { site: "forum.example", action: "post" },
        evidence: "missing",
      }),
    ],
    new Set(["t1"]),
    now,
  );
  assert.equal(missing.unconfirmed, "未确认：没有这条内容自己的链接");
  assert.equal(missing.link, null);
});

const setAt = "2026-10-11T04:00:00.000Z";
const _ai = <T>(value: T, reason = "two-year account") => ({
  value,
  source: "ai",
  reason,
  setAt,
});
const _byHand = <T>(value: T) => ({ value, source: "owner", reason: null, setAt });

test("the editor's validation messages read in Chinese; server messages stay as they are", () => {
  const message = (form: Parameters<typeof environmentPayload>[0], mode: "create" | "edit") => {
    const payload =
      mode === "create" ? environmentPayload(form, "create") : environmentPayload(form, "edit");
    assert.ok("error" in payload);
    return editorError((payload as { error: string }).error);
  };
  assert.equal(message({ name: "" }, "create"), "名称必填");
  assert.equal(message({ name: "default" }, "create"), "「default」留给群默认桌面，换一个名称");
  assert.equal(
    message({ name: "a".repeat(environmentNameMax + 1) }, "create"),
    `名称最多 ${environmentNameMax} 个字`,
  );
  assert.equal(
    message({ name: "a", timezone: "Mars/Base" }, "create"),
    "不认识的时区「Mars/Base」，请用 America/Los_Angeles 这样的写法",
  );
  assert.equal(
    message({ name: "a", locale: "not a locale!" }, "create"),
    "不认识的语言「not a locale!」，请用 en-US 这样的写法",
  );
  assert.equal(message({ name: null }, "edit"), "名称必填");
  assert.equal(
    editorError('An environment named "x" already exists'),
    'An environment named "x" already exists',
  );
  assert.equal(editValue("same", "same"), undefined);
  assert.equal(editValue("  ", "saved"), null);
  assert.equal(editValue("new", null), "new");
  assert.equal(editValue("", null), undefined);
});

test("delete needs the exact name", () => {
  assert.equal(deleteConfirmed("Oak_Example_2", "Oak_Example_2"), true);
  assert.equal(deleteConfirmed(" Oak_Example_2 ", "Oak_Example_2"), true);
  assert.equal(deleteConfirmed("oak_example_2", "Oak_Example_2"), false);
  assert.equal(deleteConfirmed("", ""), false);
});

test("a move of a rail-opened account (empty directory) still knows where the account went", async () => {
  // The account was opened from the rail: only the project's polled list knows it, and the move
  // takes it out of that list. The directory must keep it, with its new project.
  const known = view("a1", "acct-one", "p1");
  const secondFails = async (step: { header: string | null; projectId: string | null }) => {
    if (step.projectId) throw new Error("boom");
  };
  const stuckDirectory = new AccountsDirectory();
  const stuck = await runMove(movePlan("p1", "p2"), secondFails, String);
  assert.equal(stuck.state, "stuck");
  const stuckAt = movedTo(stuck, "p2");
  assert.equal(stuckAt, null);
  if (stuckAt !== undefined) stuckDirectory.move("a1", stuckAt, known);
  // In 未分配, so the assign panel can offer 再试 instead of 「这个账号已经不在了」.
  assert.equal(stuckDirectory.get("a1")?.projectId, null);
  assert.equal(stuckDirectory.get("a1")?.name, "acct-one");

  const doneDirectory = new AccountsDirectory();
  const done = await runMove(movePlan("p1", null), async () => {}, String);
  const doneAt = movedTo(done, null);
  if (doneAt !== undefined) doneDirectory.move("a1", doneAt, known);
  assert.equal(doneDirectory.get("a1")?.projectId, null);

  const across = new AccountsDirectory();
  const moved = await runMove(movePlan("p1", "p2"), async () => {}, String);
  const movedAt = movedTo(moved, "p2");
  if (movedAt !== undefined) across.move("a1", movedAt, known);
  assert.equal(across.get("a1")?.projectId, "p2");

  // Nothing changed: nothing recorded.
  const failed = await runMove(
    movePlan("p1", "p2"),
    async () => {
      throw new Error("nope");
    },
    String,
  );
  assert.equal(movedTo(failed, "p2"), undefined);
  // A view the directory already has wins over the screen's copy.
  const directory = new AccountsDirectory();
  directory.put(view("a1", "renamed", "p1"));
  directory.move("a1", "p2", known);
  assert.equal(directory.get("a1")?.name, "renamed");
  assert.equal(directory.get("a1")?.projectId, "p2");
  // Without a known view an unknown account stays unknown (the lookup fetches it).
  const empty = new AccountsDirectory();
  empty.move("a9", "p2");
  assert.equal(empty.get("a9"), undefined);
});

test("a deleted account stays gone: a list read before the delete cannot bring it back", () => {
  const directory = new AccountsDirectory();
  directory.replaceProject("p1", [view("a1", "acct-one", "p1"), view("a2", "acct-two", "p1")]);
  directory.setTopology({
    projects: [],
    environments: [
      { id: "a1", projectId: "p1" },
      { id: "a2", projectId: "p1" },
    ] as unknown as Topology["environments"],
  });
  directory.remove("a1");
  assert.equal(directory.wasRemoved("a1"), true);
  assert.equal(directory.wasRemoved("a2"), false);
  assert.equal(directory.get("a1"), undefined);
  // A page load, a topology or one fetch that answers after the delete still has it: ignored.
  directory.replaceProject("p1", [view("a1", "acct-one", "p1"), view("a2", "acct-two", "p1")]);
  directory.put(view("a1", "acct-one", "p1"));
  directory.replaceAll([view("a1", "acct-one", "p1"), view("a2", "acct-two", "p1")]);
  directory.setTopology({
    projects: [],
    environments: [
      { id: "a1", projectId: "p1" },
      { id: "a2", projectId: "p1" },
    ] as unknown as Topology["environments"],
  });
  assert.deepEqual(
    directory.all().map((item) => item.id),
    ["a2"],
  );
  assert.deepEqual(
    directory.topology()?.environments.map((item) => item.id),
    ["a2"],
  );
  // A new session starts from nothing.
  directory.reset();
  assert.equal(directory.wasRemoved("a1"), false);
});

test("the directory keeps every project's views across a switch and tells listeners", () => {
  const directory = new AccountsDirectory();
  let calls = 0;
  const stop = directory.subscribe(() => {
    calls += 1;
  });
  directory.replaceProject("p1", [view("a1", "one", "p1"), view("a2", "two", "p1")]);
  directory.replaceProject(null, [view("a3", "three", null)]);
  assert.equal(directory.all().length, 3);
  directory.replaceProject("p1", [view("a2", "two", "p1")]);
  assert.deepEqual(
    directory
      .all()
      .map((item) => item.id)
      .sort(),
    ["a2", "a3"],
  );
  directory.setTopology({
    projects: [],
    environments: [topoEnv("a2", "two", "p1"), topoEnv("a3", "three", null)],
  });
  directory.move("a2", "p9");
  assert.equal(directory.get("a2")?.projectId, "p9");
  assert.equal(directory.topology()?.environments[0].projectId, "p9");
  directory.remove("a3");
  assert.equal(directory.get("a3"), undefined);
  assert.equal(directory.topology()?.environments.length, 1);
  const token = directory.reloadToken();
  directory.requestReload();
  assert.equal(directory.reloadToken(), token + 1);
  const version = directory.getVersion();
  stop();
  directory.put(view("a4", "four", null));
  assert.equal(directory.getVersion(), version + 1);
  assert.equal(calls, 7);
});

test("an account's desktop sheet shows only Desktop and Terminal; the default desktop keeps four", () => {
  assert.deepEqual(computerTabs(true, true, "Browser"), {
    shown: "Desktop",
    tabs: ["Desktop", "Terminal"],
  });
  assert.deepEqual(computerTabs(true, true, "Files"), {
    shown: "Desktop",
    tabs: ["Desktop", "Terminal"],
  });
  assert.deepEqual(computerTabs(true, true, "Terminal").shown, "Terminal");
  assert.deepEqual(computerTabs(true, false, "Desktop"), { shown: "Terminal", tabs: ["Terminal"] });
  assert.deepEqual(computerTabs(true, undefined, "Browser"), {
    shown: "Desktop",
    tabs: ["Terminal"],
  });
  assert.deepEqual(computerTabs(false, true, "Files"), {
    shown: "Files",
    tabs: ["Browser", "Desktop", "Terminal", "Files"],
  });
  assert.deepEqual(computerTabs(false, false, "Desktop"), {
    shown: "Terminal",
    tabs: ["Browser", "Terminal", "Files"],
  });
  assert.equal(computerTabs(false, undefined, "Browser").shown, "Browser");
});

test("a list rebuilt with the same items keeps its identity", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const previous = [a, b];
  assert.equal(sameItemsOr(previous, [a, b]), previous);
  const reordered = [b, a];
  assert.equal(sameItemsOr(previous, reordered), reordered);
  const fresh = [a, { id: "b" }];
  assert.equal(sameItemsOr(previous, fresh), fresh, "a new object is a change");
  const shorter = [a];
  assert.equal(sameItemsOr(previous, shorter), shorter);
});

test("the detail's 地区 line in plain words, never 「没设 · 没设」", () => {
  assert.equal(regionLine({ locale: null, timezone: null }), "还没设（时区和语言用桌面默认的）");
  assert.equal(regionLine({ locale: "en-US", timezone: null }), "en-US · 时区没设");
  assert.equal(regionLine({ locale: null, timezone: "Europe/London" }), "语言没设 · Europe/London");
  assert.equal(
    regionLine({ locale: "en-US", timezone: "America/Los_Angeles" }),
    "en-US · America/Los_Angeles",
  );
});
