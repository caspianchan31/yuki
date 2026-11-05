/**
 * The pure model of the new shell. Everything the rail, the accounts page,
 * the chat cards and the header compute from server data lives here, so every surface reads the
 * same answer (design §4, §5) and node:test can pin it. No react-native, no fetch.
 *
 * Inputs are what the existing APIs return (GET /api/agent tasks, GET /api/environments views,
 * GET /api/workspace actions, chat reports) plus the optional contracts of the parallel pacing
 * stream (environment `pacing`, task `state.operatingPlan`, project brief) and of N1/N2. Every
 * optional field degrades to a documented reading; nothing here throws on a malformed payload.
 */

import type { AgentTask, ChatReport, IncidentKind } from "../../../../packages/domain/src/agent.ts";
import type {
  EnvironmentStatus,
  EnvironmentView,
} from "../../../../packages/domain/src/environments.ts";
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import {
  clockLabel,
  endedRecently,
  type TaskPhase,
  taskEnvironmentId,
  taskPhase,
} from "../../../../packages/domain/src/task-phase.ts";
import type { TranscriptItem } from "../chat-reports-core.ts";
import { normalizeProxyCheck } from "../environments.ts";
import { actionWord, failureText, phaseWords, t, taskTitleText } from "./strings.ts";
import type { Light } from "./theme.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const toMs = (now: Date | number) => (typeof now === "number" ? now : now.getTime());

// ───────────────────────────── tasks ─────────────────────────────

/** A task's phase as the shell shows it: `stalled` marks a run while the worker has no heartbeat
 * (`stalledPhase`). */
export type EntryPhase = TaskPhase & { stalled?: boolean };

/** A task with its phase, computed once per render pass. */
export interface TaskEntry {
  task: AgentTask;
  phase: EntryPhase;
  /** The bound account id (`input.environmentId`); null = the project's default desktop. */
  environmentId: string | null;
}

/** A run while the worker has no heartbeat (ShellData.stalled, the source of 进度汇报's line):
 * nothing carries it on, so wherever its phase shows (a pill, a task row, an account's 此刻, ⌘K,
 * 正在做, the task panel, a task card) it reads 「后台停着」, grey, with the line 「后台停着，不会
 * 推进」, never 运行中 or the step it is doing (`stalled` set). Its key stays "run": its place in
 * the order and its buttons are the run's. Any other phase is returned as it is: a queued task
 * still reads 排队中, a wait or a schedule when it goes on. */
export function stalledPhase(phase: TaskPhase, stalled: boolean): EntryPhase {
  if (!stalled || phase.key !== "run") return phase;
  return {
    ...phase,
    label: t.members.stalled,
    tone: "grey",
    sub: t.progress.stalled,
    stalled: true,
  };
}

/** Each task with its phase; an older account loop's title reads the new way (`taskTitleText`),
 * so every surface showing `entry.task.title` says 「<name> 的日常运营」. `stalled`: the worker has
 * no heartbeat (ShellData.stalled), so a run reads as stopped (`stalledPhase`). */
export function taskEntries(
  tasks: readonly AgentTask[],
  now: Date | number,
  stalled = false,
): TaskEntry[] {
  return tasks.map((raw) => {
    const title = taskTitleText(raw.title);
    const task = title === raw.title ? raw : { ...raw, title };
    return {
      task,
      phase: stalledPhase(taskPhase(task, { now, words: phaseWords }), stalled),
      environmentId: taskEnvironmentId(task),
    };
  });
}

/** A task's state as the person reads it (等你回答 / 运行中 / 排队中 / 已暂停 …): its phase label from
 * the shared phase table, never the raw `status` (「queued」); a run while the worker has no
 * heartbeat reads 「后台停着」 (`stalledPhase`). For a list line (a search hit). */
export function taskPhaseLabel(
  task: Parameters<typeof taskPhase>[0],
  now: Date | number = Date.now(),
  stalled = false,
): string {
  return stalledPhase(taskPhase(task, { now, words: phaseWords }), stalled).label;
}

const atMs = (entry: TaskEntry) => {
  const value = entry.phase.at ? Date.parse(entry.phase.at) : Number.NaN;
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};
/** 此刻 order: rank, then the earlier resume / next time, then the newer task. */
export function byPriority(a: TaskEntry, b: TaskEntry): number {
  return (
    a.phase.rank - b.phase.rank ||
    atMs(a) - atMs(b) ||
    b.task.updatedAt.localeCompare(a.task.updatedAt)
  );
}

/** The rail's task section (design §3.2): tasks that need you are only counted here (they
 * show in 需要你); active = running and queued, then waiting by resume time, then scheduled by
 * next run; paused and the last 24 hours' ended tasks are folded. */
export interface RailTasks {
  needCount: number;
  active: TaskEntry[];
  paused: TaskEntry[];
  ended: TaskEntry[];
}
export function railTasks(entries: readonly TaskEntry[], now: Date | number): RailTasks {
  const live = entries.filter((entry) => !entry.phase.needsYou);
  const active = live
    .filter((entry) => ["run", "queue", "wait", "sched"].includes(entry.phase.key))
    .sort(byPriority);
  return {
    needCount: entries.filter((entry) => entry.phase.needsYou).length,
    active,
    paused: live.filter((entry) => entry.phase.key === "pause").sort(byPriority),
    ended: live
      .filter((entry) => endedRecently(entry.phase, now))
      .sort((a, b) => atMs(b) - atMs(a)),
  };
}

/** "下一次 明天 10:05" for the quiet status strip, from the earliest wait or scheduled run. */
export function quietNext(entries: readonly TaskEntry[], now: Date | number): string {
  const next = entries
    .filter((entry) => entry.phase.key === "wait" || entry.phase.key === "sched")
    .sort((a, b) => atMs(a) - atMs(b))[0];
  const clock = next?.phase.at ? clockLabel(next.phase.at, now, phaseWords) : "";
  return clock ? t.strip.quietNext(clock) : t.strip.quietNothing;
}

// ───────────────────────────── pacing ─────────────────────────────

/** A kind of action: `<site>/<action>` as the task reports it; `*` in the next-time maps stands
 * for any kind without a cap of its own. */
export type PaceKind = string;
export const anyKind = "*";
export type PacingSource = "owner" | "ai";
/** One pacing field as it is in force: the person's value over the task's, with who set it,
 * when, and (a task's) why. */
export interface PacingField<T> {
  value: T;
  source: PacingSource;
  reason: string | null;
  setAt: string | null;
}
/** The person's own values (PATCH), field by field (caps by kind); null is not set. */
export interface PacingOwnerValues {
  minGapMinutes: number | null;
  activeHours: [number, number] | null;
  caps: Record<PaceKind, number>;
}
type AiValue<T> = { value: T; reason: string; setAt: string | null };
/** The task's values with their reasons; null is not set by a task. */
export interface PacingAiValues {
  minGapMinutes: AiValue<number> | null;
  activeHours: AiValue<[number, number]> | null;
  caps: Record<PaceKind, AiValue<number>>;
}
export interface PacingSettings {
  owner: PacingOwnerValues;
  ai: PacingAiValues;
  updatedAt: string | null;
}
/** What is in force now; null is unset: nothing is enforced for that field. */
export interface PacingEffective {
  minGapMinutes: PacingField<number> | null;
  activeHours: PacingField<[number, number]> | null;
  caps: Record<PaceKind, PacingField<number>>;
  disabled: PaceKind[];
  timezone: string | null;
  /** The account's own zone, or the desktop template's when the account sets none. */
  timezoneSource: "environment" | "template";
  timezoneReason: "environment" | "unset" | "unreadable";
}
export interface PacingStatus {
  usedToday: Record<PaceKind, number>;
  /** Only the kinds with a set cap. */
  remainingToday: Record<PaceKind, number>;
  earliestNext: Record<string, string>;
  minutesUntilNext: Record<string, number>;
  /** Null when no window is set. */
  inActiveHours: boolean | null;
  localNow: string | null;
  lastActionAt: string | null;
}
/** An account's pacing as the server reports it (environment view `pacing`). `present` is
 * false when the view carried none (a view built from the topology for another project's
 * account): then nothing here is known, and the 节奏 line says so. */
