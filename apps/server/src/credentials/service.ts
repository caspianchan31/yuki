// The credential store as the owner and the rest of
// the server use it, per project. Every call takes the request's (or task's, or conversation's)
// project owner and acts on that project's scope only; an account named in `usedBy` must be one of
// that project's live accounts. What follows a save (the AI signs in, a running desktop takes a new
// proxy, a task that asked for a login is woken) starts here.
import { z } from "zod";
import {
  type CredentialRequestView,
  type CredentialUsedBy,
  type CredentialView,
  mailboxRequestSite,
} from "../../../../packages/domain/src/credentials.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { firstSpaceKey, firstUserId } from "../auth.ts";
import type { ComputerService } from "../computer.ts";
import type { Store, StoreQuery } from "../db.ts";
import { type EnvironmentService, envOwner, scopeOfOwner } from "../environments.ts";
import { AppError } from "../errors.ts";
import { ownerActor } from "../request-actor.ts";
import { readProxyCheck, readSignIns, removeSignIn, writeSignIn } from "./facts.ts";
import { siteOf } from "./site.ts";
import type { CredentialPatch, CredentialStore } from "./store.ts";

/** Who wakes or starts the task that signs in after a login is saved (the agent service). */
export interface SignInStarter {
  signInSaved(
    owner: string,
    usedBy: CredentialUsedBy,
    site: string,
    requests: CredentialRequestView[],
  ): Promise<void>;
  /** Refuses (as creating a task would) when the sign-in tasks these logins would start could
   * not be added now; called before anything is saved, so a save never succeeds only to fail at
   * its sign-in. */
  assertRoomForSignIns(
    owner: string,
    logins: { environmentId: string; site: string }[],
  ): Promise<void>;
  /** The AI looks again at a site that needed a code; false when there was nothing to look at. */
  recheckSignIn(owner: string, usedBy: CredentialUsedBy, site: string): Promise<boolean>;
  /** Something the project's default desktop needed was saved: its operating goal goes on. */
  projectCredentialSaved(owner: string, text: string): Promise<void>;
  /** Tells the task that asked for something that it is there (and so wakes it);
   * a task waiting on the person's answer is left alone. */
  tellAsker(owner: string, taskId: string, text: string): Promise<void>;
}

const usedBySchema = z.union([
  z.object({ type: z.literal("account"), environmentId: z.string().max(100) }).strict(),
  z.object({ type: z.literal("project") }).strict(),
]);
const text = z.string().max(250_000).nullable().optional();
const createSchema = z
  .object({
    kind: z.enum(["proxy", "site_login", "mailbox"]),
    label: z.string().max(200).nullable().optional(),
    site: z.string().max(2048).nullable().optional(),
    username: text,
    password: text,
    totpSeed: text,
    cookies: text,
    proxyUrl: text,
    // A mailbox's address and servers (its password is `password`).
    address: text,
    smtpHost: text,
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpSecure: z.boolean().nullable().optional(),
    imapHost: text,
    imapPort: z.number().int().min(1).max(65535).nullable().optional(),
    usedBy: z.array(usedBySchema).max(100).optional(),
  })
  .strict();
const patchSchema = createSchema.omit({ kind: true, site: true }).strict();
const auditQuery = z.object({
  entry: z.string().max(100).optional(),
  before: z.string().max(200).optional(),
});
const recheckSchema = z
  .object({
    site: z.string().min(1).max(2048),
    environmentId: z.string().max(100).nullable().optional(),
  })
  .strict();
const notFound = () => new AppError("Credential not found", 404);

