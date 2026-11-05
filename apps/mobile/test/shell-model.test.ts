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
  absentPacing,
  accountLight,
  buildAccountModels,
  exitOfPreview,
  groupTranscript,
  latestReports,
  needItems,
  normalizeBrief,
  normalizeOverview,
  normalizePacing,
  normalizeProjectSignIns,
  operatingPlanOf,
  otherProjectsNeedsYou,
  paceKindWords,
  paceLine,
  paceReason,
  paceSite,
  paceSourceMark,
  paceWhen,
  paceWhenLabel,
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
import {
  phaseWords,
  reportLabel,
  t,
  taskTitleText,
} from "../../../packages/client/src/shell/strings.ts";
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
function account(overrides: Record<string, unknown> = {}, pacing?: unknown): AccountView {
  const settings = {
    proxy: { configured: true, preview: "http://•••@203.0.113.105:5890" },
    timezone: "America/Los_Angeles",
    locale: "en-US",
    updatedAt: null,
    unreadable: false,
    ...((overrides.settings as object) ?? {}),
  };
  return {
    ...normalizeEnvironment({
      id: "a1",
      name: "Oak_Example_2",
      accountLabel: "oak_example_2",
      projectId: "p1",
      status: "running",
      proxyConfigured: true,
      ...overrides,
      settings,
    }),
    pacing: normalizePacing(pacing),
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

test("no string tells the person to type pacing or reporting", () => {
  const all = JSON.stringify(t, (_, value) =>
    typeof value === "function" ? String(value) : value,
  );
  for (const banned of ["发完汇报", "每发一条汇报给我", "间隔 20 分钟发"])
    assert.ok(!all.includes(banned), banned);
  assert.ok(!t.newTask.whatPlaceholder.includes("分钟"));
  assert.ok(!t.chat.placeholder(t.group.hallOps).includes("节奏"));
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
    assert.equal(canSwitchProject({ store: false, ...layoutFor(width) }), true, String(width));
  assert.equal(canSwitchProject({ store: true }), false);
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

test("pacing time zone fields are read from status when effective has none", () => {
  const pacing = normalizePacing({
    settings: {},
    effective: {},
    status: {
      timezone: "America/Los_Angeles",
      timezoneSource: "environment",
      timezoneReason: "environment",
      usedToday: {},
    },
  });
  assert.equal(pacing.effective.timezone, "America/Los_Angeles");
  assert.equal(pacing.effective.timezoneSource, "environment");
  assert.equal(pacing.effective.timezoneReason, "environment");
  const unreadable = normalizePacing({
    effective: {},
    status: { timezone: "UTC", timezoneSource: "template", timezoneReason: "unreadable" },
  });
  assert.equal(unreadable.effective.timezoneSource, "template");
  assert.equal(unreadable.effective.timezoneReason, "unreadable");
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
const allSet = (over: Record<string, unknown> = {}) => ({
  minGapMinutes: inForce(30),
  caps: { [C]: inForce(5), [P]: inForce(2) },
  activeHours: inForce([10, 22]),
  disabled: [],
  ...over,
});

test("pacing absent (a view built from the topology) is unknown here, not unset", () => {
  assert.equal(normalizePacing(undefined), absentPacing);
  assert.equal(absentPacing.present, false);
  assert.equal(paceLine(absentPacing, now), "切到所在群才看得到");
  assert.equal(paceSourceMark(absentPacing), null);
  assert.equal(paceReason(absentPacing), null);
});

test("nothing set: 未定, with today's usage first when there is any; who set what; the reasons", () => {
  const unset = normalizePacing({ settings: {}, effective: {}, status: { usedToday: {} } });
  assert.equal(unset.present, true);
  assert.equal(paceLine(unset, now), "节奏还没定，下次运行时由它自己定");
  assert.equal(paceSourceMark(unset), null);
  assert.equal(paceReason(unset), null);
  const used = normalizePacing({
    settings: {},
    effective: {},
    status: { usedToday: { [C]: 2, "x.com/like": 1 } },
  });
  assert.equal(
    paceLine(used, now),
    `今天评论（example.com） 2 次 · 点赞（x.com） 1 次 · 节奏还没定，下次运行时由它自己定`,
  );
  // The task set everything with one reason.
  const ai = normalizePacing({
    effective: allSet({ minGapMinutes: inForce(30, "ai", "two-year account, exit of its own") }),
    status: { usedToday: { [C]: 1 }, remainingToday: { [C]: 4, [P]: 2 } },
  });
  assert.equal(paceSourceMark(ai), "AI 定");
  assert.equal(paceReason(ai), "two-year account, exit of its own；r");
  // A kind's cap the person fixed over the task's: both marks; the person's has no reason.
  const mixed = normalizePacing({
    effective: allSet({ caps: { [C]: inForce(3, "owner"), [P]: inForce(2) } }),
    status: { usedToday: { [C]: 1 } },
  });
  assert.equal(paceSourceMark(mixed), "AI 定 · 手动");
  assert.equal(paceReason(mixed), "r");
  const owner = normalizePacing({
    effective: allSet({
      minGapMinutes: inForce(30, "owner"),
      caps: { [C]: inForce(5, "owner"), [P]: inForce(2, "owner") },
      activeHours: inForce([10, 22], "owner"),
    }),
    status: {},
  });
  assert.equal(paceSourceMark(owner), "手动");
  assert.equal(paceReason(owner), null);
  // The settings layers are read as the server sends them (and an older plain value).
  const layered = normalizePacing({
    settings: {
      owner: {
        minGapMinutes: { value: 45, setAt: at(1, 0) },
        caps: { [P]: { value: 1, setAt: at(1, 0) } },
      },
      ai: { caps: { [C]: { value: 6, reason: "why", setAt: at(2, 0) } } },
    },
    effective: {},
  });
  assert.equal(layered.settings.owner.minGapMinutes, 45);
  assert.deepEqual(layered.settings.owner.caps, { [P]: 1 });
  assert.equal(layered.settings.owner.activeHours, null);
  assert.deepEqual(layered.settings.ai.caps[C], { value: 6, reason: "why", setAt: at(2, 0) });
  assert.equal(layered.settings.ai.minGapMinutes, null);
});

test("the pace line follows the ledger against what is set", () => {
  const ledger = (status: Record<string, unknown>, effective: Record<string, unknown> = {}) =>
    normalizePacing({
      settings: {},
      effective: allSet(effective),
      status: { inActiveHours: true, ...status },
    });
  const set = "间隔 30 分 · 当地 10–22 点";
  // Posts used up, comments wait for the gap: the next time.
  assert.equal(
    paceLine(
      ledger({
        usedToday: { [C]: 2, [P]: 2 },
        remainingToday: { [C]: 3, [P]: 0 },
        earliestNext: { [C]: at(15, 0), "*": at(15, 0) },
        minutesUntilNext: { [C]: 13, "*": 13 },
      }),
      now,
    ),
    `今天评论 2/5 次 · 发帖 2/2 次 · ${set} · 下次可做 15:00`,
  );
  assert.equal(
    paceLine(
      ledger({
        usedToday: { [C]: 1 },
        remainingToday: { [C]: 4, [P]: 2 },
        earliestNext: { [C]: at(14, 30), [P]: at(14, 30), "*": at(14, 30) },
        minutesUntilNext: { [C]: 0, [P]: 0, "*": 0 },
      }),
      now,
    ),
    `今天评论 1/5 次 · 发帖 0/2 次 · ${set} · 现在可做`,
  );
  // One kind used up, the others may go now: said which is full.
  assert.equal(
    paceLine(
      ledger({
        usedToday: { [C]: 1, [P]: 2 },
        remainingToday: { [C]: 4, [P]: 0 },
        minutesUntilNext: { [C]: 0, "*": 0 },
      }),
      now,
    ),
    `今天评论 1/5 次 · 发帖 2/2 次 · ${set} · 现在可做（发帖 今日已满）`,
  );
  // Every cap used up and only the caps are set (no gap, no window): other kinds are free now.
  assert.equal(
    paceLine(
      ledger(
        { usedToday: { [C]: 5, [P]: 2 }, remainingToday: { [C]: 0, [P]: 0 } },
        { minGapMinutes: null, activeHours: null },
      ),
      now,
    ),
    `今天评论 5/5 次 · 发帖 2/2 次 · 现在可做（评论、发帖 今日已满）`,
  );
  // A cap set to 0 reads 关; a kind with no cap reads its count alone.
  assert.equal(
    paceLine(
      ledger(
        {
          usedToday: { [C]: 2, "x.com/like": 4 },
          remainingToday: { [C]: 3, [P]: 0 },
          minutesUntilNext: { [C]: 0, "*": 0 },
        },
        { caps: { [C]: inForce(5), [P]: inForce(0) }, disabled: [P] },
      ),
      now,
    ),
    `今天评论（example.com） 2/5 次 · 发帖（example.com） 关 · 点赞（x.com） 4 次 · ${set} · 现在可做`,
  );
  // Only a gap set and not yet over: the next time, nothing about caps.
  assert.equal(
    paceLine(
      ledger(
        {
          usedToday: { [C]: 1 },
          remainingToday: {},
          earliestNext: { "*": at(14, 50) },
          minutesUntilNext: { "*": 3 },
          inActiveHours: null,
        },
        { caps: {}, activeHours: null },
      ),
      now,
    ),
    `今天评论 1 次 · 间隔 30 分 · 下次可做 14:50`,
  );
  // Outside the window: when it opens.
  assert.equal(
    paceLine(
      ledger({
        inActiveHours: false,
        usedToday: { [C]: 3 },
        remainingToday: { [C]: 2, [P]: 2 },
        earliestNext: { [C]: at(9, 0, 1), [P]: at(9, 0, 1), "*": at(9, 0, 1) },
        minutesUntilNext: { [C]: 900, [P]: 900, "*": 900 },
      }),
      now,
    ),
    `今天评论 3/5 次 · 发帖 0/2 次 · ${set} · 不在活动时段，明早 9 点继续`,
  );
});

test("pace clocks are the account's own time (当地) across zones and the midnight boundary", () => {
  const label = (iso: string, nowIso: string, zone: string | null, hourly = false) => {
    const when = paceWhen(iso, Date.parse(nowIso), zone);
    assert.ok(when, `${iso} in ${zone}`);
    return paceWhenLabel(when, hourly);
  };
  // One instant, four zones: 15:00Z is London 16:00, Los Angeles 08:00, Shanghai 23:00 and
  // Tokyo 00:00 the next day; 16:30Z is an hour and a half later on each clock.
  const nowIso = "2026-10-10T15:00:00Z";
  const next = "2026-10-10T16:30:00Z";
  assert.equal(label(next, nowIso, "Europe/London"), "当地 17:30");
  assert.equal(label(next, nowIso, "America/Los_Angeles"), "当地 09:30");
  assert.equal(label(next, nowIso, "Asia/Shanghai"), "当地明天 00:30", "past local midnight");
  assert.equal(label(next, nowIso, "Asia/Tokyo"), "当地 01:30", "both after local midnight");
  // The midnight boundary on the account's clock: London 23:59 → 00:00 is tomorrow there.
  assert.equal(
    label("2026-10-10T23:00:00Z", "2026-10-10T22:59:00Z", "Europe/London"),
    "当地明天 00:00",
  );
  assert.equal(
    label("2026-10-10T23:00:00Z", "2026-10-10T22:59:00Z", "Europe/London", true),
    "当地明天 0 点",
  );
  // One minute past midnight there, the same instant is today.
  assert.equal(
    label("2026-10-11T08:00:00Z", "2026-10-10T23:01:00Z", "Europe/London", true),
    "当地 9 点",
  );
  assert.equal(
    label("2026-10-11T08:00:00Z", "2026-10-10T22:59:00Z", "Europe/London", true),
    "当地明早 9 点",
  );
  // A resume hour is the account's 9 o'clock in every zone, whatever this device's zone is.
  assert.equal(label("2026-10-11T16:00:00Z", nowIso, "America/Los_Angeles", true), "当地明早 9 点");
  assert.equal(label("2026-10-11T01:00:00Z", nowIso, "Asia/Shanghai", true), "当地明早 9 点");
  assert.equal(label("2026-10-11T00:00:00Z", nowIso, "Asia/Tokyo", true), "当地 9 点");
  assert.equal(label("2026-10-12T08:30:00Z", nowIso, "Europe/London"), "当地 10月12日 09:30");
  // Two days ahead on the hour: the date and the hour stay apart (not 「当地 10-12 9 点」).
  assert.equal(label("2026-10-12T08:00:00Z", nowIso, "Europe/London", true), "当地 10月12日 9 点");
  // A zone unknown here, or none: this device's clock, without 当地.
  const fallback = paceWhen(next, Date.parse(nowIso), "Mars/Olympus_Mons");
  assert.equal(fallback?.local, false);
  const device = new Date(next);
  const hhmm = `${String(device.getHours()).padStart(2, "0")}:${String(device.getMinutes()).padStart(2, "0")}`;
  assert.ok(fallback && paceWhenLabel(fallback).endsWith(hhmm));
  assert.equal(paceWhen("not a time", Date.parse(nowIso), "Europe/London"), null);
});

test("the pace line of an account in another zone reads its own clock (当地)", () => {
  const london = (status: Record<string, unknown>) =>
    normalizePacing({
      settings: {},
      effective: allSet({ activeHours: inForce([9, 23]) }),
      status: {
        timezone: "Europe/London",
        timezoneSource: "environment",
        timezoneReason: "environment",
        inActiveHours: true,
        ...status,
      },
    });
  const set = "间隔 30 分 · 当地 9–23 点";
  const resume = "2026-10-11T08:00:00Z"; // London 09:00 (BST), Shanghai 16:00
  // Late evening in London: outside the hours until tomorrow 9 there, not 「16:00」 here.
  assert.equal(
    paceLine(
      london({
        inActiveHours: false,
        usedToday: { [C]: 3 },
        remainingToday: { [C]: 2, [P]: 2 },
        earliestNext: { [C]: resume, [P]: resume, "*": resume },
        minutesUntilNext: { [C]: 570, [P]: 570, "*": 570 },
      }),
      Date.parse("2026-10-10T22:30:00Z"),
    ),
    `今天评论 3/5 次 · 发帖 0/2 次 · ${set} · 不在活动时段，当地明早 9 点继续`,
  );
  // Just past midnight in London: the same 9 o'clock is today there.
  assert.equal(
    paceLine(
      london({
        inActiveHours: false,
        usedToday: {},
        remainingToday: { [C]: 5, [P]: 2 },
        earliestNext: { [C]: resume, [P]: resume, "*": resume },
        minutesUntilNext: { [C]: 510, [P]: 510, "*": 510 },
      }),
      Date.parse("2026-10-10T23:30:00Z"),
    ),
    `今天评论 0/5 次 · 发帖 0/2 次 · ${set} · 不在活动时段，当地 9 点继续`,
  );
  // Comments due in 20 minutes there.
  assert.equal(
    paceLine(
      london({
        usedToday: { [C]: 2, [P]: 2 },
        remainingToday: { [C]: 3, [P]: 0 },
        earliestNext: { [C]: "2026-10-10T15:20:00Z", "*": "2026-10-10T15:20:00Z" },
        minutesUntilNext: { [C]: 20, "*": 20 },
      }),
      Date.parse("2026-10-10T15:00:00Z"),
    ),
    `今天评论 2/5 次 · 发帖 2/2 次 · ${set} · 下次可做 当地 16:20`,
  );
  // A gap that ends mid-hour the next morning keeps its minutes.
  assert.equal(
    paceLine(
      london({
        inActiveHours: false,
        usedToday: { [C]: 1 },
        remainingToday: { [C]: 4, [P]: 2 },
        earliestNext: {
          [C]: "2026-10-11T09:50:00Z",
          [P]: "2026-10-11T09:50:00Z",
          "*": "2026-10-11T09:50:00Z",
        },
        minutesUntilNext: { [C]: 680, [P]: 680, "*": 680 },
      }),
      Date.parse("2026-10-10T22:30:00Z"),
    ),
    `今天评论 1/5 次 · 发帖 0/2 次 · ${set} · 不在活动时段，当地明天 10:50 继续`,
  );
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
  assert.equal(model.exit, "203.0.113.105:5890");
  assert.equal(model.label, null);
  assert.deepEqual(model.flags, []);
  assert.equal(model.desktopWord, "运行中");
  assert.equal(model.paceLine, "切到所在群才看得到", "no pacing in the view");
  assert.equal(model.paceMark, null);
  const [unset] = buildAccountModels({
    accounts: [account({}, { settings: {}, effective: {}, status: {} })],
    entries: [],
    now,
  });
  assert.equal(unset.paceLine, "节奏还没定，下次运行时由它自己定");
  assert.equal(unset.paceMark, null);
  assert.equal(unset.paceReason, null);
  const [decided] = buildAccountModels({
    accounts: [
      account(
        {},
        {
          effective: allSet({ caps: { [C]: inForce(5), [P]: inForce(1, "owner") } }),
          status: {
            usedToday: { [C]: 1 },
            remainingToday: { [C]: 4, [P]: 1 },
            minutesUntilNext: { [C]: 0, [P]: 0, "*": 0 },
          },
        },
      ),
    ],
    entries: [],
    now,
  });
  assert.equal(
    decided.paceLine,
    `今天评论 1/5 次 · 发帖 0/1 次 · 间隔 30 分 · 当地 10–22 点 · 现在可做`,
  );
  assert.equal(decided.paceMark, "AI 定 · 手动");
  assert.equal(decided.paceReason, "r");

  const noProxy = account({ settings: { proxy: { configured: false, preview: null } } });
  assert.equal(accountLight(noProxy, null), "red");
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
    accounts: [
      account(),
      account({ id: "a2", name: "example_user_1", status: "error" }),
      account({
        id: "a3",
        name: "acct-1",
        settings: { proxy: { configured: false, preview: null } },
      }),
    ],
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
    ["task:q", "task:ap", "task:f", "review:act2", "account:a2", "account:a3"],
  );
  const counts = shellCounts(entries, needs);
  assert.deepEqual(counts, {
    needsYou: 6,
    waitingOnYou: 5,
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

test("helpers: exits, labels, plan, brief", () => {
  assert.equal(exitOfPreview("http://•••@203.0.113.105:5890"), "203.0.113.105:5890");
  assert.equal(exitOfPreview("socks5://Proxy.Example.com:1080"), "proxy.example.com:1080");
  assert.equal(exitOfPreview("•••"), null);
  assert.equal(exitOfPreview(null), null);
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

test("an account loop's old title 「经营 · <name>」 reads 「<name> 的日常运营」 everywhere", () => {
  assert.equal(taskTitleText("经营 · Nova_Harrison"), "Nova_Harrison 的日常运营");
  assert.equal(taskTitleText("Nova_Harrison 的日常运营"), "Nova_Harrison 的日常运营");
  assert.equal(taskTitleText("经营一个摄影号"), "经营一个摄影号");
  assert.equal(taskTitleText("经营 · "), "经营 · ");
  const raw = task({ id: "loop", title: "经营 · Nova", input: { accountLoop: true } });
  const plain = task({ id: "p", title: "推广仓库" });
  const [loop, other] = entriesOf([raw, plain]);
  assert.equal(loop.task.title, "Nova 的日常运营");
  assert.equal(raw.title, "经营 · Nova", "the task itself is not changed");
  assert.equal(other.task, plain, "a task whose title reads as it is stays the same object");
});

test("the 节奏 line names actions in plain words; the one site goes under it", () => {
  assert.deepEqual(paceKindWords("example.com/post"), { site: "example.com", word: "发帖" });
  assert.deepEqual(paceKindWords("example.com/upvote"), { site: "example.com", word: "点赞" });
  assert.deepEqual(paceKindWords("example.com/crosspost"), {
    site: "example.com",
    word: "crosspost",
  });
  assert.deepEqual(paceKindWords("*"), { site: "", word: "所有动作" });
  const one = normalizePacing({ settings: {}, effective: {}, status: { usedToday: { [P]: 1 } } });
  assert.equal(paceLine(one, now), "今天发帖 1 次 · 节奏还没定，下次运行时由它自己定");
  assert.equal(paceSite(one), "example.com");
  const two = normalizePacing({
    settings: {},
    effective: {},
    status: { usedToday: { [P]: 1, "x.com/like": 2 } },
  });
  assert.equal(paceSite(two), null, "each kind names its site instead");
  assert.equal(paceSite(normalizePacing({ settings: {}, effective: {}, status: {} })), null);
  assert.equal(paceSite(absentPacing), null);
});

test("a task's state in a list line is its Chinese phase word, never the raw status", () => {
  assert.equal(taskPhaseLabel(task({ status: "queued" }), now), phaseWords.labels.queue);
  assert.equal(taskPhaseLabel(task({ status: "running" }), now), phaseWords.labels.run);
  assert.equal(taskPhaseLabel(task({ status: "paused" }), now), phaseWords.labels.pause);
  for (const status of ["queued", "running", "paused", "cancelled", "succeeded"] as const)
    assert.match(taskPhaseLabel(task({ status }), now), /[\u3000-\u9fff]/);
});
