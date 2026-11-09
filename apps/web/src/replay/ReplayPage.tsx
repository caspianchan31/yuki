/**
 * v1.6 回顾: a conversation played back step by step, one frame at a time: what the person said,
 * what the member replied, each step on the computer with the picture it kept. The same player
 * serves the owner (/replay/<threadId>, signed in) and anyone with a share link (/r/<token>).
 * Frames come from the server (chat/replay.ts); the page only draws and paces them.
 */

import { computerStepText } from "@m/shell/chat/computer-steps";
import { t } from "@m/shell/strings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "../ui/primitives";

export type ReplayFrame =
  | { kind: "person"; text: string }
  | { kind: "member"; text: string }
  | {
      kind: "step";
      tool: string;
      args: Record<string, string | number>;
      failed: boolean;
      shotId?: string;
      page?: { url: string; title: string };
    };

export interface Replay {
  name: string | null;
  frames: ReplayFrame[];
  /** A shared link's dates; absent for the owner's own view. */
  createdAt?: string;
  expiresAt?: string;
}

export interface ReplaySource {
  load(): Promise<Replay>;
  /** A kept picture as an object URL, or null when it is gone. */
  shot(id: string): Promise<string | null>;
  /** The owner's share controls; absent on a shared link. */
  share?: {
    current(): Promise<ShareInfo | null>;
    create(): Promise<ShareInfo | null>;
    revoke(): Promise<void>;
  };
}
export interface ShareInfo {
  token: string;
  url: string | null;
  expiresAt: string;
}

const speeds = [0.5, 1, 2, 4] as const;
/** How long a frame stays, at 1x: a step a little longer when it has a picture. */
const frameMs = (frame: ReplayFrame) =>
  frame.kind === "step"
    ? frame.shotId
      ? 2600
      : 1400
    : Math.min(6000, 1600 + frame.text.length * 25);

function stepLine(frame: Extract<ReplayFrame, { kind: "step" }>): string {
  if (frame.tool === "computer_screenshot") return t.replay.shotStep;
  return computerStepText(frame.tool, frame.args) + (frame.failed ? t.computerSteps.failed : "");
}

/** One frame's picture, fetched through the source (object URL) and released after. */
function Shot({ id, source }: { id: string; source: ReplaySource }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setSrc(undefined);
    source
      .shot(id)
      .then((value) => {
        if (!active) return;
        url = value;
        setSrc(value);
      })
      .catch(() => active && setSrc(null));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, source]);
  if (src === undefined) return <div className="rp-shot rp-shot-empty">{t.replay.loadingShot}</div>;
  if (src === null) return <div className="rp-shot rp-shot-empty">{t.replay.shotGone}</div>;
  return <img className="rp-shot" src={src} alt={t.replay.shotAlt} />;
}