export interface Pacing {
  settings: PacingSettings;
  effective: PacingEffective;
  /** The ledger; null when the server sent none. */
  status: PacingStatus | null;
  present: boolean;
}
export const unsetPacingSettings: PacingSettings = {
  owner: { minGapMinutes: null, activeHours: null, caps: {} },
  ai: { minGapMinutes: null, activeHours: null, caps: {} },
  updatedAt: null,
};
export const unsetPacingEffective: PacingEffective = {
  minGapMinutes: null,
  activeHours: null,
  caps: {},
  disabled: [],
  timezone: null,
  timezoneSource: "template",
  timezoneReason: "unset",
};
/** No pacing known: the server sent none. */
export const absentPacing: Pacing = {
  settings: unsetPacingSettings,
  effective: unsetPacingEffective,
  status: null,
  present: false,
};

const hours = (value: unknown): [number, number] | null => {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value.map(num);
  return start === null || end === null ? null : [start, end];
};
const kindList = (value: unknown): PaceKind[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** A map of kind → value, keeping only the values `read` accepts. */
const perKind = <T>(value: unknown, read: (item: unknown) => T | null) => {
  const out: Record<string, T> = {};
  for (const [kind, item] of Object.entries(record(value))) {
    const parsed = read(item);
    if (parsed !== null) out[kind] = parsed;
  }
  return out;
};
/** `{ value, source, reason, setAt }` as the server sends a field in force, or null. */
function inForce<T>(raw: unknown, read: (value: unknown) => T | null): PacingField<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const item = record(raw);
  const value = read(item.value);
  if (value === null) return null;
  return {
    value,
    source: item.source === "owner" ? "owner" : "ai",
    reason: str(item.reason),
    setAt: str(item.setAt),
  };
}
function aiValue<T>(raw: unknown, read: (value: unknown) => T | null): AiValue<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const item = record(raw);
  const value = read(item.value);
  if (value === null) return null;
  return { value, reason: str(item.reason) ?? "", setAt: str(item.setAt) };
}
const ownerValue = <T>(raw: unknown, read: (value: unknown) => T | null): T | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? read(record(raw).value) : read(raw);

/** Reads an environment view's optional `pacing` defensively. */
export function normalizePacing(raw: unknown): Pacing {
  if (!raw || typeof raw !== "object") return absentPacing;
  const value = record(raw);
  const settings = record(value.settings);
  const owner = record(settings.owner);
  const ai = record(settings.ai);
  const effective = record(value.effective);
  const status = value.status && typeof value.status === "object" ? record(value.status) : null;
  // The time zone fields travel in `status`; `effective` is read first for a view that has them.
  const zone = (key: "timezone" | "timezoneSource" | "timezoneReason") =>
    effective[key] ?? status?.[key];
  const reason = zone("timezoneReason");
  return {
    settings: {
      owner: {
        minGapMinutes: ownerValue(owner.minGapMinutes, num),
        activeHours: ownerValue(owner.activeHours, hours),
        caps: perKind(owner.caps, (item) => ownerValue(item, num)),
      },
      ai: {
        minGapMinutes: aiValue(ai.minGapMinutes, num),
        activeHours: aiValue(ai.activeHours, hours),
        caps: perKind(ai.caps, (item) => aiValue(item, num)),
      },
      updatedAt: str(settings.updatedAt),
    },
    effective: {
      minGapMinutes: inForce(effective.minGapMinutes, num),
      activeHours: inForce(effective.activeHours, hours),
      caps: perKind(effective.caps, (item) => inForce(item, num)),
      disabled: kindList(effective.disabled),
      timezone: str(zone("timezone")),
      timezoneSource: zone("timezoneSource") === "environment" ? "environment" : "template",
      timezoneReason:
        reason === "environment" || reason === "unreadable" ? reason : ("unset" as const),
    },
    status: status
      ? {
          usedToday: perKind(status.usedToday, num),
          remainingToday: perKind(status.remainingToday, num),
          earliestNext: perKind(status.earliestNext, str),
          minutesUntilNext: perKind(status.minutesUntilNext, num),
          inActiveHours: typeof status.inActiveHours === "boolean" ? status.inActiveHours : null,
          localNow: str(status.localNow),
          lastActionAt: str(status.lastActionAt),
        }
      : null,
    present: true,
  };
}

type SetField = PacingField<number | [number, number]>;
/** The set fields of an account's pacing, in display order (gap, caps by kind, hours). */
export function pacingSetFields(effective: PacingEffective): { key: string; field: SetField }[] {
  return [
    ...(effective.minGapMinutes ? [{ key: "minGapMinutes", field: effective.minGapMinutes }] : []),
    ...Object.entries(effective.caps)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, field]) => ({ key: kind, field })),
    ...(effective.activeHours ? [{ key: "activeHours", field: effective.activeHours }] : []),
  ];
}
/** Who set the account's pacing: 「AI 定」, 「手动」, both, or null when nothing is set. */
export function paceSourceMark(pacing: Pacing): string | null {
  if (!pacing.present) return null;
  const sources = new Set(pacingSetFields(pacing.effective).map((item) => item.field.source));
  const parts = [
    sources.has("ai") ? t.pacing.sourceAi : null,
    sources.has("owner") ? t.pacing.sourceOwner : null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(t.common.sep) : null;
}
/** The task's reasons for the fields it set (each distinct reason once, newest first), or null. */
export function paceReason(pacing: Pacing): string | null {
  const reasons = pacingSetFields(pacing.effective)
    .filter((item) => item.field.source === "ai" && item.field.reason)
    .sort((a, b) => (b.field.setAt ?? "").localeCompare(a.field.setAt ?? ""))
    .map((item) => item.field.reason as string);
  const distinct = [...new Set(reasons)];
  return distinct.length ? distinct.join(t.common.clauseSep) : null;
}

// ── pace clocks: the account's own time (当地) ──

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();
/** A formatter for an IANA zone; null for a zone this runtime does not know. */
function zoneFormat(zone: string): Intl.DateTimeFormat | null {
  if (!zoneFormats.has(zone)) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      format = null;
    }
    zoneFormats.set(zone, format);
  }
  return zoneFormats.get(zone) ?? null;
}

interface WallClock {
  /** Days since 1970-01-01 on this clock (only differences matter). */
  day: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
}
/** The wall clock of `ms` in `zone`, or on this device when `zone` is null. */
function wallClock(ms: number, zone: string | null): WallClock | null {
  if (!Number.isFinite(ms)) return null;
  const format = zone ? zoneFormat(zone) : null;
  if (zone && !format) return null;
  let y: number;
  let m: number;
  let d: number;
  let hour: number;
  let minute: number;
  if (format) {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
    [y, m, d, hour, minute] = [parts.year, parts.month, parts.day, parts.hour, parts.minute].map(
      Number,
    );
    hour %= 24;
  } else {
    const at = new Date(ms);
    [y, m, d, hour, minute] = [
      at.getFullYear(),
      at.getMonth() + 1,
      at.getDate(),
      at.getHours(),
      at.getMinutes(),
    ];
  }
  return { day: Math.round(Date.UTC(y, m - 1, d) / 86_400_000), month: m, date: d, hour, minute };
}

/** One pace clock: when an instant falls on the account's own clock, relative to now there. */
export interface PaceWhen {
  /** 0 today, 1 tomorrow, … on that clock (negative: already past). */
  dayOffset: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  /** The account's own zone (当地); false: no usable zone, so this device's clock. */
  local: boolean;
}

/** Where `iso` falls on the account's clock (`zone`, the pacing time zone) relative to `now` on
 * the same clock, so the day word (明天, 明早) is the account's day, not this device's. A zone
 * that is missing or unknown here falls back to this device's clock (`local` false). Null for
 * an unreadable time. */
