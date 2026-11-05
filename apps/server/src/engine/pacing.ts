/**
 * An account's pacing is decided by the task that runs on
 * it, per account, from facts; the server has no pacing numbers of its own. It does three
 * things: it puts the facts in front of every run of a task bound to an account (the account's
 * recorded profile, its recent actions, the other accounts on the same proxy exit, what is set
 * and by whom and why, the local time); it records what the task set (set_account_pacing,
 * source "ai") or what the person set by hand (PATCH, source "owner", which is in force over the
 * task's and which the task cannot overwrite) and enforces exactly that, marking an action over
 * it and never blocking; and it shows the person what is set and why. An unset field is a fact:
 * no gap, cap or window is enforced for it, and nothing fills it in.
 *
 * Everything is keyed by the environment's derived owner (`envOwner`), which every project
 * computes alike, so one account's ledger and settings are shared by all projects.
 */

import { activeHoursPair } from "../../../../packages/domain/src/agent.ts";
import type {
  ActionKind,
  PacingAiField,
  PacingAiLayer,
  PacingEffective,
  PacingFieldInForce,
  PacingOwnerField,
  PacingOwnerLayer,
  PacingSettings,
  PacingStatus,
  SameExitAccounts,
  SiblingAccount,
  SiteProfile,
} from "../../../../packages/domain/src/environments.ts";
import { actionKindOf } from "../../../../packages/domain/src/environments.ts";
import type { StrangerSeen } from "../../../../packages/domain/src/standing.ts";
import type { ComputerSettings } from "../computer.ts";
import type { Config } from "../config.ts";
import { siteOf } from "../credentials/site.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  isLegacyProfile,
  type LegacyProfile,
  legacyAction,
  legacyCapFields,
  legacyProfileFacts,
  legacySite,
} from "./pacing-legacy.ts";

/** The desktop template's own zone: what the desktop's clock reads when the account sets
 * no zone of its own (a fact about the desktop, reported as such). */
export const templateTimezone = "America/Los_Angeles";
export const pacingSettingsKind = "pacing-settings";
/** The person's layer (PATCH). Records written before the task could set pacing hold plain
 * values; they were the person's and read as such. */
export const pacingSettingsId = "pacing";
/** The task's layer (set_account_pacing). */
export const pacingAiSettingsId = "pacing-ai";
export const accountActionsKind = "account-actions";
export const pacingClaimsKind = "pacing-claims";
/** Facts a task recorded about the account, one record per site (id = the site). */
export const accountProfileKind = "account-profile";
/** Ledger rows older than this are removed when a new one is written. */
export const ledgerDays = 30;
// Same as model.ts defaultRunMaxMinutes (not imported: model.ts imports this module).
const runMaxMinutesDefault = 60;

/** One reported action on an account (the ledger, `account-actions` under the derived owner):
 * the site and the action the AI named, the address of what it made (when it gave one), the
 * report's links and when. Rows written before the platform-agnostic ledger have no `site`; they
 * read as pacing-legacy.ts says. */
export interface AccountAction {
  /** hash(`ledgerKey`). */
  id: string;
  taskId: string;
  /** The (project) owner of the task that reported it. */
  projectOwner: string;
  site?: string;
  action: string;
  permalink?: string | null;
  /** Reported when a set cap had nothing left today, or before the earliest time the set fields
   * allowed. */
  overCapacity: boolean;
  links: string[];
  at: string;
  /** The address of what the action was done to, normalised (`normalizeLink`), and
   * the user name it was done to, as the AI reported them. */
  target?: string | null;
  targetUser?: string | null;
  /** The job the action was for (jobs, docs/accounts.md). */
  jobId?: string | null;
  /** Another account of the project this action touched (`interaction`: its content or itself)
   * or went into the same place as (`same_target`), as the server found it when it was reported. */
  sibling?: { name: string; kind: "interaction" | "same_target" } | null;
  /** Set on the row a report without an address
   * that confirms the action wrote. The same task's report of that action with its address names
   * it in `confirms` (`confirmsRef`), takes the row over (service.ts `ledgerEntry`) and clears
   * this. */
  unconfirmed?: boolean | null;
  /** The card that first reported this row. While the
   * row waits, every later report of the action rewrites that card (service.ts `report`). */
  reportId?: string | null;
  /** What a visitor who is not signed in saw at the
   * item, the last time the account looked (`recordStrangerView`). */
  stranger?: StrangerSeen | null;
}
/** The site a ledger row is on (a row from before the per-site ledger: as pacing-legacy.ts says). */
export const siteOfRow = (row: Pick<AccountAction, "site">) => row.site ?? legacySite;
/** The kind a ledger row counts as: `<site>/<action>`. */
export function kindOfRow(row: Pick<AccountAction, "site" | "action">): ActionKind {
  if (row.site) return actionKindOf(row.site, row.action);
  return actionKindOf(legacySite, legacyAction(row.action));
}
/** A run in progress on an account (`pacing-claims` under the derived owner, id = task id). */
export interface PacingClaim {
  id: string;
  since: string;
  token: string;
}
/** Facts recorded about the account on one site (`account-profile/<site>` under the derived
 * owner). */
