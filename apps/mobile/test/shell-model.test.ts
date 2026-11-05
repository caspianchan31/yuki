// The shell's pure model, strings and layout.
import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptItem } from "../../../packages/client/src/chat-reports-core.ts";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import {
  accountsSplit,
  canSwitchProject,
  dockCovered,
  dockedAccountId,
  layoutFor,
  layoutMode,
  panelAfterClose,
  panelAfterViewChange,
  panelDocked,
} from "../../../packages/client/src/shell/layout-core.ts";
import {
  type AccountView,
  accountLight,
  buildAccountModels,
  groupTranscript,
  latestReports,
  needItems,
  normalizeBrief,
  normalizeOverview,
  normalizeProjectSignIns,
  operatingPlanOf,
  otherProjectsNeedsYou,
  phaseActions,
  projectNeedText,
  quietNext,
  railTasks,
  shellCounts,
  shownLabel,
  sortProjects,
  taskEntries,
  taskPhaseLabel,
  workerHealth,
} from "../../../packages/client/src/shell/model.ts";
import { phaseWords, reportLabel, t } from "../../../packages/client/src/shell/strings.ts";
import type { AgentTask, ChatReport } from "../../../packages/domain/src/agent.ts";
import type { ActionProposal } from "../../../packages/domain/src/index.ts";

const now = new Date(2026, 9, 10, 14, 47);
const at = (hours: number, minutes: number, dayOffset = 0) =>
  new Date(2026, 9, 10 + dayOffset, hours, minutes).toISOString();

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "任务",
    prompt: "p",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: at(12, 0),
    updatedAt: at(14, 0),
    attempts: 1,
    artifactIds: [],
    ...overrides,
  };
}
function account(overrides: Record<string, unknown> = {}): AccountView {
  const settings = {
    timezone: "America/Los_Angeles",
    locale: "en-US",
    updatedAt: null,
    ...((overrides.settings as object) ?? {}),
  };
  return {
    ...normalizeEnvironment({
      id: "a1",
      name: "Oak_Example_2",
      accountLabel: "oak_example_2",
      projectId: "p1",
      status: "running",
      ...overrides,
      settings,
    }),
  };
}
function report(overrides: Partial<ChatReport> = {}): ChatReport {
  return {
    id: "r1",
    taskId: "t1",
    taskTitle: "任务",
    threadId: "main",
    kind: "report",
    title: "Update",
    text: "x",
    links: [],
    createdAt: at(14, 10),
    readAt: null,
    ...overrides,
  };
}
const entriesOf = (tasks: AgentTask[]) => taskEntries(tasks, now);

test("server report labels read in Chinese, unknown ones as they are", () => {
  assert.equal(reportLabel("Update"), "进展");
  assert.equal(reportLabel("Finished"), "完成");
  assert.equal(reportLabel("Run 3 finished"), "第 3 轮完成");
  assert.equal(reportLabel("Needs attention"), "出问题");
  assert.equal(reportLabel("Needs your input"), "等你回答");
  assert.equal(reportLabel("Ready for your review"), "等你审阅");
  assert.equal(reportLabel("Change found"), "网页有变化");
  assert.equal(reportLabel("Run failed"), "这轮失败");
  assert.equal(reportLabel("Paused after repeated failures"), "连续失败已暂停");
  assert.equal(reportLabel("Watch needs attention"), "监控出问题");
  assert.equal(reportLabel("Comment"), "评论");
  assert.equal(reportLabel("Post"), "帖子");
  assert.equal(reportLabel("Reply"), "回复");
  assert.equal(reportLabel("Message"), "私信");
  assert.equal(reportLabel("Summary"), "复盘");
  assert.equal(reportLabel("Notice"), "提醒");
  assert.equal(reportLabel("Plan v2"), "计划第 2 版");
  assert.equal(reportLabel("Plan"), "计划");
  assert.equal(reportLabel("Comment · over pace"), "评论 · 超出节奏");
  assert.equal(reportLabel("计划 v1"), "计划 v1");
  assert.equal(reportLabel("toString"), "toString");
  // A persona's versions, and what an action did to the project's other accounts.
  assert.equal(reportLabel("Persona v3"), "人设第 3 版");
  const action = { site: "example.com", action: "reply" };
  assert.equal(reportLabel("Action · sibling touched", action), "回复 · example.com · 碰到自己人");
  assert.equal(
    reportLabel("Action · same place as Dan · over pace", action),
    "回复 · example.com · 和 Dan 进了同一处 · 超出节奏",
  );
});

