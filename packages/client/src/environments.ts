/**
 * Isolation environments (fork feature): pure logic for the mobile app. One account is one
 * identity: an isolated cloud desktop with its own proxy, time zone, language and browser
 * profile, signed in to any number of sites with its saved logins (credentials).
 * This file must stay free of react-native so the node:test suite can import it.
 *
 * HTTP contract (all under /api/environments, same auth as the rest of /api):
 *   GET    /api/environments                         EnvironmentView[] (503 without environments);
 *                                                    fork (projects): the current project's only
 *   GET    /api/environments/unassigned              EnvironmentView[] with projectId null; [] in
 *                                                    the default project
 *   POST   /api/environments                         CreateEnvironmentBody -> 201 EnvironmentView
 *   GET    /api/environments/:id                     EnvironmentView
 *   PATCH  /api/environments/:id                     EnvironmentPatch -> EnvironmentView
 *   DELETE /api/environments/:id                     204
 *   GET    /api/environments/conversation/:threadId  EnvironmentSelection
 *   PUT    /api/environments/conversation/:threadId  { environmentId } -> EnvironmentSelection
 *   *      /api/environments/:id/computer/*          the whole /api/computer route set, scoped
 */

import {
  type BrowserCheck,
  browserCheckStatuses,
  type CredentialResult,
  type ProxyCheck,
  type SiteLoginView,
  type SiteSignInFact,
} from "../../../packages/domain/src/credentials.ts";
import {
  canonicalLocale,
  canonicalTimezone,
  defaultEnvironmentName,
  type EnvironmentRef,
  type EnvironmentSelection,
  type EnvironmentSettingsView,
  type EnvironmentStatus,
  type EnvironmentView,
  environmentAccountLabelMax,
  environmentNameMax,
  isReservedEnvironmentName,
  timezoneCandidates,
} from "../../../packages/domain/src/environments.ts";
import { parseMemberFace } from "../../../packages/domain/src/member-face.ts";
import { ApiError } from "./api-response.ts";
import { settingsError } from "./computer-settings.ts";

export type {
  EnvironmentRef,
  EnvironmentSelection,
  EnvironmentSettingsView,
  EnvironmentStatus,
  EnvironmentView,
};
export { canonicalLocale, canonicalTimezone, timezoneCandidates };

/** A site login given with a new account; the values are sent once and
 * never shown back. */
export interface SiteLoginBody {
  site: string;
  username?: string;
  password?: string;
  totpSeed?: string;
  cookies?: string;
}
/** POST /api/environments. The proxy is one of the project's or a new one; without either, the
 * account's desktop takes an exit from the platform's pool when it first starts (v1.1, exits). */
export interface CreateEnvironmentBody {
  name: string;
  accountLabel?: string;
  proxyUrl?: string;
  proxyId?: string;
  timezone?: string;
  locale?: string;
  siteLogins?: SiteLoginBody[];
}
/**
 * PATCH /api/environments/:id. `accountLabel: null` clears the label.
 * `projectId` set to the current project adds an unassigned account to it; null returns one of
 * the current project's accounts to unassigned (anything else is a 409).
 */
export interface EnvironmentPatch {
  name?: string;
  accountLabel?: string | null;
  projectId?: string | null;
  /** Which of the project's entries the account uses. */
  proxyId?: string;
}
/** PUT /api/environments/:id/computer/settings: omitted = unchanged, null = clear, string = set. */
export interface EnvironmentSettingsUpdate {
  proxyUrl?: string | null;
  timezone?: string | null;
  locale?: string | null;
}
/**
 * What the editor holds. Creating: a string per field (blank = not given). Editing: `undefined`
 * leaves the saved value alone, `null` clears it, a string replaces it; a blank string is
 * treated as untouched, so secret inputs that start empty never clear a saved secret.
 */
export interface EnvironmentForm {
  name?: string | null;
  accountLabel?: string | null;
  proxyUrl?: string | null;
  /** One of the project's proxies instead of a new URL. */
  proxyId?: string | null;
  siteLogins?: SiteLoginBody[];
  timezone?: string | null;
  locale?: string | null;
}
/** The two requests an edit may need; both are undefined when nothing changed. */
export interface EnvironmentEditPayload {
  patch?: EnvironmentPatch;
  settings?: EnvironmentSettingsUpdate;
}

