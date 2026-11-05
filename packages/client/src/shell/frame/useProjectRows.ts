/**
 * The project rows of the column and the panel, from N1, the project
 * list and the current project's local counts (see project-rows.ts). When N1 knows a project the
 * list does not (created in another tab), the list is re-read once.
 */
import { useEffect, useMemo } from "react";
import { useProjects } from "../../projects-state";
import { useOverview, useShellData } from "../data";
import { type ProjectRowModel, projectRows, unknownProjectIds } from "./project-rows";

export function useProjectRows(): ProjectRowModel[] {
  const { projects, available, current, refresh } = useProjects();
  const overview = useOverview();
  const { counts } = useShellData();
  const rows = useMemo(
    () =>
      projectRows({
        overview: overview.projects,
        projects,
        projectsAvailable: available,
        current,
        currentCounts: counts,
      }),
    [overview.projects, projects, available, current, counts],
  );
  const unknown = unknownProjectIds(overview.projects, projects).join(",");
  useEffect(() => {
    if (unknown && available) void refresh();
  }, [unknown]);
  return rows;
}
