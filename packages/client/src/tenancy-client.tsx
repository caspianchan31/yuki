/**
 * The client side of the tenancy port: everything the shared client logic (providers, hooks, the
 * shell's data) needs to know about a multi-tenant deployment, behind one React context. The core
 * default is a single user in a single place: no spaces, no registration status. The multi-tenant layer (tenancy/client + tenancy/web) provides the real
 * answers through the web's one door (apps/web/src/main.tsx); nothing in the core imports tenancy/.
 * The web's UI slots extend this contract in apps/web/src/tenancy-ui.tsx.
 */
import { createContext, useContext } from "react";
import type { MuseApi } from "./api";

/** What the shell reads about the space on screen. */
export interface SpaceInfo {
  /** The signed-in person runs the platform (平台管理). */
  operator: boolean;
  /** The signed-in person's user id; null without spaces. */
  userId: string | null;
  /** The space's id; null without spaces. */
  key: string | null;
  /** The space's name; null without spaces. */
  name: string | null;
  /** How many people share the space (1 alone). */
  members: number;
  /** There is a space at all (the page is inside the space gate). */
  shared: boolean;
}

export const singleUserSpace: SpaceInfo = {
  operator: false,
  userId: null,
  key: null,
  name: null,
  members: 1,
  shared: false,
};

export interface ClientTenancy {
  /** The space on screen (a hook: it follows the space the person switches to). */
  useSpace: () => SpaceInfo;
  /** A refused sign-in's answer, as the registration status it carries; null for none. */
  normalizeRegistration: (raw: unknown) => object | null;
  /** The space's people by user id (for a line another member wrote); empty when alone. */
  useSpaceMembers: (api: MuseApi) => ReadonlyMap<string, string>;
}

const noMembers: ReadonlyMap<string, string> = new Map();

export const singleUserTenancy: ClientTenancy = {
  useSpace: () => singleUserSpace,
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
/** The space's people by user id; empty when the person is alone. */
export function useSpaceMembers(api: MuseApi): ReadonlyMap<string, string> {
  return useClientTenancy().useSpaceMembers(api);
}
