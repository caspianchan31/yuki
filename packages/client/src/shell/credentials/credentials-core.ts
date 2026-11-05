/**
 * The pure logic of the credentials page and of the
 * account editor's site logins: reading GET /api/credentials and its history defensively, the
 * page's groups (待补, 发信邮箱, 站点登录 by account then 本项目用), each row's lines, the
 * history lines, and what a login form may send (never a value back). No react-native, no fetch:
 * node:test pins it (apps/mobile/test/shell-credentials.test.ts).
 */
import type {
  CredentialActor,
  CredentialAuditPage,
  CredentialAuditRow,
  CredentialKind,
  CredentialRequestView,
  CredentialUsedBy,
  CredentialView,
  MailboxParts,
  SiteLoginParts,
} from "../../../../../packages/domain/src/credentials.ts";
import { mailboxRequestSite } from "../../../../../packages/domain/src/credentials.ts";
import { clockLabel } from "../../../../../packages/domain/src/task-phase.ts";
import { normalizeResult } from "../../environments.ts";
import { phaseWords, t } from "../strings.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
// v1.5: only site logins and mailboxes are credentials; the server lists no other kind.
const kinds: readonly CredentialKind[] = ["site_login", "mailbox"];

export interface CredentialList {
  entries: CredentialView[];
  requests: CredentialRequestView[];
}

type NamedUser = CredentialUsedBy & { name?: string | null };
function usedByOf(value: unknown): NamedUser[] {
  return (Array.isArray(value) ? value : []).flatMap((item): NamedUser[] => {
    const user = record(item);
    if (user.type === "project") return [{ type: "project" as const }];
    if (user.type === "account" && typeof user.environmentId === "string")
      return [
        { type: "account" as const, environmentId: user.environmentId, name: text(user.name) },
      ];
    return [];
  });
}
function partsOf(kind: CredentialKind, value: unknown) {
  const parts = record(value);
  if (kind === "mailbox")
    return {
      address: text(parts.address) ?? "",
      smtpHost: text(parts.smtpHost) ?? "",
      smtpPort: typeof parts.smtpPort === "number" ? parts.smtpPort : 0,
      smtpSecure: parts.smtpSecure === true,
      imapHost: text(parts.imapHost),
      imapPort: typeof parts.imapPort === "number" ? parts.imapPort : null,
      password: parts.password === true,
    } satisfies MailboxParts;
  const totp = record(parts.totp);
  const cookies = record(parts.cookies);
  return {
    password: parts.password === true,
    totp:
      parts.totp && typeof parts.totp === "object"
        ? {
            digits: typeof totp.digits === "number" ? totp.digits : 0,
            period: typeof totp.period === "number" ? totp.period : 0,
            algorithm:
              totp.algorithm === "SHA256" || totp.algorithm === "SHA512" ? totp.algorithm : "SHA1",
          }
        : null,
    cookies:
      parts.cookies && typeof parts.cookies === "object"
        ? { count: typeof cookies.count === "number" ? cookies.count : 0 }
        : null,
  } satisfies SiteLoginParts;
}
/** One entry read defensively; null for anything that is not one. */
export function normalizeEntry(value: unknown): CredentialView | null {
  const item = record(value);
  const kind = kinds.find((candidate) => candidate === item.kind);
  if (!kind || typeof item.id !== "string") return null;
  return {
    id: item.id,
    kind,
    label: text(item.label),
    site: text(item.site),
    username: text(item.username),
    parts: partsOf(kind, item.parts),
    usedBy: usedByOf(item.usedBy),
    lastUsedAt: text(item.lastUsedAt),
    lastResult: normalizeResult(item.lastResult),
    createdAt: text(item.createdAt) ?? "",
    replacedAt: text(item.replacedAt),
    unreadable: item.unreadable === true,
  };
}
/** GET /api/credentials, read defensively. */
export function normalizeCredentials(payload: unknown): CredentialList {
  const value = record(payload);
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .map(normalizeEntry)
    .filter((entry): entry is CredentialView => entry !== null);
  const requests = (Array.isArray(value.requests) ? value.requests : []).flatMap((raw) => {
    const item = record(raw);
    const [target] = usedByOf([item.for]);
    if (typeof item.id !== "string" || typeof item.site !== "string" || !target) return [];
    const by = record(item.by);
    return [
      {
        id: item.id,
        site: item.site,
        for: target,
        by: {
          ...(typeof by.taskId === "string" ? { taskId: by.taskId } : {}),
          ...(typeof by.threadId === "string" ? { threadId: by.threadId } : {}),
          title: text(by.title),
        },
        at: text(item.at) ?? "",
        status: "open" as const,
      },
    ];
  });
  return { entries, requests };
}
const actorOf = (value: unknown): CredentialActor => {
  const actor = record(value);
  if (actor.type === "task")
    return {
      type: "task",
      taskId: text(actor.taskId) ?? "",
      title: text(actor.title),
      run: typeof actor.run === "number" ? actor.run : null,
    };
  if (actor.type === "chat") return { type: "chat", threadId: text(actor.threadId) ?? "" };
  if (actor.type === "system")
    return { type: "system", what: (text(actor.what) ?? "desktop_start") as "desktop_start" };
  // The member who did it, when the server named one.
  const userId = text(actor.userId);
  return userId ? { type: "owner", userId } : { type: "owner" };
};
/** GET /api/credentials/audit, read defensively. */
export function normalizeAudit(payload: unknown): CredentialAuditPage {
  const value = record(payload);
  const rows = (Array.isArray(value.rows) ? value.rows : []).flatMap(
    (raw): CredentialAuditRow[] => {
      const item = record(raw);
      if (typeof item.id !== "string" || typeof item.event !== "string") return [];
      const account = record(item.account);
      const outcome = record(item.outcome);
      return [
        {
          id: item.id,
          at: text(item.at) ?? "",
          entryId: text(item.entryId) ?? "",
          entryKind: kinds.find((kind) => kind === item.entryKind) ?? "site_login",
          entryName: text(item.entryName) ?? "",
          event: item.event as CredentialAuditRow["event"],
          part: text(item.part) as CredentialAuditRow["part"],
          purpose: text(item.purpose) as CredentialAuditRow["purpose"],
          actor: actorOf(item.actor),
          account:
            typeof account.environmentId === "string"
              ? { environmentId: account.environmentId, name: text(account.name) }
              : null,
          outcome:
            item.outcome && typeof item.outcome === "object"
              ? { ok: outcome.ok === true, reason: text(outcome.reason) }
              : null,
        },
      ];
    },
  );
  return { rows, next: text(value.next) };
}