export function paceWhen(iso: string, now: Date | number, zone: string | null): PaceWhen | null {
  const ms = Date.parse(iso);
  const usable = zone && zoneFormat(zone) ? zone : null;
  const at = wallClock(ms, usable);
  const today = wallClock(toMs(now), usable);
  if (!at || !today) return null;
  return {
    dayOffset: at.day - today.day,
    month: at.month,
    date: at.date,
    hour: at.hour,
    minute: at.minute,
    local: usable !== null,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** 「当地 14:30」, 「当地明天 14:30」, 「当地明早 9 点」 (tomorrow, on the hour, 5–11), 「当地 10月12日
 * 14:30」; `hourly` reads a time on the hour as 「9 点」 (a resume hour, prototype paceLine). On this
 * device's clock (no zone) the same without 当地. */
export function paceWhenLabel(when: PaceWhen, hourly = false): string {
  const w = t.pacing.when;
  const onHour = when.minute === 0;
  const time = hourly && onHour ? w.hour(when.hour) : `${pad2(when.hour)}:${pad2(when.minute)}`;
  let label: string;
  if (when.dayOffset === 1 && onHour && when.hour >= 5 && when.hour < 12)
    label = w.morning(when.hour);
  else if (when.dayOffset === 1) label = w.tomorrow(time);
  else if (when.dayOffset === 0 || when.dayOffset < 0) label = time;
  else label = w.date(when.month, when.date, time);
  return when.local ? w.local(label) : label;
}

/** A pace kind (`<site>/<action>`, as the task reports it) split into its site and its action
 * in plain words (`actionWord`: post → 发帖); `*` is every action without a cap of its own. */
export function paceKindWords(kind: PaceKind): { site: string; word: string } {
  if (kind === anyKind) return { site: "", word: t.pacing.anyKind };
  const slash = kind.indexOf("/");
  if (slash < 0) return { site: "", word: actionWord(kind) };
  return { site: kind.slice(0, slash), word: actionWord(kind.slice(slash + 1)) };
}
/** The kinds the 节奏 line names: each capped one and each used today without a cap. */
function paceKinds(pacing: Pacing): PaceKind[] {
  const e = pacing.effective;
  const used = pacing.status?.usedToday ?? {};
  return [
    ...Object.keys(e.caps),
    ...Object.entries(used)
      .filter(([kind, n]) => n > 0 && !e.caps[kind])
      .map(([kind]) => kind),
  ];
}
/** The one site the 节奏 line's kinds are on (shown small under it), or null when they are on
 * none or on more than one (each kind then names its site). */
export function paceSite(pacing: Pacing): string | null {
  if (!pacing.present) return null;
  const sites = new Set(
    paceKinds(pacing)
      .map((kind) => paceKindWords(kind).site)
      .filter(Boolean),
  );
  return sites.size === 1 ? ([...sites][0] ?? null) : null;
}

/**
 * The account's 节奏 line: what is set and how today stands against it. Nothing set:
 * 「节奏还没定，下次运行时由它自己定」 (with today's usage first when there is any). Set: today's
 * usage of each kind with a cap against it (「今天发帖 1/3 次」; a cap of 0 reads 「… 关」), the
 * kinds used today without one (「点赞 4 次」), the set gap (「间隔 30 分」) and window (「当地
 * 10–22 点」), then when the next action may be done: 「现在可做」, 「现在可做（… 今日已满）」,
 * 「下次可做 当地 14:30」, 「今日额度已满，当地明早 9 点继续」, 「不在活动时段，当地 9 点继续」. Every
 * clock is the account's own time (its pacing zone), marked 当地; a ledger without a usable zone
 * falls back to this device's time, unmarked. Kinds name their action in plain words
 * (`paceKindWords`) and their site only when there is more than one (`paceSite`). A
 * view that carried no pacing (another project's account) reads 「切到所在项目才看得到」.
 */
export function paceLine(pacing: Pacing, now: Date | number): string {
  const p = t.pacing;
  if (!pacing.present) return p.unknownHere;
  const e = pacing.effective;
  const status = pacing.status;
  const used = status?.usedToday ?? {};
  // The action in plain words, the site
  // only when the kinds are on more than one site (the one site is shown under the line).
  const manySites =
    new Set(
      paceKinds(pacing)
        .map((kind) => paceKindWords(kind).site)
        .filter(Boolean),
    ).size > 1;
  const name = (kind: PaceKind) => {
    const { site, word } = paceKindWords(kind);
    return manySites && site ? p.kindSite(word, site) : word;
  };
  const usedOnly = Object.entries(used)
    .filter(([kind, n]) => n > 0 && !e.caps[kind])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => p.kindUsedNoCap(name(kind), n));
  if (!pacingSetFields(e).length) return usedOnly.length ? p.today(usedOnly, p.unset) : p.unset;
  const capped = Object.keys(e.caps).sort();
  const off = (kind: PaceKind) => e.disabled.includes(kind) || e.caps[kind]?.value === 0;
  const parts = [
    ...capped.map((kind) =>
      off(kind)
        ? p.kindOff(name(kind))
        : p.kindUsed(name(kind), used[kind] ?? 0, e.caps[kind].value),
    ),
    ...usedOnly,
    e.minGapMinutes ? p.gapSet(e.minGapMinutes.value) : null,
    e.activeHours ? p.hoursSet(e.activeHours.value[0], e.activeHours.value[1]) : null,
  ].filter((part): part is string => !!part);
  if (!status) return p.today(parts, "");
  const when = (iso: string, hourly = false) => {
    const at = paceWhen(iso, now, e.timezone);
    return at ? paceWhenLabel(at, hourly) : "";
  };
  const open = capped.filter((kind) => !off(kind) && (status.remainingToday[kind] ?? 1) > 0);
  const full = capped.filter((kind) => !off(kind) && status.remainingToday[kind] === 0);
  // Kinds without a cap of their own follow `*` (no gap and no window: always now).
  const anyNext = status.minutesUntilNext[anyKind];
  const next = [
    ...open.map((kind) => status.earliestNext[kind]),
    status.earliestNext[anyKind],
  ].filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  const earliest = next.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const readyNow =
    open.some((kind) => (status.minutesUntilNext[kind] ?? 0) <= 0) ||
    (anyNext === undefined ? true : anyNext <= 0);
  let tail = "";
  if (status.inActiveHours === false && earliest) tail = p.outsideHours(when(earliest, true));
  else if (readyNow) tail = full.length ? p.canNowExcept(full.map(name)) : p.canNow;
  else if (earliest) tail = p.nextAt(when(earliest));
  else if (full.length) {
    const resumes = full
      .map((kind) => status.earliestNext[kind])
      .filter((value): value is string => !!value)
      .sort()[0];
    tail = resumes ? p.fullAt(when(resumes, true)) : p.fullNoClock;
  }
  return p.today(parts, tail);
}

// ───────────────────────────── accounts ─────────────────────────────

/** An account (environment) view as the shell holds it: the view with its `pacing` normalized
 * (the server's EnvironmentView.pacing is optional; an absent one reads `present: false`). */
export interface AccountView extends Omit<EnvironmentView, "pacing"> {
  pacing: Pacing;
}

/** What the account flags and light read of a view: an EnvironmentView or an AccountView. */
type AccountState = Pick<EnvironmentView, "status" | "settings" | "signIns" | "proxyCheck"> &
  Partial<Pick<EnvironmentView, "id" | "projectId" | "founder" | "hasWork" | "computer">>;

/** An account flag: the desktop and proxy flags, and (fork, credentials) the facts only the
 * owner can act on: a site's `wrong_password` / `needs_code` / `suspended` / `no_login`
 * (`site:<status>:<site>`) and a proxy that does not work (`proxyDown`). */
export type AccountFlag =
  | "noProxy"
  /** A platform-set-up space's account without an exit: 选一个出口. */
  | "noExit"
  | "proxyUnreadable"
  | "desktopError"
  | "proxyDown"
  /** Not operating (`isIdleAccount`): 没在经营：给它一个长期目标或派活. */
  | "idle"
  | `site:${string}`;
/** The site facts only the owner can act on, as flags. */
export const ownerSiteStatuses = [
  "wrong_password",
  "needs_code",
  "suspended",
  "no_login",
  "needs_owner",
] as const;
/** A `needs_code` / `needs_owner` fact the owner said he handled
 * (`ownerHandledAt`) and nothing confirmed yet: the AI is confirming it (「正在确认 x 的登录…」),
 * never 「要验证码」 again. Its flag is `site:confirming:<site>`. When no record came for too long
 * after that (`ownerHandledStale`, the server decides), it is `site:unconfirmed:<site>`: 「还没确认
 * 上，再点一次我弄好了或让她再看」, with the desktop card again; never a stale blame status
 * behind nothing. */
export type OwnerSiteStatus = (typeof ownerSiteStatuses)[number] | "confirming" | "unconfirmed";
const handledStatuses = ["confirming", "unconfirmed"] as const;
/** A sign-in fact as a flag; null when it is not one the owner acts on (or waits on). */
export function factFlag(fact: {
  site: string;
  status: string;
  ownerHandledAt?: string | null;
  ownerHandledStale?: boolean | null;
}): AccountFlag | null {
  if (!(ownerSiteStatuses as readonly string[]).includes(fact.status)) return null;
  if ((fact.status === "needs_code" || fact.status === "needs_owner") && fact.ownerHandledAt)
    return fact.ownerHandledStale
      ? `site:unconfirmed:${fact.site}`
      : `site:confirming:${fact.site}`;
  return `site:${fact.status}:${fact.site}`;
}
/** A site flag's parts. */
export function siteFlag(flag: AccountFlag): { status: OwnerSiteStatus; site: string } | null {
  const match = /^site:([a-z_]+):(.+)$/.exec(flag);
  if (!match) return null;
  const status = [...ownerSiteStatuses, ...handledStatuses].find((item) => item === match[1]);
  return status ? { status, site: match[2] } : null;
}
/** Whether a proxy check says the proxy does not work (not after a replacement not yet checked). */
export function proxyIsDown(check: EnvironmentView["proxyCheck"]): boolean {
  return (
    !!check &&
    !check.pendingRestart &&
    (check.proxy !== "ok" || Object.values(check.sites).some((state) => state === "refused"))
  );
}
/** The plain reason a proxy check failed. */
export function proxyDownReason(check: NonNullable<EnvironmentView["proxyCheck"]>): string {
  if (check.proxy !== "ok") return t.signIn.proxyReasons[check.proxy] ?? check.proxy;
  const refused = Object.entries(check.sites).find(([, state]) => state === "refused");
  return refused ? t.signIn.siteRefused(refused[0]) : "";
}

/** One account row's data, shared by the rail, the accounts page, details and pickers. */
export interface AccountModel {
  id: string;
  name: string;
  /** The account label when it says more than the name (u/name == name is hidden). */
  label: string | null;
  projectId: string | null;
  desktop: EnvironmentStatus;
  desktopWord: string;
  /** "host:port" of the proxy exit, from the masked preview; null without one. */
  exit: string | null;
  /** A platform-set-up space's exit that does not work: not a flag (the
   * operator's), only 「出口连不上，已通知平台管理员」. */
  exitDown?: boolean;
  locale: string | null;
  timezone: string | null;
  light: Light;
  flags: AccountFlag[];
  /** 此刻: the task with the lowest rank among the account's live tasks, and how many more. */
  now: { entry: TaskEntry; more: number } | null;
  /** An open infrastructure incident of one of its live tasks (what keeps
   * failing and since when): the row shows the fact while the task retries by itself, instead
   * of a silent loop. Never in 需要你. */
  incident?: { kind: IncidentKind; since: string } | null;
  /** 下次: the earliest resume or scheduled run. */
  next: { at: string; label: string } | null;
  pacing: Pacing;
  paceLine: string;
  /** 「example.com 已登录 · x.com 密码不对」; null when nothing is known. */
  login: string | null;
  /** Who set the pacing in force: 「AI 定」, 「手动」, both; null when nothing is set or known. */
  paceMark: string | null;
  /** The task's reasons for what it set; null when it set nothing. */
  paceReason: string | null;
  /** Live (not ended) tasks bound to this account, by priority. */
  tasks: TaskEntry[];
  view: AccountView;
}

export function desktopWord(status: EnvironmentStatus): string {
  return t.desktop[status] ?? t.desktop.error;
}

/** "host:port" from a masked proxy preview such as "http://•••@203.0.113.105:5890". */
export function exitOfPreview(preview: string | null | undefined): string | null {
  if (!preview) return null;
  const match = /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?([^/:@\s]+):(\d{1,5})\/?$/i.exec(preview.trim());
  return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
}

/** The label worth showing beside the name: not when it is just the name again. */
export function shownLabel(name: string, label: string | null | undefined): string | null {
  if (!label) return null;
  return label.trim().toLowerCase() === name.trim().toLowerCase() ? null : label;
}

const phaseLight: Partial<Record<TaskPhase["key"], Light>> = {
  input: "amber",
  approval: "amber",
  fail: "red",
  run: "blue",
  queue: "blue",
  wait: "teal",
  sched: "teal",
  pause: "grey",
};

/** An account nothing makes act, the same rule as the server's 需要你 count
 * (project-overview.ts `idleAccount`): an account of a project, or the founder, whose view says
 * it has nothing to work on (`hasWork` false: no long-term goal, no open job, AccountLoops.wanted)
 * and that has no live task (`liveTasks`, its tasks not ended). An unassigned account that is not
 * the founder is a spare one and never is; a view that does not say (`hasWork` absent) never is. */
export function isIdleAccount(
  view: Partial<Pick<EnvironmentView, "projectId" | "founder" | "hasWork">>,
  liveTasks: number,
): boolean {
  return view.hasWork === false && !!(view.projectId || view.founder) && liveTasks === 0;
}

/** `platformEnv` (fork, 邀请码注册 P0 ①④): the space's environment is the platform's: an account
 * without a proxy needs an exit picked (noExit); a proxy that can't be read or does not work is
 * the operator's (his 环境告警), not the member's, so it is no flag. `liveTasks` (fork, make it
 * run): how many live tasks the account has; given, an account that is not operating gets the
 * `idle` flag (`isIdleAccount`), last. */
export function accountFlags(
  view: AccountState,
  platformEnv = false,
  liveTasks?: number,
): AccountFlag[] {
  const flags: AccountFlag[] = [];
  // With no computer connected a member has no desktop, exit or sign-ins, and no operating loop
  // to be idle in: no flag is hers.
  if (view.computer === false) return flags;
  if (platformEnv) {
    if (!view.settings.proxy.configured) flags.push("noExit");
  } else if (view.settings.unreadable) flags.push("proxyUnreadable");
  else if (!view.settings.proxy.configured) flags.push("noProxy");
  if (view.status === "error") flags.push("desktopError");
  // What only the owner can act on, the same rule as the server's 需要你.
  if (!platformEnv && proxyIsDown(view.proxyCheck)) flags.push("proxyDown");
  for (const fact of view.signIns ?? []) {
    const flag = factFlag(fact);
    if (flag) flags.push(flag);
  }
  if (liveTasks !== undefined && isIdleAccount(view, liveTasks)) flags.push("idle");
  return flags;
}
/** A project sign-in fact as the shell keeps it: the site, the status and (fork, incident
 * screenshots) the id of the incident whose picture was kept, when there is one. */
export interface ProjectSignIn {
  site: string;
  status: string;
  shot?: string;
  /** When the fact was recorded (absent when the server does not say). */
  at?: string;
  /** The owner said he handled it; the AI is confirming it. */
  ownerHandledAt?: string;
  /** With `ownerHandledAt`: no record came for too long; the owner is asked to look again. */
  ownerHandledStale?: boolean;
  /** The page's own words the record quoted, and whether the server reads the
   * page as a step the desktop's own tools can answer (the desktop card's lines). */
  seen?: string;
}
/** The incident id of a sign-in fact whose picture of that moment
 * was kept (「当时的画面」); null when there is none. */
export function factShot(fact: unknown): string | null {
  const incident =
    fact && typeof fact === "object" ? (fact as { incident?: unknown }).incident : null;
  if (!incident || typeof incident !== "object") return null;
  const { id, shot } = incident as { id?: unknown; shot?: unknown };
  return shot === true && typeof id === "string" && id ? id : null;
}
/** GET /api/credentials/sign-ins → each fact's site and status (anything malformed is left out). */
export function normalizeProjectSignIns(payload: unknown): ProjectSignIn[] {
  const list =
    payload && typeof payload === "object" ? (payload as { signIns?: unknown }).signIns : null;
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const fact = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const shot = factShot(fact);
    const at = typeof fact.at === "string" && fact.at ? fact.at : null;
    const handled =
      typeof fact.ownerHandledAt === "string" && fact.ownerHandledAt ? fact.ownerHandledAt : null;
    return typeof fact.site === "string" && fact.site && typeof fact.status === "string"
      ? [
          {
            site: fact.site,
            status: fact.status,
            ...(shot ? { shot } : {}),
            ...(at ? { at } : {}),
            ...(handled ? { ownerHandledAt: handled } : {}),
            ...(handled && fact.ownerHandledStale === true ? { ownerHandledStale: true } : {}),
            ...(typeof fact.seen === "string" && fact.seen ? { seen: fact.seen } : {}),
          },
        ]
      : [];
  });
}
/** GET /api/credentials/sign-ins → the project's default desktop's last proxy check, or null. */
/** Whether the project's default desktop has a proxy (GET /api/credentials/sign-ins); null when
 * the server does not say. */
