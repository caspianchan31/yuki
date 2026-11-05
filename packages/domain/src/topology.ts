/**
 * The members' topology (fork feature): every member (environment) of the request's project, with
 * its project assignment, its time zone and language and its desktop state. Pure types shared by
 * the server and the mobile app. Nothing here is a secret. (v1.5: no proxy or exit any more.)
 */
import type { EnvironmentStatus } from "./environments.ts";
import type { MemberFace } from "./member-face.ts";

export interface TopologyProject {
  id: string;
  name: string;
}

export interface TopologyEnvironment {
  id: string;
  name: string;
  accountLabel: string | null;
  /** v1.2: the member's chosen face, when she has one. */
  face?: MemberFace;
  /** null is unassigned (the default project). */
  projectId: string | null;
  locale: string | null;
  timezone: string | null;
  /** The desktop's state, as on the Environments page. */
  desktop: EnvironmentStatus;
}

/** GET /api/topology: live projects and live accounts, both sorted by name. */
export interface Topology {
  projects: TopologyProject[];
  environments: TopologyEnvironment[];
}
