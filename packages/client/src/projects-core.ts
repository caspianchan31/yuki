/**
 * Projects (fork feature): pure logic for the mobile app. A project is a partition of one
 * workspace: conversations, tasks, goals, monitors, memories, notifications, files, browser
 * sessions and the default desktop belong to one project; accounts (environments) are global and
 * carry an optional project assignment. The default project is the data without a project.
 * This file must stay free of react-native so the node:test suite can import it.
 *
 * HTTP contract (real owner: these routes ignore the project header):
 *   GET    /api/projects       ProjectView[] sorted by name (503 when the feature is off)
 *   POST   /api/projects       { name } -> 201 ProjectView (422 reserved, invalid or at the limit;
 *                              409 duplicate)
 *   PATCH  /api/projects/:id   { name } -> ProjectView
 *   DELETE /api/projects/:id   204; the project's accounts return to unassigned
 * Every other /api request carries X-OpenMuse-Project (see api-client.ts).
 */
import {
  isProjectId,
  isReservedProjectName,
  type ProjectView,
  projectNameMax,
} from "../../../packages/domain/src/projects.ts";
import { ApiError } from "./api-response.ts";

export type { ProjectView };

/** Where the web app keeps the current project id between reloads. */
export const PROJECT_STORAGE_KEY = "openmuse.project";
export const DEFAULT_PROJECT_LABEL = "Default";
export const DELETE_PROJECT_WARNING =
  "Deletes this project's conversations, tasks and desktop. Accounts are kept and return to unassigned.";

/** The subset of Storage the app uses; localStorage on web, an in-memory stand-in elsewhere. */
export interface ProjectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** An in-memory ProjectStorage for platforms without localStorage. */
export function memoryStorage(): ProjectStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}
/** Each space remembers its own last project; without a space (and for the
 * choice stored before spaces) the one key of before. */
const projectStorageKey = (space?: string | null) =>
  space ? `${PROJECT_STORAGE_KEY}:${space}` : PROJECT_STORAGE_KEY;
/** The persisted project id, or null for the default project; anything unreadable reads as default. */
export function readStoredProject(
  storage: ProjectStorage | null | undefined,
  space?: string | null,
): string | null {
  try {
    const value =
      storage?.getItem(projectStorageKey(space)) ??
      (space ? storage?.getItem(PROJECT_STORAGE_KEY) : null);
    return typeof value === "string" && isProjectId(value) ? value : null;
  } catch {
    return null;
  }
}
/** Persist the current project; null (the default project) clears the entry. Never throws. */
export function writeStoredProject(
  storage: ProjectStorage | null | undefined,
  projectId: string | null,
  space?: string | null,
): void {
  try {
    // The default project is stored as "" in a space, so the earlier key is not read instead.
    if (projectId) storage?.setItem(projectStorageKey(space), projectId);
    else if (space) storage?.setItem(projectStorageKey(space), "");
    else storage?.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // Private mode, quota or a blocked origin: the choice simply does not survive a reload.
  }
}
/**
 * The project to use once the list is known: the stored one while it still exists and is not
 * being deleted, otherwise the default project, silently.
 */
export function resolveStoredProject(
  stored: string | null,
  projects: readonly ProjectView[],
): string | null {
  return stored && projects.some((project) => project.id === stored && !project.deleting)
    ? stored
    : null;
}

const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** Read a ProjectView defensively; a missing account count reads as 0. */
export function normalizeProject(value: unknown): ProjectView {
  const item = record(value);
  const environments =
    typeof item.environments === "number" && Number.isFinite(item.environments)
      ? Math.max(0, Math.trunc(item.environments))
      : 0;
  return {
    id: text(item.id),
    name: text(item.name),
    deleting: item.deleting === true,
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt),
    environments,
  };
}
/** Read GET /api/projects: entries without an id are dropped; order is the server's. */
export function normalizeProjects(value: unknown): ProjectView[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeProject)
    .filter((project) => project.id !== "");
}

/** The name to send, trimmed, or why it can't be. Mirrors the server's rules. */
export function validProjectName(name: string): string | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required" };
  if (trimmed.length > projectNameMax)
    return { error: `Name must be at most ${projectNameMax} characters` };
  if (isReservedProjectName(trimmed))
    return { error: `Name "${trimmed}" is reserved for the default project` };
  return trimmed;
}

/** The chip and row label for a project; the default project has no record. */
export function projectLabel(project: Pick<ProjectView, "name"> | null | undefined): string {
  return project ? project.name : DEFAULT_PROJECT_LABEL;
}
/** "1 account" / "3 accounts". */
export function accountsLabel(count: number): string {
  return `${count} account${count === 1 ? "" : "s"}`;
}
/** A React key or storage bucket for a project: its id, or "default". */
export function projectKey(projectId: string | null | undefined): string {
  return projectId ?? "default";
}
export const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

/** The feature-off 503 from GET /api/projects: the project UI hides itself. */
export function projectsUnavailable(error: unknown) {
  return error instanceof ApiError && error.status === 503;
}
/** A 404 from a scoped request: the project was deleted since it was selected. */
export function projectGone(error: unknown) {
  return error instanceof ApiError && error.status === 404 && /project/i.test(error.message);
}
/** The provider's last failure, structured, so each shell words it itself:
 * reading the list, or a delete that stopped halfway. `gone`: the project no longer exists. */
export interface ProjectsFailure {
  kind: "list" | "delete";
  gone: boolean;
  /** The server's (or the network's) own message. */
  message: string;
}
export function projectsFailure(kind: ProjectsFailure["kind"], error: unknown): ProjectsFailure {
  return {
    kind,
    gone: projectGone(error),
    message: error instanceof Error ? error.message : String(error),
  };
}
export function projectError(error: unknown) {
  if (projectGone(error)) return "This project no longer exists. Pick another one.";
  return error instanceof Error ? error.message : String(error);
}
/** A DELETE that answers 204 (no body) is a success; so is a 2xx answer with an empty body. */
export async function noContent(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && /unreadable response \(2\d\d\)/.test(error.message)) return;
    throw error;
  }
}
