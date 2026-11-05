// The space's founder. One account of the space, in no
// project (its own desktop, proxy and logins, under the space's own scope), marked `founder`.
// Every project may give it jobs; its one loop (in the space's default project) takes them all,
// in the order the owner sets for the projects; every project's tasks and chats read its persona
// so that what they say about the founder or the products matches it.

import { personaFact } from "../../../../packages/domain/src/accounts.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import type { Project } from "../../../../packages/domain/src/projects.ts";
import { parseOwner, projectOwner, realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import type { Store } from "../db.ts";
import { envOwner } from "../environments.ts";
import { AppError } from "../errors.ts";
import { withoutStrayGroups } from "../stray-groups.ts";
import { readGoal, readPersona } from "./records.ts";

export const founderPrioritiesKind = "founder-priorities";
/** The owner's order of the projects for the founder: first comes first. */
export interface FounderPriorities {
  id: "priorities";
  order: string[];
  updatedAt: string;
}

/** The space's founder, or null. */
export async function founderOf(db: Store, owner: string): Promise<Environment | null> {
  const real = realOwnerOf(owner);
  const records = await db.list<Environment>(real, "environments");
  return records.find((record) => record.founder && !record.deleting) ?? null;
}
/** Whether `environmentId` is the space's founder. */
export async function isFounder(db: Store, owner: string, environmentId: string) {
  return (await founderOf(db, owner))?.id === environmentId;
}
/** The space's live projects, by name. */
export async function liveProjects(db: Store, owner: string) {
  return (
    await withoutStrayGroups(
      db,
      realOwnerOf(owner),
      await db.list<Project>(realOwnerOf(owner), "projects"),
    )
  )
    .filter((project) => !project.deleting)
    .sort((a, b) => a.name.localeCompare(b.name));
}
/** A project scope's name; null for the space's own scope (the hall). */
export async function projectNameOf(db: Store, scope: string): Promise<string | null> {
  const { projectId } = parseOwner(scope);
  if (!projectId) return null;
  return (await db.get<Project>(realOwnerOf(scope), "projects", projectId))?.name ?? null;
}
/** The scope of the project named `name` in `owner`'s space. */
export async function projectScopeByName(db: Store, owner: string, name: string): Promise<string> {
  const live = await liveProjects(db, owner);
  const wanted = name.trim().toLowerCase();
  const found = live.find((project) => project.name.toLowerCase() === wanted);
  if (!found)
    throw new AppError(
      `No project named "${name}". Projects: ${live.map((p) => p.name).join(", ")}`,
      404,
    );
  return projectOwner(realOwnerOf(owner), found.id);
}
/** Makes `environmentId` the founder (null: none). Only an account in no project can be: the
 * founder belongs to the space. The one before it stops being the founder. */
export async function setFounder(db: Store, owner: string, environmentId: string | null) {
  const real = realOwnerOf(owner);
  const records = await db.list<Environment>(real, "environments");
  const next = environmentId ? records.find((record) => record.id === environmentId) : null;
  if (environmentId && (!next || next.deleting)) throw new AppError("Environment not found", 404);
  if (next?.projectId)
    throw new AppError(
      "The founder belongs to the space, in no project: move this account to 未分组 first",
      409,
    );
  const now = new Date().toISOString();
  for (const record of records)
    if (record.founder && record.id !== environmentId)
      await db.compareAndSwap<Environment>(
        real,
        "environments",
        record.id,
        {},
        {
          founder: false,
          updatedAt: now,
        },
      );
  if (next && !next.founder)
    await db.compareAndSwap<Environment>(
      real,
      "environments",
      next.id,
      {},
      {
        founder: true,
        updatedAt: now,
      },
    );
  return founderOf(db, real);
}
/** The owner's order of the projects, with every live project in it (the ones he did not place
 * come after, by name). */
export async function founderPriorities(db: Store, owner: string) {
  const real = realOwnerOf(owner);
  const projects = await liveProjects(db, real);
  const saved = await db.get<FounderPriorities>(real, founderPrioritiesKind, "priorities");
  const placed = (saved?.order ?? []).filter((id) => projects.some((project) => project.id === id));
  const rest = projects.filter((project) => !placed.includes(project.id)).map((p) => p.id);
  const order = [...placed, ...rest];
  return order.map((id, index) => ({
    projectId: id,
    name: projects.find((project) => project.id === id)?.name ?? "",
    rank: index + 1,
    set: index < placed.length,
  }));
}
/** Saves the owner's order: project ids first to last (unknown ids are refused). */
export async function setFounderPriorities(db: Store, owner: string, order: string[]) {
  const real = realOwnerOf(owner);
  const projects = await liveProjects(db, real);
  const unique = [...new Set(order)];
  for (const id of unique)
    if (!projects.some((project) => project.id === id))
      throw new AppError(`No project with id "${id}" in this space`, 404);
  const value: FounderPriorities = {
    id: "priorities",
    order: unique,
    updatedAt: new Date().toISOString(),
  };
  const current = await db.get<FounderPriorities>(real, founderPrioritiesKind, "priorities");
  if (current) await db.compareAndSwap(real, founderPrioritiesKind, "priorities", {}, { ...value });
  else await db.insertIfAbsent(real, founderPrioritiesKind, value);
  return founderPriorities(db, real);
}
/** The project scopes of the space (where jobs are kept). */
export async function projectScopes(db: Store, owner: string) {
  const real = realOwnerOf(owner);
  return (await liveProjects(db, real)).map((project) => ({
    project,
    scope: projectOwner(real, project.id),
  }));
}
/** What every project's tasks and chats read about the founder: name, persona, long-term goal;
 * null without one. */
export async function founderFact(db: Store, owner: string) {
  const founder = await founderOf(db, owner);
  if (!founder) return null;
  const ledger = envOwner(realOwnerOf(owner), founder.id);
  return {
    name: founder.name,
    persona: personaFact(await readPersona(db, ledger)),
    goal: (await readGoal(db, ledger))?.text ?? null,
  };
}