export function normalizeProjectProxyConfigured(payload: unknown): boolean | null {
  const value = (payload as { proxyConfigured?: unknown } | null)?.proxyConfigured;
  return typeof value === "boolean" ? value : null;
}
export function normalizeProjectProxyCheck(payload: unknown): EnvironmentView["proxyCheck"] {
  return payload && typeof payload === "object"
    ? normalizeProxyCheck((payload as { proxyCheck?: unknown }).proxyCheck)
    : null;
}
/** The project's own sign-in facts (GET /api/credentials/sign-ins: the logins its default
 * desktop uses) and its default desktop's proxy check as flags, by the same rule as an
 * account's (and as the server's project count). */
export function projectSignInFlags(
  facts: readonly { site: string; status: string }[],
  proxyCheck: EnvironmentView["proxyCheck"] = null,
  proxyConfigured: boolean | null = null,
  /** The platform's proxies: no proxy flag for the member. */
  platformEnv = false,
): AccountFlag[] {
  const sites = facts.flatMap((fact) => {
    const flag = factFlag(fact);
    return flag ? [flag] : [];
  });
  if (platformEnv) return sites;
  // No proxy yet while the project uses any site login (waiting for one, or saved and not yet
  // used): the default desktop signs in nowhere until it has one, so the proxy comes first.
  const noProxy = proxyConfigured === false && facts.length ? (["noProxy"] as AccountFlag[]) : [];
  return [
    ...noProxy,
    ...(proxyIsDown(proxyCheck) ? (["proxyDown"] as AccountFlag[]) : []),
    ...sites,
  ];
}
/** The flags that put the account in 需要你 (one item per account): every flag is one only the
 * owner can act on (a proxy that can't be read is entered again), as the server counts it. */