/** The desktop that is not an environment record; used as a name, a key and a label. */
export const DEFAULT_DESKTOP_LABEL = "Default desktop";
export const DEFAULT_DRAFT_KEY = "default";
export const DEFAULT_LOCALE = "en-US";
/** Quick picks for the time zone field, in the order shown. */
export const QUICK_TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Shanghai",
  "UTC",
] as const;
export const TIMEZONE_HINT = "An IANA name such as America/Los_Angeles; the browser follows it.";
export const LOCALE_HINT = "Language and region such as en-US; the browser reports it.";
export const NO_PROXY_WARNING = "No proxy set. Add one before starting this desktop.";
export const DELETE_WARNING =
  "Deleting destroys this environment's desktop, its browser profile and every sign-in on it.";
export const DESTROY_WARNING =
  "Destroying the sandbox closes every app and drops the browser's sign-ins. Settings are kept.";
export const DELETED_SELECTION_NOTICE = "Environment deleted — pick one";
export const UNREADABLE_ENVIRONMENT_NOTICE =
  "Saved values can't be read with the server's current key. Enter the proxy, time zone and language again to replace them.";
export const ENVIRONMENTS_UNAVAILABLE = "Members are not available on this server.";

const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
function secret(value: unknown) {
  const { configured, preview } = record(value);
  return { configured: configured === true, preview: textOrNull(preview) };
}
const statuses: readonly EnvironmentStatus[] = ["missing", "stopped", "running", "error"];
/** How an entry went the last time, or null. */
export function normalizeResult(value: unknown): CredentialResult | null {
  const item = record(value);
  if (typeof item.status !== "string" || typeof item.at !== "string") return null;
  return {
    ok: item.ok === true,
    status: item.status,
    detail: textOrNull(item.detail),
    at: item.at,
  };
}
/** A site login as the account row shows it; never a value. */
export function normalizeSiteLogin(value: unknown): SiteLoginView | null {
  const item = record(value);
  if (typeof item.id !== "string" || typeof item.site !== "string") return null;
  return {
    id: item.id,
    site: item.site,
    username: textOrNull(item.username),
    password: item.password === true,
    totp: item.totp === true,
    cookies: item.cookies === true,
    lastResult: normalizeResult(item.lastResult),
    lastUsedAt: textOrNull(item.lastUsedAt),
    unreadable: item.unreadable === true,
  };
}
const signInWords = [
  "signed_in",
  "wrong_password",
  "needs_code",
  "suspended",
  "blocked",
  "no_login",
  // A check the AI could not pass: the owner finishes it on the desktop.
  "needs_owner",
  "other",
  "pending",
] as const;
/** What the AI recorded about one site, or null for anything unknown. */
export function normalizeSignInFact(value: unknown): SiteSignInFact | null {
  const item = record(value);
  const status = signInWords.find((word) => word === item.status);
  if (!status || typeof item.site !== "string" || typeof item.at !== "string") return null;
  const by = record(item.by);
  // The incident it was recorded with, for 「当时的画面」.
  const incident = record(item.incident);
  return {
    site: item.site,
    status,
    detail: textOrNull(item.detail),
    // The page's words the record quoted (「页面上写着：…」).
    ...(textOrNull(item.seen) ? { seen: textOrNull(item.seen) } : {}),
    at: item.at,
    by:
      typeof by.taskId === "string"
        ? { taskId: by.taskId }
        : typeof by.threadId === "string"
          ? { threadId: by.threadId }
          : { owner: true },
    ...(typeof incident.id === "string" && incident.id
      ? { incident: { id: incident.id, shot: incident.shot === true } }
      : {}),
    // The owner said he handled it; the AI is confirming it.
    ...(typeof item.ownerHandledAt === "string" && item.ownerHandledAt
      ? { ownerHandledAt: item.ownerHandledAt }
      : {}),
    ...(typeof item.ownerHandledAt === "string" &&
    item.ownerHandledAt &&
    item.ownerHandledStale === true
      ? { ownerHandledStale: true }
      : {}),
  };
}
const proxyStatuses = [
  "ok",
  "unreachable",
  "auth_rejected",
  "bad_setting",
  "handshake_failed",
  "missing",
  "pending",
] as const;
/** What the run last read on the bot-detection check page, or null. */
export function normalizeBrowserCheck(value: unknown): BrowserCheck | null {
  const item = record(value);
  const status = browserCheckStatuses.find((word) => word === item.status);
  if (!status || typeof item.at !== "string") return null;
  return {
    at: item.at,
    status,
    result: typeof item.result === "string" ? item.result : "",
    // The page's words the record quotes, and where.
    ...(typeof item.seen === "string" ? { seen: item.seen } : {}),
    ...(typeof item.url === "string" ? { url: item.url } : {}),
  };
}
/** The proxy's last self-check, or null. */
export function normalizeProxyCheck(value: unknown): ProxyCheck | null {
  const item = record(value);
  const proxy = proxyStatuses.find((word) => word === item.proxy);
  if (!proxy || typeof item.at !== "string") return null;
  const sites: Record<string, "ok" | "refused"> = {};
  for (const [site, state] of Object.entries(record(item.sites)))
    sites[site] = state === "ok" ? "ok" : "refused";
  return {
    at: item.at,
    proxy,
    sites,
    ...(item.pendingRestart === true ? { pendingRestart: true } : {}),
  };
}

