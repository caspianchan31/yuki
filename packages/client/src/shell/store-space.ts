/**
 * A customer's store
 * space has no project layer (no project column, no switcher, no 营销总群); its conversation is the
 * store's own, named after the space. An internal space (the operator's own, for marketing several
 * products) keeps its projects and the 营销总群. Which space is on screen comes from the tenancy
 * port (tenancy-client.tsx); without one nothing here is a store.
 */
import { useProjects } from "../projects-state";
import { useSpaceInfo } from "../tenancy-client";
import { t } from "./strings";

/** Whether the space on screen is a customer's store, and its name. */
export function useStoreSpace(): { store: boolean; name: string | null } {
  const space = useSpaceInfo();
  return { store: space.store, name: space.name };
}

/** The name of what is on screen: the project, the store (a store space), or 营销总群. */
export function useProjectTitle(): string {
  const { project } = useProjects();
  const space = useStoreSpace();
  return project?.name ?? (space.store && space.name ? space.name : t.projects.defaultName);
}