test("layout has three widths", () => {
  assert.equal(layoutMode(390), "phone");
  assert.equal(layoutMode(767), "phone");
  assert.equal(layoutMode(768), "tablet");
  assert.equal(layoutMode(1099), "tablet");
  assert.equal(layoutMode(1100), "desktop");
  const phone = layoutFor(400);
  // No drawer on a phone in either view (shell-view-mode.test.ts).
  assert.equal(phone.drawer, false);
  assert.equal(phone.railWidth, 352);
  assert.equal(layoutFor(600).railWidth, 440);
  const tablet = layoutFor(800);
  assert.equal(tablet.drawer, false);
  assert.equal(tablet.railWidth, 340);
  const desktop = layoutFor(1280);
  assert.equal(desktop.railWidth, 360);
  // The simple view has no project column; the pro view brings it back (shell-view-mode.test.ts).
  assert.equal(desktop.projectColumn, false);
});

test("the header switches projects on every width (no project column)", () => {
  // The switch depends on the space only, never on the width: no Layout field disables it.
  for (const width of [390, 800, 1100, 1280, 1920])
    assert.equal(canSwitchProject({ ...layoutFor(width) }), true, String(width));
});

test("the accounts page docks the account detail from 1100 only", () => {
  assert.equal(accountsSplit(layoutMode(1280)), true);
  assert.equal(accountsSplit(layoutMode(1100)), true);
  assert.equal(accountsSplit(layoutMode(1099)), false);
  assert.equal(accountsSplit(layoutMode(390)), false);
  const account = { kind: "account" as const, environmentId: "a1" };
  const on = { mode: "desktop" as const, view: "accounts" as const };
  assert.equal(dockedAccountId({ ...on, panel: account }), "a1");
  assert.equal(panelDocked({ ...on, panel: account }), true);
  // Phone and tablet keep the card; so does the workbench (the rail opens the same detail).
  for (const mode of ["phone", "tablet"] as const) {
    assert.equal(dockedAccountId({ mode, view: "accounts", panel: account }), null);
    assert.equal(panelDocked({ mode, view: "accounts", panel: account }), false);
  }
  assert.equal(panelDocked({ mode: "desktop", view: "work", panel: account }), false);
  // A card opened from the docked detail sits over the page; the detail stays beside it.
  const over = [
    { kind: "assign" as const, environmentId: "a1" },
    { kind: "accountEditor" as const, environmentId: "a1" },
    {
      kind: "legacy" as const,
      detail: { type: "computer" as const, environment: { id: "a1", name: "Alice" } },
    },
  ];
  for (const panel of over) {
    assert.equal(dockedAccountId({ ...on, panel }), "a1", panel.kind);
    assert.equal(panelDocked({ ...on, panel }), false, `${panel.kind} stays a card`);
  }
  assert.equal(dockedAccountId({ ...on, panel: { kind: "accountEditor" } }), null);
  assert.equal(dockedAccountId({ ...on, panel: { kind: "settings" } }), null);
  assert.equal(dockedAccountId({ ...on, panel: null }), null);
});