export interface StoredSiteProfile {
  id: string;
  site: string;
  facts: Record<string, string | number | boolean>;
  recordedAt: string;
  taskId: string;
}

type Stored<T> = { value: T; setAt: string; reason?: string };
type LayerRecord = {
  id: string;
  updatedAt: string;
  minGapMinutes?: Stored<number> | number | null;
  activeHours?: Stored<[number, number]> | [number, number] | null;
  caps?: Record<ActionKind, Stored<number> | null> | null;
  /** Written before caps were per kind (pacing-legacy.ts). */
  maxCommentsPerDay?: Stored<number> | number | null;
  maxPostsPerDay?: Stored<number> | number | null;
};
/** The legacy cap fields and the kinds they were about. */
const legacyCaps = legacyCapFields.map(
  ([name, action]) => [name, actionKindOf(legacySite, action)] as const,
);

/** A stored field: `{ value, setAt[, reason] }`, or (the person's layer, written before the task
 * could set pacing) a plain value whose time is the record's. */
function field<T>(stored: Stored<T> | T | null | undefined, updatedAt: string): Stored<T> | null {
  if (stored === null || stored === undefined) return null;
  if (typeof stored === "object" && !Array.isArray(stored) && "value" in (stored as object))
    return stored as Stored<T>;
  return { value: stored as T, setAt: updatedAt };
}
/** A layer's caps, kind by kind, with the legacy fields read as their kinds (a cap set in
 * the new shape wins over a legacy one for the same kind). */
function capsOf(record: LayerRecord): Record<ActionKind, Stored<number>> {
  const caps: Record<ActionKind, Stored<number>> = {};
  for (const [name, kind] of legacyCaps) {
    const legacy = field(record[name], record.updatedAt);
    if (legacy) caps[kind] = legacy;
  }
  for (const [kind, value] of Object.entries(record.caps ?? {})) {
    if (value) caps[kind] = value;
    else delete caps[kind];
  }
  return caps;
}
const ownerField = <T>(stored: Stored<T> | null): PacingOwnerField<T> | null =>
  stored ? { value: stored.value, setAt: stored.setAt } : null;
const aiField = <T>(stored: Stored<T> | null): PacingAiField<T> | null =>
  stored ? { value: stored.value, reason: stored.reason ?? "", setAt: stored.setAt } : null;
/** The account's saved settings: the person's layer and the task's layer, all unset when
 * nothing was set. */
export async function readPacingSettings(db: Store, ledgerOwner: string): Promise<PacingSettings> {
  const [ownerRecord, aiRecord] = await Promise.all([
    db.get<LayerRecord>(ledgerOwner, pacingSettingsKind, pacingSettingsId),
    db.get<LayerRecord>(ledgerOwner, pacingSettingsKind, pacingAiSettingsId),
  ]);
  const owner: PacingOwnerLayer = { minGapMinutes: null, activeHours: null, caps: {} };
  const ai: PacingAiLayer = { minGapMinutes: null, activeHours: null, caps: {} };
  if (ownerRecord) {
    owner.minGapMinutes = ownerField(field(ownerRecord.minGapMinutes, ownerRecord.updatedAt));
    owner.activeHours = ownerField(field(ownerRecord.activeHours, ownerRecord.updatedAt));
    for (const [kind, value] of Object.entries(capsOf(ownerRecord)))
      owner.caps[kind] = { value: value.value, setAt: value.setAt };
  }
  if (aiRecord) {
    // The task's layer was always written as { value, reason, setAt }.
    const gap = aiRecord.minGapMinutes;
    const hours = aiRecord.activeHours;
    ai.minGapMinutes = aiField(gap && typeof gap === "object" ? gap : null);
    ai.activeHours = aiField(hours && !Array.isArray(hours) ? hours : null);
    for (const [kind, value] of Object.entries(capsOf(aiRecord)))
      ai.caps[kind] = { value: value.value, reason: value.reason ?? "", setAt: value.setAt };
  }
  const times = [ownerRecord?.updatedAt, aiRecord?.updatedAt].filter(
    (time): time is string => typeof time === "string",
  );
  return { owner, ai, updatedAt: times.length ? (times.sort().at(-1) ?? null) : null };
}

