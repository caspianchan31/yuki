// The accounts unit's pure logic — the global page's merge and groupings,
// the exit notes, the account detail's lines, the two-step move, the pacing form and the editor's
// Chinese messages, and the cross-project directory.
import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentPayload,
  normalizeEnvironment,
} from "../../../packages/client/src/environments.ts";
import {
  accountExit,
  accountPlace,
  accountReportLines,
  aiPacingLine,
  answerHasPacing,
  computerTabs,
  deleteConfirmed,
  editorError,
  editValue,
  exitLabels,
  exitNotes,
  groupByExit,
  groupByProject,
  joinsProjects,
  mergeAccountViews,
  movedTo,
  moveNote,
  movePlan,
  moveTargets,
  pacingFormOf,
  pacingPatch,
  pacingSettingsLine,
  pacingTimezoneLine,
  pageSummary,
  placeOf,
  regionLine,
  runMove,
  sameExitOthers,
  sameItemsOr,
  topologyAccountView,
  topologyExit,
} from "../../../packages/client/src/shell/accounts/accounts-core.ts";
import { AccountsDirectory } from "../../../packages/client/src/shell/accounts/directory.ts";
import { plainGroupTitle } from "../../../packages/client/src/shell/accounts/people-core.ts";
import {
  type AccountModel,
  type AccountView,
  absentPacing,
  buildAccountModels,
  normalizePacing,
} from "../../../packages/client/src/shell/model.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import type { ChatReport } from "../../../packages/domain/src/agent.ts";
import { environmentNameMax } from "../../../packages/domain/src/environments.ts";
import type { Topology, TopologyEnvironment } from "../../../packages/domain/src/topology.ts";

const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number) => new Date(2026, 9, 10, hours, minutes).toISOString();
const EXIT = "203.0.113.105:5890";

function view(
  id: string,
  name: string,
  projectId: string | null,
  overrides: Record<string, unknown> = {},
  pacing?: unknown,
): AccountView {
  const settings = {
    proxy: { configured: true, preview: `http://•••@${EXIT}` },
    timezone: "America/Los_Angeles",
    locale: "en-US",
    updatedAt: null,
    unreadable: false,
    ...((overrides.settings as object) ?? {}),
  };
  return {
    ...normalizeEnvironment({
      id,
      name,
      accountLabel: `u/${name}`,
      projectId,
      status: "running",
      proxyConfigured: true,
      ...overrides,
      settings,
    }),
    pacing: normalizePacing(pacing),
  };
}
const models = (views: AccountView[]): AccountModel[] =>
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
    proxy: { scheme: "http", host: "203.0.113.105", port: 5890 },
    proxyUnreadable: false,
    locale: "en-US",
    timezone: "America/Los_Angeles",
    desktop: "stopped",
    ...overrides,
  };
}
const projects = [
  { id: "p-acmeskills", name: "acmeskills" },
  { id: "p-acmegame", name: "acmegame" },
  { id: "p-manual", name: "人工测试" },
];

test("a topology account reads as a view with its exit and no secrets", () => {
  const synthesized = topologyAccountView(topoEnv("a1", "Nova_Harrison", "p-acmeskills"));
  assert.equal(synthesized.settings.proxy.preview, `http://${EXIT}`);
  assert.equal(synthesized.settings.proxy.configured, true);
  assert.equal(synthesized.status, "stopped");
  assert.equal(synthesized.pacing, absentPacing);
  const [model] = models([synthesized]);
  assert.equal(model.exit, EXIT);
  assert.deepEqual(model.flags, []);
  const unreadable = topologyAccountView(
    topoEnv("a2", "x", null, { proxy: null, proxyUnreadable: true }),
  );
  assert.deepEqual(models([unreadable])[0].flags, ["proxyUnreadable"]);
  const none = topologyAccountView(topoEnv("a3", "y", null, { proxy: null }));
  assert.deepEqual(models([none])[0].flags, ["noProxy"]);
  assert.equal(
    topologyExit({ proxy: { scheme: "socks5", host: "Proxy.Example", port: 1080 } }),
    "proxy.example:1080",
  );
});

