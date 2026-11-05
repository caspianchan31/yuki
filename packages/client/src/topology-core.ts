/**
 * Accounts & proxies (fork feature): pure logic for the topology screen. Accounts are grouped
 * by proxy exit and by project; an exit that serves accounts of more than one project (the
 * unassigned accounts count as the default project) is flagged, because the rule is
 * that accounts sharing an exit stay in one project.
 * This file must stay free of react-native so the node:test suite can import it.
 *
 * HTTP contract (real owner: the project header is ignored):
 *   GET /api/topology  Topology (503 without environments)
 */
import type { EnvironmentStatus } from "../../../packages/domain/src/environments.ts";
import { parseMemberFace } from "../../../packages/domain/src/member-face.ts";
import type {
  ProxyEndpoint,
  Topology,
  TopologyEnvironment,
  TopologyProject,
} from "../../../packages/domain/src/topology.ts";
import { environmentsUnavailable, statusLabel } from "./environments.ts";

export type { ProxyEndpoint, Topology, TopologyEnvironment, TopologyProject };

export const TOPOLOGY_PATH = "/api/topology";
export const UNASSIGNED_LABEL = "Unassigned";
export const UNKNOWN_PROJECT_LABEL = "Unknown project";
export const NO_PROXY_LABEL = "No proxy";
export const UNREADABLE_PROXY_LABEL = "Proxy unreadable";
export const MIXED_EXIT_WARNING =
  "This exit carries accounts from more than one project. Keep accounts that share an exit in one project.";

export type ExitKind = "proxy" | "unreadable" | "none";

/** One account as the screen shows it: the record plus its project and exit labels. */
export interface TopologyAccount extends TopologyEnvironment {
  projectName: string;
  exitKey: string;
  exitLabel: string;
  /** The account's exit serves more than one project. */
  exitMixed: boolean;
}
export interface ExitGroup {
  key: string;
  kind: ExitKind;
  label: string;
  accounts: TopologyAccount[];
  /** The projects on this exit, by name; null id is unassigned. */
  projects: { id: string | null; name: string }[];
  mixed: boolean;
}
export interface ProjectGroup {
  /** null is the unassigned accounts (the default project). */
  id: string | null;
  name: string;
  accounts: TopologyAccount[];
  /** Distinct proxy exits among the accounts. */
  exits: number;
  /** Of those, exits that also serve another project. */
  sharedExits: number;
  countLine: string;
}
export interface TopologyView {
  exits: ExitGroup[];
  projects: ProjectGroup[];
  summary: string;
  mixedExits: number;
}

const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const statuses: readonly EnvironmentStatus[] = ["missing", "stopped", "running", "error"];

/** Only scheme, host and port are kept, whatever else a response carries. */
function endpoint(value: unknown): ProxyEndpoint | null {
  const item = record(value);
  const scheme = text(item.scheme);
  const host = text(item.host);
  const port = item.port;
  if (!scheme || !host || typeof port !== "number" || !Number.isInteger(port)) return null;
  if (port < 1 || port > 65535) return null;
  return { scheme, host, port };
}
/** Read GET /api/topology defensively; entries without an id are dropped, order is kept. */
export function normalizeTopology(value: unknown): Topology {
  const item = record(value);
  const projects = (Array.isArray(item.projects) ? item.projects : [])
    .map((entry) => {
      const project = record(entry);
      return { id: text(project.id), name: text(project.name) };
    })
    .filter((project) => project.id !== "");
  const environments = (Array.isArray(item.environments) ? item.environments : [])
    .map((entry): TopologyEnvironment => {
      const environment = record(entry);
      const proxy = endpoint(environment.proxy);
      const face = parseMemberFace(environment.face);
      return {
        id: text(environment.id),
        name: text(environment.name),
        accountLabel: textOrNull(environment.accountLabel),
        ...(face ? { face } : {}),
        projectId: textOrNull(environment.projectId),
        proxy,
        proxyUnreadable: !proxy && environment.proxyUnreadable === true,
        locale: textOrNull(environment.locale),
        timezone: textOrNull(environment.timezone),
        desktop: statuses.find((status) => status === environment.desktop) ?? "error",
      };
    })
    .filter((environment) => environment.id !== "");
  return { projects, environments };
}

/** The grouping key: one proxy server is one exit, whatever its scheme spelling. */
export function exitKey(environment: Pick<TopologyEnvironment, "proxy" | "proxyUnreadable">) {
  if (environment.proxy)
    return `proxy:${environment.proxy.host.toLowerCase()}:${environment.proxy.port}`;
  return environment.proxyUnreadable ? "unreadable" : "none";
}
/** `scheme://host:port`; several schemes on one server read `host:port (http, socks5)`. */
export function exitLabel(proxies: readonly ProxyEndpoint[], kind: ExitKind): string {
  if (kind === "unreadable") return UNREADABLE_PROXY_LABEL;
  if (kind === "none" || !proxies.length) return NO_PROXY_LABEL;
  const { host, port } = proxies[0];
  const schemes = [...new Set(proxies.map((proxy) => proxy.scheme.toLowerCase()))].sort();
  const endpointText = `${host.toLowerCase()}:${port}`;
  return schemes.length === 1
    ? `${schemes[0]}://${endpointText}`
    : `${endpointText} (${schemes.join(", ")})`;
}
/** The project's name, "Unassigned", or "Unknown project" for an id with no live project. */
export function projectName(projectId: string | null, projects: readonly TopologyProject[]) {
  if (projectId === null) return UNASSIGNED_LABEL;
  return projects.find((project) => project.id === projectId)?.name || UNKNOWN_PROJECT_LABEL;
}
const kindOf = (key: string): ExitKind =>
  key === "none" ? "none" : key === "unreadable" ? "unreadable" : "proxy";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Both groupings and the headline, from one response. */
