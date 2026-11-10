import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { currentActor } from "./request-actor.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// Fork: the live workspace signs in with a username and password instead of a shared access
// key. One admin account lives under the `system` owner; sessions are random tokens of which
// only the hash is stored. The sample workspace stays credential-free (it is loopback-only).
export const usernamePattern = /^[A-Za-z0-9_.-]{1,32}$/;
export const passwordMin = 8;
export const passwordMax = 256;
const sessionTtl = 30 * 24 * 60 * 60 * 1000;
const scryptParams = { N: 16384, r: 8, p: 1 };
const keyLength = 32;
const lockFailures = 5;
const lockMs = 60 * 1000;

export interface AdminRecord {
  id: "admin";
  username: string;
  hash: string;
  salt: string;
  createdAt: string;
  updatedAt: string;
}
interface SessionRecord {
  id: string;
  /** The owner older code acts as: the first space's key for its first user (so a rollback to
   * v0.5a keeps that user's sessions), else a key no older code has data under. Read by v0.5b
   * only to tell the sessions made before users existed (no `userId`). */
  owner: string;
  /** The signed-in user; absent on sessions made before users existed,
   * which belong to the first user and get the id on first use. */
  userId?: string;
  /** When the session ends; 0 on a session of a user other than the first (its end is `until`),
   * so code older than v0.5b, which knows no users and would serve such a session as an empty
   * owner of its own, refuses it as expired after a rollback. */
  expiresAt: number;
  /** The end of a session whose `expiresAt` is 0. */
  until?: number;
  createdAt?: string;
}
/** When a session ends (v0.5b reads `until` first; older code reads only `expiresAt`). */
const sessionEnd = (session: SessionRecord) => session.until ?? session.expiresAt;
/** A person who signs in. Under the `system` owner,
 * with a unique index `usernames/<lowercase name>`. */
export interface UserRecord {
  id: string;
  username: string;
  hash: string;
  salt: string;
  /** The platform operator (the deployment's own admin): may create spaces; never enters another
   * space without an invite. */
  operator: boolean;
  /** A sign-up the operator has not opened yet, or
   * one he refused. Its password hash waits in `pendingHash`/`pendingSalt` while `hash` holds
   * one nothing matches, so no code (an older one after a rollback too) signs it in. */
  status?: "pending" | "rejected" | null;
  pendingHash?: string | null;
  pendingSalt?: string | null;
  createdAt: string;
  updatedAt: string;
}
interface UsernameRecord {
  id: string;
  userId: string;
}
/** The user a session belongs to. */
export interface SessionUser {
  userId: string;
  username: string;
  operator: boolean;
}
export interface Session {
  token: string;
  mode: Config["mode"];
  username: string | null;
  expiresAt: number;
}

/** The first space's key, which every record made before spaces is under. */
export const firstSpaceKey = "local-user";
/** The first user, copied from the one admin account (`system/auth/admin`). */
export const firstUserId = "00000000-0000-4000-8000-000000000001";
/** The sample workspace's one user (never stored, cannot sign in live). */
export const sampleUserId = "sample";
const usernameKey = (username: string) => username.trim().toLowerCase();
const badCredentials = () => new AppError("Username or password is incorrect", 401);
/** What a pending or refused sign-up reads after its correct password. */
export const pendingSignInMessage = "账号正在开通中，管理员配好环境后即可登录";
export const rejectedSignInMessage = "这个账号没有开通，请联系管理员";
/** The right password of a user not opened (or refused): the app adds its status. */
export class WaitingSignIn extends AppError {
  constructor(
    message: string,
    readonly userId: string,
  ) {
    super(message, 403);
  }
}

export function validateUsername(username: string) {
  if (!usernamePattern.test(username))
    throw new AppError(
      "Username must be 1 to 32 characters: letters, digits, dot, dash or underscore",
      422,
    );
  return username;
}
export function validatePassword(password: string) {
  if (typeof password !== "string" || password.length < passwordMin)
    throw new AppError(`Password must be at least ${passwordMin} characters`, 422);
  if (password.length > passwordMax)
    throw new AppError(`Password must be at most ${passwordMax} characters`, 422);
  return password;
}

/** How long a session that checked out is remembered in this process (IDENTITY_CACHE_TTL_MS,
 * milliseconds; 30 s by default, 0 never). */
export function identityKeepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IDENTITY_CACHE_TTL_MS?.trim();
  if (!raw) return 30_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 300_000)
    throw new Error(
      "IDENTITY_CACHE_TTL_MS must be a whole number of milliseconds from 0 to 300000",
    );
  return value;
}