test("closing a card opened over the docked account detail goes back to the detail", () => {
  const on = { mode: "desktop" as const, view: "accounts" as const };
  const detail = { kind: "account" as const, environmentId: "a1" };
  // 移到… / 分配到…, 编辑 and 打开桌面 opened from the docked detail: ✕, Escape and the scrim close
  // the card only (nav.closePanel would set the panel to null and take the detail with it).
  const cards = [
    { kind: "assign" as const, environmentId: "a1" },
    { kind: "accountEditor" as const, environmentId: "a1" },
    {
      kind: "legacy" as const,
      detail: { type: "computer" as const, environment: { id: "a1", name: "Alice" } },
    },
  ];
  for (const panel of cards) {
    assert.deepEqual(panelAfterClose({ ...on, panel }), detail, panel.kind);
    // The docked detail leaves Escape to the card over it.
    assert.equal(dockCovered({ ...on, panel }), true, panel.kind);
  }
  // The docked detail itself closes for good, and takes Escape while nothing covers it.
  assert.equal(panelAfterClose({ ...on, panel: detail }), null);
  assert.equal(dockCovered({ ...on, panel: detail }), false);
  // Anything else just closes: phone and tablet cards (no docked detail), the workbench, the
  // new-account form, settings, no panel.
  for (const mode of ["phone", "tablet"] as const)
    for (const panel of cards) {
      assert.equal(panelAfterClose({ mode, view: "accounts", panel }), null);
      assert.equal(dockCovered({ mode, view: "accounts", panel }), false);
    }
  for (const panel of cards) assert.equal(panelAfterClose({ ...on, view: "work", panel }), null);
  assert.equal(panelAfterClose({ ...on, panel: { kind: "accountEditor" } }), null);
  assert.equal(panelAfterClose({ ...on, panel: { kind: "settings" } }), null);
  assert.equal(panelAfterClose({ ...on, panel: null }), null);
  assert.equal(dockCovered({ ...on, panel: null }), false);
});

const inForce = <T>(value: T, source: "ai" | "owner" = "ai", reason: string | null = "r") => ({
  value,
  source,
  reason: source === "owner" ? null : reason,
  setAt: at(12, 0),
});
/** The kinds these tests use (site/action, as a task reports them). */
const C = "example.com/comment";
const P = "example.com/post";
/** A view's `pacing` with every field set (a gap, a cap on two kinds, a window) unless `over`
 * says otherwise; nothing here is a system value. */
const _allSet = (over: Record<string, unknown> = {}) => ({
  minGapMinutes: inForce(30),
  caps: { [C]: inForce(5), [P]: inForce(2) },
  activeHours: inForce([10, 22]),
  disabled: [],
  ...over,
});

test("account rows: light, 此刻, 下次, last report, flags", () => {
  const wait = { minutes: 20, note: "n", since: at(14, 40), until: at(15, 0) };
  const entries = entriesOf([
    task({
      id: "w",
      status: "scheduled",
      nextRunAt: wait.until,
      state: { wait },
      input: { environmentId: "a1" },
    }),
    task({ id: "r", status: "running", input: { environmentId: "a1" } }),
    task({ id: "x", status: "running", input: {} }),
  ]);
  const [model] = buildAccountModels({
    accounts: [account()],
    entries,
    now,
  });
  assert.equal(model.light, "blue");
  assert.equal(model.now?.entry.task.id, "r");
  assert.equal(model.now?.more, 1);
  assert.equal(model.next?.label, "15:00 继续（等待）");
  assert.equal(model.label, null);
  assert.deepEqual(model.flags, []);
  assert.equal(model.desktopWord, "运行中");
  assert.equal(accountLight(account({ status: "error" }), null), "red");
  assert.equal(accountLight(account({ status: "missing" }), null), "hollow");
  assert.equal(accountLight(account({ status: "stopped" }), null), "grey");
  const failed = entriesOf([task({ status: "failed", updatedAt: at(14, 41) })])[0];
  assert.equal(accountLight(account(), failed), "red");
  const asked = entriesOf([task({ status: "waiting_input", question: "?" })])[0];
  assert.equal(accountLight(account(), asked), "amber");
});

