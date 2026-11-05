/**
 * The pure logic of the accounts unit — the global 账号与代理
 * page (merging the topology with each project's environment views, grouping by project or by
 * exit, the exit notes), the account detail (same-exit counts, report lines, the pacing lines),
 * the two-step cross-project move, the pacing form and the editor's Chinese validation messages.
 * No react-native, no fetch: node:test pins it (apps/mobile/test/shell-accounts.test.ts).
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import { clockLabel, firstLine } from "../../../../../packages/domain/src/task-phase.ts";
import type {
  ProxyEndpoint,
  Topology,
  TopologyEnvironment,
} from "../../../../../packages/domain/src/topology.ts";
import { normalizeEnvironment } from "../../environments.ts";
import { exitLabel } from "../../topology-core.ts";
import { unconfirmedLine } from "../chat/core.ts";
import {
  type AccountModel,
  type AccountView,
  absentPacing,
  exitOfPreview,
  exitShareKey,
  type Pacing,
  type PacingField,
  type PacingOwnerValues,
} from "../model.ts";
import { phaseWords, reportLabel, t } from "../strings.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// ───────────────────────────── page data ─────────────────────────────

/** The key a project's accounts are kept under ("" = the default project, i.e. unassigned). */
export const projectKey = (projectId: string | null | undefined) => projectId ?? "";

/** `previous` when `next` holds the very same items in the same order, else `next`: a list
 * rebuilt on every poll keeps one identity until its items really change. */
export function sameItemsOr<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && next.every((item, index) => item === previous[index])
    ? previous
    : next;
}

/** "host:port" of a topology account's exit (the same form as exitOfPreview). */
export function topologyExit(environment: Pick<TopologyEnvironment, "proxy">): string | null {
  const proxy = environment.proxy;
  return proxy ? `${proxy.host.toLowerCase()}:${proxy.port}` : null;
}

/**
 * An account view built from the topology alone, for a project whose GET /api/environments did
 * not answer: desktop state, locale, time zone and the exit (scheme://host:port, never the
 * credentials) are known; the platform's own entries and pacing are not (pacing reads `present: false`).
 */
export function topologyAccountView(environment: TopologyEnvironment): AccountView {
  const proxy = environment.proxy;
  return {
    ...normalizeEnvironment({
      id: environment.id,
      name: environment.name,
      accountLabel: environment.accountLabel,
      projectId: environment.projectId,
      status: environment.desktop,
      proxyConfigured: !!proxy,
      settings: {
        proxy: {
          configured: !!proxy || environment.proxyUnreadable,
          preview: proxy ? `${proxy.scheme}://${proxy.host}:${proxy.port}` : null,
        },
        timezone: environment.timezone,
        locale: environment.locale,
        unreadable: environment.proxyUnreadable,
      },
    }),
    pacing: absentPacing,
  };
}

/**
 * Every account the page shows: the views each project answered with (`fetched`, by
 * projectKey), and for a project that did not answer, its accounts from the topology. Accounts
 * the topology lists under a project that was not fetched at all also come from the topology.
 * Deduplicated by id (a fetched view wins), sorted by name.
 */
export function mergeAccountViews(
  topology: Topology | null,
  fetched: ReadonlyMap<string, readonly AccountView[]>,
): AccountView[] {
  const byId = new Map<string, AccountView>();
  for (const views of fetched.values())
    for (const view of views) if (!view.deleting) byId.set(view.id, view);
  for (const environment of topology?.environments ?? []) {
    if (byId.has(environment.id)) continue;
    // A project that answered does not have this account (it moved meanwhile): trust the answer.
    if (fetched.has(projectKey(environment.projectId))) continue;
    byId.set(environment.id, topologyAccountView(environment));
  }
  return [...byId.values()].sort(byName);
}

/** host:port → the exit as the page prints it ("http://203.0.113.105:5890"; several schemes
 * on one server read "host:port (http, socks5)"), from the topology. */
export function exitLabels(topology: Topology | null): Map<string, string> {
  const schemes = new Map<string, TopologyEnvironment["proxy"][]>();
  for (const environment of topology?.environments ?? []) {
    const exit = topologyExit(environment);
    if (!exit) continue;
    schemes.set(exit, [...(schemes.get(exit) ?? []), environment.proxy]);
  }
  return new Map(
    [...schemes].map(([exit, proxies]) => [
      exit,
      exitLabel(
        proxies.filter((proxy): proxy is ProxyEndpoint => !!proxy),
        "proxy",
      ),
    ]),
  );
}

