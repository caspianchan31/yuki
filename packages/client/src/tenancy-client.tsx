/**
 * The client side of the tenancy port: everything the shared client logic (providers, hooks, the
 * shell's data) needs to know about a multi-tenant deployment, behind one React context. The core
 * default is a single user in a single place: no spaces, no store space, no platform exits, no
 * registration status. The multi-tenant layer (tenancy/client + tenancy/web) provides the real
 * answers through the web's one door (apps/web/src/main.tsx); nothing in the core imports tenancy/.
 * The web's UI slots extend this contract in apps/web/src/tenancy-ui.tsx.
 */
import { createContext, useContext } from "react";
import type { MuseApi } from "./api";

/** What the shell reads about the space on screen. */
export interface SpaceInfo {
  /** The signed-in person runs the platform (平台管理). */
  operator: boolean;
  /** The space is a customer's store (no project layer, its conversation is the store's). */
  store: boolean;
  /** The signed-in person's user id; null without spaces. */
  userId: string | null;
  /** The space's id; null without spaces. */
  key: string | null;
  /** The space's name; null without spaces. */
  name: string | null;
  /** The platform sets up this space's proxies (members see exits, never proxies). */
  platformEnv: boolean;
  /** How many people share the space (1 alone). */
  members: number;
  /** There is a space at all (the page is inside the space gate). */
  shared: boolean;
}

export const singleUserSpace: SpaceInfo = {
  operator: false,
  store: false,
  userId: null,
  key: null,
  name: null,
  platformEnv: false,
  members: 1,
  shared: false,
};

/** An exit (a proxy the platform gave the space) as its members see it: no address, no port. */
export interface ExitView {
  id: string;
  name: string;
  ok: boolean | null;
  checkedAt: string | null;
  account: { id: string; name: string } | null;
  report: { status: "open" | "closed"; at: string; closedAt: string | null } | null;
}
export interface ExitsView {
  exits: ExitView[];
  application: { at: string } | null;
}
export interface ExitPicker {
  options: { id: string; label: string }[];
  none: boolean;
  applied: boolean;
}
export interface ExitsHandle {
  view: ExitsView | null;
  error: boolean;
  reload: () => Promise<void>;
  apply: (note?: string) => Promise<ExitsView | null>;
  report: (id: string, note?: string) => Promise<ExitsView | null>;
}

/** The platform's exits (出口): shown instead of proxies in a space the platform sets up. */
export interface ExitsPort {
  useExits: (enabled: boolean) => ExitsHandle;
  /** Every mounted reader reads again (after an account's exit changed anywhere). */
  exitsChanged: () => void;
  exitOfAccount: (
    view: ExitsView | null,
    accountId: string,
    proxyId?: string | null,
  ) => ExitView | null;
  exitPicker: (view: ExitsView, accountId: string | null) => ExitPicker;
  initialExit: (view: ExitsView, accountId: string | null) => string | null;
  exitLines: (
    exit: ExitView,
    clock: (iso: string) => string,
  ) => { line: string; down: string | null; report: string | null };
  canReport: (exit: Pick<ExitView, "report">) => boolean;
  /** Whether a credential kind is the platform's (neither seen nor given by a member). */
  platformKind: (kind: string, platformEnv: boolean) => boolean;
}

export interface ClientTenancy {
  /** The space on screen (a hook: it follows the space the person switches to). */
  useSpace: () => SpaceInfo;
  exits: ExitsPort;
  /** A refused sign-in's answer, as the registration status it carries; null for none. */
  normalizeRegistration: (raw: unknown) => object | null;
  /** The space's people by user id (for a line another member wrote); empty when alone. */
  useSpaceMembers: (api: MuseApi) => ReadonlyMap<string, string>;
}

const noMembers: ReadonlyMap<string, string> = new Map();
const noExits: ExitsHandle = {
  view: null,
  error: false,
  reload: async () => undefined,
  apply: async () => null,
  report: async () => null,
};

export const singleUserTenancy: ClientTenancy = {
  useSpace: () => singleUserSpace,
  exits: {
    useExits: () => noExits,
    exitsChanged: () => undefined,
    exitOfAccount: () => null,
    exitPicker: () => ({ options: [], none: true, applied: false }),
    initialExit: () => null,
    exitLines: (exit) => ({ line: exit.name, down: null, report: null }),
    canReport: () => false,
    platformKind: () => false,
  },
  normalizeRegistration: () => null,
  useSpaceMembers: () => noMembers,
};

export const ClientTenancyContext = createContext<ClientTenancy>(singleUserTenancy);

export function useClientTenancy(): ClientTenancy {
  return useContext(ClientTenancyContext);
}
/** The space on screen. */
export function useSpaceInfo(): SpaceInfo {
  return useClientTenancy().useSpace();
}
/** Whether the current space's environment is the platform's. */
export function usePlatformEnv(): boolean {
  return useSpaceInfo().platformEnv;
}
/** The platform's exits: the hook that reads them and the helpers that read their view. */
export function useExitsPort(): ExitsPort {
  return useClientTenancy().exits;
}
/** The space's people by user id; empty when the person is alone. */
export function useSpaceMembers(api: MuseApi): ReadonlyMap<string, string> {
  return useClientTenancy().useSpaceMembers(api);
}
