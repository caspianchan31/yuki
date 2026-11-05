// Members (environments). A member may have a desktop of her own, with its own time zone, locale
// and browser state. The isolation comes from a derived
// owner string: every computer subsystem (sandbox labels, lease, receipts, screenshot and
// settings) is keyed by owner, so `${owner}#env:${id}` gets a separate copy of each with no
// change to those subsystems. The derived owner is only ever produced here, after checking
// that the environment record exists and is not being deleted.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CredentialActor,
  CredentialRequestView,
  CredentialUsedBy,
  SiteLoginParts,
  SiteLoginView,
} from "../../../packages/domain/src/credentials.ts";
import {
  type Environment,
  type EnvironmentRef,
  type EnvironmentSelection,
  type EnvironmentView,
  environmentAccountLabelMax,
  environmentNameMax,
  environmentsMax,
  isReservedEnvironmentName,
  normalizeEnvironmentName,
} from "../../../packages/domain/src/environments.ts";
import {
  faceColors,
  type MemberFace,
  memberFaceShapes,
} from "../../../packages/domain/src/member-face.ts";
import { memberConversationId } from "../../../packages/domain/src/member-thread.ts";
import {
  groupMembersMax,
  parseOwner,
  projectOwner,
  realOwnerOf,
} from "../../../packages/domain/src/projects.ts";
import { removeAccountRecords } from "./accounts/records.ts";
import { ChatStore } from "./chat/chat-store.ts";
import type { ComputerService, ComputerSettingsView, DesktopState } from "./computer.ts";
import type { Config } from "./config.ts";
import { processCredentialKey } from "./credentials/crypto.ts";
import { readSignIns, removeFacts, writeSignIn } from "./credentials/facts.ts";
import { CredentialStore, loginGap } from "./credentials/store.ts";
import {
  validateCookies,
  validatePassword,
  validateSite,
  validateTotpSeed,
  validateUsername,
} from "./credentials/validate.ts";
import type { Store, StoreQuery } from "./db.ts";
import { accountActionsKind } from "./engine/action-ledger.ts";
import { AppError } from "./errors.ts";
import { ownerActor } from "./request-actor.ts";

const kind = "environments";
const selectionKind = "conversation-environments";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The only separator between a real owner and an environment id; a real owner never
// contains "#" (envOwner refuses one), so its presence identifies a derived owner.
const ownerSeparator = "#env:";

/** The owner string every computer call is keyed by for one environment. `owner` is the
 * real owner; the environment id must be a UUID, so the suffix can never be forged from a
 * path or a name. */
export function envOwner(owner: string, environmentId: string) {
  // Accounts are global, so the derived owner always comes from the real
  // owner; a project owner yields the same desktop as the default project would.
  const real = realOwnerOf(owner);
  if (real.includes("#") || !uuidPattern.test(environmentId))
    throw new AppError("Environment owner could not be derived", 500);
  return `${real}${ownerSeparator}${environmentId}`;
}
/** Whether an owner string is one envOwner derived, as opposed to a real (default desktop)
 * owner; the computer service uses it to apply environment-only rules at start. */
export const isEnvironmentOwner = (owner: string) => owner.includes(ownerSeparator);
/** The real owner and environment id a derived owner was made of; null for a real owner. */
export function parseEnvOwner(derived: string): { real: string; environmentId: string } | null {
  const at = derived.indexOf(ownerSeparator);
  if (at === -1) return null;
  const environmentId = derived.slice(at + ownerSeparator.length);
  return uuidPattern.test(environmentId) ? { real: derived.slice(0, at), environmentId } : null;
}
export const isEnvironmentId = (value: string) => uuidPattern.test(value);
export const environmentRef = (environment: Environment): EnvironmentRef => ({
  id: environment.id,
  name: environment.name,
  accountLabel: environment.accountLabel,
});

/** A conversation's choice; `deletedName` is filled in when that environment is removed. */
interface Selection {
  id: string;
  environmentId: string | null;
  updatedAt: string;
  deletedName?: string;
}
/** What a chat run acts on: the default desktop, one environment, or nothing until the
 * user picks again because the remembered environment was deleted. */