/** The account's exit: from its masked preview, else from the topology (by id). */
export function accountExit(
  account: Pick<AccountModel, "id" | "exit">,
  topology: Topology | null,
): string | null {
  if (account.exit) return account.exit;
  const environment = topology?.environments.find((item) => item.id === account.id);
  return environment ? topologyExit(environment) : null;
}

export interface PageSummary {
  accounts: number;
  exits: number;
  projects: number;
}
/** 「5 个账号 · 1 个代理出口 · 4 个项目」: projects are the live ones (not 未分组). */
export function pageSummary(
  accounts: readonly { exit: string | null; projectId?: string | null }[],
  projects: number,
): PageSummary {
  return {
    accounts: accounts.length,
    // Exits per project (未分配 is its own scope): one exit used in two projects counts twice,
    // so the total never reveals that two projects share an exit.
    exits: new Set(
      accounts.flatMap((account) =>
        account.exit ? [exitShareKey(account.projectId ?? null, account.exit)] : [],
      ),
    ).size,
    projects,
  };
}

export type AccountGroupKind =
  | "project"
  | "founder"
  | "unassigned"
  | "exit"
  | "noProxy"
  | "unreadable";
export interface AccountGroup {
  key: string;
  kind: AccountGroupKind;
  /** project / unassigned groups: the project (null = 未分配). */
  projectId?: string | null;
  /** exit groups: host:port. */
  exit?: string;
  /** exit groups: where its accounts are (`placeOf`: the founder is never 未分配). */
  place?: string;
  /** The heading, counts included where the wording carries them. */
  title: string;
  accounts: AccountModel[];
}

/**
 * 按项目 (design §3.6): the current project first, then the other live projects in the given
 * order, then accounts of projects that no longer exist, then the founder (营销总群 · 创始人: in
 * no project, but not 未分配 either, docs/founder.md), then 未分配 (always shown). Empty
 * projects are kept (「没有账号」).
 */
export function groupByProject(
  accounts: readonly AccountModel[],
  projects: readonly { id: string; name: string }[],
  current: string | null,
): AccountGroup[] {
  const ordered = [
    ...projects.filter((project) => project.id === current),
    ...projects.filter((project) => project.id !== current),
  ];
  const known = new Set(projects.map((project) => project.id));
  const group = (projectId: string): AccountGroup | null => {
    const project = ordered.find((item) => item.id === projectId);
    const members = accounts.filter((account) => account.projectId === projectId);
    if (!project && !members.length) return null;
    return {
      key: `project:${projectId}`,
      kind: "project",
      projectId,
      title: t.accountsPage.groupCount(
        project?.name ?? t.accountsPage.unknownProject,
        members.length,
      ),
      accounts: [...members].sort(byName),
    };
  };
  const orphans = [
    ...new Set(
      accounts
        .map((account) => account.projectId)
        .filter((id): id is string => id !== null && !known.has(id)),
    ),
  ];
  const placeless = accounts.filter((account) => account.projectId === null);
  const founders = placeless.filter((account) => !joinsProjects(account.view)).sort(byName);
  const unassigned = placeless.filter((account) => joinsProjects(account.view)).sort(byName);
  return [
    ...[...ordered.map((project) => project.id), ...orphans]
      .map(group)
      .filter((item): item is AccountGroup => !!item),
    ...(founders.length
      ? [
          {
            key: "founder",
            kind: "founder" as const,
            projectId: null,
            title: t.accountsPage.groupCount(t.accountsPage.founderPlace, founders.length),
            accounts: founders,
          },
        ]
      : []),
    {
      key: "unassigned",
      kind: "unassigned",
      projectId: null,
      title: t.accountsPage.groupCount(t.accountsPage.unassigned, unassigned.length),
      accounts: unassigned,
    },
  ];
}

/**
 * 按出口 (design §3.6): one group per exit (host:port, not the measured IP) inside one project
 * (未分配 is a scope of its own): accounts of different projects are never grouped together, so
 * nothing says one project shares an exit with another. Exits two or more
 * accounts share first, then by label and project name; then 代理读不出 and 没设代理.
 */
