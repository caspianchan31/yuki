/**
 * The conversation state of threads.tsx without React Native: which
 * chat is open, the main chat and its moves, 开新主聊天 (ThreadsProvider, useMuseThread). The
 * menu sheet that lists the chats stays in threads.tsx.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readLastSeen, writeLastSeen } from "./last-seen";
import { lastSeenStorage, scopeOf } from "./last-seen-store";
import { followMainSelection, followMainVisited } from "./local-thread";
import { usePoll } from "./shell/poll";
import { pollMs } from "./shell/poll-core";
import { t } from "./shell/strings";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type Selection = { id: string; existing: boolean };
/** Today on this device, YYYY-MM-DD (the name a replaced main chat gets). */
function localDay(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: () => void;
  /** 开新主聊天. The old main chat is archived (found under 已归档); an
   * empty one becomes the main chat and opens. */
  startNewMain: () => Promise<void>;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate, api, notify } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // The main chat this page knows (null until the first read) and the read's generation: a new
  // project client or 重新加载主聊天 starts over, and an answer of an earlier one is dropped.
  const known = useRef<string | null>(null);
  const generation = useRef(0);
  // The main chat this device last saw for this space and project opens at once;
  // the server's first answer confirms it, or moves to the one it names without a notice.
  const fromCache = useRef(false);
  useEffect(() => {
    generation.current += 1;
    known.current = null;
    fromCache.current = false;
    if (!enabled) return;
    setError("");
    const seen = readLastSeen<string>(lastSeenStorage(), scopeOf(api), "mainThread");
    if (seen) {
      known.current = seen;
      fromCache.current = true;
      const next = { id: seen, existing: true };
      setMainId(seen);
      setSelection(next);
      setVisited([next]);
      setLoading(false);
      return;
    }
    setLoading(true);
  }, [api, enabled, attempt]);
  /** The main chat moved (this page's 开新主聊天 or another member's): the page follows it. */
  const moveMain = useCallback((next: string) => {
    const former = known.current;
    if (former === null || former === next) return false;
    known.current = next;
    setMainId(next);
    setSelection((selection) => followMainSelection(selection, former, next));
    setVisited((visited) => followMainVisited(visited, next));
    return true;
  }, []);
  // Which chat is the project's main one, read at once and then at the pace
  // of the rail's main-chat reports, so another member's 开新主聊天 reaches this page too (no
  // reload): the chat on screen and 汇报 · 最新 5 条 follow it.
  const readMain = useCallback(async () => {
    const run = generation.current;
    try {
      const main = await api.request<{ threadId: string; existing: boolean }>("/api/main-thread");
      if (run !== generation.current) return;
      writeLastSeen(lastSeenStorage(), scopeOf(api), "mainThread", main.threadId);
      if (fromCache.current) {
        // The first answer after opening from the cache: the same chat goes on as it is; another
        // one (moved meanwhile) opens quietly, as at a first read.
        fromCache.current = false;
        if (known.current === main.threadId) return;
        known.current = null;
      }
      if (known.current === null) {
        const next = { id: main.threadId, existing: main.existing };
        known.current = next.id;
        setMainId(next.id);
        setSelection(next);
        setVisited([next]);
        setLoading(false);
        setError("");
      } else if (moveMain(main.threadId)) notify(t.threads.mainMoved);
    } catch (e) {
      // A later read that fails changes nothing: the page keeps the main chat it knows.
      if (run === generation.current && known.current === null)
        setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, moveMain, notify]);
  // A new project client or 重新加载主聊天 reads at once.
  const restart = useMemo(() => ({ api, attempt }), [api, attempt]);
  usePoll(readMain, pollMs.reports, enabled, restart);
  async function startNewMain() {
    const main = await api.request<{ threadId: string }>("/api/main-thread/new", {
      replacing: mainId,
      formerName: t.threads.formerMainName(localDay()),
    });
    // Another member's switch came first: this is the main chat they made, now open here too.
    moveMain(main.threadId);
    setSelection({ id: main.threadId, existing: true });
    navigate("chat");
    notify(t.threads.newMainDone);
  }
  function select(next: Selection) {
    setSelection(next);
    setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
    navigate("chat");
  }
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        enabled,
        mainId,
        visited,
        loading,
        error,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        start: () => select({ id: newThreadId(), existing: false }),
        startNewMain,
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}