export const needsYouFlags = (flags: readonly AccountFlag[]) => [...flags];

/** A flag as the account row prints it. */
export function flagLabel(flag: AccountFlag): string {
  const site = siteFlag(flag);
  if (site) {
    const words = {
      wrong_password: t.needs.wrongPassword,
      needs_code: t.needs.needsCode,
      needs_owner: t.needs.needsOwner,
      suspended: t.needs.suspended,
      no_login: t.needs.noLogin,
      confirming: t.needs.confirming,
      unconfirmed: t.needs.unconfirmed,
    } as const;
    return words[site.status](site.site);
  }
  if (flag === "noExit") return t.exits.flag;
  if (
    flag === "noProxy" ||
    flag === "proxyUnreadable" ||
    flag === "desktopError" ||
    flag === "proxyDown" ||
    flag === "idle"
  )
    return t.flags[flag];
  return flag;
}
/** What 需要你 says for a flag of `view`: the proxy flag with its plain reason. */
export function needText(flag: AccountFlag, view: Pick<EnvironmentView, "proxyCheck">): string {
  if (flag === "noProxy") return t.needs.noProxy;
  if (flag === "noExit") return t.exits.need;
  if (flag === "idle") return t.needs.idle;
  if (flag === "desktopError") return t.needs.desktopError;
  if (flag === "proxyDown" && view.proxyCheck)
    return t.needs.proxyDown(proxyDownReason(view.proxyCheck));
  return flagLabel(flag);
}
/** Where the owner deals with a flag: replace or add the site's login on the credentials page,
 * type a code on the account's desktop, replace the proxy, pick an exit in the account's editor
 * (a platform-set-up space), give it a long-term goal or a job (not operating), or look at the
 * account. */
export function needAction(
  flag: AccountFlag,
):
  | { kind: "login"; site: string }
  | { kind: "desktop" }
  | { kind: "proxy" }
  | { kind: "exit" }
  | { kind: "goal" }
  | { kind: "account" } {
  if (flag === "noExit") return { kind: "exit" };
  // Its long-term goal is set in its detail; a job is given in the chat.
  if (flag === "idle") return { kind: "goal" };
  const site = siteFlag(flag);
  if (site?.status === "wrong_password" || site?.status === "no_login")
    return { kind: "login", site: site.site };
  if (
    site?.status === "needs_code" ||
    site?.status === "needs_owner" ||
    // Not confirmed after the owner's step: back to the desktop.
    site?.status === "unconfirmed"
  )
    return { kind: "desktop" };
  if (flag === "proxyDown" || flag === "noProxy" || flag === "proxyUnreadable")
    return { kind: "proxy" };
  return { kind: "account" };
}
/** The account row's 登录 line: each site it has a login or a fact for, with the latest fact
 * (「example.com 已登录 · x.com 密码不对」); null when there is neither, so nothing is claimed. */
export function loginLine(view: Pick<EnvironmentView, "siteLogins" | "signIns">): string | null {
  const sites = new Set([
    ...(view.siteLogins ?? []).map((login) => login.site),
    ...(view.signIns ?? []).map((fact) => fact.site),
  ]);
  if (!sites.size) return null;
  const facts = new Map((view.signIns ?? []).map((fact) => [fact.site, fact]));
  return [...sites]
    .sort()
    .map((site) => {
      const fact = facts.get(site);
      return fact ? t.signIn.site(site, t.signIn.statuses[fact.status] ?? fact.status) : site;
    })
    .join(t.common.sep);
}
/** The detail's 登录 block: each site with its latest fact, the user name saved for it, when the
 * fact was recorded and what the AI wrote (masked by the server). */
export function signInRows(account: Pick<AccountModel, "view" | "flags">): {
  site: string;
  headline: string;
  username: string | null;
  at: string | null;
  detail: string | null;
  /** The page's words the record quoted, found on the page. */
  seen: string | null;
  flagged: boolean;
}[] {
  const view = account.view;
  const sites = new Set([
    ...(view.siteLogins ?? []).map((login) => login.site),
    ...(view.signIns ?? []).map((fact) => fact.site),
  ]);
  return [...sites].sort().map((site) => {
    const fact = view.signIns?.find((item) => item.site === site) ?? null;
    const login = view.siteLogins?.find((item) => item.site === site) ?? null;
    return {
      site,
      headline: fact ? t.signIn.site(site, t.signIn.statuses[fact.status] ?? fact.status) : site,
      username: login?.username ?? null,
      at: fact?.at ?? null,
      detail: fact?.detail ?? null,
      seen: fact?.seen ?? null,
      flagged: account.flags.some((flag) => siteFlag(flag)?.site === site),
    };
  });
}
/** The proxy's last self-check in words, or null when there was none. */
export function proxyCheckLine(
  view: Pick<EnvironmentView, "proxyCheck">,
  clock: (iso: string) => string,
): string | null {
  const check = view.proxyCheck;
  if (!check) return null;
  if (check.pendingRestart) return t.signIn.proxyPending;
  return proxyIsDown(check)
    ? t.signIn.proxyDown(clock(check.at), proxyDownReason(check))
    : t.signIn.proxyOk(clock(check.at));
}

/** What the run last read on the bot-detection check page, in words, or
 * null when there was none. */
export function browserCheckLine(
  view: Pick<EnvironmentView, "browserCheck">,
  clock: (iso: string) => string,
): string | null {
  const check = view.browserCheck;
  if (!check) return null;
  const result = check.result.trim() || "—";
  return check.status === "ok"
    ? t.signIn.browserOk(clock(check.at), result)
    : t.signIn.browserAttention(clock(check.at), result);
}

/** One light per account (design §4.4). A run while the worker has no heartbeat is grey, as its
 * pill (stalledPhase): the blue light reads 「在跑或排队中」. */
export function accountLight(
  view: AccountState,
  top: TaskEntry | null,
  platformEnv = false,
  liveTasks?: number,
): Light {
  const flags = accountFlags(view, platformEnv, liveTasks);
  if (needsYouFlags(flags).length) return "red";
  if (!top) return view.status === "missing" ? "hollow" : "grey";
  if (top.phase.stalled) return "grey";
  return phaseLight[top.phase.key] ?? "grey";
}