export function groupByExit(
  accounts: readonly AccountModel[],
  options: {
    exitOf: (account: AccountModel) => string | null;
    labels: ReadonlyMap<string, string>;
    projectName: (projectId: string | null) => string;
    /** The heading of accounts without one (没有出口 there). */
    noneTitle?: string;
  },
): AccountGroup[] {
  const byExit = new Map<
    string,
    { exit: string; projectId: string | null; members: AccountModel[] }
  >();
  const unreadable: AccountModel[] = [];
  const none: AccountModel[] = [];
  for (const account of accounts) {
    const exit = options.exitOf(account);
    if (account.flags.includes("proxyUnreadable")) unreadable.push(account);
    else if (exit) {
      const key = exitShareKey(account.projectId, exit);
      const entry = byExit.get(key) ?? { exit, projectId: account.projectId, members: [] };
      entry.members.push(account);
      byExit.set(key, entry);
    } else none.push(account);
  }
  // By project (未分配 last), then name.
  const sortMembers = (list: AccountModel[]) =>
    [...list].sort(
      (a, b) =>
        Number(a.projectId === null) - Number(b.projectId === null) ||
        accountPlace(a, options.projectName).localeCompare(accountPlace(b, options.projectName)) ||
        byName(a, b),
    );
  const exits = [...byExit].map(([key, { exit, projectId, members }]) => {
    const label = options.labels.get(exit) ?? exit;
    const project = placeOf(members, options.projectName);
    return {
      shared: members.length > 1,
      label,
      project,
      group: {
        key: `exit:${key}`,
        kind: "exit" as const,
        exit,
        projectId,
        place: project,
        title: t.accountsPage.exitGroup(label, members.length, project),
        accounts: sortMembers(members),
      },
    };
  });
  exits.sort(
    (a, b) =>
      Number(b.shared) - Number(a.shared) ||
      a.label.localeCompare(b.label) ||
      // 未分配 last on its own terms: comparing 未分配 with a Latin name depends on the ICU build.
      Number(a.group.projectId === null) - Number(b.group.projectId === null) ||
      a.project.localeCompare(b.project),
  );
  return [
    ...exits.map((item) => item.group),
    ...(unreadable.length
      ? [
          {
            key: "unreadable",
            kind: "unreadable" as const,
            title: t.accountsPage.groupCount(t.accountsPage.unreadableGroup, unreadable.length),
            accounts: sortMembers(unreadable),
          },
        ]
      : []),
    ...(none.length
      ? [
          {
            key: "none",
            kind: "noProxy" as const,
            title: t.accountsPage.groupCount(
              options.noneTitle ?? t.accountsPage.noProxyGroup,
              none.length,
            ),
            accounts: sortMembers(none),
          },
        ]
      : []),
  ];
}

/** The info notes under the switch: one per exit two or more accounts of the same project share
 * (「项目甲：X 被 3 个账号共用。出口按地址判定，不是实测 IP。」; 未分配 is a scope of its own); when
 * no exit is shared inside a project, the general note. Never counts across projects (owner
 * decision A). */
export function exitNotes(
  accounts: readonly {
    exit: string | null;
    projectId: string | null;
    view?: { founder?: boolean };
  }[],
  labels: ReadonlyMap<string, string>,
  projectName: (projectId: string | null) => string,
): string[] {
  type Sharing = { exit: string; members: (typeof accounts)[number][]; count: number };
  const byKey = new Map<string, Sharing>();
  for (const account of accounts) {
    if (!account.exit) continue;
    const key = exitShareKey(account.projectId, account.exit);
    const entry: Sharing = byKey.get(key) ?? { exit: account.exit, members: [], count: 0 };
    entry.members.push(account);
    entry.count += 1;
    byKey.set(key, entry);
  }
  const notes = [...byKey.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => ({ ...entry, project: placeOf(entry.members, projectName) }))
    .sort(
      (a, b) =>
        b.count - a.count || a.project.localeCompare(b.project) || a.exit.localeCompare(b.exit),
    )
    .map((entry) =>
      t.accountsPage.exitShared(entry.project, labels.get(entry.exit) ?? entry.exit, entry.count),
    );
  return notes.length ? notes : [t.accountsPage.exitNote];
}

/** 「同出口还有 n 个账号」: the other accounts of the same project (未分配 is a scope of its own)
 * on the same exit. Accounts of other projects are never counted. */