test("需要你 holds questions, reviews, 7-day failures and account flags only", () => {
  const entries = entriesOf([
    task({ id: "q", status: "waiting_input", question: "?" }),
    task({ id: "ap", status: "waiting_approval", actionId: "act1" }),
    task({ id: "f", status: "failed", updatedAt: at(14, 0) }),
    task({ id: "old", status: "failed", updatedAt: at(14, 0, -9) }),
    task({ id: "r1", status: "running", input: { environmentId: "a1" } }),
    task({ id: "r2", status: "running", input: { environmentId: "a1" } }),
  ]);
  const accounts = buildAccountModels({
    accounts: [account(), account({ id: "a2", name: "example_user_1", status: "error" })],
    entries,
    now,
  });
  const actions = [
    { id: "act1", status: "awaiting_review", title: "Reply" },
    { id: "act2", status: "awaiting_review", title: "Invite" },
    { id: "act3", status: "succeeded", title: "Done" },
  ] as ActionProposal[];
  const needs = needItems({ entries, actions, accounts });
  assert.deepEqual(
    needs.map((item) => item.key),
    ["task:q", "task:ap", "task:f", "review:act2", "account:a2"],
  );
  const counts = shellCounts(entries, needs);
  assert.deepEqual(counts, {
    needsYou: 5,
    waitingOnYou: 4,
    failed: 1,
    running: 2,
    waiting: 0,
    scheduled: 0,
  });
});

test("the rail orders tasks: running, waiting by resume, scheduled by next run; folds", () => {
  const wait = (until: string) => ({ minutes: 20, note: "n", since: at(14, 0), until });
  const entries = entriesOf([
    task({ id: "s2", status: "scheduled", repeatMinutes: 60, nextRunAt: at(16, 0) }),
    task({
      id: "w2",
      status: "scheduled",
      nextRunAt: at(15, 30),
      state: { wait: wait(at(15, 30)) },
    }),
    task({ id: "s1", status: "scheduled", repeatMinutes: 60, nextRunAt: at(15, 10) }),
    task({ id: "w1", status: "scheduled", nextRunAt: at(15, 0), state: { wait: wait(at(15, 0)) } }),
    task({ id: "q", status: "queued" }),
    task({ id: "r", status: "running" }),
    task({ id: "p", status: "paused" }),
    task({ id: "d", status: "succeeded", updatedAt: at(10, 0) }),
    task({ id: "d2", status: "succeeded", updatedAt: at(10, 0, -3) }),
    task({ id: "n", status: "waiting_input", question: "?" }),
  ]);
  const rail = railTasks(entries, now);
  assert.equal(rail.needCount, 1);
  assert.deepEqual(
    rail.active.map((entry) => entry.task.id),
    ["r", "q", "w1", "w2", "s1", "s2"],
  );
  assert.deepEqual(
    rail.paused.map((entry) => entry.task.id),
    ["p"],
  );
  assert.deepEqual(
    rail.ended.map((entry) => entry.task.id),
    ["d"],
  );
  assert.equal(quietNext(entries, now), "下一次 15:00");
  assert.equal(quietNext([], now), "没有排期");
});

test("inline actions follow the phase", () => {
  const [run, wait, sched, pause, fail, input] = entriesOf([
    task({ status: "running" }),
    task({
      status: "scheduled",
      nextRunAt: at(15, 0),
      state: { wait: { minutes: 20, note: "n", since: at(14, 40), until: at(15, 0) } },
    }),
    task({ status: "scheduled", repeatMinutes: 60, nextRunAt: at(15, 0) }),
    task({ status: "paused" }),
    task({ status: "failed" }),
    task({ status: "waiting_input" }),
  ]).map((entry) => entry.phase);
  const labels = (phase: typeof run, compact = false, repeating = false) =>
    phaseActions(phase, compact, repeating).map((action) => action.label);
  assert.deepEqual(labels(run), ["暂停"]);
  assert.deepEqual(labels(wait), ["立即继续", "暂停"]);
  assert.deepEqual(labels(wait, true), ["立即继续"]);
  assert.deepEqual(labels(sched, false, true), ["立即运行", "改间隔", "停止重复"]);
  assert.deepEqual(labels(sched, true, true), ["立即运行"]);
  // A one-off task scheduled again (the infrastructure stopped its run) has no interval.
  assert.deepEqual(labels(sched), ["立即运行"]);
  assert.deepEqual(labels(pause), ["恢复"]);
  assert.deepEqual(labels(fail), ["重试"]);
  assert.deepEqual(labels(input), []);
});

