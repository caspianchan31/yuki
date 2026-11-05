/** v1.2: every member of the space and the names of its groups, for the new-group dialog, the
 * group rail, the chat's @ list and the roster. The open group's accounts come first; the rest
 * are read from the space-wide list. */

import { useProjects } from "@m/projects-state";
import { useShellData } from "@m/shell/data";
import { useFounderRef } from "@m/shell/founder/useFounder";
import { allMembers, type GroupMember } from "@m/shell/members/groups";
import { t } from "@m/shell/strings";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface SpaceMember {
  id: string;
  name: string;
  projectId: string | null;
  face?: unknown;
}

/** The space's members whichever group is open. Read again when the open list or the topology
 * changes, which is what a move between groups refreshes. Both are polled and come back as new
 * objects on every poll, so they are compared by content: by identity, every mounted list read
 * the space again on each poll (about one request a second with a group open). */
export function useEveryone(): SpaceMember[] {
  const data = useShellData();
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const accountsKey = data.accounts.value
    .map((account) => `${account.id}:${account.projectId ?? ""}:${account.name}`)
    .join(",");
  const topologyKey = JSON.stringify(data.topology.value ?? null);
  useEffect(() => {
    let gone = false;
    void data
      .apiFor(null)
      .request<SpaceMember[]>("/api/environments/everyone")
      .then((list) => {
        if (!gone && Array.isArray(list)) setMembers(list);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [data.apiFor, accountsKey, topologyKey]);
  return members;
}

export function useAllMembers(): GroupMember[] {
  const data = useShellData();
  const everyone = useEveryone();
  const founderId = useFounderRef()?.environmentId ?? null;
  const accounts = data.accounts.value;
  return useMemo(
    () =>
      allMembers({
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          projectId: account.projectId,
          face: account.view.face,
        })),
        environments: everyone,
        founderId,
      }),
    [accounts, everyone, founderId],
  );
}

/** A group's name by its id; a group that is gone reads as such. */
export function useGroupName(): (projectId: string) => string {
  const { projects } = useProjects();
  return useCallback(
    (projectId: string) =>
      projects.find((project) => project.id === projectId)?.name ?? t.accountsPage.unknownProject,
    [projects],
  );
}