export type ActiveEnvironment =
  | { kind: "default" }
  | { kind: "env"; owner: string; ref: EnvironmentRef }
  | { kind: "blocked"; deletedName: string | null };

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(environmentNameMax, `Name must be ${environmentNameMax} characters or fewer`);
const accountLabelSchema = z
  .string()
  .trim()
  .max(
    environmentAccountLabelMax,
    `Account label must be ${environmentAccountLabelMax} characters or fewer`,
  )
  .nullable()
  .optional();
/** A site login given with a new account (the same fields as POST
 * /api/credentials, the account being the one created). */
export const siteLoginInputSchema = z.object({
  site: z.string().max(2048),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  totpSeed: z.string().nullable().optional(),
  cookies: z.string().nullable().optional(),
});
export type SiteLoginInput = z.infer<typeof siteLoginInputSchema>;
// v1.2: only the shapes a member may pick (the flake is the main member's) and the listed colors.
const faceSchema = z
  .object({
    shape: z.enum(memberFaceShapes, { message: "Face shape is not one of the listed shapes" }),
    color: z.enum(faceColors, { message: "Face color is not one of the listed colors" }),
  })
  .strict();
const createSchema = z.object({
  name: nameSchema,
  accountLabel: accountLabelSchema,
  face: faceSchema.optional(),
});
const patchSchema = z.object({
  name: nameSchema.optional(),
  accountLabel: accountLabelSchema,
});
/** The scope (project owner) of a request's owner. */
export function scopeOfOwner(owner: string) {
  const { real, projectId } = parseOwner(owner);
  return projectId ? projectOwner(real, projectId) : real;
}
/** Checks a site login before anything is written; returns its site. */
export function checkSiteLogin(input: SiteLoginInput) {
  const site = validateSite(input.site);
  const username = validateUsername(input.username) ?? null;
  const password = validatePassword(input.password);
  const seed = validateTotpSeed(input.totpSeed);
  const cookies = validateCookies(input.cookies, site);
  loginGap({ username, password: !!password, totp: !!seed, cookies: !!cookies });
  return site;
}

const notFound = () => new AppError("Environment not found", 404);
const reserved = () => new AppError('Name "default" is reserved for the default desktop', 422);
/** A record being deleted keeps its name only while the delete may still be running: one that
 * could not finish (the desktop provider failed, say) stays marked, and must not hold the name
 * for good. A delete can still be retried after this; it just no longer blocks a new member. */
const deleteHoldMs = 2 * 60 * 1000;
const holdsName = (record: Environment) =>
  !record.deleting || Date.now() - Date.parse(record.updatedAt) < deleteHoldMs;
const message = (error: unknown) =>
  error instanceof AppError ? error.message : "Environment inspection failed";
/** Operator-facing note; never carries secrets. */
function warn(warning: string) {
  console.warn({
    timestamp: new Date().toISOString(),
    context: { phase: "environments" },
    warning,
  });
}
// A settings view for an environment whose settings could not be read at all.
const unreadableSettings = (updatedAt: string | null = null): ComputerSettingsView => ({
  timezone: null,
  locale: null,
  updatedAt,
  localeUnreadable: true,
});