test("the page merges each project's answer with the topology for projects that did not answer", () => {
  const topology: Topology = {
    projects: [
      { id: "p-acmegame", name: "acmegame" },
      { id: "p-acmeskills", name: "acmeskills" },
    ],
    environments: [
      topoEnv("a1", "Oak_Example_2", "p-acmegame"),
      topoEnv("a2", "Pine_Example_3", "p-acmeskills"),
      topoEnv("a3", "Nova_Harrison", "p-acmeskills"),
      topoEnv("a4", "moved-meanwhile", "p-acmegame"),
      topoEnv("a5", "acct-1", null),
    ],
  };
  const fetched = new Map<string, AccountView[]>([
    ["p-acmegame", [view("a1", "Oak_Example_2", "p-acmegame")]],
    ["", [view("a5", "acct-1", null), view("a6", "gone", null, { deleting: true })]],
  ]);
  const merged = mergeAccountViews(topology, fetched);
  assert.deepEqual(
    merged.map((item) => item.name),
    ["acct-1", "Nova_Harrison", "Oak_Example_2", "Pine_Example_3"],
  );
  // a1 is the fetched view (running); a2 / a3 come from the topology (stopped).
  assert.equal(merged.find((item) => item.id === "a1")?.status, "running");
  assert.equal(merged.find((item) => item.id === "a2")?.status, "stopped");
  // Without a topology the fetched answers alone are shown.
  assert.equal(mergeAccountViews(null, fetched).length, 2);
});

test("exit labels come from the topology, with every scheme on one server", () => {
  const labels = exitLabels({
    projects: [],
    environments: [
      topoEnv("a1", "a", null),
      topoEnv("a2", "b", null, {
        proxy: { scheme: "socks5", host: "203.0.113.105", port: 5890 },
      }),
      topoEnv("a3", "c", null, { proxy: { scheme: "http", host: "10.0.0.1", port: 80 } }),
      topoEnv("a4", "d", null, { proxy: null }),
    ],
  });
  assert.equal(labels.get(EXIT), "203.0.113.105:5890 (http, socks5)");
  assert.equal(labels.get("10.0.0.1:80"), "http://10.0.0.1:80");
  assert.equal(labels.size, 2);
  assert.equal(
    accountExit(
      { id: "a3", exit: null },
      { projects: [], environments: [topoEnv("a3", "c", null)] },
    ),
    EXIT,
  );
  assert.equal(accountExit({ id: "zz", exit: null }, null), null);
});

test("by project: current project first, empty projects kept, unknown projects, 未分配 last", () => {
  const list = models([
    view("a1", "Pine_Example_3", "p-acmeskills"),
    view("a2", "Nova_Harrison", "p-acmeskills"),
    view("a3", "Oak_Example_2", "p-acmegame"),
    view("a4", "orphan", "p-deleted"),
  ]);
  const groups = groupByProject(list, projects, "p-acmegame");
  assert.deepEqual(
    groups.map((group) => group.title),
    ["acmegame (1)", "acmeskills (2)", "人工测试 (0)", "已删除的群 (1)", "未分配 (0)"],
  );
  assert.deepEqual(
    groups[1].accounts.map((account) => account.name),
    ["Nova_Harrison", "Pine_Example_3"],
  );
  assert.equal(groups.at(-1)?.kind, "unassigned");
  assert.equal(groups.at(-1)?.projectId, null);
  // In the default project there is no "current" group to lift.
  assert.equal(groupByProject(list, projects, null)[0].title, "acmeskills (2)");
});

test("by project: the founder is its own group (Yuki · 创始人), never under 未分配", () => {
  const list = models([
    view("f1", "Nova_Harrison", null, { founder: true }),
    view("u1", "Spare", null),
    view("a1", "Pine_Example_3", "p-acmeskills"),
  ]);
  const groups = groupByProject(list, projects, null);
  assert.deepEqual(
    groups.slice(-2).map((group) => [group.kind, group.title]),
    [
      ["founder", "Yuki · 创始人 (1)"],
      ["unassigned", "未分配 (1)"],
    ],
  );
  assert.deepEqual(
    groups.at(-1)?.accounts.map((account) => account.name),
    ["Spare"],
  );
  // No founder, no founder group.
  assert.equal(
    groupByProject(models([view("u1", "Spare", null)]), projects, null).some(
      (g) => g.kind === "founder",
    ),
    false,
  );
});