export function buildAccountModels(input: {
  accounts: readonly AccountView[];
  entries: readonly TaskEntry[];
  now: Date | number;
  /** The space's environment is the platform's (see accountFlags). */
  platformEnv?: boolean;
  /** `entries` are every task of these accounts' project (default). False
   * for another project's accounts, whose tasks are not read here: whether they are operating
   * is not known, so none reads 没在经营. */
  tasksKnown?: boolean;
}): AccountModel[] {
  const platformEnv = !!input.platformEnv;
  const known = input.tasksKnown !== false;
  return input.accounts
    .filter((view) => !view.deleting)
    .map((view) => {
      const tasks = input.entries
        .filter((entry) => entry.environmentId === view.id && !entry.phase.ended)
        .sort(byPriority);
      const top = tasks[0] ?? null;
      const nextEntry = tasks
        .filter(
          (entry) => (entry.phase.key === "wait" || entry.phase.key === "sched") && entry.phase.at,
        )
        .sort((a, b) => atMs(a) - atMs(b))[0];
      const clock = nextEntry?.phase.at
        ? clockLabel(nextEntry.phase.at, input.now, phaseWords)
        : "";
      return {
        id: view.id,
        name: view.name,
        label: shownLabel(view.name, view.accountLabel),
        projectId: view.projectId,
        desktop: view.status,
        desktopWord: desktopWord(view.status),
        exit: exitOfPreview(view.settings.proxy.preview),
        ...(platformEnv ? { exitDown: proxyIsDown(view.proxyCheck) } : {}),
        locale: view.settings.locale,
        timezone: view.settings.timezone,
        light: accountLight(view, top, platformEnv, known ? tasks.length : undefined),
        flags: accountFlags(view, platformEnv, known ? tasks.length : undefined),
        now: top ? { entry: top, more: tasks.length - 1 } : null,
        // Only while the task waits or is scheduled because of it: a run that works normally
        // again shows no flag (the record keeps the incident until the server ends it).
        incident:
          tasks.find(
            (entry) =>
              (entry.phase.key === "wait" || entry.phase.key === "sched") && entry.phase.incident,
          )?.phase.incident ?? null,
        next:
          nextEntry?.phase.at && clock
            ? {
                at: nextEntry.phase.at,
                label:
                  nextEntry.phase.key === "wait"
                    ? t.accountsRail.nextWait(clock)
                    : t.accountsRail.nextSched(clock),
              }
            : null,
        pacing: view.pacing,
        paceLine: paceLine(view.pacing, input.now),
        login: loginLine(view),
        paceMark: paceSourceMark(view.pacing),
        paceReason: paceReason(view.pacing),
        tasks,
        view,
      };
    });
}

/** The key of one exit inside one project (未分配 is a scope of its own): exit sharing is counted
 * per project only, never across projects. */
export function exitShareKey(projectId: string | null, exit: string): string {
  return `${projectId ?? ""}\u0000${exit}`;
}

// ───────────────────────────── 需要你 ─────────────────────────────

/** One entry of 需要你 (decision 4). Same-account-in-two-tasks is not one. */
export type NeedItem =
  | { kind: "task"; key: string; entry: TaskEntry; account: AccountModel | null }
  | { kind: "review"; key: string; action: ActionProposal; entry: TaskEntry | null }
  | {
      kind: "account";
      key: string;
      account: AccountModel;
      /** The first flag that needs the owner; `flags` all of them. Each site's
       * sign-in step is an item of its own (`needParts`); the account's other flags are one. */
      reason: AccountFlag;
      flags: AccountFlag[];
    }
  /** The project's own logins (its default desktop): one item for its proxy, one per site's
   * step (`needParts`), as the overview counts them. */
  | {
      kind: "project";
      key: string;
      flags: AccountFlag[];
      proxyCheck?: EnvironmentView["proxyCheck"];
      /** Site → the incident whose picture was kept. */
      shots?: Record<string, string>;
      /** Site → when its fact was recorded (the chat card's place). */
      raisedAt?: Record<string, string>;
      /** Site → the page's words its fact quoted and whether the page is a
       * step the desktop's own tools can answer (the desktop card's lines). */
      said?: Record<string, SiteSaid>;
    };
/** What a site's fact says about its page, for the desktop card. */
export interface SiteSaid {
  seen?: string;
}
/**
 * An account's (or the project's) flags as
 * 需要你 items, each counted as itself. Every site's step is one item (its key `<base>|<flag>`);
 * the flags that are not a site's (the desktop, the proxy, not operating) are one item under the
 * base key. In the flags' order, the account's own first.
 */
export function needParts(
  flags: readonly AccountFlag[],
): { suffix: string; flags: AccountFlag[] }[] {
  const own = flags.filter((flag) => !siteFlag(flag));
  return [
    ...(own.length ? [{ suffix: "", flags: own }] : []),
    ...flags
      .filter((flag) => siteFlag(flag))
      .map((flag) => ({ suffix: `|${flag}`, flags: [flag] })),
  ];
}
/** What the fact of `site` in a 需要你 item says about its page (the account's own facts, or
 * the project's `said`). */
export function siteSaid(
  item: Extract<NeedItem, { kind: "account" | "project" }>,
  site: string,
): SiteSaid {
  if (item.kind === "project") return item.said?.[site] ?? {};
  const fact = item.account.view.signIns?.find((entry) => entry.site === site);
  return {
    ...(fact?.seen ? { seen: fact.seen } : {}),
  };
}

export function needItems(input: {
  entries: readonly TaskEntry[];
  /** GET /api/workspace `actions` (any status; only awaiting_review are used). */
  actions: readonly ActionProposal[];
  accounts: readonly AccountModel[];
  /** The project's own sign-in facts (GET /api/credentials/sign-ins); none when not loaded. */
  projectSignIns?: readonly ProjectSignIn[];
  /** Its default desktop's last proxy check (the same answer). */
  projectProxyCheck?: EnvironmentView["proxyCheck"];
  /** Whether its default desktop has a proxy (the same answer; null: not said). */
  projectProxyConfigured?: boolean | null;
  /** The space's proxies are the platform's: no proxy item. */
  platformEnv?: boolean;
}): NeedItem[] {
  const projectProxyCheck = input.projectProxyCheck ?? null;
  const projectFlags = projectSignInFlags(
    input.projectSignIns ?? [],
    projectProxyCheck,
    input.projectProxyConfigured ?? null,
    !!input.platformEnv,
  );
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const tasks = input.entries.filter((entry) => entry.phase.needsYou).sort(byPriority);
  const reviewing = new Set(
    tasks.filter((entry) => entry.phase.key === "approval").map((entry) => entry.task.actionId),
  );
  const reviews = input.actions.filter(
    (action) => action.status === "awaiting_review" && !reviewing.has(action.id),
  );
  const entryById = new Map(input.entries.map((entry) => [entry.task.id, entry]));
  return [
    ...tasks.map(
      (entry): NeedItem => ({
        kind: "task",
        key: `task:${entry.task.id}`,
        entry,
        account: entry.environmentId ? (accountById.get(entry.environmentId) ?? null) : null,
      }),
    ),
    ...reviews.map(
      (action): NeedItem => ({
        kind: "review",
        key: `review:${action.id}`,
        action,
        entry: action.taskId ? (entryById.get(action.taskId) ?? null) : null,
      }),
    ),
    ...input.accounts.flatMap((account): NeedItem[] => {
      const flags = needsYouFlags(account.flags);
      // The order a person deals with them: the desktop, the proxy, then each site, then whether
      // it operates at all (no goal, no job).
      const order = (flag: AccountFlag) =>
        flag === "desktopError"
          ? 0
          : flag === "noProxy" || flag === "noExit"
            ? 1
            : flag === "proxyDown"
              ? 2
              : flag === "idle"
                ? 4
                : 3;
      const sorted = [...flags].sort((a, b) => order(a) - order(b));
      return needParts(sorted).map(
        (part): NeedItem => ({
          kind: "account",
          key: `account:${account.id}${part.suffix}`,
          account,
          reason: part.flags[0] as AccountFlag,
          flags: part.flags,
        }),
      );
    }),
    ...needParts(projectFlags).map(
      (part): NeedItem => ({
        kind: "project" as const,
        key: `project:sign-ins${part.suffix}`,
        flags: part.flags,
        proxyCheck: projectProxyCheck,
        ...projectShots(input.projectSignIns ?? []),
        ...projectRaisedAt(input.projectSignIns ?? []),
        ...projectSaid(input.projectSignIns ?? []),
      }),
    ),
  ];
}
function projectSaid(facts: readonly ProjectSignIn[]): { said?: Record<string, SiteSaid> } {
  const said = Object.fromEntries(
    facts.flatMap((fact) => {
      if (!fact.seen) return [];
      return [
        [
          fact.site,
          {
            ...(fact.seen ? { seen: fact.seen } : {}),
          },
        ],
      ];
    }),
  );
  return Object.keys(said).length ? { said } : {};
}
function projectRaisedAt(facts: readonly ProjectSignIn[]): { raisedAt?: Record<string, string> } {
  const raisedAt = Object.fromEntries(
    facts.flatMap((fact) =>
      fact.at && (ownerSiteStatuses as readonly string[]).includes(fact.status)
        ? [[fact.site, fact.at]]
        : [],
    ),
  );
  return Object.keys(raisedAt).length ? { raisedAt } : {};
}
function projectShots(facts: readonly ProjectSignIn[]): { shots?: Record<string, string> } {
  const shots = Object.fromEntries(
    facts.flatMap((fact) =>
      fact.shot && (ownerSiteStatuses as readonly string[]).includes(fact.status)
        ? [[fact.site, fact.shot]]
        : [],
    ),
  );
  return Object.keys(shots).length ? { shots } : {};
}
/** The picture of each flagged site of a 需要你 item whose latest
 * incident (the fact's) kept one, in the item's order: 「当时的画面」 thumbnails. */