export class EnvironmentService {
  /** What happens when a site login of an
   * account is saved or replaced: the agent service starts (or wakes) the task that signs the
   * account in to that site. Set by the app; tests may leave it unset. */
  onLoginSaved?: (owner: string, environmentId: string, site: string) => Promise<void>;
  /** Refuses (as creating a task would) when the sign-in tasks for these logins could not be
   * added now; checked before an account is written or moved. Set by the app. */
  roomForSignIns?: (
    owner: string,
    logins: { environmentId: string; site: string }[],
  ) => Promise<void>;
  /** The owner moved an account from the project `from` to `to` (both task
   * owners): the sign-in tasks still open in `from` end, a task in `from` whose request for a
   * login of the account was withdrawn is told, and the AI signs in again in `to` to each site
   * in `sites`. Set by the app. */
  onAccountMoved?: (
    from: string,
    to: string,
    environmentId: string,
    sites: string[],
    withdrawn: CredentialRequestView[],
  ) => Promise<void>;
  constructor(
    private readonly db: Store,
    private readonly computer: ComputerService,
    private readonly config: Config,
    /** The projects' credential store; left out, the computer's (tests). */
    private readonly credentialStore?: CredentialStore,
  ) {}
  /** v1.2: every member of the space, whichever group she is in, for the contact list. Only what
   * that list shows: no logins. */
  async everyone(owner: string) {
    const { real } = parseOwner(owner);
    return (await this.allRecords(real))
      .filter((record) => !record.deleting)
      .map((record) => ({
        id: record.id,
        name: record.name,
        projectId: record.projectId ?? null,
        ...(record.face ? { face: record.face } : {}),
      }));
  }
  /** The name an account has now, whatever its project: the credential history records it. */
  async nameOf(scope: string, environmentId: string) {
    if (!isEnvironmentId(environmentId)) return null;
    const record = await this.db.get<Environment>(realOwnerOf(scope), kind, environmentId);
    return record?.name ?? null;
  }
  /** The projects' credential store. */
  get store(): CredentialStore {
    if (this.credentialStore) return this.credentialStore;
    this.ownStore ??= new CredentialStore(this.db, processCredentialKey());
    return this.ownStore;
  }
  /** The store of this process's own key, for a service made without one (tests). */
  private ownStore?: CredentialStore;
  /** Members need no computer. */
  available() {
    return true;
  }
  assertAvailable() {}
  /** Every record of the real owner whatever its project, deleting ones included, sorted by
   * name. Records written before projects existed read as unassigned. */
  async allRecords(owner: string): Promise<Environment[]> {
    const records = await this.db.list<Environment>(realOwnerOf(owner), kind);
    return records
      .map((record) => ({ ...record, projectId: record.projectId ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /** The records in `owner`'s project (the default project sees the unassigned ones),
   * deleting ones included, sorted by name. */
  async records(owner: string): Promise<Environment[]> {
    const { projectId } = parseOwner(owner);
    return (await this.allRecords(owner)).filter((record) => record.projectId === projectId);
  }
  /** Unassigned live accounts, offered to a project for assignment; empty in the default
   * project, where they are simply the project's own list. */
  async unassigned(owner: string): Promise<Environment[]> {
    if (parseOwner(owner).projectId === null) return [];
    return (await this.allRecords(owner)).filter(
      (record) => record.projectId === null && !record.deleting,
    );
  }
  /** The record whatever its state, or null; a malformed id, or an account assigned to
   * another project, is simply absent. */
  async find(owner: string, id: string): Promise<Environment | null> {
    if (!isEnvironmentId(id)) return null;
    const { real, projectId } = parseOwner(owner);
    const record = await this.db.get<Environment>(real, kind, id);
    if (!record || (record.projectId ?? null) !== projectId) return null;
    return { ...record, projectId: record.projectId ?? null };
  }
  /** Moves an account between unassigned and the current project, in either direction;
   * nothing about its desktop changes. Any other move is a 409. */
  async assign(owner: string, id: string, target: string | null): Promise<EnvironmentView> {
    const { real, projectId: scope } = parseOwner(owner);
    if (!isEnvironmentId(id)) throw notFound();
    const record = await this.db.get<Environment>(real, kind, id);
    if (!record || record.deleting) throw notFound();
    const current = record.projectId ?? null;
    const joining = scope !== null && current === null && target === scope;
    const leaving = scope !== null && current === scope && target === null;
    if (!joining && !leaving)
      throw new AppError(
        "An account can only be added to the current project from unassigned, or returned to unassigned from the current project",
        409,
      );
    // v1.2: a group holds at most groupMembersMax members. Groups already over it are left alone;
    // only a new member joining a full group is refused.
    if (joining && target !== null) {
      const members = (await this.allRecords(owner)).filter(
        (item) => item.projectId === target && !item.deleting,
      );
      if (members.length >= groupMembersMax)
        throw new AppError(`一个群最多 ${groupMembersMax} 个成员`, 409);
    }
    // The account's site logins (and the other entries it uses)
    // move with it, recorded in both projects' histories, in the same transaction as the record.
    const from = current === null ? real : projectOwner(real, current);
    const to = target === null ? real : projectOwner(real, target);
    const facts = new Map(
      (await readSignIns(this.db, envOwner(real, record.id))).map((fact) => [fact.site, fact]),
    );
    const usedBy: CredentialUsedBy = { type: "account", environmentId: record.id };
    const sites = (await this.store.find(from, { usedBy, kind: "site_login" }))
      .map((entry) => entry.site ?? "")
      .filter((site) => site && (facts.get(site)?.status ?? "pending") === "pending");
    if (sites.length)
      await this.roomForSignIns?.(
        to,
        sites.map((site) => ({ environmentId: record.id, site })),
      );
    const withdrawn = await this.move(real, record.id, current, target);
    // The AI signs in again, in the project the account is in now, to each site whose login is
    // saved and not yet signed in to (no fact, or still pending); a task in `from` that asked for
    // a login of the account learns its request is withdrawn.
    await this.onAccountMoved?.(from, to, record.id, sites, withdrawn);
    // After leaving, only the default project's scope sees the record.
    return this.view(target === null ? real : owner, record.id);
  }
  /** Moves the account from the project `current` to `target` (null:
   * unassigned) in one transaction: its credentials (store.moveAccount) and its record, which
   * must still be live and in `current`; a live target project is required and held for the
   * transaction, so a project delete either waits for it (and then returns the account) or has
   * already started (404). Anything refused rolls back as a whole. The sign-in facts it carries
   * keep no task or chat of the project it left. Returns the requests withdrawn in `current`. */
  async move(
    real: string,
    id: string,
    current: string | null,
    target: string | null,
    actor: CredentialActor = ownerActor(),
  ): Promise<CredentialRequestView[]> {
    const from = current === null ? real : projectOwner(real, current);
    const to = target === null ? real : projectOwner(real, target);
    const withdrawn = await this.store.moveAccount(from, to, id, actor, {
      inside: async (via) => {
        if (target !== null) {
          const project = await this.db.lockRecord<{ deleting?: boolean }>(
            real,
            "projects",
            target,
            via,
          );
          if (!project || project.deleting) throw notFound();
        }
        const record = await this.db.lockRecord<Environment>(real, kind, id, via);
        if (!record || record.deleting || (record.projectId ?? null) !== current) throw notFound();
        await this.db.compareAndSwap<Environment>(
          real,
          kind,
          id,
          { deleting: false },
          { projectId: target, updatedAt: new Date().toISOString() },
          via,
        );
      },
    });
    const derived = envOwner(real, id);
    for (const fact of await readSignIns(this.db, derived))
      if (!("owner" in fact.by))
        await writeSignIn(this.db, derived, { ...fact, by: { owner: true } });
    // Her own conversation (an id from hers) goes where she goes, so it opens in
    // the group she joined, and is not purged with a group she leaves. Best effort: a chat
    // request for it adopts it too (runtime-hooks.ts).
    try {
      await (await ChatStore.open(this.db)).adoptThread(memberConversationId(id), real, to);
    } catch (error) {
      warn(`A member's conversation could not follow her: ${message(error)}`);
    }
    return withdrawn;
  }
  /** A check for the credential store's writes (link, create), run under
   * the scope's lock inside its transaction: the account must still be a live account of the
   * project `owner` names, or the write is refused as a usedBy outside the project. */
  memberCheck(owner: string, environmentId: string) {
    const { real, projectId } = parseOwner(owner);
    return async (via: StoreQuery) => {
      const record = await this.db.lockRecord<Environment>(real, kind, environmentId, via);
      if (!record || record.deleting || (record.projectId ?? null) !== projectId)
        throw new AppError("usedBy must name accounts of this project", 400);
    };
  }
  /** The record, or 404 when it does not exist or is being deleted. Cheap: one row. */
  async get(owner: string, id: string): Promise<Environment> {
    const record = await this.find(owner, id);
    if (!record || record.deleting) throw notFound();
    return record;
  }
  /** The id itself, a case-insensitive name, an account label (case-insensitive, whole) that
   * only one live account carries, or a user name of a site login saved in this project that
   * only one live account has; for chat, where a person names the account rather than the
   * environment. */
  async findByNameOrId(owner: string, query: string): Promise<Environment | null> {
    const needle = normalizeEnvironmentName(query);
    if (!needle) return null;
    const live = (await this.records(owner)).filter((record) => !record.deleting);
    const match =
      live.find((record) => record.id === query.trim()) ??
      live.find((record) => normalizeEnvironmentName(record.name) === needle);
    if (match) return match;
    const byLabel = live.filter(
      (record) => !!record.accountLabel && normalizeEnvironmentName(record.accountLabel) === needle,
    );
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) return null;
    const ids = new Set(await this.store.accountsByUsername(scopeOfOwner(owner), query));
    const byUsername = live.filter((record) => ids.has(record.id));
    return byUsername.length === 1 ? byUsername[0] : null;
  }
  /** The derived owner for a live environment; the only way to obtain one. */
  async owner(owner: string, id: string) {
    const record = await this.get(owner, id);
    return envOwner(owner, record.id);
  }
  /** A check to run under the computer lease, just before a start: the environment must
   * still exist, or the start would rebuild a sandbox nobody can see or delete. */
  ensure(owner: string, id: string) {
    return async () => {
      const record = await this.find(owner, id);
      if (!record || record.deleting) throw new AppError("Environment no longer exists", 404);
    };
  }
  private async settingsView(derived: string) {
    try {
      return { settings: await this.computer.settings.view(derived) };
    } catch (error) {
      return { settings: unreadableSettings(), message: message(error) };
    }
  }
  private compose(
    record: Environment,
    state: DesktopState,
    settings: ComputerSettingsView,
    credentials: Pick<EnvironmentView, "siteLogins" | "signIns">,
    settingsMessage?: string,
  ): EnvironmentView {
    const failure = state.state === "error" ? state.message : settingsMessage;
    return {
      ...record,
      status: failure === undefined ? state.state : "error",
      ...(failure === undefined ? {} : { message: failure }),
      computer: Boolean(this.config.computerEnabled),
      settings,
      ...credentials,
    };
  }
  /** What the project's default desktop has saved to sign in with (never a
   * value), for a task that runs there. */
  async projectLoginFacts(owner: string) {
    const entries = await this.store.find(scopeOfOwner(owner), { usedBy: { type: "project" } });
    return entries
      .filter((entry) => entry.kind === "site_login")
      .map((entry) => ({ site: entry.site ?? "", username: entry.username }));
  }
  /** The account's site logins (metadata only) and the sign-in facts the AI recorded. */
  async credentialFacts(
    owner: string,
    record: Environment,
  ): Promise<Pick<EnvironmentView, "siteLogins" | "signIns">> {
    const real = realOwnerOf(owner);
    const derived = envOwner(real, record.id);
    const scope = record.projectId ? projectOwner(real, record.projectId) : real;
    const usedBy: CredentialUsedBy = { type: "account", environmentId: record.id };
    const entries = await this.store.find(scope, { usedBy });
    const siteLogins: SiteLoginView[] = entries
      .filter((entry) => entry.kind === "site_login")
      .map((entry) => {
        const parts = entry.parts as SiteLoginParts;
        return {
          id: entry.id,
          site: entry.site ?? "",
          username: entry.username,
          password: parts.password,
          totp: !!parts.totp,
          cookies: !!parts.cookies,
          lastResult: entry.lastResult,
          lastUsedAt: entry.lastUsedAt,
          unreadable: entry.unreadable,
        };
      });
    return {
      siteLogins,
      signIns: await readSignIns(this.db, derived),
    };
  }
  /** Every environment with its desktop state (one provider listing) and masked settings.
   * One environment's failure marks only that environment. */
  async list(owner: string): Promise<EnvironmentView[]> {
    return this.views(owner, await this.records(owner));
  }
  /** Unassigned accounts with their desktop state, for a project's "add" list. Fork
   * (credentials): they are the default project's accounts, so nothing that comes from
   * that project's credentials (its logins, entries, sign-in facts) is in these views: a project
   * never learns another project's credentials. */
  async listUnassigned(owner: string): Promise<EnvironmentView[]> {
    const records = await this.unassigned(owner);
    if (!records.length) return [];
    const owners = records.map((record) => envOwner(owner, record.id));
    let states: DesktopState[];
    try {
      states = await this.computer.states(owners);
    } catch (error) {
      states = owners.map(() => ({ state: "error", message: message(error) }));
    }
    return Promise.all(
      records.map(async (record, index): Promise<EnvironmentView> => {
        const { settings, message: failure } = await this.settingsView(owners[index]);
        const state = states[index];
        const error = state.state === "error" ? state.message : failure;
        return {
          ...record,
          status: error === undefined ? state.state : "error",
          ...(error === undefined ? {} : { message: error }),
          computer: Boolean(this.config.computerEnabled),
          settings: {
            timezone: settings.timezone,
            locale: settings.locale,
            updatedAt: settings.updatedAt,
          },
          siteLogins: [],
          signIns: [],
        };
      }),
    );
  }
  private async views(owner: string, records: Environment[]): Promise<EnvironmentView[]> {
    if (!records.length) return [];
    const owners = records.map((record) => envOwner(owner, record.id));
    let states: DesktopState[];
    try {
      states = await this.computer.states(owners);
    } catch (error) {
      states = owners.map(() => ({ state: "error", message: message(error) }));
    }
    return Promise.all(
      records.map(async (record, index) => {
        const { settings, message } = await this.settingsView(owners[index]);
        const credentials = await this.credentialFacts(owner, record);
        return this.compose(record, states[index], settings, credentials, message);
      }),
    );
  }
  async view(owner: string, id: string): Promise<EnvironmentView> {
    const record = await this.get(owner, id);
    const derived = envOwner(owner, record.id);
    const state = await this.computer
      .states([derived])
      .then(([state]) => state)
      .catch((error): DesktopState => ({ state: "error", message: message(error) }));
    const { settings, message: failure } = await this.settingsView(derived);
    return this.compose(
      record,
      state,
      settings,
      await this.credentialFacts(owner, record),
      failure,
    );
  }
  /** Validates everything first (the name and, with a computer, its time zone and language and
   * site logins), then inserts the record, creates its site logins in the project and saves its
   * settings under the derived owner; a failure on the way removes what was added. Then the AI
   * signs the account in to each site it has a login for (a task per site). */
  async create(owner: string, raw: unknown): Promise<EnvironmentView> {
    const input = createSchema.parse(raw);
    if (isReservedEnvironmentName(input.name)) throw reserved();
    // Accounts are global: the limit and the name are checked across every project.
    const { real, projectId } = parseOwner(owner);
    const existing = await this.allRecords(real);
    if (existing.length >= environmentsMax)
      throw new AppError(`Environments are limited to ${environmentsMax}`, 422);
    const normalized = normalizeEnvironmentName(input.name);
    if (
      existing.some(
        (record) => holdsName(record) && normalizeEnvironmentName(record.name) === normalized,
      )
    )
      throw new AppError(`An environment named "${input.name}" already exists`, 409);
    const now = new Date().toISOString();
    const record: Environment = {
      id: randomUUID(),
      name: input.name,
      accountLabel: input.accountLabel ?? null,
      ...(input.face ? { face: input.face satisfies MemberFace } : {}),
      projectId,
      deleting: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.db.insertIfAbsent(real, kind, record)))
      throw new AppError("Environment could not be created", 500);
    return this.view(owner, record.id);
  }
  /** A site login of the account was saved or replaced (onLoginSaved: the
   * credential service marks it pending and the AI signs in). */
  async loginSaved(owner: string, environmentId: string, site: string) {
    const record = await this.find(owner, environmentId);
    if (!record || record.deleting) return;
    await this.onLoginSaved?.(owner, environmentId, site);
  }
  async patch(owner: string, id: string, raw: unknown): Promise<EnvironmentView> {
    const input = patchSchema.parse(raw);
    const current = await this.get(owner, id);
    const patch: Partial<Environment> = { updatedAt: new Date().toISOString() };
    if (input.name !== undefined) {
      if (isReservedEnvironmentName(input.name)) throw reserved();
      const normalized = normalizeEnvironmentName(input.name);
      const others = (await this.allRecords(owner)).filter((record) => record.id !== current.id);
      if (
        others.some(
          (record) => holdsName(record) && normalizeEnvironmentName(record.name) === normalized,
        )
      )
        throw new AppError(`An environment named "${input.name}" already exists`, 409);
      patch.name = input.name;
    }
    if (input.accountLabel !== undefined) patch.accountLabel = input.accountLabel;
    // A record that started deleting (or moved to another project) meanwhile is gone for every
    // purpose.
    const saved = await this.db.compareAndSwap<Environment>(
      realOwnerOf(owner),
      kind,
      current.id,
      current.projectId === null
        ? { deleting: false }
        : { deleting: false, projectId: current.projectId },
      patch,
    );
    if (!saved) throw notFound();
    return this.view(owner, current.id);
  }
  /** Marks the record deleting, destroys the desktop under its lease, clears the derived
   * owner's rows, then removes the record. A failed destroy keeps the record deleting so the
   * delete can be retried; repeating a delete is idempotent. */
  async remove(owner: string, id: string): Promise<void> {
    const record = await this.find(owner, id);
    if (!record) throw notFound();
    const derived = envOwner(owner, record.id);
    const real = realOwnerOf(owner);
    const marked = await this.db.compareAndSwap(
      real,
      kind,
      record.id,
      { deleting: false },
      { deleting: true, updatedAt: new Date().toISOString() },
    );
    // A move commits only while the record is not deleting, so once it is,
    // the project it is in is final. Moved out of this project before that (or gone): 404, and a
    // mark set here is taken back.
    const marking = await this.db.get<Environment>(real, kind, record.id);
    if (!marking?.deleting || (marking.projectId ?? null) !== (record.projectId ?? null)) {
      if (marked && marking)
        await this.db.compareAndSwap(
          real,
          kind,
          record.id,
          { deleting: true },
          { deleting: false, updatedAt: new Date().toISOString() },
        );
      throw notFound();
    }
    try {
      await this.computer.destroy(derived);
    } catch (error) {
      if (error instanceof AppError && error.status === 409)
        throw new AppError(
          `The desktop of environment "${record.name}" is busy or its last stop was not confirmed. Retry the delete shortly.`,
          409,
        );
      throw error;
    }
    await this.db.remove(derived, "computer-settings", "sandbox");
    await this.db.remove(derived, "computer-state", "lease");
    // What older versions kept for the account (its pacing settings, run claims and site
    // profiles) and its action ledger go with it.
    await this.db.remove(derived, "pacing-settings", "pacing");
    await this.db.remove(derived, "pacing-settings", "pacing-ai");
    for (const oldKind of [accountActionsKind, "pacing-claims", "account-profile"])
      for (const row of await this.db.list<{ id: string }>(derived, oldKind))
        await this.db.remove(derived, oldKind, row.id);
    // Conversations that pointed here keep their record and learn the name it had, so the
    // next run can say which environment went away instead of silently moving on.
    for (const selection of await this.db.list<Selection>(owner, selectionKind))
      if (selection.environmentId === record.id)
        await this.db.put<Selection>(owner, selectionKind, {
          ...selection,
          deletedName: record.name,
        });
    // Its persona and goal go with it.
    await removeAccountRecords(this.db, derived);
    // The entries only it used go, shared ones stop serving it, and its
    // sign-in facts go with it.
    await this.store.removeAccount(scopeOfOwner(owner), record.id, ownerActor());
    await removeFacts(this.db, derived);
    // Its incidents and their pictures go with it.
    await this.computer.incidents.removeOwner(derived);
    await this.db.remove(real, kind, record.id);
    // A start that passed its existence check just before the record went away may have
    // rebuilt the sandbox; one more look catches it. Failures here only warn.
    try {
      const [state] = await this.computer.states([derived]);
      if (state.state !== "missing") {
        await this.computer.destroy(derived);
        await this.db.remove(derived, "computer-state", "lease");
      }
    } catch (error) {
      warn(`A deleted environment's desktop could not be re-checked: ${message(error)}`);
    }
  }
  /** The conversation's environment: null for the default desktop; stale when it points at
   * an environment that was deleted (the record is kept so the run can report it). */
  async selection(owner: string, threadId: string): Promise<EnvironmentSelection> {
    const record = await this.db.get<Selection>(owner, selectionKind, threadId);
    if (!record?.environmentId) return { environmentId: null, name: null, stale: false };
    const environment = await this.find(owner, record.environmentId);
    if (environment && !environment.deleting)
      return { environmentId: environment.id, name: environment.name, stale: false };
    return {
      environmentId: record.environmentId,
      name: record.deletedName ?? environment?.name ?? null,
      stale: true,
    };
  }
  async select(
    owner: string,
    threadId: string,
    environmentId: string | null,
  ): Promise<EnvironmentSelection> {
    if (environmentId !== null) await this.get(owner, environmentId);
    await this.db.put<Selection>(owner, selectionKind, {
      id: threadId,
      environmentId,
      updatedAt: new Date().toISOString(),
    });
    return this.selection(owner, threadId);
  }
  /** What a chat run should act on, decided once at its start. */
  async resolveActive(owner: string, threadId: string): Promise<ActiveEnvironment> {
    const selection = await this.selection(owner, threadId);
    if (selection.stale) return { kind: "blocked", deletedName: selection.name };
    if (!selection.environmentId) return { kind: "default" };
    const environment = await this.get(owner, selection.environmentId);
    return {
      kind: "env",
      owner: envOwner(owner, environment.id),
      ref: environmentRef(environment),
    };
  }
}
