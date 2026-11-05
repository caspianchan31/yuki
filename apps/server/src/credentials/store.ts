/**
 * The credential store, an isolated subsystem.
 *
 * Every secret the system holds (mailboxes, proxies, site logins: password, two-factor seed,
 * cookies) is an entry of exactly one scope: the owner string of the project it belongs to
 * (`local-user` for the default project, `local-user/proj:<id>` for a project). The store keeps
 * its own tables (credential_entries, credential_audit, credential_requests, credential_meta) on
 * the same database as the records table, encrypts every secret with its own key (never
 * TOKEN_ENCRYPTION_KEY) bound to the entry's scope and id, and is the only code that ever decrypts
 * one. It is reachable only through the methods below, each of which takes the scope first: no
 * method lists, counts or touches more than one scope (except moving an account, which names
 * both), and an entry of another scope is simply absent. The rest of the server reads metadata
 * and hands a sink to `use`, the one door a plaintext passes through, which records every use.
 */
import { randomUUID } from "node:crypto";
import type {
  CredentialActor,
  CredentialAuditEvent,
  CredentialAuditPage,
  CredentialAuditRow,
  CredentialKind,
  CredentialPart,
  CredentialParts,
  CredentialPurpose,
  CredentialRequestView,
  CredentialResult,
  CredentialUsedBy,
  CredentialView,
  MailboxParts,
  ProxyParts,
  SiteLoginParts,
} from "../../../../packages/domain/src/credentials.ts";
import { connectionOf, type Store, type StoreConnection, type StoreQuery } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  type CredentialKey,
  isProcessCredentialKey,
  keyedTag,
  keyFingerprint,
  seal,
  unseal,
} from "./crypto.ts";
import { base32Bytes, type TotpParameters, totp } from "./totp.ts";
import {
  canonicalProxy,
  proxyExitIdentity,
  proxyMeta,
  type SiteCookie,
  validateCookies,
  validateLabel,
  validateMailbox,
  validatePassword,
  validateProxyUrl,
  validateSite,
  validateTotpSeed,
  validateUsername,
} from "./validate.ts";

/** What an entry's ciphertext holds. */
type Secret =
  | { proxyUrl: string }
  | { password?: string; totpSeed?: string; cookies?: SiteCookie[] }
  /** A mailbox's password (or app password). */
  | { mailboxPassword: string };
interface EntryRow {
  scope: string;
  id: string;
  kind: CredentialKind;
  label: string | null;
  site: string | null;
  username: string | null;
  meta: CredentialParts & { totpParameters?: TotpParameters };
  secret: string;
  used_by: CredentialUsedBy[];
  last_used_at: string | null;
  last_result: CredentialResult | null;
  created_at: string;
  replaced_at: string | null;
  updated_at: string;
}
interface RequestRow {
  scope: string;
  id: string;
  site: string;
  for_target: CredentialUsedBy;
  by_source: CredentialRequestView["by"];
  at: string;
  status: CredentialRequestView["status"];
  closed_at: string | null;
}

/** What creating an entry takes; every field is checked here. */
export interface CredentialInput {
  kind: CredentialKind;
  label?: string | null;
  usedBy?: CredentialUsedBy[];
  proxyUrl?: string | null;
  site?: string | null;
  username?: string | null;
  password?: string | null;
  totpSeed?: string | null;
  cookies?: string | null;
  /** A mailbox's address and servers (its password is `password`). */
  address?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean | null;
  imapHost?: string | null;
  imapPort?: number | null;
}
/** The kinds of entry a platform sets up for a space it runs (they outlive the accounts they
 * serve), and an account uses one of at most. */
type PlatformKind = "proxy";
const platformKinds: ReadonlySet<string> = new Set<PlatformKind>(["proxy"]);
const isPlatformKind = (kind: CredentialKind): kind is PlatformKind => platformKinds.has(kind);
/** A change to such an entry, as the platform guard is asked. */
export interface PlatformChange {
  kind: PlatformKind;
  action: "create" | "replace" | "remove" | "link";
  /** create: whom it would serve; link: whom it serves now. */
  usedBy?: CredentialUsedBy[];
}
/** What replacing parts of an entry takes: left out keeps a part, null clears it. */
export type CredentialPatch = Omit<CredentialInput, "kind" | "site" | "usedBy">;
/** The parts of an entry that can be cleared on their own. */
export type ClearablePart = "username" | "password" | "totpSeed" | "cookies";

/** Why a use did not happen; never carries a value. */
export class CredentialUseError extends Error {
  constructor(readonly reason: "no_saved_login" | "field_not_saved" | "unreadable") {
    super(reason);
    this.name = "CredentialUseError";
  }
}
/** Thrown at startup: the key does not belong to the data. */
export class CredentialKeyMismatch extends Error {
  constructor() {
    super(
      "Credential key and data do not belong together: the credential store was set up with another key (CREDENTIAL_KEY_FILE). Start with the key it was set up with.",
    );
    this.name = "CredentialKeyMismatch";
  }
}

const now = () => new Date().toISOString();
/** An account as history records it: its id and the name it had then. */
type Named = { environmentId: string; name: string | null } | null;
const sameUsedBy = (a: CredentialUsedBy, b: CredentialUsedBy) =>
  a.type === b.type &&
  (a.type === "project" || a.environmentId === (b as { environmentId: string }).environmentId);