/** Read an EnvironmentView defensively; an unknown status reads as an error with a message. */
export function normalizeEnvironment(value: unknown): EnvironmentView {
  const item = record(value);
  const settings = record(item.settings);
  const status = statuses.find((candidate) => candidate === item.status);
  const message = textOrNull(item.message) ?? (status ? null : "Unknown status");
  const face = parseMemberFace(item.face);
  return {
    id: text(item.id),
    name: text(item.name),
    accountLabel: textOrNull(item.accountLabel),
    projectId: textOrNull(item.projectId),
    deleting: item.deleting === true,
    // Only said when it is the space's founder.
    ...(item.founder === true ? { founder: true } : {}),
    ...(face ? { face } : {}),
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt),
    status: status ?? "error",
    ...(message ? { message } : {}),
    proxyConfigured: item.proxyConfigured === true,
    ...(item.computer === false ? { computer: false } : {}),
    settings: {
      proxy: secret(settings.proxy),
      timezone: textOrNull(settings.timezone),
      locale: textOrNull(settings.locale),
      updatedAt: textOrNull(settings.updatedAt),
      unreadable: settings.unreadable === true,
      localeUnreadable: settings.localeUnreadable === true,
    },
    // Absent when the server did not say (nothing is claimed).
    ...(Array.isArray(item.siteLogins)
      ? {
          siteLogins: item.siteLogins
            .map(normalizeSiteLogin)
            .filter((login): login is SiteLoginView => login !== null),
        }
      : {}),
    ...(Array.isArray(item.signIns)
      ? {
          signIns: item.signIns
            .map(normalizeSignInFact)
            .filter((fact): fact is SiteSignInFact => fact !== null),
        }
      : {}),
    ...("proxyCheck" in item ? { proxyCheck: normalizeProxyCheck(item.proxyCheck) } : {}),
    ...("browserCheck" in item ? { browserCheck: normalizeBrowserCheck(item.browserCheck) } : {}),
    ...(item.credentialIds && typeof item.credentialIds === "object"
      ? {
          credentialIds: {
            proxy: textOrNull(record(item.credentialIds).proxy),
          },
        }
      : {}),
    // Whether it has something to work on; absent when the server did not
    // say (then nothing reads it as not operating).
    ...(typeof item.hasWork === "boolean" ? { hasWork: item.hasWork } : {}),
  };
}
/** Read GET /api/environments: entries without an id are dropped; order is the server's. */
export function normalizeEnvironments(value: unknown): EnvironmentView[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeEnvironment)
    .filter((environment) => environment.id !== "");
}
/** Read a conversation selection; anything malformed reads as the default desktop. */
export function normalizeSelection(value: unknown): EnvironmentSelection {
  const item = record(value);
  return {
    environmentId: textOrNull(item.environmentId),
    name: textOrNull(item.name),
    stale: item.stale === true,
  };
}
/** The EnvironmentRef a view or selection stands for; null is the default desktop. */
export function environmentRef(
  value: Pick<EnvironmentView, "id" | "name" | "accountLabel"> | EnvironmentSelection | null,
): EnvironmentRef | null {
  if (!value) return null;
  if ("environmentId" in value) {
    return value.environmentId
      ? { id: value.environmentId, name: value.name ?? "Deleted environment" }
      : null;
  }
  return { id: value.id, name: value.name, accountLabel: value.accountLabel ?? null };
}
export function sameEnvironment(
  a: EnvironmentRef | null | undefined,
  b: EnvironmentRef | null | undefined,
) {
  return a === b || (a != null && b != null && a.id === b.id);
}