export function ReplayPage({ source, shared }: { source: ReplaySource; shared: boolean }) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof speeds)[number]>(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    source
      .load()
      .then((value) => active && setReplay(value))
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : t.replay.loadError),
      );
    return () => {
      active = false;
    };
  }, [source]);

  const frames = replay?.frames ?? [];
  const frame = frames[at];
  const last = frames.length - 1;

  // Playing: each frame stays its own while, divided by the speed; the end stops the player.
  useEffect(() => {
    if (!playing || !frame) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    timer.current = setTimeout(() => setAt((n) => Math.min(n + 1, last)), frameMs(frame) / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, at, frame, last, speed]);

  const togglePlay = useCallback(() => {
    if (at >= last) setAt(0);
    setPlaying((value) => !value);
  }, [at, last]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowRight") setAt((n) => Math.min(n + 1, last));
      else if (event.key === "ArrowLeft") setAt((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, last]);

  const title = replay?.name?.trim() || t.replay.untitled;
  const stepCount = useMemo(() => frames.filter((f) => f.kind === "step").length, [frames]);

  if (error)
    return (
      <div className="rp-page">
        <div className="rp-card">
          <h1>{t.replay.title}</h1>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  if (!replay)
    return (
      <div className="rp-page" aria-busy="true">
        <div className="rp-card">
          <p className="muted">{t.replay.loading}</p>
        </div>
      </div>
    );
  if (!frames.length)
    return (
      <div className="rp-page">
        <div className="rp-card">
          <h1>{title}</h1>
          <p className="muted">{t.replay.empty}</p>
        </div>
      </div>
    );

  return (
    <div className="rp-page">
      <header className="rp-head">
        <div>
          <div className="rp-kicker">{t.replay.title}</div>
          <h1>{title}</h1>
          <div className="muted">{t.replay.summary(frames.length, stepCount)}</div>
        </div>
        {source.share && !shared ? <ShareBox share={source.share} /> : null}
        {shared && replay.expiresAt ? (
          <div className="muted">{t.replay.sharedUntil(formatDate(replay.expiresAt))}</div>
        ) : null}
      </header>
      <main className="rp-stage">
        {frame?.kind === "step" ? (
          <div className="rp-frame">
            {frame.shotId ? (
              <Shot key={frame.shotId} id={frame.shotId} source={source} />
            ) : (
              <div className="rp-shot rp-shot-empty">{t.replay.noShot}</div>
            )}
            <div className="rp-caption">
              <span className="rp-who">{t.replay.memberDid}</span>
              {stepLine(frame)}
              {frame.page?.title || frame.page?.url ? (
                <div className="muted rp-pagetitle">{frame.page.title || frame.page.url}</div>
              ) : null}
            </div>
          </div>
        ) : frame ? (
          <div className={`rp-frame rp-text rp-${frame.kind}`}>
            <span className="rp-who">
              {frame.kind === "person" ? t.replay.personSaid : t.replay.memberSaid}
            </span>
            <p>{frame.text}</p>
          </div>
        ) : null}
      </main>
      <footer className="rp-controls">
        <Btn className="sm" onClick={() => setAt((n) => Math.max(n - 1, 0))} disabled={at === 0}>
          {t.replay.prev}
        </Btn>
        <Btn className="sm pri" onClick={togglePlay}>
          {playing ? t.replay.pause : at >= last ? t.replay.replay : t.replay.play}
        </Btn>
        <Btn
          className="sm"
          onClick={() => setAt((n) => Math.min(n + 1, last))}
          disabled={at >= last}
        >
          {t.replay.next}
        </Btn>
        <label className="rp-speed">
          {t.replay.speed}
          <select
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value) as (typeof speeds)[number])}
          >
            {speeds.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <input
          className="rp-scrub"
          type="range"
          min={0}
          max={last}
          value={at}
          onChange={(event) => setAt(Number(event.target.value))}
          aria-label={t.replay.position}
        />
        <span className="muted rp-pos">{t.replay.frameOf(at + 1, frames.length)}</span>
      </footer>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** The owner's share link: make one, copy it, take it back. */
function ShareBox({ share }: { share: NonNullable<ReplaySource["share"]> }) {
  const [info, setInfo] = useState<ShareInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let active = true;
    share
      .current()
      .then((value) => active && setInfo(value))
      .catch(() => {
        if (active) {
          setInfo(null);
          setAvailable(false);
        }
      });
    return () => {
      active = false;
    };
  }, [share]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  if (!available) return null;
  if (info === undefined) return null;
  return (
    <div className="rp-share">
      {info?.url ? (
        <>
          <input className="rp-link" readOnly value={info.url} onFocus={(e) => e.target.select()} />
          <Btn
            className="sm"
            disabled={busy}
            onClick={() =>
              void navigator.clipboard?.writeText(info.url ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? t.replay.copied : t.replay.copy}
          </Btn>
          <Btn
            className="sm ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await share.revoke();
                setInfo(null);
              })
            }
          >
            {t.replay.revoke}
          </Btn>
          <span className="muted">{t.replay.linkUntil(formatDate(info.expiresAt))}</span>
        </>
      ) : (
        <Btn
          className="sm"
          disabled={busy}
          onClick={() => void run(async () => setInfo(await share.create()))}
        >
          {t.replay.makeLink}
        </Btn>
      )}
    </div>
  );
}
