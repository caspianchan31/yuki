/**
 * The current project's credentials (GET /api/credentials with the project's
 * header). Read when a credentials screen opens and after each change; never polled.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjects } from "../../projects-state";
import { credentialErrorText } from "../accounts/hooks";
import { useShellData } from "../data";
import { type CredentialList, normalizeCredentials } from "./credentials-core";

/** Every open credentials screen reads again after a change made anywhere (an editor panel). */
const listeners = new Set<() => void>();
export function credentialsChanged() {
  for (const listener of listeners) listener();
}

/** `projectId`: another project's (an account edited from the global page); absent: the current. */
export function useCredentials(projectId?: string | null) {
  const data = useShellData();
  const { current: shown } = useProjects();
  const current = projectId === undefined ? shown : projectId;
  const api = useMemo(() => data.apiFor(current), [data.apiFor, current]);
  const [list, setList] = useState<CredentialList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = normalizeCredentials(await api.request<unknown>("/api/credentials"));
      if (mounted.current) setList(next);
    } catch (err) {
      if (mounted.current) setError(credentialErrorText(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [reload]);
  return { api, list, loading, error, reload, current };
}
