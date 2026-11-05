/**
 * Core (single-user) view of the signed-in user and their spaces: the header a request names its
 * space with, and the shape of GET /api/me. The multi-tenant layer (tenancy/domain/spaces.ts)
 * re-exports these and adds the rest.
 */

/** Request header naming the space a request acts in; a member of one space may leave it out. */
export const SPACE_HEADER = "X-OpenMuse-Space";

export type SpaceRole = "admin" | "member";
export const spaceRoles: readonly SpaceRole[] = ["admin", "member"];

/** A space the signed-in user belongs to, as /api/me lists it. */
export interface SpaceView {
  id: string;
  name: string;
  role: SpaceRole;
  /** How many members the space has (the user included). */
  members: number;
  /** A customer's store (a subscription): no projects, no 营销总群. */
  store?: boolean;
  /** Proxies are set up by the platform operator, not by members. */
  platformEnv?: boolean;
  /** Another store of a customer, not opened yet by the operator
   * (`pending`: 正在开通中) or refused by him (`rejected`). Absent once it is open. */
  opening?: "pending" | "rejected";
}

/** The signed-in user and the spaces they belong to (GET /api/me). */
export interface MeView {
  user: { id: string; username: string; operator: boolean };
  spaces: SpaceView[];
}