export function sameExitOthers(
  account: { id: string; exit: string | null; projectId: string | null },
  all: readonly { id: string; exit: string | null; projectId: string | null }[],
): number {
  if (!account.exit) return 0;
  return all.filter(
    (item) =>
      item.id !== account.id &&
      item.exit === account.exit &&
      (item.projectId ?? null) === (account.projectId ?? null),
  ).length;
}

// ───────────────────────────── moves ─────────────────────────────

/** One PATCH /api/environments/:id { projectId } sent with `header`'s project header. */
export interface MoveStep {
  header: string | null;
  projectId: string | null;
}
/** The picker's footnote: 「跨项目移动分两步…」 only for an account already in a project (a move
 * may be two steps); assigning an unassigned account is one step, so it has none. */
export function moveNote(from: string | null): string | null {
  return from !== null ? t.assign.twoSteps : null;
}

/**
 * The requests that move an account (design §3.6, §8.1): to 未分配 = one PATCH with the
 * source project's header; from 未分配 = one PATCH with the target's header; across projects =
 * both, in that order (the server only moves between unassigned and the current project).
 */
export function movePlan(from: string | null, to: string | null): MoveStep[] {
  if (from === to) return [];
  const steps: MoveStep[] = [];
  if (from !== null) steps.push({ header: from, projectId: null });
  if (to !== null) steps.push({ header: to, projectId: to });
  return steps;
}

/** Where the account can go: every live project except the one it is in. */
export function moveTargets<P extends { id: string; deleting?: boolean }>(
  projects: readonly P[],
  from: string | null,
): P[] {
  return projects.filter((project) => project.id !== from && !project.deleting);
}

/** What the result of a move looks like to the person: done, or stuck in 未分配 after the
 * first step (offer 再试 for the second), or failed before anything changed. */
export type MoveOutcome =
  | { state: "done" }
  | { state: "stuck"; error: string }
  | { state: "failed"; error: string };
export async function runMove(
  steps: readonly MoveStep[],
  send: (step: MoveStep) => Promise<unknown>,
  errorText: (error: unknown) => string,
): Promise<MoveOutcome> {
  for (const [index, step] of steps.entries()) {
    try {
      await send(step);
    } catch (error) {
      return index > 0 && steps[index - 1].projectId === null
        ? { state: "stuck", error: errorText(error) }
        : { state: "failed", error: errorText(error) };
    }
  }
  return { state: "done" };
}

/** Where the account is after a move: `to` when done, 未分配 (null) when stuck after the first
 * step, nowhere new (undefined) when nothing changed. */
export function movedTo(outcome: MoveOutcome, to: string | null): string | null | undefined {
  if (outcome.state === "done") return to;
  if (outcome.state === "stuck") return null;
  return undefined;
}

// ───────────────────────────── account detail ─────────────────────────────

export interface ReportLine {
  id: string;
  taskId: string;
  clock: string;
  label: string;
  text: string;
  link: string | null;
  /** 「未确认：…」 for an action report without the item's own address; "" otherwise. */
  unconfirmed: string;
}
/** 最近汇报（这个号）: the newest `count` reports of the account's tasks, as
 * 「14:10 · 回复 · 在 r/IPhoneApps 回复 1 条 ↗」 lines (「未确认：…」 under one without the item's own
 * address). */