export function needShots(item: NeedItem): { site: string; id: string }[] {
  if (item.kind !== "account" && item.kind !== "project") return [];
  const shotOf = (site: string) =>
    item.kind === "account"
      ? factShot(item.account.view.signIns?.find((fact) => fact.site === site))
      : (item.shots?.[site] ?? null);
  const seen = new Set<string>();
  return item.flags.flatMap((flag) => {
    const site = siteFlag(flag)?.site;
    const id = site ? shotOf(site) : null;
    if (!site || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ site, id }];
  });
}
/** What a stopped task's 需要你 card says and its one button. A one-off task's
 * failure in full (`failureText`) with 重试; a standing task that stopped (`phase.stopped`), in the
 * owner's words: 「经营停了：<why>」 with 重试. The same on the phone, the web's 需要你 page and the
 * web chat. */
export function stopNeed(entry: Pick<TaskEntry, "task" | "phase">): {
  text: string;
  op: "retry" | "resume";
  label: string;
} {
  const { task, phase } = entry;
  if (phase.stopped && phase.key === "pause")
    return { text: phase.sub, op: "resume", label: t.needs.resume };
  const error = task.error?.trim() ?? "";
  if (phase.stopped)
    return {
      text: phaseWords.loopStopped(error || phaseWords.failedUnknown),
      op: "retry",
      label: t.needs.retry,
    };
  // A failure the server wrote in English (a provider's quota answer) in Chinese.
  return { text: failureText(error) || phase.sub, op: "retry", label: t.needs.retry };
}

/** The project item's line: 「本项目：apple.com 密码不对 · x.com 要验证码」 (the proxy with its
 * plain reason). */
export function projectNeedText(
  flags: readonly AccountFlag[],
  proxyCheck: EnvironmentView["proxyCheck"] = null,
): string {
  return t.needs.projectFact(
    flags
      // The default desktop starts without a proxy; it only signs in nowhere until it has one.
      .map((flag) => (flag === "noProxy" ? t.needs.projectNoProxy : needText(flag, { proxyCheck })))
      .join(t.common.sep),
  );
}

/** An account
 * item's one line: each thing the chat asks for named (「x.com 要验证码」), then 已在聊天里问你,
 * then the rest. The same on the phone and the web (need-card-state's `asked` / `other`). */
export function accountNeedLine(
  item: Extract<NeedItem, { kind: "account" }>,
  m: { asked: readonly AccountFlag[]; other: readonly AccountFlag[] },
): string {
  return [
    ...m.asked.map((flag) => needText(flag, item.account.view)),
    ...(m.asked.length ? [t.guide.askedInChat] : []),
    ...m.other.map((flag) => needText(flag, item.account.view)),
  ].join(t.common.sep);
}
/** The project item's one line, the same way: 「本项目：x.com 要验证码 · 已在聊天里问你」. */
export function projectNeedLine(
  item: Extract<NeedItem, { kind: "project" }>,
  m: { asked: readonly AccountFlag[]; other: readonly AccountFlag[] },
): string {
  const proxyCheck = item.proxyCheck ?? null;
  return [
    m.asked.length ? projectNeedText(m.asked, proxyCheck) : "",
    m.asked.length ? t.guide.askedInChat : "",
    m.other.length ? projectNeedText(m.other, proxyCheck) : "",
  ]
    .filter(Boolean)
    .join(t.common.sep);
}

/** The status strip and project counts. `needsYou` is the whole 需要你 number (the 等你 cell is
 * needsYou − failed); running includes queued (design §3.1). */
export interface ShellCounts {
  needsYou: number;
  waitingOnYou: number;
  failed: number;
  running: number;
  waiting: number;
  scheduled: number;
}
export function shellCounts(
  entries: readonly TaskEntry[],
  needs: readonly NeedItem[],
): ShellCounts {
  const failed = entries.filter(
    (entry) => entry.phase.key === "fail" && entry.phase.needsYou,
  ).length;
  return {
    needsYou: needs.length,
    waitingOnYou: needs.length - failed,
    failed,
    running: entries.filter((entry) => entry.phase.key === "run" || entry.phase.key === "queue")
      .length,
    waiting: entries.filter((entry) => entry.phase.key === "wait").length,
    scheduled: entries.filter((entry) => entry.phase.key === "sched").length,
  };
}

// ───────────────────────────── reports ─────────────────────────────

/** The newest `count` reports, newest first (the rail's 汇报 section). */
export function latestReports(reports: readonly ChatReport[], count = 5): ChatReport[] {
  return [...reports]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, count);
}

/** Labels that are a stop the person must act on: shown as a need card, never merged. */
export const needReportLabels: readonly string[] = [
  "Needs your input",
  "Ready for your review",
  "Needs attention",
  "Run failed",
];

export type GroupedItem<M> =
  | { type: "message"; key: string; message: M }
  | { type: "reports"; key: string; taskId: string; reports: ChatReport[] }
  | { type: "need"; key: string; report: ChatReport }
  /** A card about the project's jobs or an account's persona (`report.notice`). */
  | { type: "notice"; key: string; report: ChatReport };

/**
 * Design §6.4–6.5: consecutive reports of one task (nothing of yours in between) merge into one
 * group whose latest is expanded; a need report always stands alone.
 */
export function groupTranscript<M>(
  items: readonly TranscriptItem<M>[],
  isNeed: (report: ChatReport) => boolean = (report) =>
    report.kind === "outcome" && needReportLabels.includes(report.title),
): GroupedItem<M>[] {
  const out: GroupedItem<M>[] = [];
  for (const item of items) {
    if (item.type === "message") {
      out.push(item);
      continue;
    }
    const report = item.report;
    if (isNeed(report)) {
      out.push({ type: "need", key: item.key, report });
      continue;
    }
    // A job declined or done, a persona changed: a card of its own, never merged.
    if (report.notice) {
      out.push({ type: "notice", key: item.key, report });
      continue;
    }
    const last = out.at(-1);
    if (last?.type === "reports" && last.taskId === report.taskId) last.reports.push(report);
    else out.push({ type: "reports", key: item.key, taskId: report.taskId, reports: [report] });
  }
  return out;
}

// ───────────────────────────── projects (N1) ─────────────────────────────

export interface ProjectCounts {
  needsYou: number;
  running: number;
  queued: number;
  waiting: number;
  scheduled: number;
  failed7d: number;
}
/** One 需要你 item of a project as N1 lists it (apps/server/src/project-overview.ts
 * ProjectNeedLine): its needItems key, what kind of stop it is, the title and the account. An
 * `unknown` line stands for an item of a server that only counts (no `needs` yet). */
export interface ProjectNeedLine {
  key: string;
  kind: "input" | "approval" | "fail" | "review" | "account" | "project" | "unknown";
  title: string;
  account: string | null;
  /** A site's sign-in step (an item of its own): the site and what it needs
   * (a flag status: needs_owner, needs_code, confirming…), named by `needLineWords`. */
  site?: string;
  need?: string;
}
/** One row of GET /api/projects/overview. `id` null is the default project (未分组). */
export interface ProjectOverview {
  id: string | null;
  name: string;
  accounts: number;
  counts: ProjectCounts;
  /** Every 需要你 item; `counts.needsYou` is its length (normalizeOverview keeps it so). Absent
   * on a row built here without N1's lines: `projectNeedLines` stands one line in per count. */
  needs?: ProjectNeedLine[];
  lastActivityAt: string | null;
}
const zeroCounts: ProjectCounts = {
  needsYou: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  scheduled: 0,
  failed7d: 0,
};
/** Reads `{ projects: ProjectOverview[] }` defensively; null when the payload is unusable. */
export function normalizeOverview(payload: unknown): ProjectOverview[] | null {
  const list = record(payload).projects;
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const value = record(item);
    const counts = record(value.counts);
    const needs = Array.isArray(value.needs) ? value.needs.map(needLineOf) : undefined;
    return {
      id: str(value.id),
      name: str(value.name) ?? "",
      accounts: num(value.accounts) ?? 0,
      counts: {
        // One source: with the lines, the count is their number.
        needsYou: needs ? needs.length : (num(counts.needsYou) ?? zeroCounts.needsYou),
        running: num(counts.running) ?? 0,
        queued: num(counts.queued) ?? 0,
        waiting: num(counts.waiting) ?? 0,
        scheduled: num(counts.scheduled) ?? 0,
        failed7d: num(counts.failed7d) ?? 0,
      },
      ...(needs ? { needs } : {}),
      lastActivityAt: str(value.lastActivityAt),
    };
  });
}
const needKinds: readonly ProjectNeedLine["kind"][] = [
  "input",
  "approval",
  "fail",
  "review",
  "account",
  "project",
];
function needLineOf(item: unknown, index: number): ProjectNeedLine {
  const value = record(item);
  const kind = str(value.kind);
  const site = str(value.site);
  const need = str(value.need);
  return {
    key: str(value.key) ?? `need:${index}`,
    kind: needKinds.find((known) => known === kind) ?? "unknown",
    title: str(value.title) ?? "",
    account: str(value.account),
    ...(site && need ? { site, need } : {}),
  };
}
/** Another project's site step named as the account row prints it
 * (「x.com 要验证码」); null for any other line, or a status this client does not know. */