/** A patch of the pacing fields: an omitted field (or kind) is left as it is, null unsets it. */
export interface PacingPatch {
  minGapMinutes?: number | null;
  /** Two hours, [start, end) (the schemas check it: an array of two, not a tuple, for the model
   * API). */
  activeHours?: readonly number[] | null;
  caps?: Record<ActionKind, number | null>;
}
const hoursOf = (hours: readonly number[] | null | undefined) =>
  hours === undefined ? undefined : hours === null ? null : activeHoursPair(hours);

/** Caps keyed the way the ledger counts: each key's site part is reduced to its registrable domain
 * (`siteOf`, as report_to_user does with the site of an action), so a cap set for
 * `www.example.com/post` is the cap of the kind `example.com/post` the ledger counts. A key with
 * no website's domain, or two keys of one kind with different values, is refused. */
export function normaliseCapKinds<T>(caps: Record<string, T>): Record<ActionKind, T>;
export function normaliseCapKinds<T>(
  caps: Record<string, T> | undefined,
): Record<ActionKind, T> | undefined;
export function normaliseCapKinds<T>(caps: Record<string, T> | undefined) {
  if (caps === undefined) return undefined;
  const out: Record<ActionKind, T> = {};
  for (const [key, value] of Object.entries(caps)) {
    const slash = key.lastIndexOf("/");
    const site = slash > 0 ? siteOf(key.slice(0, slash)) : null;
    const action = key.slice(slash + 1);
    if (!site || !action)
      throw new AppError(
        `caps: "${key}" is not <site>/<action> with a website's domain, such as example.com/post`,
        422,
      );
    const kind = actionKindOf(site, action);
    if (kind in out && out[kind] !== value)
      throw new AppError(`caps: two keys name the kind ${kind} with different values`, 422);
    out[kind] = value;
  }
  return out;
}

/** Rewrites one layer: `change` gets the current record and returns the fields to write. The
 * record is replaced with a compare-and-swap on its time, again until no other save came in
 * between, so two saves of different fields at once both stay. Legacy cap fields are folded
 * into `caps` on the first write. */
async function writeLayer(
  db: Store,
  ledgerOwner: string,
  id: string,
  change: (current: LayerRecord) => Partial<LayerRecord>,
) {
  for (;;) {
    const current = await db.get<LayerRecord>(ledgerOwner, pacingSettingsKind, id);
    const updatedAt = new Date().toISOString();
    const base: LayerRecord = current ?? { id, updatedAt };
    const caps = capsOf(base);
    const next: LayerRecord = {
      ...base,
      caps,
      maxCommentsPerDay: null,
      maxPostsPerDay: null,
      ...change({ ...base, caps }),
      id,
      updatedAt,
    };
    const saved = current
      ? await db.compareAndSwap(
          ledgerOwner,
          pacingSettingsKind,
          id,
          { updatedAt: current.updatedAt },
          next,
        )
      : await db.insertIfAbsent(ledgerOwner, pacingSettingsKind, next);
    if (saved) return;
  }
}
/** The person's layer (PATCH /api/environments/:id { pacing }): an omitted field or kind keeps
 * its value, null unsets it (the task's value, if any, is in force again); `null` for the whole
 * patch unsets every value of the person's. */
export async function writeOwnerPacing(
  db: Store,
  ledgerOwner: string,
  raw: PacingPatch | null,
): Promise<PacingSettings> {
  const patch = raw && {
    ...raw,
    activeHours: hoursOf(raw.activeHours),
    caps: normaliseCapKinds(raw.caps),
  };
  const setAt = new Date().toISOString();
  await writeLayer(db, ledgerOwner, pacingSettingsId, (current) => {
    if (patch === null) return { minGapMinutes: null, activeHours: null, caps: {} };
    const out: Partial<LayerRecord> = {};
    if (patch.minGapMinutes !== undefined)
      out.minGapMinutes =
        patch.minGapMinutes === null ? null : { value: patch.minGapMinutes, setAt };
    if (patch.activeHours !== undefined)
      out.activeHours = patch.activeHours === null ? null : { value: patch.activeHours, setAt };
    if (patch.caps !== undefined) {
      const caps = { ...(current.caps ?? {}) };
      for (const [kind, value] of Object.entries(patch.caps))
        if (value === null) delete caps[kind];
        else caps[kind] = { value, setAt };
      out.caps = caps;
    }
    return out;
  });
  return readPacingSettings(db, ledgerOwner);
}
/** The task's layer (set_account_pacing): the fields and kinds sent are written with the reason
 * and the time, except those the person has set (`ownerLocked`), which are left as they are. */