export function statusLabel(status: EnvironmentStatus): string {
  switch (status) {
    case "missing":
      return "Not created";
    case "stopped":
      return "Paused · sandbox kept";
    case "running":
      return "Running";
    default:
      return "Error";
  }
}
/** The name shown for a thread's desktop: the environment's, or the default desktop's. */
export function environmentTitle(environment: EnvironmentRef | null | undefined): string {
  return environment ? environment.name : DEFAULT_DESKTOP_LABEL;
}
/** The header pill: "Desktop: Default" or "Desktop: <name>". */
export function desktopLabel(environment: EnvironmentRef | null | undefined): string {
  return `Desktop: ${environment ? environment.name : "Default"}`;
}
/** One line under an environment's name: account, time zone, language and proxy state. */
export function environmentSummary(environment: EnvironmentView): string {
  const parts = [
    environment.accountLabel,
    environment.settings.timezone,
    environment.settings.locale,
    environment.settings.unreadable
      ? "settings unreadable"
      : environment.proxyConfigured
        ? "proxy set"
        : "no proxy",
  ];
  return parts.filter((part): part is string => !!part).join(" · ");
}

/** The ComputerDraftProvider bucket for a desktop: "default" or "env:<id>". */
export function environmentDraftKey(
  environment: Pick<EnvironmentRef, "id"> | string | null | undefined,
): string {
  const id = typeof environment === "string" ? environment : environment?.id;
  return id ? `env:${id}` : DEFAULT_DRAFT_KEY;
}
/** The Details sheet key for a desktop, so switching environments remounts the sheet. */
export function computerDetailKey(
  environment: Pick<EnvironmentRef, "id"> | string | null | undefined,
): string {
  return `computer:${environmentDraftKey(environment)}`;
}

const computerPath = /^\/api\/computer(?=\/|\?|$)/;
/**
 * Point a default-desktop computer call at an environment's desktop. Only paths under
 * /api/computer change; other API paths and absolute URLs pass through untouched.
 */
export function scopeComputerPath(path: string, environmentId: string | null | undefined): string {
  if (!environmentId) return path;
  return path.replace(
    computerPath,
    `/api/environments/${encodeURIComponent(environmentId)}/computer`,
  );
}

function validName(name: string): string | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required" };
  if (trimmed.length > environmentNameMax)
    return { error: `Name must be at most ${environmentNameMax} characters` };
  if (isReservedEnvironmentName(trimmed))
    return { error: `Name "${defaultEnvironmentName}" is reserved for the default desktop` };
  return trimmed;
}
function validLabel(label: string): string | { error: string } {
  const trimmed = label.trim();
  if (trimmed.length > environmentAccountLabelMax)
    return { error: `Account label must be at most ${environmentAccountLabelMax} characters` };
  return trimmed;
}
/**
 * The time zone as the server's list spells it: canonicalTimezone, or, for a valid IANA name
 * that ICU lists under another name (Asia/Kolkata is Asia/Calcutta there, Europe/Kyiv is
 * Europe/Kiev), that listed name, which the server accepts. The server keeps its own rule (the
 * ICU list); the client only spells the zone the way the list does. Area/Location names only;
 * null when unknown.
 */
