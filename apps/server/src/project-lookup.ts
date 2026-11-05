// The space's projects by name: what the hall's assistant uses to find the project a request names.
import type { Project } from "../../../packages/domain/src/projects.ts";
import { projectOwner, realOwnerOf } from "../../../packages/domain/src/projects.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { withoutStrayGroups } from "./stray-groups.ts";

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