export function topologyView(topology: Topology): TopologyView {
  const keyed = topology.environments.map((environment) => ({
    environment,
    key: exitKey(environment),
    name: projectName(environment.projectId, topology.projects),
  }));
  // Which projects each exit serves; only a real proxy exit can be mixed.
  const projectsByExit = new Map<string, Map<string | null, string>>();
  for (const { environment, key, name } of keyed) {
    const entry = projectsByExit.get(key) ?? new Map<string | null, string>();
    entry.set(environment.projectId, name);
    projectsByExit.set(key, entry);
  }
  const mixed = (key: string) =>
    kindOf(key) === "proxy" && (projectsByExit.get(key)?.size ?? 0) > 1;
  const labels = new Map<string, string>();
  for (const key of projectsByExit.keys())
    labels.set(
      key,
      exitLabel(
        keyed.filter((item) => item.key === key).flatMap((item) => item.environment.proxy ?? []),
        kindOf(key),
      ),
    );
  const accounts: TopologyAccount[] = keyed.map(({ environment, key, name }) => ({
    ...environment,
    projectName: name,
    exitKey: key,
    exitLabel: labels.get(key) ?? NO_PROXY_LABEL,
    exitMixed: mixed(key),
  }));

  const rank = (group: ExitGroup) =>
    group.kind === "proxy" ? (group.mixed ? 0 : 1) : group.kind === "unreadable" ? 2 : 3;
  const exits = [...projectsByExit.entries()]
    .map(([key, served]): ExitGroup => {
      const members = accounts
        .filter((account) => account.exitKey === key)
        .sort((a, b) => a.projectName.localeCompare(b.projectName) || byName(a, b));
      return {
        key,
        kind: kindOf(key),
        label: labels.get(key) ?? NO_PROXY_LABEL,
        accounts: members,
        projects: [...served.entries()].map(([id, name]) => ({ id, name })).sort(byName),
        mixed: mixed(key),
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  const projectGroup = (id: string | null, name: string): ProjectGroup => {
    const members = accounts.filter((account) => account.projectId === id).sort(byName);
    const proxied = new Set(
      members.filter((account) => kindOf(account.exitKey) === "proxy").map((a) => a.exitKey),
    );
    const shared = [...proxied].filter(mixed).length;
    const unproxied = members.filter((account) => kindOf(account.exitKey) !== "proxy").length;
    const parts = members.length
      ? [
          plural(members.length, "account"),
          plural(proxied.size, "proxy exit"),
          shared ? `${shared} shared with another project` : "",
          unproxied ? `${unproxied} without a known exit` : "",
        ]
      : ["No accounts"];
    return {
      id,
      name,
      accounts: members,
      exits: proxied.size,
      sharedExits: shared,
      countLine: parts.filter(Boolean).join(" · "),
    };
  };
  const known = new Set(topology.projects.map((project) => project.id));
  const orphans = [
    ...new Set(
      topology.environments
        .map((environment) => environment.projectId)
        .filter((id): id is string => id !== null && !known.has(id)),
    ),
  ];
  const projects = [
    ...topology.projects.map((project) => projectGroup(project.id, project.name)),
    ...orphans.map((id) => projectGroup(id, UNKNOWN_PROJECT_LABEL)),
    ...(accounts.some((account) => account.projectId === null)
      ? [projectGroup(null, UNASSIGNED_LABEL)]
      : []),
  ];

  const proxyExits = exits.filter((group) => group.kind === "proxy").length;
  const mixedExits = exits.filter((group) => group.mixed).length;
  const summary = [
    plural(accounts.length, "account"),
    plural(proxyExits, "proxy exit"),
    plural(topology.projects.length, "project"),
  ].join(" · ");
  return { exits, projects, summary, mixedExits };
}

/** "1 proxy exit is shared across projects" / "2 proxy exits are …"; null when none is. */
export function mixedExitsNotice(count: number): string | null {
  if (!count) return null;
  return `${plural(count, "proxy exit")} ${count === 1 ? "is" : "are"} shared across projects.`;
}
/** One line under an account: desktop state, locale and time zone. */
export function accountDetail(
  account: Pick<TopologyEnvironment, "desktop" | "locale" | "timezone">,
) {
  return [
    statusLabel(account.desktop),
    account.locale ?? "language not set",
    account.timezone ?? "time zone not set",
  ].join(" · ");
}
/** The account's title: its name, with the account label when there is one. */
export function accountTitle(account: Pick<TopologyEnvironment, "name" | "accountLabel">) {
  return account.accountLabel ? `${account.name} (${account.accountLabel})` : account.name;
}
/** The feature-off 503, shared with the Environments page. */
export const topologyUnavailable = environmentsUnavailable;
export function topologyError(error: unknown) {
  if (topologyUnavailable(error)) return error instanceof Error ? error.message : String(error);
}