export async function writeAiPacing(
  db: Store,
  ledgerOwner: string,
  raw: PacingPatch,
  reason: string,
): Promise<{ settings: PacingSettings; set: string[]; ownerLocked: string[] }> {
  const patch = {
    ...raw,
    activeHours: hoursOf(raw.activeHours),
    caps: normaliseCapKinds(raw.caps),
  };
  const before = await readPacingSettings(db, ledgerOwner);
  const setAt = new Date().toISOString();
  const set: string[] = [];
  const ownerLocked: string[] = [];
  const out: Partial<LayerRecord> = {};
  for (const name of ["minGapMinutes", "activeHours"] as const) {
    if (patch[name] === undefined) continue;
    if (before.owner[name]) ownerLocked.push(name);
    else {
      set.push(name);
      Object.assign(out, {
        [name]: patch[name] === null ? null : { value: patch[name], reason, setAt },
      });
    }
  }
  const capChanges: [ActionKind, number | null][] = [];
  for (const [kind, value] of Object.entries(patch.caps ?? {})) {
    if (before.owner.caps[kind]) ownerLocked.push(`caps.${kind}`);
    else {
      set.push(`caps.${kind}`);
      capChanges.push([kind, value]);
    }
  }
  if (set.length)
    await writeLayer(db, ledgerOwner, pacingAiSettingsId, (current) => {
      const caps = { ...(current.caps ?? {}) };
      for (const [kind, value] of capChanges)
        if (value === null) delete caps[kind];
        else caps[kind] = { value, reason, setAt };
      return { ...out, caps };
    });
  return { settings: await readPacingSettings(db, ledgerOwner), set, ownerLocked };
}

/** What is in force, field by field and kind by kind: the person's value over the task's;
 * nothing else. A cap set to 0 turns its kind off. */
export function effectivePacing(settings: PacingSettings | null): PacingEffective {
  const inForce = <T>(
    owner: PacingOwnerField<T> | null | undefined,
    ai: PacingAiField<T> | null | undefined,
  ): PacingFieldInForce<T> | null => {
    if (owner) return { value: owner.value, source: "owner", reason: null, setAt: owner.setAt };
    if (ai) return { value: ai.value, source: "ai", reason: ai.reason, setAt: ai.setAt };
    return null;
  };
  const caps: Record<ActionKind, PacingFieldInForce<number>> = {};
  const kinds = new Set([
    ...Object.keys(settings?.ai.caps ?? {}),
    ...Object.keys(settings?.owner.caps ?? {}),
  ]);
  for (const kind of [...kinds].sort()) {
    const cap = inForce(settings?.owner.caps[kind], settings?.ai.caps[kind]);
    if (cap) caps[kind] = cap;
  }
  return {
    minGapMinutes: inForce(settings?.owner.minGapMinutes, settings?.ai.minGapMinutes),
    activeHours: inForce(settings?.owner.activeHours, settings?.ai.activeHours),
    caps,
    disabled: Object.keys(caps).filter((kind) => caps[kind].value === 0),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The local calendar fields of an instant in `timezone`. */
export function localParts(timezone: string, ms: number) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, format);
  }
  const fields: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) fields[part.type] = part.value;
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
    weekday: fields.weekday,
  };
}
/** How far `timezone`'s local clock is ahead of UTC at the instant `ms`. */
function offsetAt(timezone: string, ms: number) {
  const local = localParts(timezone, ms);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}
/** The instant when the local clock in `timezone` reads y-m-d h:00 (`d` may run past the month's
 * end: Date.UTC carries it over), with the offset in force at that local time, not now: on the
 * day daylight saving ends in Los Angeles local 00:00 is 07:00Z but 09:00 is
 * 17:00Z, and the next midnight is 25 hours after this one. Day starts, the next midnight and
 * the window's start all go through here, never "midnight + h hours".
 * Each offset in force around that time (at the guess, at the guess moved by its offset, and a
 * day either side) gives a candidate; of those whose local time is the one asked for, the
 * earliest wins, so an hour the clock goes through twice is its first occurrence on either side
 * of UTC (00 is 08:00Z in PDT, Berlin 02:00 is 00:00Z in
 * CEST). An hour the clock jumps over (00, Santiago 00:00)
 * has no such candidate; it is the first instant after the jump (03:00 PDT, 01:00 CLST), never
 * the hour before it. */