export function listedTimezone(input: string): string | null {
  const canonical = canonicalTimezone(input);
  if (canonical) return canonical;
  const value = input.trim();
  if (!value.includes("/")) return null;
  try {
    return canonicalTimezone(
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone,
    );
  } catch {
    return null;
  }
}
function validTimezone(value: string): string | { error: string } {
  const canonical = listedTimezone(value);
  return (
    canonical ?? {
      error: `Unknown time zone "${value.trim()}". Use an IANA name such as America/Los_Angeles`,
    }
  );
}
function validLocale(value: string): string | { error: string } {
  const canonical = canonicalLocale(value);
  return canonical ?? { error: `Unknown language "${value.trim()}". Use a form such as en-US` };
}
const failed = (value: string | { error: string }): value is { error: string } =>
  typeof value !== "string";
/** A string with content, or undefined for null/undefined/blank. */
const given = (value: string | null | undefined) =>
  typeof value === "string" && value.trim() ? value : undefined;

/**
 * Build the request bodies for the environment editor.
 * - "create": name and proxy URL are required; blank optional fields are omitted; time zone
 *   and language are canonicalised (america/los_angeles -> America/Los_Angeles, en-us -> en-US).
 * - "edit": per field, undefined or blank = unchanged, null = clear, string = set. The name and
 *   account label go to PATCH /api/environments/:id, the rest to PUT .../computer/settings.
 *   The name can't be cleared.
 */
export function environmentPayload(
  form: EnvironmentForm,
  mode?: "create",
): { create: CreateEnvironmentBody } | { error: string };
export function environmentPayload(
  form: EnvironmentForm,
  mode: "edit",
): EnvironmentEditPayload | { error: string };
export function environmentPayload(
  form: EnvironmentForm,
  mode: "create" | "edit" = "create",
): { create: CreateEnvironmentBody } | EnvironmentEditPayload | { error: string } {
  if (mode === "create") {
    const name = validName(form.name ?? "");
    if (failed(name)) return name;
    const proxyUrl = given(form.proxyUrl)?.trim();
    const proxyId = given(form.proxyId)?.trim();
    if (!proxyUrl && !proxyId) return { error: "Proxy URL is required" };
    const create: CreateEnvironmentBody = proxyId ? { name, proxyId } : { name, proxyUrl };
    const label = validLabel(form.accountLabel ?? "");
    if (failed(label)) return label;
    if (label) create.accountLabel = label;
    if (form.siteLogins?.length) create.siteLogins = form.siteLogins;
    const timezone = given(form.timezone);
    if (timezone) {
      const value = validTimezone(timezone);
      if (failed(value)) return value;
      create.timezone = value;
    }
    const locale = given(form.locale);
    if (locale) {
      const value = validLocale(locale);
      if (failed(value)) return value;
      create.locale = value;
    }
    return { create };
  }
  const patch: EnvironmentPatch = {};
  const settings: EnvironmentSettingsUpdate = {};
  if (form.name === null) return { error: "Name can't be cleared" };
  if (given(form.name) !== undefined) {
    const name = validName(form.name ?? "");
    if (failed(name)) return name;
    patch.name = name;
  }
  if (form.accountLabel === null) patch.accountLabel = null;
  else if (given(form.accountLabel) !== undefined) {
    const label = validLabel(form.accountLabel ?? "");
    if (failed(label)) return label;
    patch.accountLabel = label;
  }
  // Which entries the account uses (null: none).
  if (given(form.proxyId)) patch.proxyId = form.proxyId as string;
  const proxyUrl = given(form.proxyUrl);
  if (form.proxyUrl === null) settings.proxyUrl = null;
  else if (proxyUrl) settings.proxyUrl = proxyUrl.trim();
  const timezone = given(form.timezone);
  if (form.timezone === null) settings.timezone = null;
  else if (timezone) {
    const value = validTimezone(timezone);
    if (failed(value)) return value;
    settings.timezone = value;
  }
  const locale = given(form.locale);
  if (form.locale === null) settings.locale = null;
  else if (locale) {
    const value = validLocale(locale);
    if (failed(value)) return value;
    settings.locale = value;
  }
  return {
    ...(Object.keys(patch).length ? { patch } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

/** "Now in America/Los_Angeles: 5:00 AM", or null when the zone is not usable here. */
export function timezoneNow(timezone: string, now = Date.now()): string | null {
  const zone = canonicalTimezone(timezone);
  if (!zone) return null;
  try {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(now));
    return `Now in ${zone}: ${time}`;
  } catch {
    return null;
  }
}

const environmentTools = new Set(["use_environment", "use_desktop"]);
function toolName(call: unknown): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const tool = call as Record<string, unknown>;
  const fn = record(tool.function);
  return typeof fn.name === "string"
    ? fn.name
    : typeof tool.name === "string"
      ? tool.name
      : undefined;
}
function parseResult(content: unknown): Record<string, unknown> | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/**
 * The desktop a conversation's transcript last reported, read from use_environment and
 * use_desktop results in order: `null` means the default desktop, an EnvironmentRef names an
 * environment, and `undefined` means the transcript never said. Failed results (an `error`
 * field) and results without an `environment` field are skipped, so a use_desktop call that is
 * still running keeps the previous answer.
 */
export function threadEnvironment(messages: readonly unknown[]): EnvironmentRef | null | undefined {
  const calls = new Map<string, string>();
  let latest: EnvironmentRef | null | undefined;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    if (item.role === "assistant" && Array.isArray(item.toolCalls)) {
      for (const call of item.toolCalls) {
        const name = toolName(call);
        const id = call && typeof call === "object" ? (call as { id?: unknown }).id : undefined;
        if (name && environmentTools.has(name) && typeof id === "string") calls.set(id, name);
      }
    }
    if (item.role !== "tool" || typeof item.toolCallId !== "string") continue;
    if (!calls.has(item.toolCallId)) continue;
    const result = parseResult(item.content);
    if (!result || (typeof result.error === "string" && result.error)) continue;
    if (!("environment" in result)) continue;
    if (result.environment === null) {
      latest = null;
      continue;
    }
    const environment = record(result.environment);
    if (typeof environment.id !== "string" || !environment.id) continue;
    if (typeof environment.name !== "string") continue;
    latest = {
      id: environment.id,
      name: environment.name,
      accountLabel: textOrNull(environment.accountLabel),
    };
  }
  return latest;
}