export function accountReportLines(
  reports: readonly ChatReport[],
  taskIds: ReadonlySet<string>,
  now: Date | number,
  count = 3,
): ReportLine[] {
  return reports
    .filter((report) => taskIds.has(report.taskId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, count)
    .map((report) => ({
      id: report.id,
      taskId: report.taskId,
      clock: clockLabel(report.createdAt, now, phaseWords),
      label: reportLabel(report.title, report.action),
      text: firstLine(report.text, 80),
      link: report.links[0] ?? null,
      unconfirmed: unconfirmedLine(report),
    }));
}

const sourceWord = (field: PacingField<unknown>) =>
  field.source === "owner" ? t.pacing.sourceOwner : t.pacing.sourceAi;
/** A cap in words: 「example.com/post 每天 3」, or 「… 关」 at 0. */
const capWords = (kind: string, value: number) =>
  value === 0 ? t.pacing.kindOff(kind) : t.pacing.fieldCap(kind, value);
/** The second 节奏 line of the detail: the gap, each kind's cap and the window as they are in
 * force, with who set each (「AI 定」/「手动」), or 未定; which zone 「当地」 is when the account has
 * none of its own (the desktop template's, named); then that the caps count per account. */
/** The account detail's 地区 line in plain words: 「en-US · America/Los_Angeles」, 「还没设（时区和
 * 语言用桌面默认的）」 when neither is set, 「语言没设」 / 「时区没设」 for the one missing. */
export function regionLine(account: { locale: string | null; timezone: string | null }): string {
  const d = t.accountDetail;
  if (!account.locale && !account.timezone) return d.regionUnset;
  return `${account.locale ?? d.localeUnset}${t.common.sep}${account.timezone ?? d.timezoneUnset}`;
}

export function pacingSettingsLine(pacing: Pacing): string {
  const p = t.pacing;
  const d = t.accountDetail;
  if (!pacing.present) return p.unknownHere;
  const e = pacing.effective;
  const set = (text: string, field: PacingField<unknown>) => p.withSource(text, sourceWord(field));
  const caps = Object.entries(e.caps).sort(([a], [b]) => a.localeCompare(b));
  const fields = [
    e.minGapMinutes
      ? set(p.fieldGap(e.minGapMinutes.value), e.minGapMinutes)
      : p.fieldUnset(p.labelGap),
    ...(caps.length
      ? caps.map(([kind, field]) => set(capWords(kind, field.value), field))
      : [p.fieldUnset(p.labelCaps)]),
    e.activeHours
      ? set(p.fieldHours(e.activeHours.value[0], e.activeHours.value[1]), e.activeHours)
      : p.fieldUnset(p.labelHours),
  ];
  const { timezone, timezoneSource, timezoneReason } = e;
  const zone =
    timezoneSource === "template" && timezone
      ? timezoneReason === "unreadable"
        ? d.pacingZoneUnreadable(timezone)
        : d.pacingZoneTemplate(timezone)
      : null;
  return [fields.join(t.common.sep), zone, p.accountHint].filter(Boolean).join(d.pacingJoin);
}

/** The editor's caption under the 节奏 inputs: what the task has set for the account (its own
 * layer, whether or not the person's value is in force over it) and its reasons (each distinct
 * reason once, newest first), or that it set nothing yet. */
export function aiPacingLine(pacing: Pacing): string {
  const p = t.pacing;
  const ai = pacing.settings.ai;
  const caps = Object.entries(ai.caps).sort(([a], [b]) => a.localeCompare(b));
  const parts = [
    ai.minGapMinutes ? p.fieldGap(ai.minGapMinutes.value) : null,
    ...caps.map(([kind, field]) => capWords(kind, field.value)),
    ai.activeHours ? p.fieldHours(ai.activeHours.value[0], ai.activeHours.value[1]) : null,
  ].filter((part): part is string => !!part);
  if (!parts.length) return p.aiNone;
  const fields: { reason: string; setAt: string | null }[] = [
    ai.minGapMinutes,
    ...caps.map(([, field]) => field),
    ai.activeHours,
  ].flatMap((field) => (field?.reason ? [field] : []));
  const reasons = [
    ...new Set(
      fields
        .sort((a, b) => (b.setAt ?? "").localeCompare(a.setAt ?? ""))
        .map((field) => field.reason),
    ),
  ];
  return [p.aiCurrent(parts), reasons.length ? p.reason(reasons.join(t.common.clauseSep)) : null]
    .filter((part): part is string => !!part)
    .join(t.common.clauseSep);
}

/**
 * Which time zone the account's pacing hours follow, from the raw `pacing` of an environment
 * view: the server sends timezone / timezoneSource / timezoneReason in `status` (an older view
 * may carry them in `effective`). Null when the view has no pacing.
 */
export function pacingTimezoneLine(rawPacing: unknown): string | null {
  if (!rawPacing || typeof rawPacing !== "object") return null;
  const value = record(rawPacing);
  const effective = record(value.effective);
  const status = record(value.status);
  const pick = (key: string) => effective[key] ?? status[key];
  const zone = typeof pick("timezone") === "string" ? (pick("timezone") as string) : "";
  const reason = pick("timezoneReason");
  const source = pick("timezoneSource");
  if (reason === "unreadable") return t.pacing.timezoneUnreadable(zone);
  if (source === "environment" && zone) return t.pacing.timezoneFrom(zone);
  return t.pacing.timezoneTemplate(zone);
}

/** The delete confirmation is typed exactly (spaces around it ignored). */
export const deleteConfirmed = (typed: string, name: string) =>
  !!name && typed.trim() === name.trim();

// ───────────────────────────── pacing form ─────────────────────────────

/** The pacing inputs as typed: blank = not set by the person (null); caps are rows of a kind
 * (`<site>/<action>`) and a number. */
export interface PacingForm {
  gap: string;
  start: string;
  end: string;
  caps: { kind: string; cap: string }[];
}
/** PATCH /api/environments/:id { pacing }: the person's values; null unsets the person's, a cap
 * of null unsets that kind's. */
export interface PacingPatch {
  minGapMinutes?: number | null;
  activeHours?: [number, number] | null;
  caps?: Record<string, number | null>;
}

const field = (value: number | null) => (value === null ? "" : String(value));
/** The inputs prefilled from the person's own values (a field the person did not set stays
 * blank, whatever the task set). */
export function pacingFormOf(owner: PacingOwnerValues): PacingForm {
  return {
    gap: field(owner.minGapMinutes),
    start: owner.activeHours ? String(owner.activeHours[0]) : "",
    end: owner.activeHours ? String(owner.activeHours[1]) : "",
    caps: Object.entries(owner.caps)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, cap]) => ({ kind, cap: String(cap) })),
  };
}

