import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AgentTask,
  AgentWorkspace,
  CreateTaskInput,
} from "../../../packages/domain/src/agent";
import { readLastSeen, writeLastSeen } from "./last-seen";
import { lastSeenStorage, scopeOf } from "./last-seen-store";
import { usePoll } from "./shell/poll";
import { useWorkspace } from "./workspace";

interface AgentContextValue {
  data?: AgentWorkspace;
  /** When the read behind `data` started (ms); null before the first. A
   * screen that needs "a read newer than X" waits for this instead of reading again. */
  fetchedAt: number | null;
  error: string;
  refresh: () => Promise<void>;
  mutate: <T>(path: string, body: unknown) => Promise<T>;
  delegate: (input: CreateTaskInput, requestId?: string) => Promise<AgentTask>;
}
const AgentContext = createContext<AgentContextValue | null>(null);
export function AgentWorkspaceProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  // The last snapshot this device read for this space and project, at once.
  const [data, setData] = useState<AgentWorkspace | undefined>(() =>
    readLastSeen<AgentWorkspace>(lastSeenStorage(), scopeOf(api), "agent"),
  );
  useEffect(() => {
    setData(readLastSeen<AgentWorkspace>(lastSeenStorage(), scopeOf(api), "agent"));
  }, [api]);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    const started = Date.now();
    try {
      const next = await api.request<AgentWorkspace>("/api/agent");
      if (version === requestVersion.current) {
        setData(next);
        writeLastSeen(lastSeenStorage(), scopeOf(api), "agent", next);
        setFetchedAt(started);
        setError("");
      }
    } catch (e) {
      if (version === requestVersion.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api]);
  // The shared poller (shell/poll.ts): loads at once whatever the page's
  // visibility, then every 3 s while the page is in use, slowly while it is hidden and untouched.
  usePoll(refresh, 3000);
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [refresh],
  );
  const mutate = useCallback(
    async <T,>(path: string, body: unknown): Promise<T> => {
      const result = await api.request<T>(`/api/agent${path}`, body);
      // The successful mutation stays successful even if the following read fails.
      await refresh().catch(() => {});
      return result;
    },
    [api, refresh],
  );
  const delegate = useCallback(
    (input: CreateTaskInput, requestId?: string) =>
      mutate<AgentTask>("/tasks", { ...input, requestId }),
    [mutate],
  );
  return (
    <AgentContext.Provider value={{ data, fetchedAt, error, refresh, mutate, delegate }}>
      {children}
    </AgentContext.Provider>
  );
}
export function useAgentWorkspace() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("Agent workspace is unavailable");
  return context;
}