export function localInstant(timezone: string, y: number, m: number, d: number, h: number) {
  const guess = Date.UTC(y, m - 1, d, h);
  const wanted = new Date(guess);
  const first = offsetAt(timezone, guess);
  const instant = guess - first;
  const second = offsetAt(timezone, instant);
  const offsets = new Set([
    first,
    second,
    offsetAt(timezone, guess - 86400000),
    offsetAt(timezone, guess + 86400000),
  ]);
  const matches = [...offsets]
    .map((offset) => guess - offset)
    .filter((candidate) => {
      const local = localParts(timezone, candidate);
      return (
        local.year === wanted.getUTCFullYear() &&
        local.month === wanted.getUTCMonth() + 1 &&
        local.day === wanted.getUTCDate() &&
        local.hour === wanted.getUTCHours() &&
        local.minute === 0
      );
    });
  if (matches.length) return Math.min(...matches);
  // Skipped: the later of the two passes, which is the end of the jump.
  return Math.max(instant, guess - second);
}

export interface PacingInput {
  effective: PacingEffective;
  timezone: string;
  timezoneSource: PacingStatus["timezoneSource"];
  timezoneReason: PacingStatus["timezoneReason"];
  /** The ledger rows of the last 30 days, any order. */
  actions: Pick<AccountAction, "site" | "action" | "at">[];
  /** Runs in progress on the account (this one's included). */
  claims: PacingClaim[];
  /** The run asking; null for the account card (no run of its own, so it yields to nobody). */
  taskId: string | null;
  now: Date;
  /** A claim older than this is a leftover of a killed process and ignored. */
  staleAfterMinutes: number;
  /** What tasks recorded about the account, per site. */
  profiles?: Record<string, SiteProfile>;
  /** The accounts on the same proxy exit; an account card or a test may leave it out. */
  sameExit?: SameExitAccounts;
  /** The project's other accounts (v0.6); left out, none. */
  siblings?: SiblingAccount[];
}
const two = (n: number) => String(n).padStart(2, "0");
const noExit: SameExitAccounts = { exit: null, exitUnreadable: false, accounts: [] };
/** The key of earliestNext for a kind without a cap of its own. */
export const anyKind = "*";
/** The window of `usedLast7Days`, the siblings' recent actions and the chat's recentActions. */
export const recentWindowMs = 7 * 86400000;
/** On a task bound to an
 * account, a wait_until with no action recorded this run, after a run that waited the same way
 * (`state.waits`), that is not the account's pacing, names no `blocked` and has no instruction or
 * job waiting (the run would start again at once), is refused once per run with these words
 * (service.ts emptyWaitCheck). The second one goes through: waits still have no limit, and the
 * person is never asked. The refusal is a status event, not a failure of the tool. */
export const emptyWaitRefusedLabel = "Wait refused: nothing done this run";
/** A reported action whose word is a look, not a deed, is
 * not what the refusal asks for. */
export const lookOnlyPattern =
  /^(explore|exploring|browse|browsing|check|checked|checking|read|reading|look|looked|looking|review|reviewed|research|researched|search|searched|scan|scanned|visit|visited|view|viewed|inspect|inspected|monitor|monitored|observe|observed|patrol|patrolled|watch|watched|survey|surveyed|巡检|浏览|查看|观察)$/i;