test("consecutive reports of one task merge; need reports stand alone", () => {
  const message = (id: string): TranscriptItem<{ id: string }> => ({
    type: "message",
    key: id,
    message: { id },
  });
  const item = (r: ChatReport): TranscriptItem<{ id: string }> => ({
    type: "report",
    key: `report-${r.id}`,
    report: r,
  });
  const grouped = groupTranscript([
    message("m1"),
    item(report({ id: "a", taskId: "t1", title: "Plan v1" })),
    item(report({ id: "b", taskId: "t1" })),
    item(report({ id: "c", taskId: "t2" })),
    item(report({ id: "d", taskId: "t2", kind: "outcome", title: "Needs your input" })),
    item(report({ id: "e", taskId: "t2" })),
    message("m2"),
    item(report({ id: "f", taskId: "t2" })),
    // A card about a job or a persona stands alone, like a need.
    item(report({ id: "g", taskId: "t2", notice: { kind: "job_done", jobTitle: "J" } })),
    item(report({ id: "h", taskId: "t2" })),
  ]);
  assert.deepEqual(
    grouped.map((entry) =>
      entry.type === "reports"
        ? `R:${entry.reports.map((r) => r.id).join("")}`
        : entry.type === "need"
          ? `N:${entry.report.id}`
          : entry.type === "notice"
            ? `J:${entry.report.id}`
            : `M:${entry.message.id}`,
    ),
    ["M:m1", "R:ab", "R:c", "N:d", "R:e", "M:m2", "R:f", "J:g", "R:h"],
  );
  assert.deepEqual(
    latestReports(
      [report({ id: "1", createdAt: at(1, 0) }), report({ id: "2", createdAt: at(2, 0) })],
      1,
    ).map((r) => r.id),
    ["2"],
  );
});

test("project overview: read, sort, red dot", () => {
  assert.equal(normalizeOverview({}), null);
  const list = normalizeOverview({
    projects: [
      { id: null, name: "", accounts: 1, counts: {}, lastActivityAt: null },
      {
        id: "a",
        name: "acmegame",
        accounts: 1,
        counts: { running: 1 },
        lastActivityAt: at(14, 45),
      },
      {
        id: "b",
        name: "长期测试",
        accounts: 1,
        counts: { needsYou: 1, failed7d: 1 },
        lastActivityAt: at(14, 41),
      },
      {
        id: "c",
        name: "acmeskills",
        accounts: 2,
        counts: { waiting: 1 },
        lastActivityAt: at(14, 46),
      },
    ],
  });
  assert.ok(list);
  assert.deepEqual(
    sortProjects(list).map((project) => project.name),
    ["长期测试", "acmeskills", "acmegame", ""],
  );
  assert.equal(otherProjectsNeedsYou(list, "a"), 1);
  assert.equal(otherProjectsNeedsYou(list, "b"), 0);
  assert.equal(otherProjectsNeedsYou(null, "a"), 0);
});

test("worker health: a heartbeat older than 45 seconds is down", () => {
  assert.equal(
    workerHealth({ running: true, lastTickAt: new Date(now.getTime() - 10_000).toISOString() }, now)
      .down,
    false,
  );
  const down = workerHealth(
    { running: false, lastTickAt: new Date(now.getTime() - 180_000).toISOString() },
    now,
  );
  assert.equal(down.down, true);
  assert.equal(down.sinceMs, 180_000);
  assert.equal(workerHealth({ running: false }, now).down, true);
  assert.equal(workerHealth(undefined, now).down, false);
  // This device's clock is 2 minutes ahead of the server's: the server still says running.
  assert.equal(
    workerHealth(
      { running: true, lastTickAt: new Date(now.getTime() - 120_000).toISOString() },
      now,
    ).down,
    false,
  );
  // Stopped by the server's verdict, but the last tick is only 20 s old here: no flash yet.
  assert.equal(
    workerHealth(
      { running: false, lastTickAt: new Date(now.getTime() - 20_000).toISOString() },
      now,
    ).down,
    false,
  );
});

