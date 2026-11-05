/**
 * Credentials (fork feature, docs/credentials.md): every secret the system holds, per
 * project. An entry is a mailbox or a site login (a user name with any of a password, a
 * two-factor seed and cookies), linked to the account (identity) or the project that uses it.
 * Pure types shared by the server and the mobile app; nothing here carries a secret value, only
 * what is saved and how it went. (v1.5: only these two kinds; a proxy, or another kind saved
 * before, stays in the database, unread.)
 */

export type CredentialKind = "site_login" | "mailbox";
/** Who uses an entry: one account of the project, or the project itself (its default desktop
 * and the conversations and tasks not bound to an account). */
export type CredentialUsedBy = { type: "account"; environmentId: string } | { type: "project" };
/** How an entry went the last time it was used: a site login by the last sign-in the AI
 * recorded. `status` is a code the client words; `detail` is what the AI wrote when it recorded
 * a sign-in. */
export interface CredentialResult {
  ok: boolean;
  status: string;
  detail: string | null;
  at: string;
}
export interface TotpParts {
  digits: number;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
}
export interface SiteLoginParts {
  password: boolean;
  totp: TotpParts | null;
  cookies: { count: number } | null;
}
/** A mailbox the project sends from and reads (SMTP and IMAP, any
 * provider). The password (or app password) is the secret; the servers are metadata. */
export interface MailboxParts {
  address: string;
  smtpHost: string;
  smtpPort: number;
  /** TLS from the first byte (465); otherwise STARTTLS is required on the plain port (587). */
  smtpSecure: boolean;
  /** Reading is optional: a mailbox with no IMAP server only sends. */
  imapHost: string | null;
  imapPort: number | null;
  password: boolean;
}
export type CredentialParts = SiteLoginParts | MailboxParts;
/** The pseudo-site of a request for a mailbox (a task needed to send and the project has none):
 * `CredentialRequestView.site` holds it where a site login's request holds the domain. */
export const mailboxRequestSite = "mailbox";
/** One entry as the owner sees it: what it is, where it is used, how it went, never a value. */
export interface CredentialView {
  id: string;
  kind: CredentialKind;
  label: string | null;
  /** Site logins: the registrable domain, e.g. example.com. */
  site: string | null;
  /** Site logins: the user name, which is not a secret. */
  username: string | null;
  parts: CredentialParts;
  usedBy: (CredentialUsedBy & { name?: string | null })[];
  lastUsedAt: string | null;
  lastResult: CredentialResult | null;
  createdAt: string;
  replacedAt: string | null;
  /** Saved, but the credential key in use cannot read it: replace or clear it. */
  unreadable: boolean;
}
/** Something only the owner can give, asked for by a task or a chat (record_sign_in with
 * status no_login): a site login for an account or for the project. */
export interface CredentialRequestView {
  id: string;
  site: string;
  for: CredentialUsedBy & { name?: string | null };
  by: { taskId?: string; threadId?: string; title?: string | null };
  at: string;
  status: "open" | "fulfilled" | "withdrawn";
}
export type CredentialAuditEvent =
  | "added"
  | "replaced"
  | "cleared"
  | "removed"
  | "linked"
  | "unlinked"
  | "used"
  | "result"
  | "moved_in"
  | "moved_out"
  | "copied_in"
  | "migrated";
export type CredentialPart =
  | "username"
  | "password"
  | "totp_code"
  | "totp_seed"
  | "cookies"
  | "mailbox_password";
export type CredentialPurpose =
  | "fill"
  | "cookie_import"
  /** The cookies a proven sign-in left in the desktop's browser, saved. */
  | "cookie_export"
  | "mail_send"
  | "mail_read";
export type CredentialActor =
  /** `userId` names the member who did it (absent on older lines). */
  | { type: "owner"; userId?: string }
  | { type: "task"; taskId: string; title: string | null; run: number | null }
  | { type: "chat"; threadId: string }
  | { type: "system"; what: "desktop_start" | "migration" | "desktop_stop" };
/** One line of an entry's history: what happened, by whom and when; never a value. */
export interface CredentialAuditRow {
  id: string;
  at: string;
  entryId: string;
  entryKind: CredentialKind;
  /** What the entry was at the time: `site · username`, a mailbox's address. */
  entryName: string;
  event: CredentialAuditEvent;
  part: CredentialPart | null;
  purpose: CredentialPurpose | null;
  actor: CredentialActor;
  account: { environmentId: string; name: string | null } | null;
  outcome: { ok: boolean; reason: string | null } | null;
}
export interface CredentialAuditPage {
  rows: CredentialAuditRow[];
  /** Pass as `before` for the next (older) page; null at the end. */
  next: string | null;
}

