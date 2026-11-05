/**
 * Isolation environments (fork feature): which desktop a chat thread's computer tools use.
 * The server keeps the selection (GET/PUT /api/environments/conversation/:threadId), and that is
 * what the next run uses, so it is authoritative once loaded. The transcript's use_environment /
 * use_desktop results stand in only before the selection has loaded and while a reply is running
 * (the agent may switch mid-run); the selection is refreshed as soon as the run ends.
 * The old pill above the messages and its picker are gone; the chat's
 * 「操作账号：<name> ▾」 row above the input (shell/chat/Composer.tsx) shows and changes it.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type EnvironmentRef,
  type EnvironmentSelection,
  environmentError,
  environmentsUnavailable,
  normalizeSelection,
  resolveThreadEnvironment,
  sameEnvironment,
  threadEnvironment,
} from "./environments";
import { t } from "./shell/strings";
import { useWorkspace } from "./workspace";

export interface ThreadEnvironmentValue {
  /**
   * The desktop this thread's computer tools use; null is the default desktop. The last known
   * value is kept while the selection refreshes or a switch is in flight.
   */
  environment: EnvironmentRef | null;
  /**
   * True until a first answer arrives from the server or the transcript. Nothing may poll or
   * start the default desktop on this thread's behalf while it is true.
   */
  loading: boolean;
  /** The selection names a deleted environment; computer tools are blocked until a new pick. */
  stale: boolean;
  /** The server has no environments (no desktop provider); the 操作账号 row hides itself. */
  unavailable: boolean;
  error: string;
  /** Save the thread's desktop on the server; null is the default desktop. Rejects on failure. */
  select: (environmentId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
}
// Outside a provider (a surface with no thread) the pre-feature behaviour applies: the default
// desktop, nothing to load, no 操作账号 row.
const outsideThread: ThreadEnvironmentValue = {
  environment: null,
  loading: false,
  stale: false,
  unavailable: true,
  error: "",
  select: () => Promise.reject(new Error(t.chat.noConversation)),
  refresh: () => Promise.resolve(),
};
const ThreadEnvironmentContext = createContext<ThreadEnvironmentValue>(outsideThread);
export function useThreadEnvironment() {
  return useContext(ThreadEnvironmentContext);
}

const conversationPath = (threadId: string) =>
  `/api/environments/conversation/${encodeURIComponent(threadId)}`;
const noneSelected: EnvironmentSelection = { environmentId: null, name: null, stale: false };

/** Keep one object per distinct desktop so scoped contexts and keys stay stable. */
function useStableRef(next: EnvironmentRef | null | undefined) {
  const last = useRef<EnvironmentRef | null | undefined>(undefined);
  const previous = last.current;
  const same =
    next === undefined
      ? previous === undefined
      : sameEnvironment(previous, next) &&
        previous?.name === next?.name &&
        (previous?.accountLabel ?? null) === (next?.accountLabel ?? null);
  if (!same) last.current = next;
  return last.current;
}

export function ThreadEnvironmentProvider({
  threadId,
  messages,
  running,
  children,
}: {
  threadId: string;
  /** The thread's transcript (agent.messages); scanned for use_environment / use_desktop results. */
  messages: readonly unknown[];
  /** True while a reply runs; the selection is refreshed when it ends. */
  running: boolean;
  children: ReactNode;
}) {
  const { api } = useWorkspace();
  // Held with its thread id, so a provider reused for another thread never shows the old pick.
  const [loaded, setLoaded] = useState<{ threadId: string; selection: EnvironmentSelection }>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  // True from the end of a run until the selection has been reloaded: the loaded one predates
  // the run, so the transcript keeps precedence until the server answers again.
  const [settling, setSettling] = useState(false);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      const selection = normalizeSelection(await api.request<unknown>(conversationPath(threadId)));
      if (current !== version.current) return;
      setLoaded({ threadId, selection });
      setSettling(false);
      setUnavailable(false);
      setError("");
    } catch (e) {
      if (current !== version.current) return;
      if (environmentsUnavailable(e)) {
        setUnavailable(true);
        setLoaded({ threadId, selection: noneSelected });
        setSettling(false);
        setError("");
        return;
      }
      setError(environmentError(e));
    }
  }, [api, threadId]);
  useEffect(() => {
    setSettling(false);
    void refresh();
    return () => {
      version.current++;
    };
  }, [refresh]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      setSettling(true);
      void refresh();
    }
    wasRunning.current = running;
  }, [running, refresh]);
  const select = useCallback(
    async (environmentId: string | null) => {
      const current = ++version.current;
      const selection = normalizeSelection(
        await api.request<unknown>(conversationPath(threadId), { environmentId }, "PUT"),
      );
      if (current !== version.current) return;
      setLoaded({ threadId, selection });
      setSettling(false);
      setError("");
    },
    [api, threadId],
  );

  const { environment: resolved, stale } = resolveThreadEnvironment({
    selection: loaded?.threadId === threadId ? loaded.selection : undefined,
    record: threadEnvironment(messages),
    running: running || settling,
  });
  const environment = useStableRef(resolved);
  return (
    <ThreadEnvironmentContext.Provider
      value={{
        environment: environment ?? null,
        loading: environment === undefined,
        stale,
        unavailable,
        error,
        select,
        refresh,
      }}
    >
      {children}
    </ThreadEnvironmentContext.Provider>
  );
}