// ───────────────────────────── the page ─────────────────────────────

/** What an entry is, in one line: 「example.com · alice」, a mailbox's address. */
export function entryWhat(entry: CredentialView): string {
  const c = t.credentials;
  if (entry.kind === "mailbox") {
    const parts = entry.parts as MailboxParts;
    return c.mailboxWhat(parts.address, !!parts.imapHost);
  }
  return c.loginWhat(entry.site ?? "", entry.username);
}
/** What a site login holds (never the values): 「密码 · 两步验证 · Cookie 3 个」. */
export function loginParts(entry: CredentialView): string | null {
  if (entry.kind !== "site_login") return null;
  const parts = entry.parts as SiteLoginParts;
  const c = t.credentials;
  const list = [
    parts.password ? c.partPassword : null,
    parts.totp ? c.partTotp : null,
    parts.cookies ? c.partCookies(parts.cookies.count) : null,
  ].filter((part): part is string => !!part);
  return list.length ? c.loginParts(list) : null;
}
/** Where an entry is used, by the names the server gave (an account not of this project's list
 * any more is said as such). */
export function usedByLine(entry: CredentialView): string {
  const c = t.credentials;
  if (!entry.usedBy.length) return c.usedNowhere;
  return c.usedBy(
    entry.usedBy.map((user) =>
      user.type === "project"
        ? entry.kind === "mailbox"
          ? c.usedProjectMailbox
          : c.usedProject
        : ((user as { name?: string | null }).name ?? c.unknownAccount),
    ),
  );
}
/** How it went the last time: 「上次：可用」, 「上次：密码不对（页面说…）」, or 还没有结果. */
export function lastResultLine(entry: Pick<CredentialView, "lastResult">): string {
  const c = t.credentials;
  const result = entry.lastResult;
  if (!result) return c.neverResult;
  const word = c.results[result.status] ?? result.status;
  return result.ok ? c.lastOk(word) : c.lastFail(word, result.detail);
}
/** The row's time line: 上次使用 · 添加于 · 更换于. */
export function timesLine(entry: CredentialView, now: Date | number): string {
  const c = t.credentials;
  const clock = (iso: string) => clockLabel(iso, now, phaseWords);
  return [
    entry.lastUsedAt ? c.lastUsed(clock(entry.lastUsedAt)) : c.neverUsed,
    entry.createdAt ? c.added(clock(entry.createdAt)) : null,
    entry.replacedAt ? c.replaced(clock(entry.replacedAt)) : null,
  ]
    .filter((part): part is string => !!part)
    .join(t.common.sep);
}