/** What the AI recorded about signing an account (or the project) in to a site. */
export const signInStatuses = [
  "signed_in",
  "wrong_password",
  "needs_code",
  "suspended",
  "blocked",
  "no_login",
  "needs_owner",
  "other",
] as const;
export type RecordedSignInStatus = (typeof signInStatuses)[number];
/** `pending`: written by the server only, when the owner saves or replaces the site's login
 * ("saved, waiting for a task to sign in"). */
export type SignInStatus = RecordedSignInStatus | "pending";
/** The sign-in status words the person reads (apps/mobile strings `signIn.statuses` is this
 * table). The data a chat reply gets (an environment's facts, its note) carries these
 * words, so the reply has no key to repeat; the keys stay where a tool takes or records one
 * (record_sign_in's `status`). */
export const signInStatusWordsZh: Readonly<Record<SignInStatus, string>> = {
  signed_in: "已登录",
  wrong_password: "密码不对",
  needs_code: "要验证码",
  suspended: "号被封",
  blocked: "被网站拦下",
  no_login: "缺登录",
  needs_owner: "要你接手",
  other: "其他情况",
  pending: "已保存，等任务登录",
};
/** The words for `status`; a status this table does not know reads as it is. */
export const signInStatusWord = (status: string) =>
  (signInStatusWordsZh as Readonly<Record<string, string>>)[status] ?? status;
/** The statuses only the owner can act on: they become flags on the account (and 需要你). */
export const ownerSignInStatuses: readonly SignInStatus[] = [
  "wrong_password",
  "needs_code",
  "suspended",
  "no_login",
  "needs_owner",
];
export interface SiteSignInFact {
  site: string;
  status: SignInStatus;
  /** What the AI saw, in its own words (masked); null for `pending`. */
  detail: string | null;
  /** The page's own words the record quoted and the server found on the page
   * (「页面上写着：…」), masked; absent on older facts and on `pending`. */
  seen?: string | null;
  at: string;
  by: { taskId: string } | { threadId: string } | { owner: true };
  /** The incident this fact was recorded with, and whether the
   * desktop's picture of that moment was kept (「当时的画面」). */
  incident?: { id: string; shot: boolean } | null;
  /** The owner said he handled this fact on the desktop at this
   * time and no newer fact was recorded since: the AI is confirming it (「正在确认 x 的登录…」).
   * Only on `needs_code` / `needs_owner`; set by the server when it reads the facts. */
  ownerHandledAt?: string;
  /** With `ownerHandledAt`: no record came for too long after the check started (or after the
   * owner said he handled it, before any check): 「还没确认上，再点一次我弄好了或让她再看」. */
  ownerHandledStale?: boolean;
  /** The desktop browser's page when a `needs_code` /
   * `needs_owner` was recorded: where the owner is asked to act. `target` is that browser tab,
   * kept for him until the fact is answered; `gone` once the owner or a code found the tab
   * closed. Absent when the browser could not be read at the time. */
  page?: SignInPage | null;
}
export interface SignInPage {
  url: string | null;
  title: string | null;
  target: string | null;
  gone?: boolean;
}
/** A site login of an account as its row shows it: never a value, only what is saved. */
export interface SiteLoginView {
  id: string;
  site: string;
  username: string | null;
  password: boolean;
  totp: boolean;
  cookies: boolean;
  lastResult: CredentialResult | null;
  lastUsedAt: string | null;
  unreadable: boolean;
}
/** What a guidance card in the chat asks the
 * owner for. The card posts what he types to the credentials API itself; the conversation and
 * the model only ever see what was asked and whether it was saved. A verification code is typed
 * into the focused field of the desktop that asked for it and never saved. */
export const guideKinds = ["site_login", "verification_code"] as const;
export type GuideKind = (typeof guideKinds)[number];
/** A guidance card the chat's AI showed (request_credential): never a value. `status`: open,
 * saved (a login was saved for it, from the card or anywhere else), typed (the code was typed on
 * the desktop), withdrawn (no longer needed: the site stopped asking for a code, or its account
 * left the project). */
export interface CredentialGuideView {
  id: string;
  kind: GuideKind;
  site: string | null;
  for: CredentialUsedBy & { name?: string | null };
  /** Why the AI asks, in its words (plain Chinese). */
  why: string;
  threadId: string | null;
  at: string;
  status: "open" | "saved" | "typed" | "withdrawn";
  doneAt: string | null;
}
