/**
 * Phase C (docs/web.md): the state of the desktop sheet's Linux workspace (its snapshot,
 * start / stop, the terminal's commands, the Files tab), from computer-workspace.tsx, free of
 * React Native so the web app's desktop sheet runs the same rules. The drafts (the unsent
 * command, the working directory, the folder and the open file) are passed in: the phone keeps
 * them in ComputerDraftProvider, the web in its own store, both per desktop.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Artifact } from "../../../packages/domain/src";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../packages/domain/src/computer";
import {
  type ComputerControl,
  controlPath,
  desktopExists,
  workspaceStatusText,
} from "./computer-workspace-core";
import { appInBackground, isWeb, onAppActive } from "./platform-env";
import { t } from "./shell/strings";
import { useWorkspace } from "./workspace";

// The panel's pure rules live in computer-workspace-core.ts (tested
// without React Native); the web and the phone keep importing them from here.
export { type ComputerControl, controlPath, desktopExists, workspaceStatusText };

/** A draft value and its setter (useState's pair). */
export type DraftPair<T> = readonly [T, Dispatch<SetStateAction<T>>];
export interface FileEditorDraft {
  path: string;
  text: string;
  saved: string;
  savedPath: string;
}
export type WorkspaceTab = "Terminal" | "Files" | "Desktop";

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The app is in front: on a phone not in the background, in a browser the page is shown. */
export function appVisible(): boolean {
  if (appInBackground()) return false;
  return !(isWeb && typeof document !== "undefined" && document.hidden);
}

/** The workspace's snapshot, polled while something is happening, and its actions. */
export function useLinuxWorkspace({
  tab,
  command: [command, setCommand],
  cwd: [cwd],
  onSnapshot,
}: {
  tab: WorkspaceTab;
  command: DraftPair<string>;
  cwd: DraftPair<string>;
  onSnapshot?: (snapshot: ComputerSnapshot) => void;
}) {
  const { api } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ComputerSnapshot>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingCommand, setEditingCommand] = useState(false);
  const version = useRef(0);
  const polling = useRef(false);
  const mutations = useRef(0);
  const refresh = useCallback(async () => {
    if (polling.current || mutations.current) return;
    polling.current = true;
    const request = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>("/api/computer");
      if (request === version.current) {
        setSnapshot(next);
        setConnectionError("");
      }
    } catch (e) {
      if (request === version.current) setConnectionError(errorText(e));
    } finally {
      polling.current = false;
    }
  }, [api]);
  const anyRunning = snapshot?.commands.some((item) => item.status === "running");
  useEffect(() => {
    const poll = () => {
      if (!appVisible()) return;
      void refresh();
    };
    void refresh();
    const unsubscribe = onAppActive(poll);
    const watching = tab === "Desktop" && isWeb && snapshot?.status === "running";
    const active = executing || busy || anyRunning;
    const interval = watching || active ? setInterval(poll, 5000) : undefined;
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [refresh, tab, executing, busy, snapshot?.status, anyRunning]);

  useEffect(
    () => () => {
      version.current++;
    },
    [refresh],
  );

  /** Start, stop or destroy the desktop; true when the server did it (the panel's confirmation
   * closes on that, and stays with the error otherwise). */
  async function control(action: ComputerControl): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>(controlPath(action), {});
      if (operation === version.current) setSnapshot(next);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
      mutations.current--;
      void refresh();
    }
  }
  async function run() {
    if (!command.trim() || executing || busy) return;
    const sent = command;
    setExecuting(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const result = await api.request<ComputerCommand>("/api/computer/commands", {
        command: sent,
        cwd,
      });
      if (operation === version.current)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                commands: [result, ...current.commands.filter((item) => item.id !== result.id)],
              }
            : current,
        );
      setCommand((current) => (current === sent ? "" : current));
      setEditingCommand(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExecuting(false);
      mutations.current--;
      void refresh();
    }
  }
  /** The refresh button and 重新连接: a fresh snapshot, clearing the last action's error. */
  function reload() {
    void refresh()
      .then(() => setError(""))
      .catch((e) => setError(errorText(e)));
  }
  useEffect(() => {
    if (snapshot) onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);
  const running = snapshot?.status === "running";
  const commandRunning = executing || !!anyRunning;
  return {
    snapshot,
    error,
    connectionError,
    busy,
    running,
    commandRunning,
    showHistory,
    setShowHistory,
    editingCommand,
    setEditingCommand,
    control,
    run,
    reload,
  };
}

/** Curly quotes a phone keyboard typed into a command, made straight. */
export const straightQuotes = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The parent of a desktop folder, never above /workspace. */
export const parentFolder = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/workspace";

/** The Files tab: the folder listing, the open file, new folders and copied documents. */
export function useComputerFiles({
  running,
  active,
  path: [path, setPath],
  editor: [editor, setEditor],
}: {
  running: boolean;
  active: boolean;
  path: DraftPair<string>;
  editor: DraftPair<FileEditorDraft | undefined>;
}) {
  const { api, open, refresh } = useWorkspace();
  const c = t.computer;
  const [directory, setDirectory] = useState<ComputerDirectory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [retry, setRetry] = useState(0);
  const [folder, setFolder] = useState<string>();
  const [importing, setImporting] = useState(false);
  const dirty = !!editor && (editor.text !== editor.saved || editor.path !== editor.savedPath);
  useEffect(() => {
    if (!active || !running) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    void api
      .request<ComputerDirectory>(`/api/computer/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        if (alive) setDirectory(value);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, active, running, path, retry]);

  async function read(file: string) {
    if (busy || loading || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const content = await api.request<{ path: string; text: string }>(
        "/api/computer/files/read",
        { path: file },
      );
      if (mounted.current) setEditor({ ...content, saved: content.text, savedPath: content.path });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function importDocument(file: Artifact) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/import", {
        fileId: file.id,
        path: `${path}/${file.name.replace(/[\\/]/g, "_")}`,
      });
      setImporting(false);
      setNotice(c.copied);
      setRetry((value) => value + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function openPdf(path: string) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>("/api/computer/files/export", { path });
      await refresh();
      if (mounted.current) open({ type: "file", file });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!editor || busy) return;
    const sent = editor;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/write", { path: sent.path, text: sent.text });
      if (mounted.current)
        setEditor((current) =>
          current?.path === sent.path
            ? { ...current, saved: sent.text, savedPath: sent.path }
            : current,
        );
      setNotice(c.saved);
      setRetry((value) => value + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function mkdir() {
    if (!folder?.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request("/api/computer/files/mkdir", { path: `${path}/${folder.trim()}` });
      setFolder(undefined);
      setRetry((value) => value + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /** A row of the listing: a folder opens, a PDF opens in the file sheet, anything else is read. */
  function openEntry(entry: ComputerDirectory["entries"][number]) {
    if (busy || loading || !running) return;
    if (entry.type === "directory") {
      setNotice("");
      setPath(entry.path);
    } else if (/\.pdf$/i.test(entry.name)) void openPdf(entry.path);
    else void read(entry.path);
  }
  function newFile() {
    setNotice("");
    setEditor({ path: `${path}/note-${Date.now()}.txt`, text: "", saved: "", savedPath: "" });
  }
  function closeEditor() {
    setEditor(undefined);
    setNotice("");
  }
  return {
    path,
    setPath,
    editor,
    setEditor,
    directory,
    error,
    notice,
    busy,
    loading,
    dirty,
    folder,
    setFolder,
    importing,
    setImporting,
    reload: () => setRetry((value) => value + 1),
    importDocument,
    save,
    mkdir,
    openEntry,
    newFile,
    closeEditor,
  };
}
