/**
 * v1.4 (docs/apps.md): the space's app directory for the @ list and 设置. Read when the page
 * mounts and again when it regains focus (an app authorised in another tab shows without a reload).
 */

import { useWorkspace } from "@m/workspace";
import { useCallback, useEffect, useState } from "react";
import type { AppEntry } from "../../../../packages/domain/src/apps";

export function useApps() {
  const { api, workspace } = useWorkspace();
  const live = workspace.mode === "live";
  const [apps, setApps] = useState<AppEntry[]>([]);
  const reload = useCallback(async () => {
    if (!live) return;
    try {
      setApps(await api.request<AppEntry[]>("/api/apps"));
    } catch {
      // The list stays as it was; the next focus reads it again.
    }
  }, [api, live]);
  useEffect(() => {
    void reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { apps, reload };
}