test("by exit: shared exits first with the design's wording, then 代理读不出 and 没设代理", () => {
  const list = models([
    view("a1", "Oak_Example_2", "p-acmegame"),
    view("a2", "Pine_Example_3", "p-acmeskills"),
    view("a3", "acct-1", null),
    view("a4", "solo", "p-manual", {
      settings: { proxy: { configured: true, preview: "socks5://•••@10.0.0.1:80" } },
    }),
    view("a5", "unread", "p-manual", {
      settings: { unreadable: true, proxy: { configured: true, preview: null } },
    }),
    view("a6", "bare", null, { settings: { proxy: { configured: false, preview: null } } }),
  ]);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const groups = groupByExit(list, {
    exitOf: (account) => account.exit,
    labels: new Map([[EXIT, `http://${EXIT}`]]),
    projectName: (id) => (id === null ? "未分配" : (names.get(id) ?? "")),
  });
  assert.deepEqual(
    groups.map((group) => group.title),
    [
      // One exit used in three scopes: three groups, never one group spanning projects.
      "10.0.0.1:80 · 1 个账号 · 人工测试",
      `http://${EXIT} · 1 个账号 · acmegame`,
      `http://${EXIT} · 1 个账号 · acmeskills`,
      `http://${EXIT} · 1 个账号 · 未分配`,
      "代理读不出 (1)",
      "没设代理 (1)",
    ],
  );
  for (const group of groups.filter((item) => item.kind === "exit"))
    assert.equal(new Set(group.accounts.map((account) => account.projectId)).size, 1);
  assert.ok(!groups.some((group) => group.title.includes("跨")));
  assert.equal(groups.at(-2)?.kind, "unreadable");
  assert.equal(groups.at(-1)?.kind, "noProxy");
});

test("by exit: accounts sharing an exit inside one project group together, shared first", () => {
  const groups = groupByExit(
    models([
      view("a1", "Oak_Example_2", "p-acmegame"),
      view("a2", "acct-1", null),
      view("a3", "solo", "p-manual", {
        settings: { proxy: { configured: true, preview: "socks5://•••@10.0.0.1:80" } },
      }),
      view("a4", "solo-2", "p-manual", {
        settings: { proxy: { configured: true, preview: "socks5://•••@10.0.0.1:80" } },
      }),
    ]),
    {
      exitOf: (account) => account.exit,
      labels: new Map(),
      projectName: (id) => (id === null ? "未分配" : id),
    },
  );
  assert.deepEqual(
    groups.map((group) => group.title),
    [
      "10.0.0.1:80 · 2 个账号 · p-manual",
      `${EXIT} · 1 个账号 · p-acmegame`,
      `${EXIT} · 1 个账号 · 未分配`,
    ],
  );
  assert.equal(t.accountsPage.exitGroup("h:1", 5, "甲"), "h:1 · 5 个账号 · 甲");
  assert.equal(
    t.accountsPage.exitShared("甲", EXIT, 2),
    `甲：${EXIT} 被 2 个账号共用。出口按地址判定，不是实测 IP。`,
  );
});

test("the two-step note is only for a move out of a project; assigning is one step", () => {
  assert.equal(moveNote("p1"), t.assign.twoSteps);
  assert.equal(moveNote(null), null);
});

test("by exit: an exit only unassigned accounts use says 未分配, not 跨 0 个项目", () => {
  const groups = groupByExit(models([view("a1", "acct-1", null), view("a2", "acct-2", null)]), {
    exitOf: (account) => account.exit,
    labels: new Map(),
    projectName: () => "未分配",
  });
  assert.deepEqual(
    groups.map((group) => group.title),
    [`${EXIT} · 2 个账号 · 未分配`],
  );
});

