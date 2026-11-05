/**
 * Fork: the state of the repeat / account pickers (task-schedule.tsx), free of React Native so the
 * web app (apps/web, phase C) shares it: the project's accounts, or an empty list when
 * environments are unavailable.
 */
import { useEffect, useState } from "react";
import { type EnvironmentView, normalizeEnvironments } from "./environments";
import { useEnvironmentsAvailable } from "./environments-screen-state";
import { useWorkspace } from "./workspace";

/** The project's accounts, or an empty list when environments are unavailable. */
export function useScheduleAccounts(enabled: boolean) {
  const { api } = useWorkspace();
  const available = useEnvironmentsAvailable();
  const [accounts, setAccounts] = useState<EnvironmentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled || !available) return;
    let alive = true;
    void api
      .request<unknown>("/api/environments")
      .then((list) => {
        if (!alive) return;
        setAccounts(normalizeEnvironments(list).filter((item) => !item.deleting));
        setLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, available, enabled]);
  return { accounts, available: Boolean(available), loaded };
}