const whole = (value: string): number | null | "bad" => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : "bad";
};
/** `<registrable domain>/<word>`, as the server takes it (lower case). */
const kindPattern = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+\/[a-z][a-z0-9_-]*$/;

/**
 * The pacing PATCH for what was typed: `null` when nothing differs from the person's saved
 * values, `{ error }` (Chinese) for a value that can't be sent. Only the shape is checked
 * (whole numbers, hours 0–23 / 1–24 with start before end, a kind as 站点/动作); there is no bound
 * of the system's own. 0 turns a kind off; blank unsets the person's value; a row removed (or
 * left without a number) unsets that kind's cap.
 */
export function pacingPatch(
  form: PacingForm,
  saved: PacingOwnerValues,
): { pacing: PacingPatch } | { error: string } | null {
  const p = t.pacing;
  const e = t.accountEditor;
  const gap = whole(form.gap);
  if (gap === "bad") return { error: e.pacingWhole(p.gapLabel) };
  const start = whole(form.start);
  const end = whole(form.end);
  if (start === "bad" || end === "bad") return { error: e.pacingHoursRange };
  if ((start === null) !== (end === null)) return { error: e.pacingHoursBoth };
  let activeHours: [number, number] | null = null;
  if (start !== null && end !== null) {
    if (start > 23 || end < 1 || end > 24 || start >= end) return { error: e.pacingHoursRange };
    activeHours = [start, end];
  }
  const caps: Record<string, number> = {};
  for (const row of form.caps) {
    const kind = row.kind.trim().toLowerCase();
    const cap = whole(row.cap);
    if (!kind && cap === null) continue;
    if (!kindPattern.test(kind)) return { error: e.pacingKind(row.kind.trim() || "?") };
    if (cap === "bad" || cap === null) return { error: e.pacingWhole(kind) };
    if (kind in caps) return { error: e.pacingKindTwice(kind) };
    caps[kind] = cap;
  }
  const pacing: PacingPatch = {};
  if (gap !== saved.minGapMinutes) pacing.minGapMinutes = gap;
  const sameHours =
    activeHours === null
      ? saved.activeHours === null
      : saved.activeHours !== null &&
        activeHours[0] === saved.activeHours[0] &&
        activeHours[1] === saved.activeHours[1];
  if (!sameHours) pacing.activeHours = activeHours;
  const capChanges: Record<string, number | null> = {};
  for (const [kind, cap] of Object.entries(caps))
    if (saved.caps[kind] !== cap) capChanges[kind] = cap;
  for (const kind of Object.keys(saved.caps)) if (!(kind in caps)) capChanges[kind] = null;
  if (Object.keys(capChanges).length) pacing.caps = capChanges;
  return Object.keys(pacing).length ? { pacing } : null;
}

/** Did a PATCH answer carry pacing? An older server silently drops the unknown field. */
export const answerHasPacing = (payload: unknown) =>
  !!record(payload).pacing && typeof record(payload).pacing === "object";

// ───────────────────────────── editor messages ─────────────────────────────

/** environmentPayload()'s English validation messages, in the shell's words; anything else (a
 * server message) is shown as it is. */
