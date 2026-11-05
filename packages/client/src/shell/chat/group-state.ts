/**
 * Phase C (docs/web.md): who the conversation on screen belongs to, from Group.tsx and
 * Speaker.tsx, free of React Native so the web app names the speakers the same way.
 *   useOpsName        the project's 运营专员 name
 *   useIsHall         whether the conversation is the 营销总群
 *   useMascotVariant  the capybara's colour from the stored identity
 */
import { useAgentWorkspace } from "../../agent-workspace";
import { useProjects } from "../../projects-state";
import { useStoreSpace } from "../store-space";
import { t } from "../strings";
import { mascotVariant } from "./core";

/** The project's 运营专员 name: 「acmeskills 运营专员」, 「运营专员」 in 未分组. */
export function useOpsName(): string {
  const projects = useProjects();
  // The space's own conversation has the hall's assistant.
  const space = useStoreSpace();
  if (space.store) return t.group.ops(space.name);
  return projects.current === null ? t.group.hallOps : t.group.ops(projects.project?.name ?? null);
}
/** Whether the conversation on screen is the 营销总群 (the space's own, the default project). */
export function useIsHall(): boolean {
  const current = useProjects().current;
  const space = useStoreSpace();
  return current === null && !space.store;
}

/** The capybara's colour from the stored identity (sky until the settings have loaded). */
export function useMascotVariant() {
  const { data } = useAgentWorkspace();
  return mascotVariant(data?.identity.avatar);
}