export interface CredentialSection {
  key: string;
  title: string;
  entries: CredentialView[];
}
/** The page's groups: 发信邮箱, then 站点登录 by account (by name) and 本项目用. */
export function credentialSections(list: CredentialList): CredentialSection[] {
  const c = t.credentials;
  const byKind = (kind: CredentialKind) => list.entries.filter((entry) => entry.kind === kind);
  const logins = byKind("site_login");
  const owners = new Map<string, { title: string; entries: CredentialView[] }>();
  for (const entry of logins) {
    const user = entry.usedBy[0];
    const key = !user
      ? "none"
      : user.type === "project"
        ? "project"
        : `account:${user.environmentId}`;
    const title = !user
      ? c.usedNowhere
      : user.type === "project"
        ? c.groups.project
        : ((user as { name?: string | null }).name ?? c.unknownAccount);
    const group = owners.get(key) ?? { title, entries: [] };
    group.entries.push(entry);
    owners.set(key, group);
  }
  const accountGroups = [...owners.entries()]
    .filter(([key]) => key.startsWith("account:"))
    .sort(([, a], [, b]) => a.title.localeCompare(b.title));
  const rest = [...owners.entries()].filter(([key]) => !key.startsWith("account:"));
  const sortLogins = (entries: CredentialView[]) =>
    [...entries].sort((a, b) => (a.site ?? "").localeCompare(b.site ?? ""));
  return [
    { key: "mailbox", title: c.groups.mailboxes, entries: byKind("mailbox") },
    ...[...accountGroups, ...rest].map(([key, group]) => ({
      key: `logins:${key}`,
      title: `${c.groups.logins} · ${group.title}`,
      entries: sortLogins(group.entries),
    })),
  ];
}
/** With no computer connected (未接电脑) the project's only credentials are its mailboxes: no
 * site login or request for one is shown. */
export function withoutComputer(list: CredentialList): CredentialList {
  return {
    ...list,
    entries: list.entries.filter((entry) => entry.kind === "mailbox"),
    requests: list.requests.filter((request) => request.site === mailboxRequestSite),
  };
}
/** A 待补 line: 「acct-2 要 x.com 的登录」, 「本项目要 apple.com 的登录」. */
export function requestLine(request: CredentialRequestView): string {
  const c = t.credentials;
  if (request.site === mailboxRequestSite) return c.mailboxRequest;
  return request.for.type === "project"
    ? c.projectRequest(request.site)
    : c.request((request.for as { name?: string | null }).name ?? c.unknownAccount, request.site);
}

/** What the editor opens with for a 待补 line: a mailbox, or the site's login for whom asked. */
export function requestPreset(request: CredentialRequestView): {
  kind: "site_login" | "mailbox";
  site?: string;
  environmentId?: string | null;
} {
  if (request.site === mailboxRequestSite) return { kind: "mailbox" };
  return {
    kind: "site_login",
    site: request.site,
    environmentId: request.for.type === "account" ? request.for.environmentId : null,
  };
}
/** What a mailbox form sends: the address, the password (when typed), the SMTP server and, when
 * given, the IMAP server; ports as numbers. An error names the first missing field. */
