/**
 * v1.7.3 电脑在旁边: the members' computer (open core) seen in three places: a small live preview kept beside the conversation (ComputerDock), the whole
 * desktop opened from it (ComputerViewer), where the person takes over (接手) and hands back
 * (交还); and the computer card (ContainerComputer) on a member's page and in 设置. One provider
 * holds what they share, so the computer is read by one poller and the live picture is asked for
 * once.
 */

import { useWorkspace } from "@m/workspace";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ComputerSnapshot } from "../../../../packages/domain/src/computer";

export interface LiveView {
  url: string;
  control: "member" | "person";
}

/** While the big picture is open it keeps the computer awake (each read counts as use), for at
 * most this many refreshes this far apart: the computer pauses when nobody uses it. */
const refreshEveryMs = 2 * 60_000;
const refreshes = 15;

export interface ContainerComputerState {
  snapshot: ComputerSnapshot | null;
  /** This server's computer is the container one (the open core's); the hosted one has its own. */
  ours: boolean;
  configured: boolean;
  running: boolean;
  /** The person drives (接手), not the members. */
  person: boolean;
  view: LiveView | null;
  viewerOpen: boolean;
  busy: boolean;
  error: string;
  /** Opens the big picture, starting the computer first when it is paused. */
  look: () => Promise<void>;
  closeViewer: () => void;
  /** The live picture for the preview, when the computer runs (it is not started for it). */
  preview: () => Promise<void>;
  control: (by: "person" | "member") => Promise<void>;
  power: () => Promise<void>;
}

const Context = createContext<ContainerComputerState | null>(null);

export function ContainerComputerProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [view, setView] = useState<LiveView | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const read = useCallback(async () => {
    try {
      setSnapshot(await api.request<ComputerSnapshot>("/api/computer"));
    } catch {
      setSnapshot(null);
    }
  }, [api]);

  const ours = !!snapshot && (snapshot.provider === "desktop" || snapshot.provider === "none");
  // Every 5 s while this server has the container computer (what it does shows beside the chat);
  // a server without it (the hosted one) is asked once a minute, in case one is set up.
  const watching = ours && snapshot?.provider === "desktop";
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => void read(), watching ? 5_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [read, watching]);

  const running = snapshot?.status === "running";
  // The computer paused (or went away): no picture to show.
  useEffect(() => {
    if (snapshot && !running) setView(null);
  }, [snapshot, running]);

  useEffect(() => {
    if (!viewerOpen) return;
    let left = refreshes;
    const timer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) window.clearInterval(timer);
      void api
        .request<LiveView>("/api/computer/desktop")
        .then(setView)
        .catch(() => setView(null));
    }, refreshEveryMs);
    return () => window.clearInterval(timer);
  }, [api, viewerOpen]);

  const run = useCallback(
    async (step: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await step();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        void read();
      }
    },
    [read],
  );

  const value = useMemo<ContainerComputerState>(
    () => ({
      snapshot,
      ours,
      configured: snapshot?.provider === "desktop",
      running,
      person: snapshot?.control === "person",
      view,
      viewerOpen,
      busy,
      error,
      look: () =>
        run(async () => {
          setViewerOpen(true);
          if (!running) await api.request<ComputerSnapshot>("/api/computer/start", {});
          setView(await api.request<LiveView>("/api/computer/desktop"));
        }),
      closeViewer: () => setViewerOpen(false),
      preview: async () => {
        if (!running || view) return;
        try {
          setView(await api.request<LiveView>("/api/computer/desktop"));
        } catch {
          // The preview stays a placeholder; 看电脑 says what went wrong.
        }
      },
      control: (by) =>
        run(async () => {
          setView(await api.request<LiveView>("/api/computer/control", { by }));
        }),
      power: () =>
        run(async () => {
          await api.request<ComputerSnapshot>(
            running ? "/api/computer/stop" : "/api/computer/start",
            {},
          );
        }),
    }),
    [api, busy, error, ours, run, running, snapshot, view, viewerOpen],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useContainerComputer(): ContainerComputerState | null {
  return useContext(Context);
}