test("exit notes name exits shared inside one project, never across projects (decision A)", () => {
  const labels = new Map([[EXIT, `http://${EXIT}`]]);
  const name = (id: string | null) => (id === null ? "未分配" : id);
  const shared = exitNotes(
    [
      { exit: EXIT, projectId: "p1" },
      { exit: EXIT, projectId: "p2" },
      { exit: EXIT, projectId: "p2" },
      { exit: EXIT, projectId: null },
      { exit: "10.0.0.1:80", projectId: "p1" },
      { exit: null, projectId: null },
    ],
    labels,
    name,
  );
  assert.deepEqual(shared, [`p2：http://${EXIT} 被 2 个账号共用。出口按地址判定，不是实测 IP。`]);
  // Three accounts in three projects on one exit: no project shares it, so only the general note.
  const isolated = exitNotes(
    [
      { exit: EXIT, projectId: "A" },
      { exit: EXIT, projectId: "B" },
      { exit: EXIT, projectId: "C" },
    ],
    labels,
    name,
  );
  assert.deepEqual(isolated, [t.accountsPage.exitNote]);
  assert.ok(!isolated.join("").includes("跨"));
  assert.deepEqual(exitNotes([{ exit: EXIT, projectId: "p1" }], labels, name), [
    t.accountsPage.exitNote,
  ]);
  assert.ok(t.accountsPage.exitNote.includes("不是实测 IP"));
});

test("the page summary counts accounts, distinct exits and live projects", () => {
  assert.deepEqual(
    pageSummary([{ exit: EXIT }, { exit: EXIT }, { exit: "10.0.0.1:80" }, { exit: null }], 4),
    { accounts: 4, exits: 2, projects: 4 },
  );
  // One exit in two projects counts once per project: the total says nothing about sharing.
  assert.equal(
    pageSummary(
      [
        { exit: EXIT, projectId: "A" },
        { exit: EXIT, projectId: "B" },
      ],
      2,
    ).exits,
    2,
  );
  assert.equal(t.accountsPage.summary(5, 1, 4), "5 个账号 · 1 个代理出口 · 4 个群");
  assert.equal(t.accountsPage.summaryMembers(5, 1), "5 个账号 · 1 个代理出口");
});