const accountUser = (environmentId: string): CredentialUsedBy => ({
  type: "account",
  environmentId,
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A scope is a project's owner string: a real owner or `<real>/proj:<id>`, never an account's
 * derived owner (with `#env:`): those are keyed by account, not by project. */
function assertScope(scope: string) {
  if (!scope || scope.includes("#") || scope.length > 500)
    throw new AppError("Credential scope could not be derived", 500);
}
function checkUsedBy(list: CredentialUsedBy[]) {
  for (const item of list)
    if (
      !(
        (item.type === "project" && Object.keys(item).length === 1) ||
        (item.type === "account" && uuidPattern.test(item.environmentId))
      )
    )
      throw new AppError("usedBy must be an account of this project or the project", 400);
}
/** The name an entry goes by in lists and history: never a value. */
function entryName(row: Pick<EntryRow, "kind" | "site" | "username" | "meta">) {
  if (row.kind === "site_login")
    return `${row.site ?? ""}${row.username ? ` · ${row.username}` : ""}`;
  if (row.kind === "proxy") {
    const meta = row.meta as ProxyParts;
    return `${meta.scheme}://${meta.host}:${meta.port}`;
  }
  return (row.meta as MailboxParts).address;
}
/** Every spelling of a value that could show up in text (as typed, percent-encoded, decoded, and
 * form-encoded as a login form sent by GET puts it in an address: a space is `+`, `!` is `%21`). */
function spellings(value: string) {
  const out = new Set([value]);
  try {
    out.add(decodeURIComponent(value));
  } catch {
    // Not percent-encoded.
  }
  out.add(encodeURIComponent(value));
  out.add(new URLSearchParams([["", value]]).toString().slice(1));
  return [...out].filter(Boolean);
}

/** What this process runs one at a time (oneAtATime), by lock name. */
const running = new Map<string, Promise<unknown>>();

export class CredentialStore {
  private readonly db: StoreConnection;
  private ready: Promise<void> | undefined;
  /** The account names history records carry; set by the app (the environment records). */
  private accountName: (scope: string, environmentId: string) => Promise<string | null> =
    async () => null;
  /** `sample`: the sample workspace (made-up data only). Only there may this process's own key
   * take over data sealed with another key; in live mode another key always refuses. */
  constructor(
    store: Store,
    private readonly key: CredentialKey,
    private readonly options: { sample?: boolean } = {},
  ) {
    this.db = connectionOf(store);
  }
  nameAccountsWith(lookup: (scope: string, environmentId: string) => Promise<string | null>) {
    this.accountName = lookup;
  }
  /** Throws when `actor` may not make `change` in
   * `scope` (a space whose platform entries the platform operator sets up; its members
   * only point an account at a free proxy, `link`, whose `usedBy` the entry serves now). Set by
   * the app; nothing is refused by default. */
  platformGuard: (scope: string, actor: CredentialActor, change: PlatformChange) => Promise<void> =
    async () => {};
  /** Whether `scope` belongs to a space whose platform entries the
   * platform sets up (they outlive the accounts they serve). Set by the app. */
  platformScope?: (scope: string) => Promise<boolean>;
  /** Told every result recorded on an entry (a proxy check, a solve, a
   * sign-in), after it is written. Set by the app. */
  onResult?: (
    scope: string,
    entry: CredentialView,
    result: CredentialResult,
    purpose: CredentialPurpose | undefined,
    actor: CredentialActor,
  ) => Promise<void>;
  /** Creates the tables and checks the key against the data, once per process. Startup awaits it
   * so a key that does not belong to the data refuses the start. */
  open() {
    this.ready ??= this.prepare();
    return this.ready;
  }
  private async prepare() {
    const q = this.db.query;
    await q(
      "CREATE TABLE IF NOT EXISTS credential_entries(scope text NOT NULL,id text NOT NULL,kind text NOT NULL,label text,site text,username text,meta jsonb NOT NULL,secret text NOT NULL,used_by jsonb NOT NULL,last_used_at text,last_result jsonb,created_at text NOT NULL,replaced_at text,updated_at text NOT NULL,PRIMARY KEY(scope,id))",
    );
    await q(
      "CREATE TABLE IF NOT EXISTS credential_audit(scope text NOT NULL,id text NOT NULL,seq bigserial,at text NOT NULL,entry_id text NOT NULL,entry_kind text NOT NULL,entry_name text NOT NULL,event text NOT NULL,part text,purpose text,actor jsonb NOT NULL,account jsonb,outcome jsonb,PRIMARY KEY(scope,id))",
    );
    await q(
      "CREATE TABLE IF NOT EXISTS credential_requests(scope text NOT NULL,id text NOT NULL,site text NOT NULL,for_target jsonb NOT NULL,by_source jsonb NOT NULL,at text NOT NULL,status text NOT NULL,closed_at text,PRIMARY KEY(scope,id))",
    );
    await q("CREATE TABLE IF NOT EXISTS credential_meta(id text PRIMARY KEY,value jsonb NOT NULL)");
    // Values that stopped serving an account or project (replaced, cleared, deleted, unlinked)
    // while a desktop may still hold them: masked like current ones until forgotten.
    await q(
      "CREATE TABLE IF NOT EXISTS credential_retired(scope text NOT NULL,id text NOT NULL,entry_id text NOT NULL,used_by jsonb NOT NULL,secret text NOT NULL,at text NOT NULL,PRIMARY KEY(scope,id))",
    );
    await q(
      'CREATE INDEX IF NOT EXISTS credential_audit_page ON credential_audit(scope,(at COLLATE "C"),seq)',
    ).catch(() => {});
    const fingerprint = keyFingerprint(this.key);
    await this.db.transaction(async (tx) => {
      await tx("SELECT pg_advisory_xact_lock(hashtext('openmuse:credential-meta'))");
      const saved = await tx(
        "SELECT value AS data FROM credential_meta WHERE id='key-fingerprint'",
      );
      const known = (saved.rows[0]?.data as { fingerprint?: string } | undefined)?.fingerprint;
      if (known === fingerprint) return;
      // A recorded fingerprint binds the data to its key, whether or not an entry exists yet: a
      // process with another key (a worker with a different key file) must not take it over.
      // Only the sample workspace's per-process key, which seals made-up data, replaces it, and
      // the made-up data sealed with the previous one goes with it: decided by the mode the
      // store was opened in, never by the key alone, so live data is never wiped.
      if (known && !(this.options.sample && isProcessCredentialKey(this.key)))
        throw new CredentialKeyMismatch();
      if (known)
        for (const table of [
          "credential_entries",
          "credential_audit",
          "credential_requests",
          "credential_retired",
        ])
          await tx(`DELETE FROM ${table}`);
      await tx(
        "INSERT INTO credential_meta(id,value) VALUES('key-fingerprint',$1::jsonb) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        [JSON.stringify({ fingerprint })],
      );
    });
  }
  private async query(sql: string, params: unknown[] = []) {
    await this.open();
    return this.db.query(sql, params);
  }
  private async rows<T>(sql: string, params: unknown[] = [], via?: StoreQuery): Promise<T[]> {
    const result = via ? await via(sql, params) : await this.query(sql, params);
    return result.rows.map((row) => row.data as unknown as T);
  }
  /** A flag kept with the data (the migration marker); scope-free on purpose: no secret. */
  async flag(id: string): Promise<boolean> {
    const rows = await this.rows<unknown>("SELECT value AS data FROM credential_meta WHERE id=$1", [
      id,
    ]);
    return rows.length > 0;
  }
  async setFlag(id: string, via?: StoreQuery) {
    const sql =
      "INSERT INTO credential_meta(id,value) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING";
    if (via) await via(sql, [id, JSON.stringify({ at: now() })]);
    else await this.query(sql, [id, JSON.stringify({ at: now() })]);
  }
  /** Runs `work` (which makes its own writes) in one process at a time, across every process on
   * this database: the API and a separate worker start together, and the second one waits until
   * the first is done. */
  async oneAtATime<T>(lock: string, work: () => Promise<T>): Promise<T> {
    await this.open();
    const name = `openmuse:credentials:${lock}`;
    const before = running.get(name) ?? Promise.resolve();
    const run = before
      .catch(() => {})
      .then(() =>
        this.db.shared
          ? // The lock is held by this transaction's connection while `work` runs on others.
            this.db.transaction(async (tx) => {
              await tx("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
              return work();
            })
          : work(),
      );
    running.set(name, run);
    try {
      return await run;
    } finally {
      if (running.get(name) === run) running.delete(name);
    }
  }
  /** Runs `work` with the store's other writes in one transaction, holding a lock named `lock`,
   * so two processes (the API and the worker) never do it at once. */
  async exclusively<T>(lock: string, work: (via: StoreQuery) => Promise<T>) {
    await this.open();
    return this.db.transaction(async (tx) => {
      await tx("SELECT pg_advisory_xact_lock(hashtext($1))", [`openmuse:credentials:${lock}`]);
      return work(tx);
    });
  }

  // ---- reading -------------------------------------------------------------------------
  private async row(scope: string, id: string, via?: StoreQuery): Promise<EntryRow | null> {
    assertScope(scope);
    const [row] = await this.rows<EntryRow>(
      "SELECT to_jsonb(e) AS data FROM credential_entries e WHERE scope=$1 AND id=$2",
      [scope, id],
      via,
    );
    return row ?? null;
  }
  private async scopeRows(scope: string, via?: StoreQuery): Promise<EntryRow[]> {
    assertScope(scope);
    return this.rows<EntryRow>(
      "SELECT to_jsonb(e) AS data FROM credential_entries e WHERE scope=$1 ORDER BY kind,site NULLS FIRST,username NULLS FIRST,created_at,id",
      [scope],
      via,
    );
  }
  private open_(row: Pick<EntryRow, "scope" | "id" | "secret">): Secret | undefined {
    const text = unseal(this.key, row.scope, row.id, row.secret);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as Secret;
    } catch {
      return undefined;
    }
  }
  private view(row: EntryRow): CredentialView {
    const { totpParameters: _, ...parts } = row.meta;
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      site: row.site,
      username: row.username,
      parts: parts as CredentialParts,
      usedBy: row.used_by.map((item) => ({ ...item })),
      lastUsedAt: row.last_used_at,
      lastResult: row.last_result,
      createdAt: row.created_at,
      replacedAt: row.replaced_at,
      unreadable: this.open_(row) === undefined,
    };
  }
  /** Every entry of the scope, metadata only. */
  async list(scope: string): Promise<CredentialView[]> {
    return (await this.scopeRows(scope)).map((row) => this.view(row));
  }
  /** One entry of the scope, metadata only; null for an id of another scope or none. */
  async get(scope: string, id: string): Promise<CredentialView | null> {
    if (typeof id !== "string" || id.length > 100) return null;
    const row = await this.row(scope, id);
    return row ? this.view(row) : null;
  }
  /** Entries of the scope used by `usedBy` (when given), of a site or kind, metadata only. */
  async find(
    scope: string,
    query: { usedBy?: CredentialUsedBy; site?: string; kind?: CredentialKind },
  ): Promise<CredentialView[]> {
    const user = query.usedBy;
    return (await this.scopeRows(scope))
      .filter(
        (row) =>
          (!user || row.used_by.some((item) => sameUsedBy(item, user))) &&
          (query.site === undefined || row.site === query.site) &&
          (query.kind === undefined || row.kind === query.kind),
      )
      .map((row) => this.view(row));
  }
  /** The accounts of the scope with a site login whose user name is `name` (case-insensitive,
   * whole name). */
  async accountsByUsername(scope: string, name: string): Promise<string[]> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return [];
    const ids = new Set<string>();
    for (const row of await this.scopeRows(scope))
      if (row.kind === "site_login" && row.username?.toLowerCase() === wanted)
        for (const item of row.used_by) if (item.type === "account") ids.add(item.environmentId);
    return [...ids];
  }

  /** A keyed fingerprint of a proxy's exit (`proxyExitIdentity`: scheme,
   * user name, host and port, never the password) under a subkey of this store's own key
   * (`keyedTag`), so the platform's pool can tell an exit it already holds from the tag it kept
   * when the proxy was added, without unsealing any entry. Kept beside the pool's record; it says
   * nothing of the address without the key. null for a value that is not a proxy address. */
  proxyExitTag(proxyUrl: string): string | null {
    let identity: string;
    try {
      identity = proxyExitIdentity(proxyUrl);
    } catch {
      return null;
    }
    return keyedTag(this.key, "proxy-exit", identity);
  }

  /** The exit tag (`proxyExitTag`) of a proxy entry already saved, read inside the store like
   * `entryHolding`: never the value, no use recorded (nothing leaves the store but the tag). null
   * for an entry that is missing, not a proxy, or cannot be read. So the pool can refuse to adopt
   * an exit it holds before it reads the value to copy it. */
  async proxyEntryTag(scope: string, id: string): Promise<string | null> {
    const row = await this.row(scope, id);
    if (row?.kind !== "proxy") return null;
    const secret = this.open_(row);
    return secret && "proxyUrl" in secret ? this.proxyExitTag(secret.proxyUrl) : null;
  }

  /** The id of an entry of the scope holding `value` (a proxy URL, compared in its canonical
   * spelling), so the same value is not entered twice; never the value. */
  async entryHolding(scope: string, kind: PlatformKind, value: string): Promise<string | null> {
    const canonical = (text: string) => {
      try {
        return kind === "proxy" ? canonicalProxy(text) : text;
      } catch {
        return undefined;
      }
    };
    const wanted = canonical(value);
    if (wanted === undefined) return null;
    for (const row of await this.scopeRows(scope)) {
      if (row.kind !== kind) continue;
      const secret = this.open_(row);
      let held: string | undefined;
      if (secret && "proxyUrl" in secret) held = secret.proxyUrl;
      if (held !== undefined && canonical(held) === wanted) return row.id;
    }
    return null;
  }

  // ---- writing -------------------------------------------------------------------------
  private async audit(
    scope: string,
    row: Pick<EntryRow, "id" | "kind" | "site" | "username" | "meta">,
    event: CredentialAuditEvent,
    actor: CredentialActor,
    extra: {
      part?: CredentialPart | null;
      purpose?: CredentialPurpose | null;
      account?: Named;
      outcome?: { ok: boolean; reason: string | null } | null;
      at?: string;
    } = {},
    via?: StoreQuery,
  ) {
    const account = extra.account ?? null;
    const sql =
      "INSERT INTO credential_audit(scope,id,at,entry_id,entry_kind,entry_name,event,part,purpose,actor,account,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)";
    const params = [
      scope,
      randomUUID(),
      extra.at ?? now(),
      row.id,
      row.kind,
      entryName(row),
      event,
      extra.part ?? null,
      extra.purpose ?? null,
      JSON.stringify(actor),
      JSON.stringify(account),
      JSON.stringify(extra.outcome ?? null),
    ];
    if (via) await via(sql, params);
    else await this.query(sql, params);
  }
  private accountOf(row: Pick<EntryRow, "used_by">) {
    const account = row.used_by.find((item) => item.type === "account");
    return account?.type === "account" ? account.environmentId : null;
  }
  /**
   * `before`'s value stops serving some of its users (`after` holds another value, or it serves
   * fewer users, or none): each user that had it keeps it in its mask set (the ciphertext as it
   * was, opened under the entry's own scope and id) until `forgetRetired`, because a desktop the
   * old value was written into may still hold it.
   */
  private async retire(
    scope: string,
    before: EntryRow,
    via: StoreQuery,
    after?: EntryRow,
    users?: CredentialUsedBy[],
  ) {
    const lost =
      users ??
      (after && after.secret !== before.secret
        ? before.used_by
        : before.used_by.filter(
            (item) => !after?.used_by.some((other) => sameUsedBy(other, item)),
          ));
    for (const user of lost)
      await via(
        "INSERT INTO credential_retired(scope,id,entry_id,used_by,secret,at) VALUES($1,$2,$3,$4::jsonb,$5,$6)",
        [scope, randomUUID(), before.id, JSON.stringify(user), before.secret, now()],
      );
  }
  /** A desktop of `usedBy` has been rewritten with its current values: the values it no longer
   * holds need no masking any more. */
  async forgetRetired(scope: string, usedBy: CredentialUsedBy) {
    assertScope(scope);
    await this.query("DELETE FROM credential_retired WHERE scope=$1 AND used_by @> $2::jsonb", [
      scope,
      JSON.stringify(usedBy),
    ]);
  }
  /** The account with its current name, looked up before any transaction starts (the lookup
   * reads the records table, which a transaction here must not wait on). */
  private async named(scope: string, environmentId: string | null): Promise<Named> {
    if (!environmentId) return null;
    return { environmentId, name: await this.accountName(scope, environmentId).catch(() => null) };
  }
  private async insert(row: EntryRow, via?: StoreQuery) {
    const sql =
      "INSERT INTO credential_entries(scope,id,kind,label,site,username,meta,secret,used_by,last_used_at,last_result,created_at,replaced_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14)";
    const params = [
      row.scope,
      row.id,
      row.kind,
      row.label,
      row.site,
      row.username,
      JSON.stringify(row.meta),
      row.secret,
      JSON.stringify(row.used_by),
      row.last_used_at,
      JSON.stringify(row.last_result),
      row.created_at,
      row.replaced_at,
      row.updated_at,
    ];
    if (via) await via(sql, params);
    else await this.query(sql, params);
  }
  private async update(row: EntryRow, expectedUpdatedAt: string, via?: StoreQuery) {
    const sql =
      "UPDATE credential_entries SET label=$3,username=$4,meta=$5::jsonb,secret=$6,used_by=$7::jsonb,replaced_at=$8,updated_at=$9 WHERE scope=$1 AND id=$2 AND updated_at=$10 RETURNING id AS data";
    const params = [
      row.scope,
      row.id,
      row.label,
      row.username,
      JSON.stringify(row.meta),
      row.secret,
      JSON.stringify(row.used_by),
      row.replaced_at,
      row.updated_at,
      expectedUpdatedAt,
    ];
    const result = via ? await via(sql, params) : await this.query(sql, params);
    if (!result.rows.length)
      throw new AppError("This credential changed while saving. Try again.", 409);
  }
  /** Builds the metadata and ciphertext of a site login from its secret parts. */
  private sealLogin(
    scope: string,
    id: string,
    secret: { password?: string; totpSeed?: string; cookies?: SiteCookie[] },
    parameters: TotpParameters | undefined,
  ) {
    const meta: SiteLoginParts & { totpParameters?: TotpParameters } = {
      password: !!secret.password,
      totp: secret.totpSeed && parameters ? { ...parameters } : null,
      cookies: secret.cookies ? { count: secret.cookies.length } : null,
      ...(secret.totpSeed && parameters ? { totpParameters: parameters } : {}),
    };
    return { meta, secret: seal(this.key, scope, id, JSON.stringify(secret)) };
  }
  /** A new entry of the scope. Checks every value; a site login needs a password or cookies, a
   * password needs a user name and a two-factor seed needs a password. A site login is used by
   * at most one account (or the project), and only once per site; an account uses exactly one
   * entry of each platform kind, so linking one unlinks the account's previous one. */
  async create(
    scope: string,
    input: CredentialInput,
    actor: CredentialActor,
    options: {
      event?: "added" | "migrated";
      /** Runs first inside the write, under the scope's lock (which a move also takes): throws
       * when a user named is no longer of this project. */
      check?: (via: StoreQuery) => Promise<void>;
    } = {},
  ) {
    assertScope(scope);
    const usedBy = input.usedBy ?? [];
    checkUsedBy(usedBy);
    const label = validateLabel(input.label) ?? null;
    const id = randomUUID();
    const at = now();
    let row: EntryRow;
    if (isPlatformKind(input.kind))
      await this.platformGuard(scope, actor, { kind: input.kind, action: "create", usedBy });
    if (input.kind === "proxy") {
      const proxyUrl = validateProxyUrl(input.proxyUrl);
      if (!proxyUrl) throw new AppError("proxyUrl is required for a proxy", 400);
      row = this.newRow(scope, id, "proxy", label, null, null, proxyMeta(proxyUrl), usedBy, at, {
        proxyUrl,
      });
    } else if (input.kind === "site_login") {
      const site = validateSite(input.site);
      if (usedBy.length > 1)
        throw new AppError("A site login is used by one account or by the project", 400);
      const username = validateUsername(input.username) ?? null;
      const password = validatePassword(input.password) ?? undefined;
      const seed = validateTotpSeed(input.totpSeed) ?? undefined;
      const cookies = validateCookies(input.cookies, site) ?? undefined;
      loginGap({ username, password: !!password, totp: !!seed, cookies: !!cookies });
      const sealed = this.sealLogin(
        scope,
        id,
        { password, totpSeed: seed?.seed, cookies },
        seed?.parameters,
      );
      row = {
        scope,
        id,
        kind: "site_login",
        label,
        site,
        username,
        meta: sealed.meta,
        secret: sealed.secret,
        used_by: usedBy,
        last_used_at: null,
        last_result: null,
        created_at: at,
        replaced_at: null,
        updated_at: at,
      };
    } else if (input.kind === "mailbox") {
      // The address is the row's user name (shown, searched);
      // the servers are metadata; the password is the secret.
      const settings = validateMailbox(input);
      const password = validatePassword(input.password);
      if (!password) throw new AppError("password is required for a mailbox", 400);
      row = this.newRow(
        scope,
        id,
        "mailbox",
        label,
        null,
        settings.address,
        { ...settings, password: true } satisfies MailboxParts,
        usedBy,
        at,
        { mailboxPassword: password },
      );
    } else throw new AppError("kind must be one of the credential kinds", 400);
    const account = await this.named(scope, this.accountOf(row));
    const users = await Promise.all(
      usedBy.map(async (user) => ({
        user,
        named: user.type === "account" ? await this.named(scope, user.environmentId) : null,
      })),
    );
    await this.exclusively(`scope:${scope}`, async (via) => {
      await options.check?.(via);
      if (row.kind === "site_login" && usedBy.length) {
        const clash = (await this.scopeRows(scope, via)).find(
          (other) =>
            other.kind === "site_login" &&
            other.site === row.site &&
            other.used_by.some((item) => sameUsedBy(item, usedBy[0])),
        );
        if (clash)
          throw new AppError(
            `There is already a ${row.site} login for this ${usedBy[0].type === "account" ? "account" : "project"}; replace it instead`,
            409,
          );
      }
      await this.insert(row, via);
      await this.audit(scope, row, options.event ?? "added", actor, { account }, via);
      if (row.kind !== "site_login")
        for (const { user, named } of users)
          await this.serveOnly(scope, row, user, actor, via, named);
    });
    return this.view(row);
  }
  private newRow(
    scope: string,
    id: string,
    kind: CredentialKind,
    label: string | null,
    site: string | null,
    username: string | null,
    meta: CredentialParts,
    usedBy: CredentialUsedBy[],
    at: string,
    secret: Secret,
  ): EntryRow {
    return {
      scope,
      id,
      kind,
      label,
      site,
      username,
      meta,
      secret: seal(this.key, scope, id, JSON.stringify(secret)),
      used_by: usedBy,
      last_used_at: null,
      last_result: null,
      created_at: at,
      replaced_at: null,
      updated_at: at,
    };
  }
  /** One entry of a kind per account or project: `row` now serves `user`,
   * so every other entry of its kind stops serving it. */
  private async serveOnly(
    scope: string,
    row: EntryRow,
    user: CredentialUsedBy,
    actor: CredentialActor,
    via: StoreQuery,
    account: Named,
  ) {
    for (const other of await this.scopeRows(scope, via)) {
      if (other.id === row.id || other.kind !== row.kind) continue;
      if (!other.used_by.some((item) => sameUsedBy(item, user))) continue;
      const next: EntryRow = {
        ...other,
        used_by: other.used_by.filter((item) => !sameUsedBy(item, user)),
        updated_at: now(),
      };
      await this.update(next, other.updated_at, via);
      await this.audit(scope, other, "unlinked", actor, { account }, via);
      await this.retire(scope, other, via, next);
    }
  }
  /** Replaces parts of an entry: a part left out is kept, null clears it. A value is never
   * returned; the entry's metadata is. `purpose` goes on the history line
   * (`cookie_export`: the server saved the cookies of a proven sign-in). */
  async replace(
    scope: string,
    id: string,
    patch: CredentialPatch,
    actor: CredentialActor,
    options: { purpose?: CredentialPurpose } = {},
  ) {
    const before = await this.row(scope, id);
    if (!before) throw notFound();
    if (isPlatformKind(before.kind))
      await this.platformGuard(scope, actor, { kind: before.kind, action: "replace" });
    const account = await this.named(scope, this.accountOf(before));
    return this.exclusively(`scope:${scope}`, async (via) => {
      const row = await this.row(scope, id, via);
      if (!row) throw notFound();
      const label = patch.label === undefined ? row.label : (validateLabel(patch.label) ?? null);
      const at = now();
      let next: EntryRow = { ...row, label, updated_at: at };
      const secretChanged = Object.entries(patch).some(
        ([key, value]) => key !== "label" && key !== "username" && value !== undefined,
      );
      const parts: CredentialPart[] = [];
      // A mailbox's servers changed (metadata; recorded as a replacement too).
      let serversChanged = false;
      if (row.kind === "proxy" && patch.proxyUrl !== undefined) {
        const proxyUrl = validateProxyUrl(patch.proxyUrl);
        if (!proxyUrl) throw new AppError("A proxy entry needs its URL; delete it instead", 400);
        next = {
          ...next,
          meta: proxyMeta(proxyUrl),
          secret: seal(this.key, scope, id, JSON.stringify({ proxyUrl })),
          replaced_at: at,
        };
        parts.push("proxy_url");
      } else if (row.kind === "mailbox") {
        // The servers change without the password; the password alone changes too.
        const meta = row.meta as MailboxParts;
        const fields = ["address", "smtpHost", "smtpPort", "smtpSecure", "imapHost", "imapPort"];
        const serversGiven = fields.some((f) => patch[f as keyof CredentialPatch] !== undefined);
        if (serversGiven) {
          const settings = validateMailbox({
            address: patch.address === undefined ? meta.address : patch.address,
            smtpHost: patch.smtpHost === undefined ? meta.smtpHost : patch.smtpHost,
            smtpPort: patch.smtpPort === undefined ? meta.smtpPort : patch.smtpPort,
            // A new port without a TLS mode takes the mode that port implies.
            smtpSecure:
              patch.smtpSecure !== undefined
                ? patch.smtpSecure
                : patch.smtpPort !== undefined
                  ? null
                  : meta.smtpSecure,
            imapHost: patch.imapHost === undefined ? meta.imapHost : patch.imapHost,
            imapPort: patch.imapPort === undefined ? meta.imapPort : patch.imapPort,
          });
          next = { ...next, username: settings.address, meta: { ...settings, password: true } };
          serversChanged = true;
        }
        if (patch.password !== undefined) {
          const password = validatePassword(patch.password);
          if (!password)
            throw new AppError("A mailbox entry needs its password; delete it instead", 400);
          next = {
            ...next,
            secret: seal(this.key, scope, id, JSON.stringify({ mailboxPassword: password })),
            replaced_at: at,
          };
          parts.push("mailbox_password");
        }
      } else if (row.kind === "site_login") {
        const username =
          patch.username === undefined ? row.username : (validateUsername(patch.username) ?? null);
        next.username = username;
        if (patch.username !== undefined && username !== row.username) parts.push("username");
        if (secretChanged) {
          const current = this.open_(row) as
            | { password?: string; totpSeed?: string; cookies?: SiteCookie[] }
            | undefined;
          if (!current && (patch.password === undefined || patch.cookies === undefined))
            throw new AppError(
              "This login was saved with another credential key and can't be read: enter its password and cookies again (or clear them), or delete it",
              409,
            );
          const base = current ?? {};
          const password =
            patch.password === undefined
              ? base.password
              : (validatePassword(patch.password) ?? undefined);
          const seed =
            patch.totpSeed === undefined
              ? base.totpSeed
                ? { seed: base.totpSeed, parameters: row.meta.totpParameters as TotpParameters }
                : undefined
              : (validateTotpSeed(patch.totpSeed) ?? undefined);
          const cookies =
            patch.cookies === undefined
              ? base.cookies
              : (validateCookies(patch.cookies, row.site ?? "") ?? undefined);
          if (patch.password !== undefined) parts.push("password");
          if (patch.totpSeed !== undefined) parts.push("totp_seed");
          if (patch.cookies !== undefined) parts.push("cookies");
          const sealed = this.sealLogin(
            scope,
            id,
            { password, totpSeed: seed?.seed, cookies },
            seed?.parameters,
          );
          // 更换于 moves only when a part got a new value; clearing one is not a replacement.
          const replacedAny = [patch.password, patch.totpSeed, patch.cookies].some(
            (value) => value !== undefined && value !== null,
          );
          next = {
            ...next,
            meta: sealed.meta,
            secret: sealed.secret,
            replaced_at: replacedAny ? at : row.replaced_at,
          };
        }
        const meta = next.meta as SiteLoginParts;
        loginGap(
          {
            username: next.username,
            password: meta.password,
            totp: !!meta.totp,
            cookies: !!meta.cookies,
          },
          true,
        );
      } else if (secretChanged)
        throw new AppError(`Those fields do not belong to a ${row.kind} entry`, 400);
      await this.update(next, row.updated_at, via);
      const cleared = (part: CredentialPart) => {
        const field = {
          username: "username",
          password: "password",
          totp_seed: "totpSeed",
          cookies: "cookies",
        }[part as string] as keyof CredentialPatch | undefined;
        return !!field && patch[field] === null;
      };
      if (parts.length || label !== row.label || serversChanged)
        for (const part of parts.length ? parts : [null])
          await this.audit(
            scope,
            next,
            part && cleared(part) ? "cleared" : "replaced",
            actor,
            { part, account, purpose: options.purpose ?? null },
            via,
          );
      await this.retire(scope, row, via, next);
      return { view: this.view(next), parts };
    });
  }
  /** Removes the whole entry. */
  async remove(scope: string, id: string, actor: CredentialActor) {
    const before = await this.row(scope, id);
    if (!before) throw notFound();
    if (isPlatformKind(before.kind))
      await this.platformGuard(scope, actor, { kind: before.kind, action: "remove" });
    const account = await this.named(scope, this.accountOf(before));
    await this.exclusively(`scope:${scope}`, async (via) => {
      const row = await this.row(scope, id, via);
      if (!row) throw notFound();
      await via("DELETE FROM credential_entries WHERE scope=$1 AND id=$2", [scope, id]);
      await this.audit(scope, row, "removed", actor, { account }, via);
      await this.retire(scope, row, via);
    });
  }
  /** Points an entry at `usedBy` instead of (`replace`) or besides what it served. A site login
   * serves one account or the project, so it always replaces. */
  async link(
    scope: string,
    id: string,
    usedBy: CredentialUsedBy,
    actor: CredentialActor,
    options: { check?: (via: StoreQuery) => Promise<void> } = {},
  ) {
    checkUsedBy([usedBy]);
    const account = await this.named(
      scope,
      usedBy.type === "account" ? usedBy.environmentId : null,
    );
    const before = await this.row(scope, id);
    const seen = before?.used_by ?? [];
    if (before?.kind === "proxy" && !before.used_by.some((item) => sameUsedBy(item, usedBy)))
      await this.platformGuard(scope, actor, {
        kind: "proxy",
        action: "link",
        usedBy: seen.map((item) => ({ ...item })),
      });
    return this.exclusively(`scope:${scope}`, async (via) => {
      await options.check?.(via);
      const row = await this.row(scope, id, via);
      if (!row) throw notFound();
      if (row.used_by.some((item) => sameUsedBy(item, usedBy))) return this.view(row);
      // Checked again under the lock: what the guard was shown is what the entry serves.
      if (row.kind === "proxy" && JSON.stringify(row.used_by) !== JSON.stringify(seen))
        throw new AppError("这个出口刚刚被占用了，请重新选择", 409);
      if (row.kind === "site_login") {
        const clash = (await this.scopeRows(scope, via)).find(
          (other) =>
            other.id !== row.id &&
            other.kind === "site_login" &&
            other.site === row.site &&
            other.used_by.some((item) => sameUsedBy(item, usedBy)),
        );
        if (clash)
          throw new AppError(`There is already a ${row.site} login there; replace it instead`, 409);
      }
      const next: EntryRow = {
        ...row,
        used_by: row.kind === "site_login" ? [usedBy] : [...row.used_by, usedBy],
        updated_at: now(),
      };
      await this.update(next, row.updated_at, via);
      await this.audit(scope, next, "linked", actor, { account }, via);
      await this.retire(scope, row, via, next);
      if (row.kind !== "site_login") await this.serveOnly(scope, next, usedBy, actor, via, account);
      return this.view(next);
    });
  }
  async unlink(scope: string, id: string, usedBy: CredentialUsedBy, actor: CredentialActor) {
    const account = await this.named(
      scope,
      usedBy.type === "account" ? usedBy.environmentId : null,
    );
    return this.exclusively(`scope:${scope}`, async (via) => {
      const row = await this.row(scope, id, via);
      if (!row) throw notFound();
      if (!row.used_by.some((item) => sameUsedBy(item, usedBy))) return this.view(row);
      const next: EntryRow = {
        ...row,
        used_by: row.used_by.filter((item) => !sameUsedBy(item, usedBy)),
        updated_at: now(),
      };
      await this.update(next, row.updated_at, via);
      await this.audit(scope, next, "unlinked", actor, { account }, via);
      await this.retire(scope, row, via, next);
      return this.view(next);
    });
  }

  // ---- using ---------------------------------------------------------------------------
  /**
   * The one door a value leaves the store through. Reads the part (a two-factor code is computed
   * here, at this moment, from the saved seed), hands it to `sink` and records the use (what, by
   * whom, for which purpose, how it went), never the value. The value is not returned and is
   * never put in an error: a sink that fails is recorded as failed and its error is rethrown.
   */
  async use<T>(
    scope: string,
    ref: { id: string; part: CredentialPart },
    purpose: CredentialPurpose,
    actor: CredentialActor,
    sink: (value: string) => Promise<T>,
    options: { outcome?: (result: T) => { ok: boolean; reason: string | null } } = {},
  ): Promise<T> {
    const row = await this.row(scope, ref.id);
    if (!row) throw new CredentialUseError("no_saved_login");
    let value: string | undefined;
    if (ref.part === "username") value = row.username ?? undefined;
    else {
      const secret = this.open_(row);
      if (!secret) throw new CredentialUseError("unreadable");
      if (ref.part === "proxy_url" && "proxyUrl" in secret) value = canonicalProxy(secret.proxyUrl);
      else if (ref.part === "mailbox_password" && "mailboxPassword" in secret)
        value = secret.mailboxPassword;
      else if (row.kind === "site_login") {
        const login = secret as { password?: string; totpSeed?: string; cookies?: SiteCookie[] };
        if (ref.part === "password") value = login.password;
        else if (ref.part === "cookies" && login.cookies) value = JSON.stringify(login.cookies);
        else if (ref.part === "totp_code" && login.totpSeed)
          value = totp(
            base32Bytes(login.totpSeed),
            Date.now() / 1000,
            row.meta.totpParameters as TotpParameters,
          );
      }
    }
    if (!value) throw new CredentialUseError("field_not_saved");
    const at = now();
    const account = await this.named(scope, this.accountOf(row));
    // 上次使用 is the last attempt, whether it worked or not; the trail says how it went.
    const record = async (outcome: { ok: boolean; reason: string | null }) => {
      await this.audit(scope, row, "used", actor, {
        part: ref.part,
        purpose,
        account,
        outcome,
        at,
      });
      await this.query("UPDATE credential_entries SET last_used_at=$3 WHERE scope=$1 AND id=$2", [
        scope,
        row.id,
        at,
      ]);
    };
    let result: T;
    try {
      result = await sink(value);
    } catch (error) {
      await record({ ok: false, reason: useFailure(error) }).catch(() => {});
      throw error;
    }
    await record(options.outcome?.(result) ?? { ok: true, reason: null });
    return result;
  }
  /** How an entry went the last time it was used (a sign-in, a proxy check, a solve). */
  async recordResult(
    scope: string,
    id: string,
    result: Omit<CredentialResult, "at"> & { at?: string },
    actor: CredentialActor,
    options: { purpose?: CredentialPurpose; account?: string | null } = {},
  ) {
    const row = await this.row(scope, id);
    if (!row) return;
    const saved: CredentialResult = { ...result, at: result.at ?? now() };
    await this.query(
      "UPDATE credential_entries SET last_result=$3::jsonb WHERE scope=$1 AND id=$2",
      [scope, id, JSON.stringify(saved)],
    );
    await this.audit(scope, row, "result", actor, {
      purpose: options.purpose ?? null,
      account: await this.named(scope, options.account ?? this.accountOf(row)),
      outcome: { ok: saved.ok, reason: saved.ok ? null : saved.status },
      at: saved.at,
    });
    if (this.onResult) {
      const after = await this.row(scope, id);
      if (after)
        await this.onResult(scope, this.view(after), saved, options.purpose, actor).catch((error) =>
          console.warn(`[OpenMuse] result hook failed: ${(error as Error).message}`),
        );
    }
  }
  /**
   * `text` with every saved secret of `usedBy` (its logins' passwords, seeds and cookie values,
   * its proxy URL with its user name and password, its mailbox password) replaced by `***`; null
   * when one of those entries cannot be read, so the caller withholds the text whole. `cut`:
   * the text was cut short, so a secret may end it half-written; a tail that is the beginning of
   * one is masked too.
   */
  async scrub(
    scope: string,
    usedBy: CredentialUsedBy,
    text: string,
    options: { cut?: boolean } = {},
  ): Promise<string | null> {
    if (!text) return text;
    const secrets = new Set<string>();
    const held: Pick<EntryRow, "scope" | "id" | "secret">[] = (await this.scopeRows(scope)).filter(
      (row) => row.used_by.some((item) => sameUsedBy(item, usedBy)),
    );
    // Values it held before (replaced, cleared, deleted, unlinked) that a desktop may still hold.
    held.push(
      ...(
        await this.rows<{ entry_id: string; secret: string }>(
          "SELECT jsonb_build_object('entry_id',entry_id,'secret',secret) AS data FROM credential_retired WHERE scope=$1 AND used_by @> $2::jsonb",
          [scope, JSON.stringify(usedBy)],
        )
      ).map((row) => ({ scope, id: row.entry_id, secret: row.secret })),
    );
    for (const row of held) {
      const secret = this.open_(row);
      if (!secret) return null;
      if ("proxyUrl" in secret) {
        secrets.add(secret.proxyUrl);
        try {
          const url = new URL(secret.proxyUrl);
          for (const part of [url.username, url.password])
            for (const s of spellings(part)) secrets.add(s);
          if (url.username) secrets.add(`${url.username}:${url.password}`);
        } catch {
          // Saved under older rules; the whole URL is still masked.
        }
      } else if ("mailboxPassword" in secret) {
        for (const s of spellings(secret.mailboxPassword)) secrets.add(s);
      } else {
        const login = secret as { password?: string; totpSeed?: string; cookies?: SiteCookie[] };
        if (login.password) for (const s of spellings(login.password)) secrets.add(s);
        if (login.totpSeed) secrets.add(login.totpSeed);
        // Short cookie values (flags, languages) are not secrets and would garble the text.
        for (const cookie of login.cookies ?? [])
          if (cookie.value.length >= 8) secrets.add(cookie.value);
      }
    }
    let out = text;
    const all = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of all) out = out.split(secret).join("***");
    if (options.cut) {
      let tail = 0;
      for (const secret of all)
        for (let k = Math.min(secret.length - 1, out.length); k > tail; k--)
          if (out.endsWith(secret.slice(0, k))) {
            tail = k;
            break;
          }
      if (tail) out = `${out.slice(0, -tail)}***`;
    }
    return out;
  }

  // ---- accounts moving between projects --------------------------------------------------
  /**
   * An account moves from one project to another (the owner's own action): its site logins,
   * and the platform entries only it uses, move with it (sealed again for the new scope);
   * a proxy or key other accounts of the old project still use is copied (a new entry with the
   * same value in the new project) and the old one stops serving it. Its open requests are
   * withdrawn in the old project (returned, so whoever asked can be told) and opened afresh,
   * with no source, in the new one. Both projects' histories record it. All in one transaction,
   * with `inside` (the caller's own part of the move) last.
   */
  async moveAccount(
    from: string,
    to: string,
    environmentId: string,
    actor: CredentialActor,
    options: { inside?: (via: StoreQuery) => Promise<void> } = {},
  ): Promise<CredentialRequestView[]> {
    assertScope(from);
    assertScope(to);
    if (from === to) {
      await options.inside?.(this.db.query);
      return [];
    }
    const user = accountUser(environmentId);
    const account = await this.named(from, environmentId);
    await this.open();
    return this.db.transaction(async (via) => {
      await via("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `openmuse:credentials:scope:${from}`,
      ]);
      await via("SELECT pg_advisory_xact_lock(hashtext($1))", [`openmuse:credentials:scope:${to}`]);
      const at = now();
      for (const row of await this.scopeRows(from, via)) {
        if (!row.used_by.some((item) => sameUsedBy(item, user))) continue;
        const plain = unseal(this.key, from, row.id, row.secret);
        const shared = row.kind !== "site_login" && row.used_by.length > 1;
        const id = shared ? randomUUID() : row.id;
        const moved: EntryRow = {
          ...row,
          scope: to,
          id,
          // Unreadable stays unreadable: the ciphertext travels as it is.
          secret: plain === undefined ? row.secret : seal(this.key, to, id, plain),
          used_by: [user],
          updated_at: at,
          ...(shared
            ? { created_at: at, last_used_at: null, last_result: null, replaced_at: null }
            : {}),
        };
        // An id already taken in the target scope (it never is: ids are random) gets a new one.
        await this.insert(moved, via);
        await this.audit(to, moved, shared ? "copied_in" : "moved_in", actor, { account, at }, via);
        if (shared) {
          const kept: EntryRow = {
            ...row,
            used_by: row.used_by.filter((item) => !sameUsedBy(item, user)),
            updated_at: at,
          };
          await this.update(kept, row.updated_at, via);
          await this.audit(from, row, "unlinked", actor, { account, at }, via);
        } else {
          await via("DELETE FROM credential_entries WHERE scope=$1 AND id=$2", [from, row.id]);
          await this.audit(from, row, "moved_out", actor, { account, at }, via);
        }
      }
      // Values it held before stay masked for it in its new project.
      for (const retired of await this.rows<{ id: string; entry_id: string; secret: string }>(
        "SELECT jsonb_build_object('id',id,'entry_id',entry_id,'secret',secret) AS data FROM credential_retired WHERE scope=$1 AND used_by @> $2::jsonb",
        [from, JSON.stringify(user)],
        via,
      )) {
        const plain = unseal(this.key, from, retired.entry_id, retired.secret);
        await via("DELETE FROM credential_retired WHERE scope=$1 AND id=$2", [from, retired.id]);
        if (plain === undefined) continue;
        const id = randomUUID();
        await via(
          "INSERT INTO credential_retired(scope,id,entry_id,used_by,secret,at) VALUES($1,$2,$3,$4::jsonb,$5,$6)",
          [to, id, id, JSON.stringify(user), seal(this.key, to, id, plain), at],
        );
      }
      // Its open requests stay in the old project's history, withdrawn; the new project gets
      // them afresh with no source (who asked belongs to the old project).
      const withdrawn = await this.rows<RequestRow>(
        "UPDATE credential_requests r SET status='withdrawn',closed_at=$3 WHERE scope=$1 AND status='open' AND for_target @> $2::jsonb RETURNING to_jsonb(r) AS data",
        [from, JSON.stringify(user), at],
        via,
      );
      for (const request of withdrawn)
        await via(
          "INSERT INTO credential_requests(scope,id,site,for_target,by_source,at,status,closed_at) SELECT $1,$2,$3,$4::jsonb,'{}'::jsonb,$5,'open',NULL WHERE NOT EXISTS (SELECT 1 FROM credential_requests WHERE scope=$1 AND site=$3 AND status='open' AND for_target @> $4::jsonb)",
          [to, randomUUID(), request.site, JSON.stringify(request.for_target), at],
        );
      // The caller's own part of the move (the account record), in the same transaction: when it
      // throws, nothing of the move happened.
      await options.inside?.(via);
      return withdrawn.map((row) => this.requestView(row));
    });
  }
  /** An account is deleted: the entries only it used go, shared ones stop serving it, its open
   * requests are withdrawn. */
  async removeAccount(scope: string, environmentId: string, actor: CredentialActor) {
    const user = accountUser(environmentId);
    const account = await this.named(scope, environmentId);
    // In a space the platform sets up, its platform entries are the
    // platform's, not the account's: the account going only frees them.
    const platform = (await this.platformScope?.(scope)) ?? false;
    await this.exclusively(`scope:${scope}`, async (via) => {
      for (const row of await this.scopeRows(scope, via)) {
        if (!row.used_by.some((item) => sameUsedBy(item, user))) continue;
        const kept = platform && isPlatformKind(row.kind);
        if (!kept && (row.kind === "site_login" || row.used_by.length === 1)) {
          await via("DELETE FROM credential_entries WHERE scope=$1 AND id=$2", [scope, row.id]);
          await this.audit(scope, row, "removed", actor, { account }, via);
        } else {
          const next: EntryRow = {
            ...row,
            used_by: row.used_by.filter((item) => !sameUsedBy(item, user)),
            updated_at: now(),
          };
          await this.update(next, row.updated_at, via);
          await this.audit(scope, row, "unlinked", actor, { account }, via);
        }
      }
      await via(
        "UPDATE credential_requests SET status='withdrawn',closed_at=$3 WHERE scope=$1 AND status='open' AND for_target @> $2::jsonb",
        [scope, JSON.stringify(user), now()],
      );
    });
  }
  /** A project is deleted (its accounts have already moved back to the default project): what is
   * left of its entries, history and requests goes. */
  async purgeScope(scope: string) {
    assertScope(scope);
    await this.exclusively(`scope:${scope}`, async (via) => {
      for (const table of [
        "credential_entries",
        "credential_audit",
        "credential_requests",
        "credential_retired",
      ])
        await via(`DELETE FROM ${table} WHERE scope=$1`, [scope]);
    });
  }

  // ---- a project moving to another space (tenancy/move-projects.ts) ----------------------
  /** How many rows the scope has in each of the store's tables (the move tool's report and its
   * check after the move); never a value. */
  async scopeCounts(
    scope: string,
    via?: StoreQuery,
  ): Promise<{ entries: number; audit: number; requests: number; retired: number }> {
    assertScope(scope);
    const [row] = await this.rows<Record<string, string>>(
      "SELECT jsonb_build_object('entries',(SELECT count(*) FROM credential_entries WHERE scope=$1),'audit',(SELECT count(*) FROM credential_audit WHERE scope=$1),'requests',(SELECT count(*) FROM credential_requests WHERE scope=$1),'retired',(SELECT count(*) FROM credential_retired WHERE scope=$1)) AS data",
      [scope],
      via,
    );
    return {
      entries: Number(row?.entries ?? 0),
      audit: Number(row?.audit ?? 0),
      requests: Number(row?.requests ?? 0),
      retired: Number(row?.retired ?? 0),
    };
  }
  /** Opens every entry of the scope (the plaintext stays here): how many there are and the ids
   * of those that do not open with this key under this scope. `usedBy` narrows it to the
   * entries one account (or the project) uses. */
  async checkScope(
    scope: string,
    via?: StoreQuery,
    usedBy?: CredentialUsedBy,
  ): Promise<{ entries: number; unreadable: string[] }> {
    const rows = (await this.scopeRows(scope, via)).filter(
      (row) => !usedBy || row.used_by.some((item) => sameUsedBy(item, usedBy)),
    );
    return {
      entries: rows.length,
      unreadable: rows
        .filter((row) => unseal(this.key, row.scope, row.id, row.secret) === undefined)
        .map((row) => row.id),
    };
  }
  /** What still serves or waits for an account in a scope: entries it uses and its open
   * requests (after it moved away both must be 0; its history rows stay). */
  async accountTraces(scope: string, environmentId: string, via?: StoreQuery) {
    assertScope(scope);
    const user = JSON.stringify([accountUser(environmentId)]);
    const [row] = await this.rows<Record<string, string>>(
      "SELECT jsonb_build_object('entries',(SELECT count(*) FROM credential_entries WHERE scope=$1 AND used_by @> $2::jsonb),'requests',(SELECT count(*) FROM credential_requests WHERE scope=$1 AND status='open' AND for_target @> $3::jsonb)) AS data",
      [scope, user, JSON.stringify(accountUser(environmentId))],
      via,
    );
    return { entries: Number(row?.entries ?? 0), openRequests: Number(row?.requests ?? 0) };
  }
  /**
   * A whole project moves to another space (the offline move tool, inside its one transaction
   * `via`): every entry keeps its id and is sealed again for the new scope (the additional data
   * binds the scope), each new ciphertext opened again before it is written; the values it held
   * before (retired) likewise; its history and requests follow unchanged. The target scope must
   * be empty and every entry must open with this key, else nothing is written (the caller's
   * transaction rolls back). A retired value this key cannot open is dropped, as a moving account
   * drops it (it can mask nothing).
   */
  async moveScope(from: string, to: string, via: StoreQuery) {
    assertScope(from);
    assertScope(to);
    if (from === to) throw new AppError("A scope cannot move onto itself", 500);
    await via("SELECT pg_advisory_xact_lock(hashtext($1))", [`openmuse:credentials:scope:${from}`]);
    await via("SELECT pg_advisory_xact_lock(hashtext($1))", [`openmuse:credentials:scope:${to}`]);
    const target = await this.scopeCounts(to, via);
    if (target.entries || target.audit || target.requests || target.retired)
      throw new AppError("The target credential scope is not empty", 409);
    let entries = 0;
    for (const row of await this.scopeRows(from, via)) {
      const plain = unseal(this.key, from, row.id, row.secret);
      if (plain === undefined)
        throw new AppError(`Credential entry ${row.id} does not open with this key`, 409);
      const secret = seal(this.key, to, row.id, plain);
      if (unseal(this.key, to, row.id, secret) !== plain)
        throw new AppError(`Credential entry ${row.id} did not open after sealing it again`, 500);
      await via("UPDATE credential_entries SET scope=$3,secret=$4 WHERE scope=$1 AND id=$2", [
        from,
        row.id,
        to,
        secret,
      ]);
      entries++;
    }
    let retired = 0;
    let dropped = 0;
    for (const value of await this.rows<{ id: string; entry_id: string; secret: string }>(
      "SELECT jsonb_build_object('id',id,'entry_id',entry_id,'secret',secret) AS data FROM credential_retired WHERE scope=$1",
      [from],
      via,
    )) {
      const plain = unseal(this.key, from, value.entry_id, value.secret);
      if (plain === undefined) {
        await via("DELETE FROM credential_retired WHERE scope=$1 AND id=$2", [from, value.id]);
        dropped++;
        continue;
      }
      await via("UPDATE credential_retired SET scope=$3,secret=$4 WHERE scope=$1 AND id=$2", [
        from,
        value.id,
        to,
        seal(this.key, to, value.entry_id, plain),
      ]);
      retired++;
    }
    const moved = async (table: "credential_audit" | "credential_requests") =>
      (
        await this.rows<{ id: string }>(
          `UPDATE ${table} SET scope=$2 WHERE scope=$1 RETURNING jsonb_build_object('id',id) AS data`,
          [from, to],
          via,
        )
      ).length;
    return {
      entries,
      retired,
      droppedRetired: dropped,
      audit: await moved("credential_audit"),
      requests: await moved("credential_requests"),
    };
  }

  // ---- history -------------------------------------------------------------------------
  /** The scope's history, newest first, one page at a time; `entry` narrows it to one entry. */
  async history(
    scope: string,
    query: { entry?: string; before?: string; limit?: number } = {},
  ): Promise<CredentialAuditPage> {
    assertScope(scope);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const params: unknown[] = [scope];
    let filter = "";
    if (query.entry) {
      params.push(query.entry);
      filter += ` AND entry_id=$${params.length}`;
    }
    if (query.before) {
      // The cursor is the id of the last row of the earlier page, a random id of this scope. The
      // order behind it (the table's sequence, shared by every scope) never leaves the store: its
      // gaps would count what happened in other projects.
      const [mark] =
        typeof query.before === "string" && query.before.length <= 100
          ? await this.rows<{ at: string; seq: string }>(
              "SELECT jsonb_build_object('at',at,'seq',seq::text) AS data FROM credential_audit WHERE scope=$1 AND id=$2",
              [scope, query.before],
            )
          : [];
      if (!mark) throw new AppError("before must be a cursor from an earlier page", 400);
      params.push(mark.at, mark.seq);
      filter += ` AND (at COLLATE "C" < $${params.length - 1} OR (at COLLATE "C" = $${params.length - 1} AND seq < $${params.length}::bigint))`;
    }
    params.push(limit + 1);
    const rows = await this.rows<{
      id: string;
      at: string;
      entry_id: string;
      entry_kind: CredentialKind;
      entry_name: string;
      event: CredentialAuditEvent;
      part: CredentialPart | null;
      purpose: CredentialPurpose | null;
      actor: CredentialActor;
      account: CredentialAuditRow["account"];
      outcome: CredentialAuditRow["outcome"];
    }>(
      `SELECT to_jsonb(a) - 'seq' AS data FROM credential_audit a WHERE scope=$1${filter} ORDER BY at COLLATE "C" DESC,seq DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit).map(
      (row): CredentialAuditRow => ({
        id: row.id,
        at: row.at,
        entryId: row.entry_id,
        entryKind: row.entry_kind,
        entryName: row.entry_name,
        event: row.event,
        part: row.part,
        purpose: row.purpose,
        actor: row.actor,
        account: row.account,
        outcome: row.outcome,
      }),
    );
    const last = rows[page.length - 1];
    return { rows: page, next: rows.length > limit && last ? last.id : null };
  }

  // ---- requests ------------------------------------------------------------------------
  private requestView(row: RequestRow): CredentialRequestView {
    return {
      id: row.id,
      site: row.site,
      for: { ...row.for_target },
      by: row.by_source,
      at: row.at,
      status: row.status,
    };
  }
  async requests(scope: string, status: CredentialRequestView["status"] | "all" = "open") {
    assertScope(scope);
    const rows = await this.rows<RequestRow>(
      `SELECT to_jsonb(r) AS data FROM credential_requests r WHERE scope=$1${status === "all" ? "" : " AND status=$2"} ORDER BY at DESC,id`,
      status === "all" ? [scope] : [scope, status],
    );
    return rows.map((row) => this.requestView(row));
  }
  /** Something only the owner can give: a login of `site` for an account or the project. One
   * open request per site and target: asking again returns the open one. */
  async openRequest(
    scope: string,
    input: { site: string; for: CredentialUsedBy; by: CredentialRequestView["by"] },
  ) {
    checkUsedBy([input.for]);
    return this.exclusively(`scope:${scope}`, async (via) => {
      const [open] = await this.rows<RequestRow>(
        "SELECT to_jsonb(r) AS data FROM credential_requests r WHERE scope=$1 AND site=$2 AND status='open' AND for_target @> $3::jsonb",
        [scope, input.site, JSON.stringify(input.for)],
        via,
      );
      if (open) return { request: this.requestView(open), created: false };
      const row: RequestRow = {
        scope,
        id: randomUUID(),
        site: input.site,
        for_target: input.for,
        by_source: input.by,
        at: now(),
        status: "open",
        closed_at: null,
      };
      await via(
        "INSERT INTO credential_requests(scope,id,site,for_target,by_source,at,status,closed_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)",
        [
          row.scope,
          row.id,
          row.site,
          JSON.stringify(row.for_target),
          JSON.stringify(row.by_source),
          row.at,
          row.status,
          row.closed_at,
        ],
      );
      return { request: this.requestView(row), created: true };
    });
  }
  /** Closes the open requests for `site` and target: fulfilled (the owner saved the login) or
   * withdrawn (a sign-in succeeded without it); returns them, so whoever asked can be woken. */
  async closeRequests(
    scope: string,
    query: { site: string; for: CredentialUsedBy },
    status: "fulfilled" | "withdrawn",
  ) {
    assertScope(scope);
    const rows = await this.rows<RequestRow>(
      "UPDATE credential_requests r SET status=$4,closed_at=$5 WHERE scope=$1 AND site=$2 AND status='open' AND for_target @> $3::jsonb RETURNING to_jsonb(r) AS data",
      [scope, query.site, JSON.stringify(query.for), status, now()],
    );
    return rows.map((row) => this.requestView(row));
  }
}

const notFound = () => new AppError("Credential not found", 404);
/** Why a sink failed, as the trail shows it: the domain reason a CredentialUseError carries, or
 * the code an AppError was raised with (such as typing_uncertain); never a message with text
 * that could hold a value. */
/** How many entries each scope holds; counts only, for the
 * deploy check (no value, no name). Empty before the store's tables exist. */
export async function credentialCountsByScope(db: Store): Promise<Record<string, number>> {
  const { query } = connectionOf(db);
  const table = await query(
    "SELECT jsonb_build_object('n', count(*)) AS data FROM information_schema.tables WHERE table_name='credential_entries'",
  );
  if (Number(table.rows[0]?.data.n) !== 1) return {};
  const out: Record<string, number> = {};
  for (const row of (
    await query(
      "SELECT jsonb_build_object('scope', scope, 'n', count(*)) AS data FROM credential_entries GROUP BY scope",
    )
  ).rows)
    out[String(row.data.scope)] = Number(row.data.n);
  return out;
}

export function useFailure(error: unknown): string {
  if (error instanceof CredentialUseError) return error.reason;
  if (error instanceof AppError && /^[a-z][a-z0-9_]{0,63}$/.test(error.message))
    return error.message;
  return "failed";
}

/** What a site login must hold to be used: a password needs a user name, a two-factor seed needs
 * a password, and a login needs a password or cookies to sign in with. `existing` relaxes the
 * last rule for an entry that is being changed, not created, so a part can be cleared. */
export function loginGap(
  login: { username: string | null; password: boolean; totp: boolean; cookies: boolean },
  existing = false,
) {
  if (login.password && !login.username)
    throw new AppError("A password needs the user name it belongs to", 400);
  if (login.totp && !login.password)
    throw new AppError("A two-factor key needs the password it goes with", 400);
  if (!existing && !login.password && !login.cookies)
    throw new AppError("A site login needs a password or cookies to sign in with", 400);
}
