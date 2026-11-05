/**
 * The members' topology (fork feature): pure logic for reading GET /api/topology, the members of
 * the request's project with their project, time zone and language and desktop state. v1.5: no
 * proxy or exit, so nothing is grouped by one any more.
 * This file must stay free of react-native so the node:test suite can import it.
 *
 * HTTP contract (real owner: the project header is ignored):
 *   GET /api/topology  Topology (503 without environments)
 */
import type { EnvironmentStatus } from "../../../packages/domain/src/environments.ts";
import { parseMemberFace } from "../../../packages/domain/src/member-face.ts";
import type {
  Topology,
  TopologyEnvironment,
  TopologyProject,
} from "../../../packages/domain/src/topology.ts";
import { environmentsUnavailable, statusLabel } from "./environments.ts";

export type { Topology, TopologyEnvironment, TopologyProject };

export const TOPOLOGY_PATH = "/api/topology";
export const UNASSIGNED_LABEL = "Unassigned";
export const UNKNOWN_PROJECT_LABEL = "Unknown project";

const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const statuses: readonly EnvironmentStatus[] = ["missing", "stopped", "running", "error"];

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
      const face = parseMemberFace(environment.face);
      return {
        id: text(environment.id),
        name: text(environment.name),
        accountLabel: textOrNull(environment.accountLabel),
        ...(face ? { face } : {}),
        projectId: textOrNull(environment.projectId),
        locale: textOrNull(environment.locale),
        timezone: textOrNull(environment.timezone),
        desktop: statuses.find((status) => status === environment.desktop) ?? "error",
      };
    })
    .filter((environment) => environment.id !== "");
  return { projects, environments };
}

/** The project's name, "Unassigned", or "Unknown project" for an id with no live project. */
export function projectName(projectId: string | null, projects: readonly TopologyProject[]) {
  if (projectId === null) return UNASSIGNED_LABEL;
  return projects.find((project) => project.id === projectId)?.name || UNKNOWN_PROJECT_LABEL;
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