export interface MailboxDraft {
  address: string;
  password: string;
  smtpHost: string;
  smtpPort: string;
  imapHost: string;
  imapPort: string;
}
export const emptyMailbox: MailboxDraft = {
  address: "",
  password: "",
  smtpHost: "",
  smtpPort: "465",
  imapHost: "",
  imapPort: "993",
};
export function mailboxBody(
  draft: MailboxDraft,
  mode: "create" | "replace",
): Record<string, unknown> | { error: string } {
  const e = t.credentials.editor;
  const address = draft.address.trim();
  const smtpHost = draft.smtpHost.trim();
  if (!address) return { error: e.mailboxNeedsAddress };
  if (!smtpHost) return { error: e.mailboxNeedsSmtp };
  if (mode === "create" && !draft.password) return { error: e.mailboxNeedsPassword };
  const port = (value: string) => {
    const n = Number(value.trim());
    return value.trim() && Number.isInteger(n) ? n : null;
  };
  const imapHost = draft.imapHost.trim();
  return {
    address,
    smtpHost,
    smtpPort: port(draft.smtpPort),
    imapHost: imapHost || null,
    imapPort: imapHost ? port(draft.imapPort) : null,
    ...(draft.password ? { password: draft.password } : {}),
  };
}
/** One history line: 「10:05 · 填入 密码 · 任务「登录 x.com」 · 成功」. `named`: the full history
 * (not narrowed to one entry) also says which credential the line is about, 「10:05 · x.com ·
 * alice · 填入 密码 · …」. */
export function auditLine(
  row: CredentialAuditRow,
  now: Date | number,
  options: {
    named?: boolean;
    /** In a space of several members, another member's line names them
     * (user id -> username); the signed-in user's own lines stay 「你」. */
    members?: ReadonlyMap<string, string>;
    me?: string;
  } = {},
): string {
  const log = t.credentials.log;
  const event = log.events[row.event] ?? row.event;
  const purpose = row.purpose ? (log.purposes[row.purpose] ?? row.purpose) : null;
  const partWord = row.part ? (log.parts[row.part] ?? row.part) : null;
  // 「导入 Cookie」 already names the part: never 「导入 Cookie Cookie」.
  const part =
    partWord && !(purpose && row.event === "used" && purpose.includes(partWord)) ? partWord : null;
  const what =
    row.event === "used"
      ? [purpose ?? event, part].filter(Boolean).join(" ")
      : row.event === "result"
        ? [event, purpose].filter(Boolean).join(" ")
        : // 「登录成功后保存 Cookie」 says what the replacement was.
          row.event === "replaced" && purpose
          ? purpose
          : [event, part].filter(Boolean).join(" ");
  const actor = row.actor;
  const who =
    actor.type === "owner"
      ? actor.userId && actor.userId !== options.me
        ? (options.members?.get(actor.userId) ?? log.owner)
        : log.owner
      : actor.type === "task"
        ? log.task(actor.title)
        : actor.type === "chat"
          ? log.chat
          : log.system;
  const account = row.account
    ? log.account(row.account.name ?? t.credentials.unknownAccount)
    : null;
  const outcome = row.outcome
    ? row.outcome.ok
      ? log.ok
      : // A code this app does not know reads as the plain failure, never the code itself.
        log.failed(t.credentials.results[row.outcome.reason ?? ""] ?? t.credentials.results.failed)
    : "";
  let name: string | null = null;
  if (options.named) name = row.entryName || null;
  return log.line(
    clockLabel(row.at, now, phaseWords),
    [name, what, account].filter(Boolean).join(t.common.sep),
    who,
    outcome,
  );
}

// ───────────────────────────── login forms ─────────────────────────────

/** A site login as typed: blank = not given (or, replacing, kept). */
export interface LoginDraft {
  site: string;
  username: string;
  password: string;
  totpSeed: string;
  cookies: string;
}
export const emptyLogin: LoginDraft = {
  site: "",
  username: "",
  password: "",
  totpSeed: "",
  cookies: "",
};
/** What a login holds once saved (typed, or already saved when replacing). */
export interface LoginHave {
  username: boolean;
  password: boolean;
  totp: boolean;
  cookies: boolean;
}
/** What a login lacks, said before the request (the server checks the same): a password needs
 * the user name, a two-factor key needs the password, and a new login needs a password or
 * cookies to sign in with. */
export function loginGap(have: LoginHave, mode: "create" | "replace"): string | null {
  const e = t.accountEditor;
  if (have.password && !have.username) return e.gapPasswordNeedsUser;
  if (have.totp && !have.password) return e.gapTotpNeedsPassword;
  if (mode === "create" && !have.password && !have.cookies) return e.gapNeedsSecret;
  return null;
}
/** The host part of what was typed for a site, lower case (the server computes the registrable
 * domain; this only tells two rows of one form apart). */