export function needLineWords(line: Pick<ProjectNeedLine, "site" | "need">): string | null {
  if (!line.site || !line.need) return null;
  const flag: AccountFlag = `site:${line.need}:${line.site}`;
  return siteFlag(flag) ? flagLabel(flag) : null;
}
/** A project's 需要你 lines: N1's, or (a server that only counts) one `unknown` line per item,
 * so the rows shown are always as many as the number counted. */
export function projectNeedLines(
  row: Pick<ProjectOverview, "id" | "counts" | "needs">,
): ProjectNeedLine[] {
  if (row.needs) return row.needs;
  return Array.from({ length: Math.max(0, row.counts.needsYou) }, (_, index) => ({
    key: `${row.id ?? ""}:${index}`,
    kind: "unknown" as const,
    title: "",
    account: null,
  }));
}

/** One project's group on the whole space's 需要你 page: the current project's items with every
 * action they have (needItems), each other project's as N1's lines, opened by switching to it. */
export type SpaceNeedGroup =
  | { current: true; projectId: string | null; items: NeedItem[] }
  | { current: false; projectId: string | null; name: string; lines: ProjectNeedLine[] };
/** The whole space's 需要你, grouped by project: the current project first, then the others with
 * anything waiting in the project list's order (sortProjects; 未分组 last). The one source of
 * 需要你: `spaceNeedCount` of it is every count shown (sidebar, tab title, bottom bar). The
 * overview's own row for the current project is not used: its items are the local ones. */
export function spaceNeeds(
  local: readonly NeedItem[],
  overview: readonly ProjectOverview[] | null,
  current: string | null,
): SpaceNeedGroup[] {
  const others = sortProjects((overview ?? []).filter((row) => row.id !== current))
    .map(
      (row): SpaceNeedGroup => ({
        current: false,
        projectId: row.id,
        name: row.name,
        lines: projectNeedLines(row),
      }),
    )
    .filter((group) => !group.current && group.lines.length > 0);
  return [{ current: true, projectId: current, items: [...local] }, ...others];
}
/** How many rows the whole space's 需要你 page lists. */
export function spaceNeedCount(groups: readonly SpaceNeedGroup[]): number {
  return groups.reduce(
    (sum, group) => sum + (group.current ? group.items.length : group.lines.length),
    0,
  );
}
/** Design §3.3: projects with something for you first, then by latest activity; 未分组 last. */
export function sortProjects(list: readonly ProjectOverview[]): ProjectOverview[] {
  return [...list].sort((a, b) => {
    if ((a.id === null) !== (b.id === null)) return a.id === null ? 1 : -1;
    const na = a.counts.needsYou > 0;
    const nb = b.counts.needsYou > 0;
    if (na !== nb) return na ? -1 : 1;
    return (
      (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.name.localeCompare(b.name)
    );
  });
}
/** The header's red dot: 需要你 in every project but the current one. */
export function otherProjectsNeedsYou(
  list: readonly ProjectOverview[] | null,
  current: string | null,
): number {
  return (list ?? [])
    .filter((project) => project.id !== current)
    .reduce((sum, project) => sum + projectNeedLines(project).length, 0);
}

// ───────────────────────────── worker ─────────────────────────────

/** Design §3.1: a heartbeat older than 45 seconds shows the red bar. The server's own verdict
 * (`running`, judged on the server's clock) comes first: while it says running there is no red
 * bar, however far this device's clock is ahead; when it says stopped, the bar waits until the
 * heartbeat is 45 s old here too, so a short gap between two ticks does not flash it. */
export const workerStaleMs = 45_000;
export interface WorkerHealth {
  down: boolean;
  /** How long since the last heartbeat; null without one. */
  sinceMs: number | null;
  lastTickAt: string | null;
}
export function workerHealth(
  worker: { running: boolean; lastTickAt?: string } | undefined,
  now: Date | number,
): WorkerHealth {
  if (!worker) return { down: false, sinceMs: null, lastTickAt: null };
  const last = worker.lastTickAt ? Date.parse(worker.lastTickAt) : Number.NaN;
  const sinceMs = Number.isNaN(last) ? null : Math.max(0, toMs(now) - last);
  return {
    down: !worker.running && (sinceMs === null || sinceMs > workerStaleMs),
    sinceMs,
    lastTickAt: worker.lastTickAt ?? null,
  };
}

// ───────────────────────────── task extras ─────────────────────────────

/** `state.operatingPlan` (feat/pacing contract), or null. */
export interface OperatingPlan {
  version: number;
  setAt: string | null;
  communities: { name: string; why: string; rule: string }[];
  forms: string;
  voice: string;
  pace: string;
  review: string;
  horizon: string;
}
const prose = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(prose).filter(Boolean).join(t.common.clauseSep);
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}${t.common.colon}${prose(item)}`)
      .join(t.common.clauseSep);
  return typeof value === "number" ? String(value) : "";
};
export function operatingPlanOf(task: Pick<AgentTask, "state">): OperatingPlan | null {
  const raw = task.state?.operatingPlan;
  if (!raw || typeof raw !== "object") return null;
  const plan = record(raw);
  const communities = Array.isArray(plan.communities)
    ? plan.communities.map((item) => {
        if (typeof item === "string") return { name: item, why: "", rule: "" };
        const value = record(item);
        return { name: prose(value.name), why: prose(value.why), rule: prose(value.rule) };
      })
    : [];
  return {
    version: num(plan.version) ?? 1,
    setAt: str(plan.setAt),
    communities: communities.filter((item) => item.name),
    forms: prose(plan.forms),
    voice: prose(plan.voice),
    pace: prose(plan.pace),
    review: prose(plan.review),
    horizon: prose(plan.horizon),
  };
}

/** GET /api/agent/brief → `{ text, updatedAt }`. */
export interface ProjectBrief {
  text: string;
  updatedAt: string | null;
}
export function normalizeBrief(payload: unknown): ProjectBrief {
  const value = record(payload);
  return {
    text: typeof value.text === "string" ? value.text : "",
    updatedAt: str(value.updatedAt),
  };
}

// ───────────────────────────── inline task actions ─────────────────────────────

/** POST /api/agent/tasks/:id/control actions, plus 改间隔 (opens an editor) and 停止重复
 * (PATCH repeatMinutes: null). 回答 / 审阅 are the need card's. */
export type TaskOp = "pause" | "resume" | "run" | "retry" | "cancel" | "interval" | "stopRepeat";
export interface TaskAction {
  op: TaskOp;
  label: string;
}
/** The buttons a task shows in place (prototype rowActions): only what the phase allows.
 * `compact` (chat task cards) drops the secondary one. Questions and reviews have none here:
 * the need card answers them. 改间隔 / 停止重复 only for a repeating task (`repeating`): a
 * one-off task scheduled again (after the infrastructure stopped its run) has no interval. */
export function phaseActions(
  phase: Pick<TaskPhase, "key">,
  compact = false,
  repeating = false,
): TaskAction[] {
  const words = t.tasksRail;
  switch (phase.key) {
    case "run":
      return [{ op: "pause", label: words.pause }];
    case "wait":
      return compact
        ? [{ op: "run", label: words.continueNow }]
        : [
            { op: "run", label: words.continueNow },
            { op: "pause", label: words.pause },
          ];
    case "sched":
      return compact || !repeating
        ? [{ op: "run", label: words.runNow }]
        : [
            { op: "run", label: words.runNow },
            { op: "interval", label: words.changeInterval },
            { op: "stopRepeat", label: words.stopRepeating },
          ];
    case "pause":
      return [{ op: "resume", label: words.resume }];
    case "fail":
      return [{ op: "retry", label: words.retry }];
    default:
      return [];
  }
}