export class Auth {
  private code?: string;
  private readonly failures = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  /** The admin account, if one was set up. */
  admin() {
    return this.db.get<AdminRecord>("system", "auth", "admin");
  }
  async configured() {
    return Boolean(await this.admin());
  }
  /** Live mode needs an account before anyone can sign in. */
  async setupRequired() {
    return this.config.mode === "live" && !(await this.configured());
  }
  /** The one-time code the first visitor must present to create the admin account, so a public
   * deployment cannot be claimed by a stranger. `OPENMUSE_SETUP_CODE` fixes it; otherwise it is
   * random per process and printed to the server log the first time it is needed. */
  setupCode() {
    if (!this.code) {
      this.code = this.config.setupCode?.trim() || randomBytes(4).toString("hex");
      console.log({
        timestamp: new Date().toISOString(),
        context: { phase: "auth" },
        notice: `No admin account yet. Open the web app and finish setup with this code: ${this.code}`,
      });
    }
    return this.code;
  }
  /** Creates the admin account. Live mode requires the setup code unless the values come from
   * the environment at startup (`fromEnv`). */
  async setup(
    input: { username: string; password: string; code?: string },
    options: { fromEnv?: boolean } = {},
  ): Promise<Session> {
    if (this.config.mode !== "live")
      throw new AppError("The sample workspace opens without an account", 409);
    if (await this.configured())
      throw new AppError("An account already exists. Sign in instead.", 409);
    const username = validateUsername(input.username.trim());
    const password = validatePassword(input.password);
    if (!options.fromEnv) {
      const expected = this.setupCode();
      const given = input.code?.trim() ?? "";
      if (given.length !== expected.length || !timingSafeEqual(digest(given), digest(expected)))
        throw new AppError("Setup code is incorrect. It is printed in the server log.", 403);
    }
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, keyLength, scryptParams);
    const now = new Date().toISOString();
    const record: AdminRecord = {
      id: "admin",
      username,
      hash: hash.toString("hex"),
      salt: salt.toString("hex"),
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.db.insertIfAbsent("system", "auth", record)))
      throw new AppError("An account already exists. Sign in instead.", 409);
    // The admin is the first user; the app then makes the first space.
    const user = await this.migrateAdmin();
    if (!user) throw new AppError("Account could not be created", 500);
    return this.issue(user);
  }
  /** Creates the admin account from `OPENMUSE_ADMIN_USERNAME` / `OPENMUSE_ADMIN_PASSWORD` on a
   * first start, for deployments that cannot use the setup page. Silent when an account exists. */
  async bootstrap() {
    const { adminUsername, adminPassword } = this.config;
    if (this.config.mode !== "live" || !adminUsername || !adminPassword) return false;
    if (await this.configured()) return false;
    await this.setup({ username: adminUsername, password: adminPassword }, { fromEnv: true });
    return true;
  }
  /** Signs in. The sample workspace needs no credentials; live mode checks the user's password
   * and locks a client out for a minute after repeated failures (sign-ins and invite links). */
  async login(
    input: { username?: string; password?: string },
    client = "unknown",
  ): Promise<Session> {
    if (this.config.mode !== "live") return this.issue(null);
    this.assertNotLocked(client);
    if (!(await this.admin())) throw new AppError("No account yet. Finish setup first.", 401);
    const username = input.username?.trim() ?? "";
    const user = username ? await this.userByName(username) : null;
    // The same work whether or not the user exists, so the answer time names no user.
    // A sign-up not opened yet is checked against its waiting password.
    const waiting = user?.status ? user.pendingHash && user.pendingSalt : null;
    const salt = user
      ? Buffer.from(waiting ? (user.pendingSalt as string) : user.salt, "hex")
      : randomBytes(16);
    const actual = await scrypt(input.password ?? "", salt, keyLength, scryptParams);
    const expected = user
      ? Buffer.from(waiting ? (user.pendingHash as string) : user.hash, "hex")
      : randomBytes(keyLength);
    if (!user || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      this.failed(client);
      throw badCredentials();
    }
    this.failures.delete(client);
    if (user.status === "pending") throw new WaitingSignIn(pendingSignInMessage, user.id);
    if (user.status) throw new WaitingSignIn(rejectedSignInMessage, user.id);
    return this.issue(user);
  }
  /** Too many failed sign-ins or invite links from this client: 429 for a minute. Fork: refused
   * sign-up codes and refused password reset submissions count the same (signup/routes.ts,
   * password-reset.ts). */
  assertNotLocked(client: string) {
    const locked = this.failures.get(client);
    if (locked && locked.count >= lockFailures && locked.until > Date.now())
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
  }
  /** A sign-in or an invite link that worked clears the client's failures. */
  succeeded(client: string) {
    this.failures.delete(client);
  }
  /** Counts a failed sign-in or a refused invite link against the client. */
  failed(client: string) {
    const entry = this.failures.get(client);
    const count = entry && entry.until > Date.now() ? entry.count + 1 : 1;
    this.failures.set(client, { count, until: Date.now() + lockMs });
    if (this.failures.size > 10_000) this.failures.clear();
  }
  /** A user by id. */
  findUser(id: string) {
    return this.db.get<UserRecord>("system", "users", id);
  }
  /** A user by name, any case. */
  async userByName(username: string): Promise<UserRecord | null> {
    const index = await this.db.get<UsernameRecord>("system", "usernames", usernameKey(username));
    return index ? this.findUser(index.userId) : null;
  }
  /** Every user (the operator's and the members' lists). */
  users() {
    return this.db.list<UserRecord>("system", "users");
  }
  /** A new user (an invite's sign-up). The name is taken by its index first,
   * so two sign-ups with one name never both succeed. */
  async createUser(input: {
    username: string;
    password: string;
    /** Waits for the operator before it may sign in. */
    pending?: boolean;
  }): Promise<UserRecord> {
    if (this.config.mode !== "live")
      throw new AppError("The sample workspace opens without an account", 409);
    const username = validateUsername(input.username.trim());
    const password = validatePassword(input.password);
    const id = randomUUID();
    if (
      !(await this.db.insertIfAbsent<UsernameRecord>("system", "usernames", {
        id: usernameKey(username),
        userId: id,
      }))
    )
      throw new AppError("This username is taken. Choose another one.", 409);
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, keyLength, scryptParams);
    const now = new Date().toISOString();
    const user: UserRecord = {
      id,
      username,
      ...(input.pending
        ? {
            // A hash of random bytes under a random salt: no password matches it.
            hash: randomBytes(keyLength).toString("hex"),
            salt: randomBytes(16).toString("hex"),
            status: "pending" as const,
            pendingHash: hash.toString("hex"),
            pendingSalt: salt.toString("hex"),
          }
        : { hash: hash.toString("hex"), salt: salt.toString("hex") }),
      operator: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.put("system", "users", user);
    return user;
  }
  /** The operator opened the sign-up: its own password signs it in now. */
  async activateUser(id: string): Promise<UserRecord | null> {
    this.forgetSessions();
    const user = await this.findUser(id);
    if (user?.status !== "pending" || !user.pendingHash || !user.pendingSalt) return null;
    return this.db.compareAndSwap<UserRecord>(
      "system",
      "users",
      id,
      { status: "pending", pendingHash: user.pendingHash },
      {
        hash: user.pendingHash,
        salt: user.pendingSalt,
        status: null,
        pendingHash: null,
        pendingSalt: null,
        updatedAt: new Date().toISOString(),
      },
    );
  }
  /** The operator refused the sign-up: it never signs in. */
  async rejectUser(id: string): Promise<UserRecord | null> {
    this.forgetSessions();
    const refused = await this.db.compareAndSwap<UserRecord>(
      "system",
      "users",
      id,
      { status: "pending" },
      { status: "rejected", updatedAt: new Date().toISOString() },
    );
    this.forgetSessions();
    return refused;
  }
  /** The admin account becomes the first user (same name, same password
   * hash, the platform operator). The admin record stays as it is, for a rollback. Each step only
   * inserts what is absent, so running it twice changes nothing. */
  async migrateAdmin(): Promise<UserRecord | null> {
    const admin = await this.admin();
    if (!admin) return null;
    await this.db.insertIfAbsent<UsernameRecord>("system", "usernames", {
      id: usernameKey(admin.username),
      userId: firstUserId,
    });
    await this.db.insertIfAbsent<UserRecord>("system", "users", {
      id: firstUserId,
      username: admin.username,
      hash: admin.hash,
      salt: admin.salt,
      operator: true,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    });
    return this.findUser(firstUserId);
  }
  /** A session for a user who just proved who they are some other way (an invite's sign-up). */
  sessionFor(user: UserRecord) {
    return this.issue(user);
  }
  /** A credential-free session: the sample workspace only. */
  async session(): Promise<Session> {
    if (this.config.mode === "live")
      throw new AppError("Sign in with your username and password", 401);
    return this.issue(null);
  }
  /** The user of the session the request carries. A session made before
   * users existed belongs to the first user and is given its id now, so nobody signs in again. */
  async user(authorization?: string): Promise<SessionUser> {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const id = digest(authorization.slice(7)).toString("hex");
    // v1.7.2 对话快: every request asks whose session this is (two reads), and a page that opens
    // sends some thirty at once. A session that checked out is remembered in this process for a
    // short while (IDENTITY_CACHE_TTL_MS, 30 s; 0 turns it off), and those asking at the same
    // moment share one read. Whatever this process does to a session or a user (sign-out, a new
    // password, a sign-up opened or refused) forgets all of it at once, so it counts for the very
    // next request; a change made straight in the database counts within that short while.
    const now = Date.now();
    const kept = this.known.get(id);
    if (kept && now - kept.at < this.keepMs && kept.end > now) return kept.user;
    const asking = this.asking.get(id);
    if (asking) return asking;
    const epoch = this.epoch;
    const answer = this.readUser(id)
      .then(({ user, end }) => {
        // Not kept when something was forgotten while this read was on its way: a sign-out that
        // landed meanwhile must not be undone by the answer of a read that began before it.
        if (this.keepMs > 0 && epoch === this.epoch) {
          if (this.known.size >= Auth.knownMax) this.known.clear();
          this.known.set(id, { user, end, at: Date.now() });
        }
        return user;
      })
      .finally(() => {
        if (this.asking.get(id) === answer) this.asking.delete(id);
      });
    this.asking.set(id, answer);
    return answer;
  }
  private readonly asking = new Map<string, Promise<SessionUser>>();
  private readonly known = new Map<string, { user: SessionUser; end: number; at: number }>();
  private static readonly knownMax = 5000;
  private epoch = 0;
  private readonly keepMs = identityKeepMs();
  /** Nothing remembered about any session holds from here on. */
  forgetSessions() {
    this.epoch += 1;
    this.known.clear();
    this.asking.clear();
  }
  private async readUser(id: string): Promise<{ user: SessionUser; end: number }> {
    const session = await this.db.get<SessionRecord>("system", "sessions", id);
    if (!session || sessionEnd(session) < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    if (this.config.mode !== "live" && !session.userId)
      return {
        user: { userId: sampleUserId, username: sampleUserId, operator: false },
        end: sessionEnd(session),
      };
    let userId = session.userId;
    if (!userId) {
      if (session.owner !== firstSpaceKey || !(await this.findUser(firstUserId)))
        throw new AppError("Session expired. Sign in again.", 401);
      await this.db.compareAndSwap<SessionRecord>(
        "system",
        "sessions",
        id,
        { owner: firstSpaceKey },
        { userId: firstUserId },
      );
      userId = firstUserId;
    }
    const user = await this.findUser(userId);
    // A sign-up not opened (or refused) has no session that works.
    if (!user || user.status) throw new AppError("Session expired. Sign in again.", 401);
    return {
      user: { userId: user.id, username: user.username, operator: user.operator },
      end: sessionEnd(session),
    };
  }
  /** The key of the space a session acts in when its user has one space (the sample workspace,
   * tests and single-space tools); set by the app (tenancy). */
  spaceKeyOf: (userId: string) => Promise<string> = async () => firstSpaceKey;
  async owner(authorization?: string) {
    return this.spaceKeyOf((await this.user(authorization)).userId);
  }
  /** Ends the session the request carries; a missing or expired one is already ended. */
  async logout(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) return;
    this.forgetSessions();
    await this.db.remove("system", "sessions", digest(authorization.slice(7)).toString("hex"));
    this.forgetSessions();
  }
  /** Changes the signed-in user's own password after checking the current one, ends that user's
   * other sessions and returns a fresh one for the caller. For the first user the admin record
   * (kept for a rollback) takes the new password too, so a rollback never reopens the old one. */
  async changePassword(
    authorization: string | undefined,
    input: { current: string; next: string },
  ): Promise<Session> {
    if (this.config.mode !== "live")
      throw new AppError("The sample workspace has no password", 409);
    const { userId } = await this.user(authorization);
    const user = await this.findUser(userId);
    if (!user) throw new AppError("Session expired. Sign in again.", 401);
    const actual = await scrypt(
      input.current ?? "",
      Buffer.from(user.salt, "hex"),
      keyLength,
      scryptParams,
    );
    const expected = Buffer.from(user.hash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new AppError("Current password is incorrect", 403);
    return this.issue(await this.storePassword(user, validatePassword(input.next)));
  }
  /** A one-time reset link was used: the user's
   * new password replaces the old one and every session of the user ends; no session is made
   * (he signs in with it). Null for a user who is gone or not opened (pending, refused). */
  async resetPassword(userId: string, next: string): Promise<UserRecord | null> {
    if (this.config.mode !== "live")
      throw new AppError("The sample workspace has no password", 409);
    const password = validatePassword(next);
    const user = await this.findUser(userId);
    if (!user || user.status) return null;
    return this.storePassword(user, password);
  }
  /** Runs once a user has a new password (设置, or
   * a reset link); the app ends his open reset links here, so a link the operator sent stops
   * working once he got back in himself. Set by the app (password-reset.ts). */
  passwordStored: (userId: string) => Promise<void> = async () => undefined;
  /** Stores a new (already validated) password for `user`, also on the admin record for the
   * first user (kept for a rollback, so it never reopens the old password), and ends every
   * session of the user and (Fork, 重置密码) his open reset links. */
  private async storePassword(user: UserRecord, next: string): Promise<UserRecord> {
    this.forgetSessions();
    const salt = randomBytes(16);
    const hash = await scrypt(next, salt, keyLength, scryptParams);
    const saved = await this.db.compareAndSwap<UserRecord>(
      "system",
      "users",
      user.id,
      { hash: user.hash },
      {
        hash: hash.toString("hex"),
        salt: salt.toString("hex"),
        updatedAt: new Date().toISOString(),
      },
    );
    if (!saved) throw new AppError("The password changed meanwhile. Sign in again.", 409);
    if (user.id === firstUserId)
      await this.db.compareAndSwap<AdminRecord>(
        "system",
        "auth",
        "admin",
        {},
        { hash: saved.hash, salt: saved.salt, updatedAt: saved.updatedAt },
      );
    for (const session of await this.db.list<SessionRecord>("system", "sessions"))
      if (session.userId === user.id || (!session.userId && user.id === firstUserId))
        await this.db.remove("system", "sessions", session.id);
    this.forgetSessions();
    await this.passwordStored(user.id);
    return saved;
  }
  private async issue(user: UserRecord | null): Promise<Session> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + sessionTtl;
    const first = !user || user.id === firstUserId;
    await this.db.put<SessionRecord>("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: first ? firstSpaceKey : `user:${user.id}`,
      ...(user ? { userId: user.id } : {}),
      ...(first ? { expiresAt } : { expiresAt: 0, until: expiresAt }),
      createdAt: new Date().toISOString(),
    });
    // Expired sessions are swept lazily, so the table never grows without bound.
    for (const session of await this.db.list<SessionRecord>("system", "sessions"))
      if (sessionEnd(session) < Date.now())
        await this.db.remove("system", "sessions", session.id).catch(() => undefined);
    return { token, mode: this.config.mode, username: user?.username ?? null, expiresAt };
  }
  /** A link made for a member (in a request) names them and is signed with
   * them, so it stops working once they leave the space (checked where it is used). */
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const user = currentActor()?.userId ?? null;
    const signature = createHmac("sha256", this.signingKey)
      .update(linkPayload(owner, path, expires, user))
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}${user ? `&user=${encodeURIComponent(user)}` : ""}&expires=${expires}&signature=${signature}`;
  }
  /** The member a verified link was made for, if any. */
  linkUser(url: URL): string | null {
    return url.searchParams.get("user") || null;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(linkPayload(owner, url.pathname, expires, this.linkUser(url)))
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
/** What a signed link's signature covers; a link without a member keeps the earlier form. */
const linkPayload = (owner: string, path: string, expires: string, user: string | null) =>
  user ? `${owner}\n${path}\n${expires}\n${user}` : `${owner}\n${path}\n${expires}`;
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "session-signing-key");
  let key: string;
  try {
    key = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    key = randomBytes(32).toString("base64");
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    await writeFile(temporary, key, { mode: 0o600, flag: "wx" });
    try {
      // Publish only complete bytes, without replacing another process's key.
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      key = await readFile(path, "utf8");
    } finally {
      await unlink(temporary);
    }
  }
  return new Auth(db, config, key);
}