export function siteKey(typed: string): string {
  const value = typed.trim().toLowerCase();
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}
const given = (value: string) => (value.trim() ? value : undefined);
/** The body of a new site login (POST /api/credentials or a new account's siteLogins). */
export function loginBody(
  draft: LoginDraft,
):
  | { site: string; username?: string; password?: string; totpSeed?: string; cookies?: string }
  | { error: string } {
  if (!draft.site.trim()) return { error: t.accountEditor.gapSiteRequired };
  const gap = loginGap(
    {
      username: !!given(draft.username),
      password: !!given(draft.password),
      totp: !!given(draft.totpSeed),
      cookies: !!given(draft.cookies),
    },
    "create",
  );
  if (gap) return { error: gap };
  return {
    site: draft.site.trim(),
    ...(given(draft.username) ? { username: draft.username.trim() } : {}),
    ...(given(draft.password) ? { password: draft.password } : {}),
    ...(given(draft.totpSeed) ? { totpSeed: draft.totpSeed.trim() } : {}),
    ...(given(draft.cookies) ? { cookies: draft.cookies.trim() } : {}),
  };
}
/** The PATCH of a saved login: a blank secret is kept; the user name is replaced as typed;
 * null when nothing changes. */
export function loginPatch(
  draft: Omit<LoginDraft, "site">,
  saved: { username: string | null; password: boolean; totp: boolean; cookies: boolean },
):
  | { username?: string | null; password?: string; totpSeed?: string; cookies?: string }
  | { error: string }
  | null {
  const username = draft.username.trim();
  const patch: {
    username?: string | null;
    password?: string;
    totpSeed?: string;
    cookies?: string;
  } = {};
  if (username !== (saved.username ?? "")) patch.username = username || null;
  if (given(draft.password)) patch.password = draft.password;
  if (given(draft.totpSeed)) patch.totpSeed = draft.totpSeed.trim();
  if (given(draft.cookies)) patch.cookies = draft.cookies.trim();
  if (!Object.keys(patch).length) return null;
  const gap = loginGap(
    {
      username: "username" in patch ? !!patch.username : !!saved.username,
      password: !!patch.password || saved.password,
      totp: !!patch.totpSeed || saved.totp,
      cookies: !!patch.cookies || saved.cookies,
    },
    "replace",
  );
  return gap ? { error: gap } : patch;
}
/** A saved login part the owner can clear on its own (清除这一项). */
export type ClearablePart = "username" | "password" | "totpSeed" | "cookies";
/** Which parts of a saved login have 清除这一项: the password, the two-factor key and the
 * cookies whenever saved; the user name only once no password needs it. */
export function clearableParts(saved: {
  username: string | null;
  password: boolean;
  totp: boolean;
  cookies: boolean;
}): ClearablePart[] {
  return [
    ...(saved.username && !saved.password ? (["username"] as const) : []),
    ...(saved.password ? (["password"] as const) : []),
    ...(saved.totp ? (["totpSeed"] as const) : []),
    ...(saved.cookies ? (["cookies"] as const) : []),
  ];
}
/** The PATCH that clears one part: clearing the password also clears the two-factor key, which
 * goes with it (the server refuses a key without its password). */
export function clearPatch(
  part: ClearablePart,
  saved: { totp: boolean },
): Partial<Record<ClearablePart, null>> {
  if (part === "password") return { password: null, ...(saved.totp ? { totpSeed: null } : {}) };
  return { [part]: null };
}
/** The rows of a login list, as the editor shows each: 「site · 用户名 · 密码 已保存 · 两步验证 未填 · Cookie 已保存」. */
export function loginRowText(login: {
  site: string;
  username: string | null;
  password: boolean;
  totp: boolean;
  cookies: boolean;
}): string {
  const e = t.accountEditor;
  return [
    e.loginRow(login.site, login.username ?? e.loginNoUser),
    e.loginPassword(login.password),
    e.loginTotp(login.totp),
    e.loginCookies(login.cookies),
  ].join(t.common.sep);
}
