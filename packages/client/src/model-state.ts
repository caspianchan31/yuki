/**
 * v1.7 模型兜底 / 出错时页面直说: which model answers now and whether the backup is in force,
 * from GET /api/agent/model, read once the chat is open and then every minute (a cheap, ETag'd
 * answer); read again right after a reply fails, which is when the switch happens.
 */
import { useCallback, useState } from "react";
import { usePoll } from "./shell/poll";
import { useWorkspace } from "./workspace";

export interface ModelState {
  primary: string | null;
  fallback: string | null;
  backup: {
    active: boolean;
    reason: "quota" | "auth" | "outage" | null;
    until: string | null;
    since: string | null;
  };
}

const none: ModelState = {
  primary: null,
  fallback: null,
  backup: { active: false, reason: null, until: null, since: null },
};

export function useModelState(enabled = true): { state: ModelState; refresh: () => Promise<void> } {
  const { api } = useWorkspace();
  const [state, setState] = useState<ModelState>(none);
  const refresh = useCallback(async () => {
    try {
      const next = await api.request<ModelState>("/api/agent/model");
      setState(next && next.backup ? next : none);
    } catch {
      // a failed read keeps the last state
    }
  }, [api]);
  usePoll(refresh, 60_000, enabled);
  return { state, refresh };
}
