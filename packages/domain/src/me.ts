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
}

/** The signed-in user and the spaces they belong to (GET /api/me). */
export interface MeView {
  user: { id: string; username: string; operator: boolean };
  spaces: SpaceView[];
}
