/**
 * v1.4 (docs/skills.md): the space's skills for the @ list and 设置. Read when the page mounts
 * and again when it regains focus (a skill saved in chat shows without a reload).
 */

import { useWorkspace } from "@m/workspace";
import { useCallback, useEffect, useState } from "react";
import type { Skill } from "../../../../packages/domain/src/skills";

export function useSkills() {
  const { api, workspace } = useWorkspace();
  const live = workspace.mode === "live";
  const [skills, setSkills] = useState<Skill[]>([]);
  const reload = useCallback(async () => {
    if (!live) return;
    try {
      setSkills(await api.request<Skill[]>("/api/skills"));
    } catch {
      // The list stays as it was; the next focus reads it again.
    }
  }, [api, live]);
  useEffect(() => {
    void reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { skills, reload };
}