test("同出口还有 counts only the account's own project (未分配 is its own scope)", () => {
  const all = [
    { id: "a1", exit: EXIT, projectId: "p1" },
    { id: "a2", exit: EXIT, projectId: "p2" },
    { id: "a3", exit: EXIT, projectId: "p1" },
    { id: "a4", exit: EXIT, projectId: null },
    { id: "a5", exit: "10.0.0.1:80", projectId: "p1" },
  ];
  assert.equal(sameExitOthers(all[0], all), 1);
  // An account of another project is never counted with the current project's accounts.
  assert.equal(sameExitOthers({ id: "b1", exit: EXIT, projectId: "B" }, all), 0);
  assert.equal(sameExitOthers(all[3], all), 0);
  assert.equal(sameExitOthers(all[4], all), 0);
  assert.equal(sameExitOthers({ id: "a9", exit: null, projectId: "p1" }, all), 0);
  assert.equal(t.accountDetail.sameExit(4), "同出口还有 4 个账号");
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
const ai = <T>(value: T, reason = "two-year account, idle exit") => ({
  value,
  source: "ai",
  reason,
  setAt,
});
const byHand = <T>(value: T) => ({ value, source: "owner", reason: null, setAt });

test("节奏 second line: each field as set with who set it, or 未定; the zone 「当地」 is; the caps count per account", () => {
  assert.equal(pacingSettingsLine(absentPacing), "切到所在群才看得到");
  const nothing = normalizePacing({ settings: {}, effective: {}, status: {} });
  assert.equal(
    pacingSettingsLine(nothing),
    "间隔 未定 · 每天上限 未定 · 时段 未定；额度按这个号算，所有任务一起计",
  );
  // Caps are per kind (site/action as the task reports it), shown as they are, sorted.
  const decided = normalizePacing({
    effective: {
      minGapMinutes: ai(30),
      caps: { "x.com/post": ai(0), "example.com/comment": byHand(5) },
      activeHours: ai([10, 22]),
      disabled: ["x.com/post"],
    },
    status: {
      timezone: "Europe/London",
      timezoneSource: "environment",
      timezoneReason: "environment",
    },
  });
  assert.equal(
    pacingSettingsLine(decided),
    "间隔 30 分钟（AI 定） · example.com/comment 每天 5（手动） · x.com/post 关（AI 定） · 时段 当地 10–22 点（AI 定）；额度按这个号算，所有任务一起计",
  );
  // No zone of its own (地区 says 没设): the line names the zone 「当地」 is, the desktop template's.
  const zoneless = normalizePacing({
    effective: { minGapMinutes: ai(30) },
    status: {
      timezone: "America/Los_Angeles",
      timezoneSource: "template",
      timezoneReason: "unset",
    },
  });
  assert.equal(
    pacingSettingsLine(zoneless),
    "间隔 30 分钟（AI 定） · 每天上限 未定 · 时段 未定；账号没设时区，「当地」按桌面模板的 America/Los_Angeles；额度按这个号算，所有任务一起计",
  );
  const unreadableZone = normalizePacing({
    effective: {},
    status: {
      timezone: "America/Los_Angeles",
      timezoneSource: "template",
      timezoneReason: "unreadable",
    },
  });
  assert.ok(
    pacingSettingsLine(unreadableZone).includes(
      "账号时区读不出，「当地」按桌面模板的 America/Los_Angeles",
    ),
  );
  // The editor's caption: the task's own layer, whether or not the person's value is over it,
  // with the task's reasons (distinct, newest first).
  assert.equal(aiPacingLine(nothing), "AI 还没为这个号定节奏");
  assert.equal(
    aiPacingLine(
      normalizePacing({
        settings: {
          owner: { caps: { "example.com/comment": { value: 4, setAt } } },
          ai: {
            minGapMinutes: { value: 30, reason: "r", setAt },
            caps: {
              "example.com/comment": {
                value: 6,
                reason: "later: busier exit",
                setAt: "2026-10-11T09:00:00.000Z",
              },
              "example.com/post": { value: 0, reason: "r", setAt },
            },
            activeHours: { value: [10, 22], reason: "r", setAt },
          },
        },
      }),
    ),
    "AI 目前定的：间隔 30 分钟 · example.com/comment 每天 6 · example.com/post 关 · 时段 当地 10–22 点；AI 的理由：later: busier exit；r",
  );
});

test("the time zone line follows the server's timezone fields, wherever it puts them", () => {
  assert.equal(pacingTimezoneLine(undefined), null);
  assert.equal(
    pacingTimezoneLine({
      status: {
        timezone: "America/New_York",
        timezoneSource: "environment",
        timezoneReason: "environment",
      },
    }),
    "按 America/New_York",
  );
  assert.equal(
    pacingTimezoneLine({ effective: { timezone: "Europe/London", timezoneSource: "environment" } }),
    "按 Europe/London",
  );
  assert.equal(
    pacingTimezoneLine({
      status: {
        timezone: "America/Los_Angeles",
        timezoneSource: "template",
        timezoneReason: "unset",
      },
    }),
    "账号没设时区，按桌面模板的 America/Los_Angeles",
  );
  assert.equal(
    pacingTimezoneLine({ status: { timezoneSource: "template", timezoneReason: "unreadable" } }),
    "账号时区读不出，按桌面模板的时区",
  );
});

test("pacing inputs: blank is not set by the person, 0 turns a kind off, unchanged sends nothing", () => {
  const saved = absentPacing.settings.owner;
  const blank = pacingFormOf(saved);
  assert.deepEqual(blank, { gap: "", start: "", end: "", caps: [] });
  assert.equal(pacingPatch(blank, saved), null);
  assert.deepEqual(
    pacingPatch({ ...blank, gap: " 30 ", caps: [{ kind: "Example.com/Post", cap: "0" }] }, saved),
    { pacing: { minGapMinutes: 30, caps: { "example.com/post": 0 } } },
  );
  assert.deepEqual(pacingPatch({ ...blank, start: "10", end: "22" }, saved), {
    pacing: { activeHours: [10, 22] },
  });
  // The form shows the person's values only; what the task set stays blank here.
  const own = normalizePacing({
    settings: {
      owner: {
        minGapMinutes: 30,
        caps: { "example.com/comment": 5, "x.com/post": 0 },
        activeHours: [10, 22],
      },
      ai: { minGapMinutes: { value: 12, reason: "r", setAt } },
    },
  }).settings.owner;
  const filled = pacingFormOf(own);
  assert.deepEqual(filled, {
    gap: "30",
    start: "10",
    end: "22",
    caps: [
      { kind: "example.com/comment", cap: "5" },
      { kind: "x.com/post", cap: "0" },
    ],
  });
  assert.equal(pacingPatch(filled, own), null);
  // Cleared: every field unset, every kind's cap unset (a removed row unsets its kind).
  assert.deepEqual(pacingPatch({ gap: "", start: "", end: "", caps: [] }, own), {
    pacing: {
      minGapMinutes: null,
      activeHours: null,
      caps: { "example.com/comment": null, "x.com/post": null },
    },
  });
  // One cap changed, one row added: only those are sent.
  assert.deepEqual(
    pacingPatch(
      {
        ...filled,
        caps: [
          { kind: "example.com/comment", cap: "7" },
          { kind: "x.com/post", cap: "0" },
          { kind: "x.com/like", cap: "40" },
        ],
      },
      own,
    ),
    { pacing: { caps: { "example.com/comment": 7, "x.com/like": 40 } } },
  );
  const aiOnly = normalizePacing({
    settings: { ai: { minGapMinutes: { value: 12, reason: "r", setAt } } },
  }).settings.owner;
  assert.deepEqual(pacingFormOf(aiOnly), blank);
  // Shape errors, in Chinese; there is no bound of the system's own.
  assert.deepEqual(pacingPatch({ ...blank, gap: "1.5" }, saved), {
    error: "「两次动作之间至少隔（分钟）」要填 0 或正整数",
  });
  assert.deepEqual(pacingPatch({ ...blank, caps: [{ kind: "x.com/post", cap: "-1" }] }, saved), {
    error: "「x.com/post」要填 0 或正整数",
  });
  assert.deepEqual(pacingPatch({ ...blank, caps: [{ kind: "comment", cap: "3" }] }, saved), {
    error: "「comment」要写成 站点/动作，例如 example.com/post",
  });
  assert.deepEqual(
    pacingPatch(
      {
        ...blank,
        caps: [
          { kind: "x.com/post", cap: "1" },
          { kind: "X.com/post", cap: "2" },
        ],
      },
      saved,
    ),
    { error: "「x.com/post」写了两次" },
  );
  assert.equal(pacingPatch({ ...blank, caps: [{ kind: " ", cap: "" }] }, saved), null);
  assert.deepEqual(pacingPatch({ ...blank, start: "9" }, saved), {
    error: t.accountEditor.pacingHoursBoth,
  });
  for (const [start, end] of [
    ["22", "10"],
    ["9", "9"],
    ["24", "24"],
    ["0", "25"],
    ["a", "23"],
  ])
    assert.deepEqual(pacingPatch({ ...blank, start, end }, saved), {
      error: t.accountEditor.pacingHoursRange,
    });
  assert.ok(!("error" in (pacingPatch({ ...blank, start: "0", end: "24" }, saved) ?? {})));
  assert.deepEqual(pacingPatch({ ...blank, caps: [{ kind: "x.com/like", cap: "600" }] }, saved), {
    pacing: { caps: { "x.com/like": 600 } },
  });
  assert.equal(answerHasPacing({ id: "a", pacing: { settings: {} } }), true);
  assert.equal(answerHasPacing({ id: "a" }), false);
});

test("the editor's validation messages read in Chinese; server messages stay as they are", () => {
  const message = (form: Parameters<typeof environmentPayload>[0], mode: "create" | "edit") => {
    const payload =
      mode === "create" ? environmentPayload(form, "create") : environmentPayload(form, "edit");
    assert.ok("error" in payload);
    return editorError((payload as { error: string }).error);
  };
  assert.equal(message({ name: "", proxyUrl: "http://h:1" }, "create"), "名称必填");
  assert.equal(message({ name: "a" }, "create"), "代理必填");
  assert.equal(
    message({ name: "default", proxyUrl: "http://h:1" }, "create"),
    "「default」留给群默认桌面，换一个名称",
  );
  assert.equal(
    message({ name: "a".repeat(environmentNameMax + 1), proxyUrl: "http://h:1" }, "create"),
    `名称最多 ${environmentNameMax} 个字`,
  );
  assert.equal(
    message({ name: "a", proxyUrl: "http://h:1", timezone: "Mars/Base" }, "create"),
    "不认识的时区「Mars/Base」，请用 America/Los_Angeles 这样的写法",
  );
  assert.equal(
    message({ name: "a", proxyUrl: "http://h:1", locale: "not a locale!" }, "create"),
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

test("no accounts copy asks the person to type pacing or reporting, or to approve anything", () => {
  const all = JSON.stringify(t, (_, value) =>
    typeof value === "function" ? String(value) : value,
  );
  for (const banned of [
    "发完汇报",
    "汇报给我",
    "间隔 20 分钟发",
    "批准",
    "审批",
    "确认发帖",
    "系统默认",
    "默认节奏",
    "每天 8 评论",
  ])
    assert.ok(!all.includes(banned), banned);
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

test("the founder joins no project: never offered to one, and its place is the hall, not 未分配", () => {
  // docs/founder.md: the founder belongs to the whole space; the server refuses its move.
  assert.equal(joinsProjects({ founder: true }), false);
  assert.equal(joinsProjects({}), true);
  const name = (id: string | null) => (id === null ? t.accountsPage.unassigned : "acmeskills");
  assert.equal(accountPlace({ projectId: null, view: { founder: true } }, name), "Yuki · 创始人");
  assert.equal(accountPlace({ projectId: null, view: {} }, name), "未分配");
  assert.equal(accountPlace({ projectId: "p1", view: {} }, name), "acmeskills");
});

test("an exit's group and note name the founder by her place, never 未分配", () => {
  // The founder and 未分配 share the default project's scope (an exit they share is counted
  // once), but each is named as what it is, as 账号与代理 and the pane name them.
  const name = (id: string | null) => (id === null ? t.accountsPage.unassigned : id);
  const founder = view("f1", "Nova_Harrison", null, { founder: true });
  const alone = groupByExit(models([founder]), {
    exitOf: (account) => account.exit,
    labels: new Map(),
    projectName: name,
  });
  assert.deepEqual(
    alone.map((group) => group.title),
    [`${EXIT} · 1 个账号 · Yuki · 创始人`],
  );
  assert.equal(
    plainGroupTitle(alone[0], { projectName: name, exitLabel: (exit) => exit }),
    `${EXIT} · Yuki · 创始人`,
  );
  const shared = groupByExit(models([founder, view("a1", "acct-1", null)]), {
    exitOf: (account) => account.exit,
    labels: new Map(),
    projectName: name,
  });
  assert.deepEqual(
    shared.map((group) => group.title),
    [`${EXIT} · 2 个账号 · Yuki · 创始人、未分配`],
  );
  assert.deepEqual(exitNotes(models([founder, view("a1", "acct-1", null)]), new Map(), name), [
    `Yuki · 创始人、未分配：${EXIT} 被 2 个账号共用。出口按地址判定，不是实测 IP。`,
  ]);
  assert.equal(
    placeOf([{ projectId: null, view: { founder: true } }, { projectId: null }], name),
    "Yuki · 创始人、未分配",
  );
});