test("helpers: labels, plan, brief", () => {
  assert.equal(shownLabel("Oak_Example_2", "oak_example_2 "), null);
  assert.equal(shownLabel("acct-1", null), null);
  assert.equal(shownLabel("acct-1", "本人账号"), "本人账号");
  assert.equal(operatingPlanOf(task()), null);
  const plan = operatingPlanOf(
    task({
      state: {
        operatingPlan: {
          version: 2,
          setAt: at(12, 51),
          communities: [
            { name: "r/LocalLLaMA", why: "开发者多", rule: "不放链接" },
            "r/IPhoneApps",
          ],
          forms: "以回复为主，一帖",
          voice: "以开发团队成员身份出现",
          pace: "间隔 30 分钟、每天 5 条评论（AI 定）",
          review: ["每天复盘", "每周建议"],
          horizon: "持续运营",
        },
      },
    }),
  );
  assert.equal(plan?.version, 2);
  assert.equal(plan?.communities.length, 2);
  assert.equal(plan?.communities[1].name, "r/IPhoneApps");
  assert.equal(plan?.review, "每天复盘；每周建议");
  assert.deepEqual(normalizeBrief({ text: "AcmeGame", updatedAt: at(1, 0) }), {
    text: "AcmeGame",
    updatedAt: at(1, 0),
  });
  assert.deepEqual(normalizeBrief(null), { text: "", updatedAt: null });
});

test("switching between the workbench and the accounts page closes the open panel", () => {
  const account = { kind: "account", environmentId: "env-1" } as const;
  // The docked detail must not come back as a card over the chat after 「← 返回」.
  assert.equal(panelAfterViewChange({ from: "accounts", to: "work", panel: account }), null);
  assert.equal(panelAfterViewChange({ from: "work", to: "accounts", panel: account }), null);
  // Setting the same view again keeps it.
  assert.deepEqual(
    panelAfterViewChange({ from: "accounts", to: "accounts", panel: account }),
    account,
  );
  assert.equal(panelAfterViewChange({ from: "work", to: "work", panel: null }), null);
});

test("the project's own sign-in facts are 需要你 items, last, one per site's step, and only what the owner acts on", () => {
  const facts = normalizeProjectSignIns({
    signIns: [
      { site: "apple.com", status: "needs_code" },
      { site: "x.com", status: "signed_in" },
      { site: 3, status: "wrong_password" },
      null,
    ],
  });
  assert.deepEqual(facts, [
    { site: "apple.com", status: "needs_code" },
    { site: "x.com", status: "signed_in" },
  ]);
  assert.deepEqual(normalizeProjectSignIns({ error: "x" }), []);
  const entries = entriesOf([task({ id: "q", status: "waiting_input", question: "?" })]);
  const needs = needItems({ entries, actions: [], accounts: [], projectSignIns: facts });
  assert.deepEqual(
    needs.map((item) => item.key),
    ["task:q", "project:sign-ins|site:needs_code:apple.com"],
  );
  assert.equal(shellCounts(entries, needs).needsYou, 2);
  assert.equal(
    projectNeedText(["site:needs_code:apple.com"]),
    t.needs.projectFact(t.needs.needsCode("apple.com")),
  );
  // Healthy facts only: no item.
  assert.deepEqual(
    needItems({ entries: [], actions: [], accounts: [], projectSignIns: [facts[1]] }),
    [],
  );
});

test("a task's state in a list line is its Chinese phase word, never the raw status", () => {
  assert.equal(taskPhaseLabel(task({ status: "queued" }), now), phaseWords.labels.queue);
  assert.equal(taskPhaseLabel(task({ status: "running" }), now), phaseWords.labels.run);
  assert.equal(taskPhaseLabel(task({ status: "paused" }), now), phaseWords.labels.pause);
  for (const status of ["queued", "running", "paused", "cancelled", "succeeded"] as const)
    assert.match(taskPhaseLabel(task({ status }), now), /[\u3000-\u9fff]/);
});