export function editorError(message: string): string {
  const e = t.accountEditor;
  if (message === "Name is required" || message === "Name can't be cleared")
    return t.accountEditor.nameRequired;
  if (message === "Proxy URL is required") return t.accountEditor.proxyRequired;
  let match = /^Name must be at most (\d+) characters$/.exec(message);
  if (match) return e.nameTooLong(Number(match[1]));
  match = /^Name "(.*)" is reserved/.exec(message);
  if (match) return e.nameReserved(match[1]);
  match = /^Account label must be at most (\d+) characters$/.exec(message);
  if (match) return e.labelTooLong(Number(match[1]));
  match = /^Unknown time zone "(.*)"/.exec(message);
  if (match) return e.unknownTimezone(match[1]);
  match = /^Unknown language "(.*)"/.exec(message);
  if (match) return e.unknownLocale(match[1]);
  return message;
}

/** The edit value for a prefilled field (environments-screen's `diff`): unchanged, cleared
 * (null) or replaced. */
export const editValue = (typed: string, saved: string | null): string | null | undefined =>
  typed.trim() === (saved ?? "") ? undefined : typed.trim() ? typed : null;

// ───────────────────────────── account desktop sheet ─────────────────────────────

export type ComputerTab = "Browser" | "Desktop" | "Terminal" | "Files";
/**
 * The computer sheet's tabs (design §3.5, §7): an account's desktop (inside an EnvironmentScope)
 * shows only Desktop and Terminal, and a remembered Browser or Files tab opens on Desktop there;
 * the default desktop keeps all four. Desktop is listed only while the desktop runs (`desktop`
 * undefined = not known yet), and a remembered Desktop tab falls back to Terminal while it is off.
 */
export function computerTabs(
  scoped: boolean,
  desktop: boolean | undefined,
  tab: ComputerTab,
): { shown: ComputerTab; tabs: readonly ComputerTab[] } {
  if (scoped)
    return {
      shown: tab === "Terminal" || desktop === false ? "Terminal" : "Desktop",
      tabs: desktop ? ["Desktop", "Terminal"] : ["Terminal"],
    };
  return {
    shown: desktop === false && tab === "Desktop" ? "Terminal" : tab,
    tabs: desktop ? ["Browser", "Desktop", "Terminal", "Files"] : ["Browser", "Terminal", "Files"],
  };
}

/** "host:port" for any masked preview; re-exported so screens import one module. */
export { exitOfPreview };

/**
 * The founder belongs to the whole space (it lives in the
 * hall) and joins no project; projects give it jobs instead (the server refuses the move with a
 * 409). So it is never offered in 分配到… / 加入, and its place reads 营销总群 · 创始人, not 未分配.
 */
export function joinsProjects(view: { founder?: boolean }): boolean {
  return view.founder !== true;
}
/** The account's place as a list shows it: its project's name, 营销总群 · 创始人 for the founder.
 * Wherever an account's project is named (a row, a detail, the pane's 「这个号在…」, an exit's
 * group or note), it is named by this, so the founder never reads 未分配. */
export function accountPlace(
  account: { projectId: string | null; view?: { founder?: boolean } },
  projectName: (projectId: string | null) => string,
): string {
  return account.projectId === null && !joinsProjects(account.view ?? {})
    ? t.accountsPage.founderPlace
    : projectName(account.projectId);
}
/** The place of accounts kept together in one project's scope (an exit's group or note): each
 * one's `accountPlace`, once each, in order. 未分配 and the founder share the default project's
 * scope (one exit they share is counted), but each is named as what it is. */
export function placeOf(
  accounts: readonly { projectId: string | null; view?: { founder?: boolean } }[],
  projectName: (projectId: string | null) => string,
): string {
  return [...new Set(accounts.map((account) => accountPlace(account, projectName)))].join(
    t.common.listSep,
  );
}

/**
 * The project to read an account in, from this project's topology. The
 * topology lists this project's accounts only (projects are isolated), so an account in no
 * project, the founder above all, is not in it: then 未分组 (the default project, where the
 * unassigned accounts are its own) is asked; from 未分组 itself, a miss is gone (undefined).
 */
export function projectToRead(
  found: { projectId: string | null } | undefined,
  current: string | null,
): string | null | undefined {
  if (found) return found.projectId;
  return current === null ? undefined : null;
}