export function lookOnly(action: string | undefined | null): boolean {
  return !!action && lookOnlyPattern.test(action.trim());
}
export function emptyWaitRefusal(latestActionAt: string | null) {
  return `Nothing was recorded on this account this run, and the run before waited the same way${
    latestActionAt
      ? ` (the account's latest action: ${latestActionAt})`
      : " (no action on its ledger yet)"
  }. Waiting is not what this run does, and a look (explore, check, browse) is not an action. Open one place your plan names, find one item that recentActions does not list, and act there now (a reply, a comment, a post), reporting it with report_to_user; when something outside you stops that, wait_until again with blocked naming it.`;
}
/** The facts about an account at `input.now`, and what the set fields say about
 * when each capped kind (and any other kind, `*`) may be done next. Pure: the caller loads the
 * rows. Only set fields constrain anything: without a gap and a window, `*` has no earliestNext;
 * a kind without a cap counts as `*`. */
export function pacingStatus(input: PacingInput): PacingStatus {
  const { effective, timezone } = input;
  const now = input.now.getTime();
  const today = localParts(timezone, now);
  const dayStart = localInstant(timezone, today.year, today.month, today.day, 0);
  const weekStart = now - recentWindowMs;
  const usedToday: Record<ActionKind, number> = {};
  const usedLast7Days: Record<ActionKind, number> = {};
  // The gap runs from the last action whenever it was (an action at 23:59 still spaces one at
  // 00:01); only the daily counts start at the local midnight.
  let last: number | null = null;
  for (const row of input.actions) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    // A look starts no gap.
    if (last === null || at > last) if (!lookOnly(row.action)) last = at;
    const kind = kindOfRow(row);
    if (at >= weekStart) usedLast7Days[kind] = (usedLast7Days[kind] ?? 0) + 1;
    if (at >= dayStart) usedToday[kind] = (usedToday[kind] ?? 0) + 1;
  }
  const remainingToday: Record<ActionKind, number> = {};
  for (const [kind, cap] of Object.entries(effective.caps))
    remainingToday[kind] = Math.max(0, cap.value - (usedToday[kind] ?? 0));
  // Concurrent runs on one account: the later one (by start, then task id) leaves a gap after
  // now, so two runs that start together do not both see an unused account. Without a set gap
  // there is no gap to leave.
  const fresh = now - input.staleAfterMinutes * 60000;
  const live = input.claims.filter((claim) => Date.parse(claim.since) >= fresh);
  const own = input.taskId === null ? null : live.find((claim) => claim.id === input.taskId);
  const peers = live
    .filter((claim) => claim.id !== input.taskId)
    .map((claim) => ({ taskId: claim.id, since: claim.since }))
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.taskId.localeCompare(b.taskId));
  const earlier = (peer: { taskId: string; since: string }) => {
    if (!own) return true;
    const delta = Date.parse(peer.since) - Date.parse(own.since);
    return delta < 0 || (delta === 0 && peer.taskId < own.id);
  };
  const yieldToPeer = input.taskId !== null && peers.some(earlier);
  const gap = effective.minGapMinutes ? effective.minGapMinutes.value * 60000 : null;
  const window = effective.activeHours?.value ?? null;
  const next = (kind: ActionKind) => {
    let t = now;
    if (gap !== null && last !== null) t = Math.max(t, last + gap);
    if (gap !== null && yieldToPeer) t = Math.max(t, now + gap);
    if (remainingToday[kind] === 0)
      t = Math.max(t, localInstant(timezone, today.year, today.month, today.day + 1, 0));
    if (window) {
      const [start, end] = window;
      const local = localParts(timezone, t);
      if (local.hour < start) t = localInstant(timezone, local.year, local.month, local.day, start);
      else if (local.hour >= end)
        t = localInstant(timezone, local.year, local.month, local.day + 1, start);
    }
    return t;
  };
  const earliestNext: Record<string, string> = {};
  const minutesUntilNext: Record<string, number> = {};
  const kinds = [
    ...Object.keys(effective.caps).filter((kind) => !effective.disabled.includes(kind)),
    ...(gap !== null || window !== null ? [anyKind] : []),
  ];
  for (const kind of kinds) {
    const t = next(kind);
    earliestNext[kind] = new Date(t).toISOString();
    minutesUntilNext[kind] = Math.max(0, Math.ceil((t - now) / 60000));
  }
  return {
    timezone,
    timezoneSource: input.timezoneSource,
    timezoneReason: input.timezoneReason,
    localNow: `${today.weekday} ${two(today.hour)}:${two(today.minute)}`,
    now: input.now.toISOString(),
    profiles: input.profiles ?? {},
    usedToday,
    usedLast7Days,
    lastActionAt: last === null ? null : new Date(last).toISOString(),
    sameExit: input.sameExit ?? noExit,
    siblings: input.siblings ?? [],
    set: {
      minGapMinutes: effective.minGapMinutes,
      activeHours: effective.activeHours,
      caps: { ...effective.caps },
      disabled: [...effective.disabled],
    },
    disabled: [...effective.disabled],
    remainingToday,
    inActiveHours: window ? window[0] <= today.hour && today.hour < window[1] : null,
    earliestNext,
    minutesUntilNext,
    peers,
  };
}

/** Whether a wait_until of `minutes` is the account's pacing: it matches some constrained
 * kind's time to next action m > 0, from one minute under (rounding) to 30 minutes over (the
 * model's number is from the start of the run or its last report, and the server's shrinks
 * while the run works), capped at 1440; or it is a full day towards a kind that is more than a
 * day away. With nothing set there is nothing to match. */
export function isPacingWait(minutes: number, status: Pick<PacingStatus, "minutesUntilNext">) {
  return Object.values(status.minutesUntilNext).some(
    (m) =>
      typeof m === "number" &&
      m > 0 &&
      ((minutes >= m - 1 && minutes <= Math.min(1440, m + 30)) || (minutes === 1440 && m > 1440)),
  );
}

/** The account's time zone, and why: the account's own, else the desktop template's (what the
 * desktop's clock reads), also when the saved settings cannot be read. Never reads a secret. */
export async function pacingTimezone(
  settings: Pick<ComputerSettings, "endpoint">,
  ledgerOwner: string,
): Promise<Pick<PacingInput, "timezone" | "timezoneSource" | "timezoneReason">> {
  const template = (reason: "unset" | "unreadable") => ({
    timezone: templateTimezone,
    timezoneSource: "template" as const,
    timezoneReason: reason,
  });
  try {
    const endpoint = await settings.endpoint(ledgerOwner);
    if (endpoint.timezone) {
      localParts(endpoint.timezone, Date.now()); // a zone this runtime cannot use is unreadable
      return {
        timezone: endpoint.timezone,
        timezoneSource: "environment",
        timezoneReason: "environment",
      };
    }
    return template(endpoint.localeUnreadable ? "unreadable" : "unset");
  } catch {
    // A missing TOKEN_ENCRYPTION_KEY or a zone Intl refuses.
    return template("unreadable");
  }
}

/** The time of the latest action on a ledger, or null. */
export function lastActionOf(rows: Pick<AccountAction, "at">[]): string | null {
  let last: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last === null ? null : new Date(last).toISOString();
}
/** Who knows which other accounts leave through this account's exit, and which are the other
 * accounts of its project: the environment service (environments.ts imports this module, so it
 * is passed in). */
export interface ExitPeersSource {
  exitPeers(ledgerOwner: string): Promise<{
    exit: string | null;
    exitUnreadable: boolean;
    peers: { name: string; ledgerOwner: string }[];
  }>;
  /** The other live accounts of the account's project, with the user names they are known by. */
  siblings?(ledgerOwner: string): Promise<SiblingRecord[]>;
}
export interface SiblingRecord {
  name: string;
  ledgerOwner: string;
  identities: SiblingAccount["identities"];
}
/** The project's other accounts with what each did over the
 * window of `usedLast7Days` (addresses and times, never the text), whether a run is on it now
 * (a fresh claim) and whether it shares this account's exit. Only the project's own accounts:
 * another project's are never named or counted. */
export async function siblingFacts(
  db: Store,
  records: SiblingRecord[],
  sameExit: SameExitAccounts,
  now: Date,
  staleAfterMinutes: number,
): Promise<SiblingAccount[]> {
  const since = now.getTime() - recentWindowMs;
  const fresh = now.getTime() - staleAfterMinutes * 60000;
  const exitNames = new Set(sameExit.accounts.map((account) => account.name));
  return Promise.all(
    records.map(async (record) => {
      const [rows, claims] = await Promise.all([
        db.list<AccountAction>(record.ledgerOwner, accountActionsKind),
        db.list<PacingClaim>(record.ledgerOwner, pacingClaimsKind),
      ]);
      const recent = rows
        .filter((row) => Date.parse(row.at) >= since)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((row) => ({
          site: row.site ?? null,
          action: row.action,
          permalink: row.permalink ?? null,
          target: row.target ?? null,
          at: row.at,
          jobId: row.jobId ?? null,
        }));
      return {
        name: record.name,
        identities: record.identities,
        runningNow: claims.some((claim) => Date.parse(claim.since) >= fresh),
        sameExit: exitNames.has(record.name),
        lastActionAt: lastActionOf(rows),
        recent,
      };
    }),
  );
}
/** The accounts on the same exit with their last action, each from its own ledger. */
export async function sameExitFacts(
  db: Store,
  source: ExitPeersSource | undefined,
  ledgerOwner: string,
): Promise<SameExitAccounts> {
  if (!source) return noExit;
  const { exit, exitUnreadable, peers } = await source.exitPeers(ledgerOwner);
  const accounts = await Promise.all(
    peers.map(async (peer) => ({
      name: peer.name,
      lastActionAt: lastActionOf(
        await db.list<AccountAction>(peer.ledgerOwner, accountActionsKind),
      ),
    })),
  );
  return { exit, exitUnreadable, accounts };
}

/** Settings, what is in force and the facts of one account now; `taskId` is the run asking
 * (null for the account card). */
export async function loadPacing(
  db: Store,
  settingsStore: Pick<ComputerSettings, "endpoint">,
  config: Config,
  ledgerOwner: string,
  taskId: string | null,
  now = new Date(),
  exits?: ExitPeersSource,
) {
  const settings = await readPacingSettings(db, ledgerOwner);
  const effective = effectivePacing(settings);
  const [zone, actions, claims, profiles, sameExit] = await Promise.all([
    pacingTimezone(settingsStore, ledgerOwner),
    db.list<AccountAction>(ledgerOwner, accountActionsKind),
    db.list<PacingClaim>(ledgerOwner, pacingClaimsKind),
    readProfiles(db, ledgerOwner),
    sameExitFacts(db, exits, ledgerOwner),
  ]);
  const staleAfterMinutes = (config.agentRunMaxMinutes ?? runMaxMinutesDefault) + 5;
  const siblings = await siblingFacts(
    db,
    (await exits?.siblings?.(ledgerOwner)) ?? [],
    sameExit,
    now,
    staleAfterMinutes,
  );
  const status = pacingStatus({
    effective,
    ...zone,
    actions,
    claims,
    taskId,
    now,
    staleAfterMinutes,
    profiles,
    sameExit,
    siblings,
  });
  return { settings, effective, status };
}

/** What tasks recorded about the account, by site; the record written before profiles were per
 * site reads as pacing-legacy.ts says. */
export async function readProfiles(
  db: Store,
  ledgerOwner: string,
): Promise<Record<string, SiteProfile>> {
  const rows = await db.list<StoredSiteProfile | LegacyProfile>(ledgerOwner, accountProfileKind);
  const profiles: Record<string, SiteProfile> = {};
  for (const row of rows) {
    if (isLegacyProfile(row)) {
      if (!profiles[legacySite])
        profiles[legacySite] = { facts: legacyProfileFacts(row), recordedAt: row.recordedAt };
    } else if ("site" in row && row.facts)
      profiles[row.site] = { facts: { ...row.facts }, recordedAt: row.recordedAt };
  }
  return profiles;
}
/** Records what a task read about the account on `site` (record_account_profile). */
export async function writeProfile(
  db: Store,
  ledgerOwner: string,
  profile: Omit<StoredSiteProfile, "id">,
) {
  await db.put<StoredSiteProfile>(ledgerOwner, accountProfileKind, {
    id: profile.site,
    ...profile,
  });
}

/** A link as the ledger compares it: https, the host in lower case, no fragment, no trailing
 * slash; the path and query exactly as given. Null for something that is not a URL. No site is
 * known here: two hosts are two hosts. */
export function normalizeLink(link: string): string | null {
  try {
    const url = new URL(link);
    if (!url.hostname) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `https://${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
  } catch {
    return null;
  }
}
/** An address as it tells one item from another on the ledger: `normalizeLink`, with the
 * fragment kept when there is one (fork, report evidence: a reply that only its fragment tells
 * apart, `#comment-2`, and a page a single-page site routes by its fragment, `#/post/9`, are
 * items of their own; keyed without it, two replies under one post were one row and the second
 * went uncounted). A text fragment the browser adds to point at words (`#:~:text=`) is no part
 * of it. `normalizeLink` itself still drops the fragment: comparing what was acted on with what
 * another account made (accounts/operating.ts) reads a thread and its replies as one place. */
