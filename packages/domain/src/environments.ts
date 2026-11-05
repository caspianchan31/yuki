/**
 * Members (environments, fork feature): one member may have a desktop of her own, with its own
 * time zone, language and browser profile, signed in to any number of sites (its site logins
 * are credentials of its project, docs/credentials.md). Pure types and helpers shared by the
 * server and the mobile app; no runtime dependencies beyond Intl.
 */
import type { SiteLoginView, SiteSignInFact } from "./credentials.ts";
import type { MemberFace } from "./member-face.ts";
export type EnvironmentStatus = "missing" | "stopped" | "running" | "error";

export interface Environment {
  id: string;
  name: string;
  /** Optional non-secret note the owner keeps about the account. */
  accountLabel: string | null;
  /** The project this account is assigned to; null is unassigned (usable in the default
   * project only). Accounts are global: the assignment moves nothing else. */
  projectId: string | null;
  /** Set while the desktop and records are being destroyed; the environment is unusable. */
  deleting: boolean;
  /** The space's founder, one per space, in no project; every
   * project may give it jobs and every project's tasks read its persona. */
  founder?: boolean;
  /** v1.2: the shape and color the owner picked for the member; absent: the web app picks one
   * from the name. */
  face?: MemberFace;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the server's ComputerSettingsView: the desktop's time zone and language. */
export interface EnvironmentSettingsView {
  timezone: string | null;
  locale: string | null;
  updatedAt: string | null;
  /** The time zone and language can't be read: the owner enters them again. */
  localeUnreadable?: boolean;
}

/** A kind of action is the site and the
 * action the AI names when it reports what it did, `<site>/<action>`, e.g. `example.com/comment`
 * or `x.com/post`. Nothing here lists sites or actions: they are data. */
export type ActionKind = string;
/** `<registrable domain>/<short lower-case word>`. */
export const actionKindPattern = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+\/[a-z][a-z0-9_-]*$/;
export const actionKindOf = (site: string, action: string) => `${site}/${action}`;
/** The pacing fields of an account. Each is set by the task that runs on the account
 * (set_account_pacing, source "ai", with its reason) or by the person by hand (PATCH
 * /api/environments/:id { pacing }, source "owner"); a person's value is in force over the
 * task's, field by field and, for the caps, kind by kind. An unset field is a fact: nothing is
 * enforced for it, and nothing fills it in. */
export type PacingFieldName = "minGapMinutes" | "activeHours" | "caps";
export const pacingFieldNames: readonly PacingFieldName[] = [
  "minGapMinutes",
  "activeHours",
  "caps",
];
export type PacingSource = "owner" | "ai";
/** minGapMinutes: minutes between two actions of any kind; activeHours: local hours [start,
 * end) in the account's time zone, 0 <= start < end <= 24; caps: actions of a kind per local
 * day (0 turns that kind off). */
export interface PacingValues {
  minGapMinutes: number;
  activeHours: [number, number];
}
/** A field the person set by hand. */
export interface PacingOwnerField<T> {
  value: T;
  setAt: string;
}
/** A field the task set, with the reason it gave. */
export interface PacingAiField<T> {
  value: T;
  reason: string;
  setAt: string;
}
export interface PacingOwnerLayer {
  minGapMinutes: PacingOwnerField<number> | null;
  activeHours: PacingOwnerField<[number, number]> | null;
  caps: Record<ActionKind, PacingOwnerField<number>>;
}
export interface PacingAiLayer {
  minGapMinutes: PacingAiField<number> | null;
  activeHours: PacingAiField<[number, number]> | null;
  caps: Record<ActionKind, PacingAiField<number>>;
}
/** The account's saved pacing: what the person set and what the task set, field by field. */
export interface PacingSettings {
  owner: PacingOwnerLayer;
  ai: PacingAiLayer;
  /** Null until either layer was first written. */
  updatedAt: string | null;
}
/** One field as it is in force: the person's value over the task's, with who set it and why. */
export interface PacingFieldInForce<T> {
  value: T;
  source: PacingSource;
  /** The task's reason; null for a field the person set. */
  reason: string | null;
  setAt: string;
}
/** What is in force now; null is unset, which enforces nothing for that field. `caps` holds
 * only the kinds that have one; `disabled`: the kinds whose cap is 0. */
export interface PacingEffective {
  minGapMinutes: PacingFieldInForce<number> | null;
  activeHours: PacingFieldInForce<[number, number]> | null;
  caps: Record<ActionKind, PacingFieldInForce<number>>;
  disabled: ActionKind[];
}
/** Facts about the account on one site, as a task read them there (record_account_profile):
 * free-form keys and values, kept as written. */
export interface SiteProfile {
  facts: Record<string, string | number | boolean>;
  recordedAt: string;
}
/** Another live account of the same project, as the facts
 * show it: the user names it is known by (`site` null: its name or account label, any site),
 * whether a run is on it now, and what it did over the same window as `usedLast7Days` (addresses
 * and times only, never what it wrote). */
export interface SiblingAccount {
  name: string;
  identities: { site: string | null; username: string }[];
  runningNow: boolean;
  lastActionAt: string | null;
  recent: {
    site: string | null;
    action: string;
    permalink: string | null;
    target: string | null;
    at: string;
    jobId: string | null;
  }[];
}
/** The facts the server puts in front of a run of a task bound to the account, computed at one
 * moment: also returned by report_to_user and shown on the account card. Nothing in it is
 * advice: the account's recorded facts per site, its recent actions by kind, what is set (by
 * whom and why), the local time, and what the set fields say about now. A kind is
 * `<site>/<action>`; `*` stands for any kind without a cap of its own. */
export interface PacingStatus {
  timezone: string;
  /** The account's own zone, or the desktop template's zone when the account sets none. */
  timezoneSource: "environment" | "template";
  /** Why: the account's own zone, none set, or saved settings this server's key can't read. */
  timezoneReason: "environment" | "unset" | "unreadable";
  /** Local weekday and time, e.g. "Fri 10:05". */
  localNow: string;
  /** The moment the facts were computed, ISO. */
  now: string;
  /** What tasks recorded about the account, per site. */
  profiles: Record<string, SiteProfile>;
  /** Reported actions per kind, today (local) and over the last 7 days. */
  usedToday: Record<ActionKind, number>;
  usedLast7Days: Record<ActionKind, number>;
  lastActionAt: string | null;
  /** The project's other accounts and what they did recently. */
  siblings: SiblingAccount[];
  /** What is in force, field by field (null = unset), with its source and reason. */
  set: PacingEffective;
  disabled: ActionKind[];
  /** What is left today of each kind that has a cap; a kind without one is left out. */
  remainingToday: Record<ActionKind, number>;
  /** Whether the local time is inside the set window; null when no window is set. */
  inActiveHours: boolean | null;
  /** When each capped kind, and `*` (any other kind), may be done next (ISO), from the set
   * fields only: a disabled kind is left out, and so is `*` when no gap and no window is set. */
  earliestNext: Record<string, string>;
  /** Whole minutes from now to earliestNext; may exceed 1440. Same keys as earliestNext. */
  minutesUntilNext: Record<string, number>;
  /** Other runs on this account in progress now. */
  peers: { taskId: string; since: string }[];
}
export interface EnvironmentPacing {
  settings: PacingSettings;
  effective: PacingEffective;
  status: PacingStatus;
}
/** The local hours a window can name. */
export const activeHourRange = [0, 24] as const;

export interface EnvironmentView extends Environment {
  status: EnvironmentStatus;
  /** Present when status is "error". */
  message?: string;
  /** False when the server has no computer connected (未接电脑): the member has no desktop, and
   * nothing about one (its state, settings) is shown. Absent from older servers. */
  computer?: boolean;
  settings: EnvironmentSettingsView;
  /** Always sent by the server; optional only for views a client builds itself. */
  pacing?: EnvironmentPacing;
  /** The account's site logins (never a value) and the sign-in facts the AI recorded per site.
   * Always sent by the server; optional for views a client builds itself. */
  siteLogins?: SiteLoginView[];
  signIns?: SiteSignInFact[];
  /** Whether the account has something to work on: a long-term goal, or a
   * job given to it that is not over (AccountLoops.wanted, the rule its standing loop follows).
   * False: nothing makes it act; an account of a project (or the founder) with no live task then
   * reads 没在经营 and is one 需要你 item. Absent when the server does not say (an older server,
   * a view a client builds itself, the unassigned list a project picks from). */
  hasWork?: boolean;
}

export interface EnvironmentRef {
  id: string;
  name: string;
  accountLabel?: string | null;
}

/** A conversation's active environment: null = the default desktop; stale = it was deleted. */
export interface EnvironmentSelection {
  environmentId: string | null;
  name: string | null;
  stale: boolean;
}

export const environmentNameMax = 64;
export const environmentAccountLabelMax = 64;
export const environmentsMax = 20;
/** Reserved for the default desktop, which is not an environment record. */
export const defaultEnvironmentName = "default";

export function normalizeEnvironmentName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedEnvironmentName(name: string): boolean {
  return normalizeEnvironmentName(name) === defaultEnvironmentName;
}

// Area/Location[/Sub] with the characters zoneinfo file names use; no dots, no leading slash.
const timezoneSyntax = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
let timezoneCache: { list: string[]; byLower: Map<string, string> } | null = null;

function timezones() {
  if (!timezoneCache) {
    let supported: string[] = [];
    try {
      supported = Intl.supportedValuesOf("timeZone");
    } catch {
      supported = [];
    }
    // ICU omits the bare "UTC" aliases that the template's zoneinfo check accepts.
    const list = Array.from(new Set([...supported, "UTC", "Etc/UTC"])).sort();
    timezoneCache = { list, byLower: new Map(list.map((zone) => [zone.toLowerCase(), zone])) };
  }
  return timezoneCache;
}

/** ICU canonical zone names plus UTC/Etc/UTC, sorted. */
export function supportedTimezones(): string[] {
  return timezones().list;
}

/** Case-insensitive match against supportedTimezones(); returns the canonical spelling or null. */
export function canonicalTimezone(input: string): string | null {
  const value = input.trim();
  if (!timezoneSyntax.test(value)) return null;
  return timezones().byLower.get(value.toLowerCase()) ?? null;
}

const localePattern = /^[a-z]{2,3}-[A-Z]{2}$/;

/** "en_us" / "en-us" -> "en-US"; anything that is not language-REGION returns null. */
export function canonicalLocale(input: string): string | null {
  const raw = input.trim().replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2}$/.test(raw)) return null;
  let value = "";
  try {
    value = Intl.getCanonicalLocales(raw)[0] ?? "";
  } catch {
    value = "";
  }
  if (!localePattern.test(value)) {
    const [language, region] = raw.split("-");
    value = `${language.toLowerCase()}-${region.toUpperCase()}`;
  }
  return localePattern.test(value) ? value : null;
}

/** Prefix matches first, then substring matches, for a type-ahead picker. */
export function timezoneCandidates(query: string, limit = 8): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const list = supportedTimezones();
  const starts = list.filter((zone) => zone.toLowerCase().startsWith(needle));
  const contains = list.filter(
    (zone) => !zone.toLowerCase().startsWith(needle) && zone.toLowerCase().includes(needle),
  );
  return [...starts, ...contains].slice(0, limit);
}
