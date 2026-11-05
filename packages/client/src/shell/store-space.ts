/**
 * The name of what is on screen. v1.5 (docs/v1.5.md): there are no store spaces any more; every
 * space has the same shape (the file keeps its name for its many importers).
 */
import { useProjects } from "../projects-state";
import { t } from "./strings";

/** The name of what is on screen: the project, or the space's own conversation. */
export function useProjectTitle(): string {
  const { project } = useProjects();
  return project?.name ?? t.projects.defaultName;
}
