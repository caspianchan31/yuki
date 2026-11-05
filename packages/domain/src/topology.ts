/**
 * Accounts & proxies topology (fork feature): every account (environment) of the signed-in
 * user across all projects, with its project assignment, its proxy endpoint and its desktop
 * state. Pure types shared by the server and the mobile app. Nothing here is a secret: the
 * proxy is only ever its scheme, host and port, never its credentials.
 */
import type { EnvironmentStatus } from "./environments.ts";
import type { MemberFace } from "./member-face.ts";

/** Where an account's traffic leaves: the proxy server, without user name or password. */
export interface ProxyEndpoint {
  scheme: string;
  host: string;
  port: number;
}

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
  /** null when no proxy is saved, or when the saved settings can't be read. */
  proxy: ProxyEndpoint | null;
  /** Settings are saved but this server can't read them, so the proxy is unknown. */
  proxyUnreadable: boolean;
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
