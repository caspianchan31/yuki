/**
 * v1.5 (open core): the members' computer on a member's card. One computer is shared by every
 * member of the install; the card says whether it runs, is paused or is not set up, opens its
 * live picture (view only) and lets the person take it over (接手) and hand it back (交还).
 * Draws nothing when the server's computer is not the container (the hosted computer has its own
 * card).
 */

import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useCallback, useEffect, useState } from "react";
import type { ComputerSnapshot } from "../../../../packages/domain/src/computer";
import { ErrorLine } from "../ui/primitives";

interface LiveView {
  url: string;
  control: "member" | "person";
}

/** The live frame stays awake-refreshed for this long (the computer pauses when nobody uses it). */
const refreshEveryMs = 2 * 60_000;
const refreshes = 15;

/** `inSettings`: the 设置 → 电脑 pane, which has no heading of its own and adds 暂停 / 启动. */
export function ContainerComputer({ inSettings = false }: { inSettings?: boolean } = {}) {
  const { api } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [view, setView] = useState<LiveView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const c = t.containerComputer;

  const read = useCallback(async () => {
    try {
      setSnapshot(await api.request<ComputerSnapshot>("/api/computer"));
    } catch {
      setSnapshot(null);
    }
  }, [api]);

  useEffect(() => {
    void read();
    const timer = window.setInterval(() => void read(), 5_000);
    return () => window.clearInterval(timer);
  }, [read]);

  // A frame that is open keeps the computer awake (each read counts as use), for a while.
  const framed = view !== null;
  useEffect(() => {
    if (!framed) return;
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
  }, [api, framed]);

  // The computer paused (or went away) under an open frame: close it.
  const running = snapshot?.status === "running";
  useEffect(() => {
    if (snapshot && !running) setView(null);
  }, [snapshot, running]);

  if (!snapshot || (snapshot.provider !== "desktop" && snapshot.provider !== "none")) return null;

  async function run(step: () => Promise<void>) {
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
  }
  const look = () =>
    run(async () => {
      if (!running) await api.request<ComputerSnapshot>("/api/computer/start", {});
      setView(await api.request<LiveView>("/api/computer/desktop"));
    });
  const control = (by: "person" | "member") =>
    run(async () => {
      const next = await api.request<LiveView>("/api/computer/control", { by });
      setView(next);
    });

  const power = () =>
    run(async () => {
      await api.request<ComputerSnapshot>(
        running ? "/api/computer/stop" : "/api/computer/start",
        {},
      );
    });
  const configured = snapshot.provider === "desktop";
  const person = snapshot.control === "person";
  const word = !configured
    ? c.unset
    : snapshot.status === "running"
      ? c.running
      : snapshot.status === "error"
        ? c.error
        : c.stopped;
  return (
    <section>
      {inSettings ? null : <h3>{c.title}</h3>}
      <div className="member-card">
        <div>{word}</div>
        {!configured ? <div className="roster-line">{c.unsetHint}</div> : null}
        {configured ? <div className="roster-line">{c.shared}</div> : null}
        {configured && snapshot.status === "error" && snapshot.message ? (
          <div className="roster-line">{snapshot.message}</div>
        ) : null}
        {configured && running ? (
          <div className="roster-line">{person ? c.personDrives : c.memberDrives}</div>
        ) : null}
        {configured ? (
          <div className="member-actions">
            {inSettings ? (
              <button
                type="button"
                className="member-run quiet"
                disabled={busy}
                onClick={() => void power()}
              >
                {running ? c.pause : c.start}
              </button>
            ) : null}
            <button
              type="button"
              className="member-run quiet"
              disabled={busy}
              onClick={() => (view ? setView(null) : void look())}
            >
              {busy && !view ? c.starting : view ? c.closeLook : c.look}
            </button>
            {running ? (
              <button
                type="button"
                className="member-run quiet"
                disabled={busy}
                onClick={() => void control(person ? "member" : "person")}
              >
                {person ? c.handBack : c.drive}
              </button>
            ) : null}
          </div>
        ) : null}
        <ErrorLine error={error} />
        {view ? (
          <>
            <div
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "16 / 10",
                border: "1px solid var(--line)",
                borderRadius: 6,
                overflow: "hidden",
                background: "var(--bg2)",
              }}
            >
              <iframe
                key={view.url}
                src={view.url}
                title={c.frame}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              />
            </div>
            {view.control === "member" ? <div className="roster-line">{c.viewOnly}</div> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
