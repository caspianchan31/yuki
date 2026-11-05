// What the core asks of "who is asking and which space they act in", without knowing whether
// there are many spaces. `singleUserTenancy` is the core's own: one implicit space (`local-user`),
// the admin user only, no extra routes, nothing gated. The multi-tenant layer's `multiTenancy`
// (tenancy/register.ts) is the other implementation; createApp builds it unless told otherwise.
import type { Hono } from "hono";
import type { MeView, SpaceRole } from "../../../packages/domain/src/me.ts";
import type { Auth, SessionUser } from "./auth.ts";
import { firstSpaceKey, firstUserId } from "./auth.ts";
import type { ComputerService } from "./computer.ts";
import type { Config } from "./config.ts";
import type { CredentialService } from "./credentials/service.ts";
import type { CredentialStore } from "./credentials/store.ts";
import type { Store } from "./db.ts";
import type { AgentService } from "./engine/service.ts";
import type { EnvironmentService } from "./environments.ts";
import { AppError } from "./errors.ts";
import type { AgentExtension } from "./extensions.ts";
import { allowAllGate, type PlanGate, type SpaceScopes } from "./gate.ts";
import type { MemberFileStore } from "./member-files/store.ts";

/** The space a request acts in, and the member's role there. */
export interface RequestSpace {
  id: string;
  key: string;
  name: string;
  role: SpaceRole;
}

/** What the API's middleware keeps for the rest of a request. */
export type AppEnv = { Variables: { owner: string; user: SessionUser; space: RequestSpace } };
export type AppRoutes = Hono<AppEnv>;

/** Whether `owner` is the space's own key or one derived from it (a
 * project `key/proj:<id>`, an account `key#env:<id>`). */
export function ownerInSpace(owner: string, key: string): boolean {
  if (owner === key) return true;
  if (!owner.startsWith(key)) return false;
  const next = owner.charAt(key.length);
  return next === "/" || next === "#";
}

/** A request may only touch owners of its own space. Every owner a
 * route uses already comes from the space, so this never fires unless code is wrong: it answers
 * 500 and logs, rather than serve another space's data. */
export function assertInSpace(owner: string, key: string) {
  if (ownerInSpace(owner, key)) return;
  console.error("[OpenMuse] A request reached an owner outside its space; refused");
  throw new AppError("Request failed. Check the server setup and try again.", 500);
}

/** What the core hands the tenancy layer once its services exist. */
export interface TenancyCore {
  db: Store;
  config: Config;
  auth: Auth;
  agent: AgentService;
  computer: ComputerService;
  environments: EnvironmentService;
  credentials: CredentialService;
  credentialStore: CredentialStore;
}

export interface Tenancy {
  /** What the agent asks before work runs or a project is added. */
  readonly plan: PlanGate & SpaceScopes;
  /** What the layer adds to the agent (the store). */
  readonly extensions: AgentExtension[];
  /** /api paths that act for the signed-in user, not for a space. */
  readonly userLevelPath: RegExp;
  /** /api paths that act on the space itself, with no project header. */
  readonly unscopedPath: RegExp;
  /** The key a single-space user acts in. */
  defaultKey(userId: string): Promise<string>;
  /** The space named by the request's space header, which must be one of the user's. */
  resolve(userId: string, header: string | undefined): Promise<RequestSpace>;
  spacesOf(userId: string): Promise<RequestSpace[]>;
  spaces(): Promise<{ key: string; name: string }[]>;
  memberCount(key: string): Promise<number>;
  /** Usernames of this space's members by user id (who said what in a conversation). */
  usernames(key: string): Promise<Map<string, string>>;
  /** One line of the space's activity, by the member acting in this request. */
  record(key: string, action: string, subject: string | null, detail: string | null): Promise<void>;
  me(user: SessionUser): Promise<MeView>;
  ensureFirstSpace(): Promise<unknown>;
  /** What to run when a space gets its first member (agent identity, sample data). */
  provisionWith(provision: (key: string) => Promise<void>): void;
  /** What a refused sign-in of a sign-up not yet opened tells; undefined without sign-ups. */
  registrationStatus?(userId: string): Promise<unknown>;
  /** Wires its hooks into the core's services (once they exist). */
  attach(core: TenancyCore): Promise<void>;
  /** Routes that need no session. */
  mountPublic(app: AppRoutes, core: TenancyCore): void;
  /** Routes of the signed-in user, in no space (the user-level paths). */
  mountUser(app: AppRoutes, core: TenancyCore): void;
  /** Routes of the request's space, after its project is resolved. */
  mountScoped(app: AppRoutes, core: TenancyCore): void;
  /** The deployment is one owner's: connected apps may be on the owner's own machine or network
   * (an MCP server on localhost). A server many people share leaves this out. */
  readonly privateNetwork?: boolean;
  /** Where member files are kept, when not the core's directory of .md files. */
  memberFileStore?(db: Store): MemberFileStore;
}

export type TenancyFactory<T extends Tenancy = Tenancy> = (deps: {
  db: Store;
  config: Config;
  auth: Auth;
}) => T;

/** The core's default: one implicit space, its admin the only user, nothing else. */
export const singleUserTenancy: TenancyFactory = ({ config, auth }) => {
  const space = (): RequestSpace => ({
    id: "00000000-0000-4000-8000-000000000001",
    key: firstSpaceKey,
    name: config.mode === "live" ? "我的空间" : "示例空间",
    role: "admin",
  });
  return {
    plan: allowAllGate,
    extensions: [],
    privateNetwork: true,
    userLevelPath: /^\/api\/(?:auth|me)(?:\/|$)/,
    unscopedPath: /^\/api\/(?:projects|google|auth|me)(?:\/|$)/,
    defaultKey: async () => firstSpaceKey,
    resolve: async () => space(),
    spacesOf: async () => [space()],
    spaces: async () => [space()],
    memberCount: async () => 1,
    usernames: async () => {
      const admin = await auth.findUser(firstUserId);
      return new Map(admin ? [[admin.id, admin.username]] : []);
    },
    record: async () => {},
    me: async (user) => ({
      user: { id: user.userId, username: user.username, operator: user.operator },
      spaces: [{ id: space().id, name: space().name, role: "admin", members: 1 }],
    }),
    // The admin account's user record (live mode); the one space needs no records.
    ensureFirstSpace: async () => {
      if (config.mode === "live") await auth.migrateAdmin();
    },
    provisionWith: () => {},
    attach: async () => {},
    mountPublic: () => {},
    mountUser: () => {},
    mountScoped: () => {},
  };
};