export class CredentialService {
  /** Set by the app: the agent service. */
  agent?: SignInStarter;
  /** True when the request's member may not see `owner`'s platform entries
   * (a space the platform sets up: they see its exits at /api/exits instead). */
  systemHidden?: (owner: string) => Promise<boolean>;
  private async hidden(owner: string) {
    return (await this.systemHidden?.(owner)) ?? false;
  }
  private static system(kind: string) {
    return kind === "proxy";
  }
  constructor(
    private readonly db: Store,
    readonly store: CredentialStore,
    private readonly environments: EnvironmentService,
    private readonly computer: ComputerService,
  ) {}
  /** Each account in `usedBy` must be a live account of this project. */
  private async checkUsers(owner: string, usedBy: CredentialUsedBy[]) {
    for (const user of usedBy)
      if (user.type === "account") {
        const record = await this.environments.find(owner, user.environmentId);
        if (!record || record.deleting)
          throw new AppError("usedBy must name accounts of this project", 400);
      }
  }
  /** Re-checks, under the scope's lock inside the store's write, that each account in `usedBy`
   * is still a live account of this project (a move takes the same lock). */
  private memberChecks(owner: string, usedBy: CredentialUsedBy[]) {
    const checks = usedBy.flatMap((user) =>
      user.type === "account" ? [this.environments.memberCheck(owner, user.environmentId)] : [],
    );
    return async (via: StoreQuery) => {
      for (const check of checks) await check(via);
    };
  }
  /** Account names for the views (the project's own accounts only). */
  private async names(owner: string) {
    const records = await this.environments.records(owner);
    return new Map(records.map((record) => [record.id, record.name]));
  }
  private named(names: Map<string, string>, user: CredentialUsedBy) {
    return user.type === "account"
      ? { ...user, name: names.get(user.environmentId) ?? null }
      : { ...user };
  }
  async list(owner: string) {
    const scope = scopeOfOwner(owner);
    const names = await this.names(owner);
    const hidden = await this.hidden(owner);
    const entries = (await this.store.list(scope))
      .filter((entry) => !hidden || !CredentialService.system(entry.kind))
      .map(
        (entry): CredentialView => ({
          ...entry,
          usedBy: entry.usedBy.map((user) => this.named(names, user)),
        }),
      );
    const requests = (await this.store.requests(scope)).map((request) => ({
      ...request,
      for: this.named(names, request.for),
    }));
    return { entries, requests };
  }
  /** The project's own sign-in facts (the logins its default desktop uses) and its default
   * desktop's proxy check, read in the request's scope only: the client's 需要你 builds its
   * project item from them, by the same rule the project overview counts it (factsNeedYou). */
  async projectSignIns(owner: string) {
    const scope = scopeOfOwner(owner);
    return {
      signIns: await readSignIns(this.db, scope),
      proxyCheck: await readProxyCheck(this.db, scope),
      proxyConfigured: false,
    };
  }
  /** The owner acted on the desktop of an account (or the project's default desktop) for a site
   * that needed a code: the AI looks again (AgentService.recheckSignIn). Nothing happens for a
   * site with no such fact. */
  async recheck(owner: string, raw: unknown) {
    const input = recheckSchema.parse(raw);
    const site = siteOf(input.site);
    if (!site) throw new AppError("site must be a website's address or domain", 400);
    if (input.environmentId) {
      const record = await this.environments.find(owner, input.environmentId);
      if (!record || record.deleting) throw new AppError("Environment not found", 404);
    }
    const usedBy: CredentialUsedBy = input.environmentId
      ? { type: "account", environmentId: input.environmentId }
      : { type: "project" };
    return { rechecking: (await this.agent?.recheckSignIn(owner, usedBy, site)) ?? false };
  }
  async get(owner: string, id: string) {
    const entry = await this.store.get(scopeOfOwner(owner), id);
    if (!entry) throw notFound();
    if (CredentialService.system(entry.kind) && (await this.hidden(owner))) throw notFound();
    const names = await this.names(owner);
    return { ...entry, usedBy: entry.usedBy.map((user) => this.named(names, user)) };
  }
  async create(owner: string, raw: unknown) {
    const input = createSchema.parse(raw);
    const usedBy = input.usedBy ?? [];
    await this.checkUsers(owner, usedBy);
    if (input.kind === "site_login" && input.site)
      await this.roomForSignIns(owner, usedBy, siteOf(input.site));
    const view = await this.store.create(scopeOfOwner(owner), input, ownerActor(), {
      check: this.memberChecks(owner, usedBy),
    });
    await this.afterSave(owner, view, {
      login: view.kind === "site_login",
      filesFor: view.kind === "site_login" || view.kind === "mailbox" ? [] : view.usedBy,
    });
    if (view.kind === "mailbox") await this.mailboxSaved(owner, view);
    return this.get(owner, view.id);
  }
  /** Everything that can refuse the patch is checked before anything is written (the parts in
   * the store's replace, which writes nothing when it refuses; who uses it here), so a 4xx never
   * leaves a partial change. Then: the parts are replaced, the users it no longer serves are
   * unlinked (a site login's old account loses its sign-in fact for the site), the new ones
   * linked. */
  async patch(owner: string, id: string, raw: unknown) {
    const input = patchSchema.parse(raw);
    const scope = scopeOfOwner(owner);
    const before = await this.store.get(scope, id);
    if (!before) throw notFound();
    const { usedBy, ...parts } = input;
    const has = (list: CredentialUsedBy[], user: CredentialUsedBy) =>
      list.some((item) => JSON.stringify(item) === JSON.stringify(user));
    const login = before.kind === "site_login";
    const added = usedBy ? usedBy.filter((user) => !has(before.usedBy, user)) : [];
    const removed = usedBy ? before.usedBy.filter((user) => !has(usedBy, user)) : [];
    if (usedBy) {
      if (login && usedBy.length > 1)
        throw new AppError("A site login is used by one account or by the project", 400);
      await this.checkUsers(owner, usedBy);
      for (const user of login ? added : []) {
        const clash = (await this.store.find(scope, { usedBy: user, kind: "site_login" })).find(
          (other) => other.id !== id && other.site === before.site,
        );
        if (clash)
          throw new AppError(
            `There is already a ${before.site} login there; replace it instead`,
            409,
          );
      }
    }
    const partsGiven = Object.values(parts).some((value) => value !== undefined);
    if (login && before.site && (partsGiven || added.length))
      await this.roomForSignIns(owner, usedBy ?? before.usedBy, before.site);
    const { view, parts: changed } = await this.store.replace(
      scope,
      id,
      parts as CredentialPatch,
      ownerActor(),
    );
    let after = view;
    for (const user of removed) {
      after = await this.store.unlink(scope, id, user, ownerActor());
      if (login && before.site)
        await removeSignIn(this.db, this.factOwner(owner, user), before.site);
    }
    for (const user of added)
      after = await this.store.link(scope, id, user, ownerActor(), {
        check: this.memberChecks(owner, [user]),
      });
    // Any change to what a login signs in with (or where it is used) means signing in again.
    const loginChanged =
      login && after.usedBy.length > 0 && (changed.length > 0 || added.length > 0);
    // A proxy now serving an account (or no longer serving it) reaches its running desktop.
    const filesFor =
      login || after.kind === "mailbox"
        ? []
        : [...(changed.length > 0 ? after.usedBy : added), ...removed];
    await this.afterSave(owner, after, { login: loginChanged, filesFor });
    if (after.kind === "mailbox" && (changed.length > 0 || added.length > 0))
      await this.mailboxSaved(owner, after);
    return this.get(owner, id);
  }
  async remove(owner: string, id: string) {
    const scope = scopeOfOwner(owner);
    const entry = await this.store.get(scope, id);
    if (!entry) throw notFound();
    await this.store.remove(scope, id, ownerActor());
    // The accounts a removed proxy served are left without one: their running
    // desktops too. A removed site login no longer serves its account: its sign-in fact for the
    // site goes (it named a login that is gone) and so do the open requests it answered.
    if (entry.kind !== "site_login")
      await this.afterSave(owner, entry, { login: false, filesFor: entry.usedBy });
    else if (entry.site)
      for (const user of entry.usedBy) {
        await removeSignIn(this.db, this.factOwner(owner, user), entry.site);
        await this.store.closeRequests(scope, { site: entry.site, for: user }, "withdrawn");
      }
  }
  /** Where a user's sign-in facts are kept: the account's derived owner, or the project's. */
  private factOwner(owner: string, user: CredentialUsedBy) {
    return user.type === "account" ? envOwner(owner, user.environmentId) : scopeOfOwner(owner);
  }
  /** A saved login starts a sign-in task for the account it serves: refuse first when there is
   * no room for one. */
  private async roomForSignIns(owner: string, usedBy: CredentialUsedBy[], site: string | null) {
    if (!site) return;
    const logins = usedBy.flatMap((user) =>
      user.type === "account" ? [{ environmentId: user.environmentId, site }] : [],
    );
    if (logins.length) await this.agent?.assertRoomForSignIns(owner, logins);
  }
  async history(owner: string, raw: unknown) {
    const query = auditQuery.parse(raw);
    const scope = scopeOfOwner(owner);
    if (query.entry && !(await this.store.get(scope, query.entry))) throw notFound();
    const page = await this.store.history(scope, query);
    if (await this.hidden(owner)) {
      if (query.entry) {
        const entry = await this.store.get(scope, query.entry);
        if (entry && CredentialService.system(entry.kind)) throw notFound();
      }
      page.rows = page.rows.filter((row) => !CredentialService.system(row.entryKind));
    }
    // A line the owner wrote before members existed names nobody. Only the
    // first space has such lines, and only its first user used the workspace then: they are his,
    // so another member never reads them as 「你」.
    if (realOwnerOf(scope) !== firstSpaceKey) return page;
    return {
      ...page,
      rows: page.rows.map((row) =>
        row.actor.type === "owner" && !row.actor.userId
          ? { ...row, actor: { type: "owner" as const, userId: firstUserId } }
          : row,
      ),
    };
  }
  /** A mailbox was saved: the requests for one close (the
   * project's and its accounts'), and the project's operating task is told so it sends. */
  private async mailboxSaved(owner: string, view: CredentialView) {
    const scope = scopeOfOwner(owner);
    const users: CredentialUsedBy[] = [{ type: "project" }, ...view.usedBy];
    const asked = new Set<string>();
    for (const user of users)
      for (const request of await this.store.closeRequests(
        scope,
        { site: mailboxRequestSite, for: user },
        "fulfilled",
      ))
        if (request.by.taskId) asked.add(request.by.taskId);
    const text = "本项目的发信邮箱已设好，可以发邮件了。";
    // The tasks that asked for it are told (and so woken), whatever kind they are; a role without
    // an operating plan (the store's logistics) would otherwise wait out its own wait.
    for (const taskId of asked) await this.agent?.tellAsker(owner, taskId, text);
    await this.agent?.projectCredentialSaved(owner, text);
  }
  /** What follows a save: a saved or replaced login is marked pending and the AI signs in (or the
   * task that asked for it is woken); with a computer, an entry now serving (or no longer
   * serving) an account reaches its desktop. */
  private async afterSave(
    owner: string,
    view: CredentialView,
    changed: { login: boolean; filesFor: CredentialUsedBy[] },
  ) {
    if (changed.login && view.site)
      for (const user of view.usedBy) await this.loginSaved(owner, user, view.site);
  }
  /** A login of `site` was saved for `usedBy`: the sign-in fact turns to `pending` ("saved,
   * waiting for a task to sign in"), the requests for it are fulfilled, and the agent wakes the
   * task that asked or starts one that signs in. */
  async loginSaved(owner: string, usedBy: CredentialUsedBy, site: string) {
    const scope = scopeOfOwner(owner);
    await writeSignIn(this.db, this.factOwner(owner, usedBy), {
      site,
      status: "pending",
      detail: null,
      at: new Date().toISOString(),
      by: { owner: true },
    });
    const requests = await this.store.closeRequests(scope, { site, for: usedBy }, "fulfilled");
    await this.agent?.signInSaved(owner, usedBy, site, requests);
  }
}
