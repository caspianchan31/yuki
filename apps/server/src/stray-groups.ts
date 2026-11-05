// A request for no project could make a group named "null" (the model sent the
// word, not JSON null). Such a group with nobody in it is not shown: the sidebar, the hall's
// project list and the overview read the space's projects through `withoutStrayGroups`.
import { isEmptyProjectWord, type Project } from "../../../packages/domain/src/projects.ts";
import type { Store } from "./db.ts";

export async function withoutStrayGroups(
  db: Store,
  real: string,
  projects: Project[],
): Promise<Project[]> {
  if (!projects.some((project) => isEmptyProjectWord(project.name))) return projects;
  const members = new Set(
    (await db.list<{ projectId?: string | null; deleting?: boolean }>(real, "environments"))
      .filter((record) => !record.deleting && record.projectId)
      .map((record) => record.projectId),
  );
  return projects.filter((project) => !isEmptyProjectWord(project.name) || members.has(project.id));
}