/** What a thread's desktop resolves to: `undefined` while neither source has answered yet. */
export interface ResolvedThreadEnvironment {
  environment: EnvironmentRef | null | undefined;
  /** The selection names a deleted environment. */
  stale: boolean;
}
/**
 * Which source decides a thread's desktop. The server selection is what the next run uses
 * (use_environment writes it before answering), so once loaded it is authoritative. The
 * transcript's record stands in only while the selection has not loaded yet, and while a reply
 * is running, when the agent may switch and the selection is refreshed as soon as the run ends.
 * A stale selection that still names the record's environment stays stale: only the server
 * knows the environment was deleted since the agent switched to it.
 */
export function resolveThreadEnvironment({
  selection,
  record,
  running,
}: {
  selection: EnvironmentSelection | undefined;
  record: EnvironmentRef | null | undefined;
  running: boolean;
}): ResolvedThreadEnvironment {
  if (selection && !running)
    return { environment: environmentRef(selection), stale: selection.stale };
  if (record !== undefined) {
    const stale = selection?.stale === true && selection.environmentId === record?.id;
    return { environment: stale && selection ? environmentRef(selection) : record, stale };
  }
  if (selection) return { environment: environmentRef(selection), stale: selection.stale };
  return { environment: undefined, stale: false };
}

/**
 * The feature-off 503 from /api/environments (a server whose computer provider has no
 * environments). Any other 503, such as a proxy page while the API restarts,
 * is an ordinary failure: the feature is not hidden and the thread is not resolved to the
 * default desktop on its account.
 */
export function environmentsUnavailable(error: unknown) {
  return error instanceof ApiError && error.status === 503 && false;
}
/** A 404: the environment was deleted (or never existed) since the list was loaded. */
export function environmentGone(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}
/**
 * Show the server's message: a 404 says the environment is gone, the missing-key 503 is
 * reworded (see settingsError), and every other message is kept. Callers that want to hide
 * the feature rather than show an error check environmentsUnavailable first.
 */
export function environmentError(error: unknown) {
  if (environmentGone(error)) return "This environment no longer exists. Refresh the list.";
  return settingsError(error);
}