export function itemLink(link: string): string | null {
  const base = normalizeLink(link);
  if (!base) return null;
  const fragment = new URL(link).hash.replace(/:~:.*$/, "");
  return fragment && fragment !== "#" ? `${base}${fragment}` : base;
}
/** What tells one recorded action from another (hashed into the ledger row's id): the account,
 * the site, the action, and the address that tells the action apart when the report gave one
 * (`itemLink`; chat-reports.ts `reportEvidence`), else the report's text with its whitespace
 * collapsed. An item's address keys alone (one item is one action, however the sentence reads);
 * what an action without text was done to keys with the sentence (`withText`: two profile edits
 * on the account's page, or the same words for likes on two comments, are two actions). Never a
 * run or resume count, so an action reported again after a resume stays one row. */
export function ledgerKey(
  ledgerOwner: string,
  site: string,
  action: string,
  address: string | undefined,
  text: string,
  withText = false,
) {
  const link = address ? itemLink(address) : null;
  const words = text.trim().replace(/\s+/g, " ");
  return `${ledgerOwner}:${site}:${action}:${link ? (withText ? `${link} ${words}` : link) : words}`;
}
/** The reference a not-confirmed report's
 * answer gives for its ledger row, which the report of the same action with its address names in
 * `confirms`: the start of the row's id (a hash, nothing it says). */
export const confirmsRef = (rowId: string) => rowId.slice(0, 12);
/** Whether an action of `kind`, done at the status's moment, went past what is set for the
 * account: its cap with nothing left today (a cap of 0 included), or a set field whose earliest
 * time for that kind (or, without a cap of its own, for any kind) has not come. With nothing set
 * for it, nothing was exceeded. */
export function exceedsPacing(status: PacingStatus, kind: ActionKind, now: number) {
  if (status.remainingToday[kind] === 0) return true;
  const earliest = status.earliestNext[kind] ?? status.earliestNext[anyKind];
  return earliest !== undefined && now < Date.parse(earliest);
}
