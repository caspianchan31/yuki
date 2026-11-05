/**
 * Phase C (docs/web.md): the small pieces the need rows share, from
 * shell/components/StatusPill.tsx (the phase pill), shell/chat/pieces.tsx ReceiptLine (the line a
 * need collapses into once acted on) and shell/components/IncidentShot.tsx (「当时的画面」, read
 * with the session into an object URL; click → full size).
 */

import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { TaskPhase } from "../../../../packages/domain/src/task-phase";
import type { Tone } from "../ui/primitives";

const toneOf: Record<TaskPhase["tone"], Tone> = {
  amber: "a",
  red: "r",
  blue: "",
  blueSoft: "",
  teal: "",
  tealSoft: "",
  grey: "",
  green: "",
};

/** The status pill (.pill): a dot and the phase label; only red and amber are coloured. */
export function StatusPill({ phase }: { phase: Pick<TaskPhase, "label" | "tone"> }) {
  const tone = toneOf[phase.tone];
  return (
    <span className={`pill${tone ? ` ${tone}` : ""}`}>
      <span className="dot" aria-hidden="true" />
      {phase.label}
    </span>
  );
}

/** 「✓ 你点了重试，任务重新运行 · 14:48」. */
export function Receipt({ text }: { text: string }) {
  return (
    <span className="receipt" role="status">
      <Check size={13} />
      <span>{text}</span>
    </span>
  );
}

type Picture = { kind: "loading" } | { kind: "image"; uri: string } | { kind: "none" };

/** 「当时的画面」 of an incident at `path`; click → full size over the app (Escape closes). */
export function IncidentShot({ path, site }: { path: string; site?: string | null }) {
  const { api } = useWorkspace();
  const s = t.incidentShots;
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPicture({ kind: "loading" });
    fetch(api.url(path), { headers: api.headers(), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPicture({ kind: "image", uri: objectUrl });
      })
      .catch(() => {
        if (active) setPicture({ kind: "none" });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const label = site ? s.thumbAlt(site) : s.thumb;
  if (picture.kind === "none") return <span className="hint">{s.missing}</span>;
  if (picture.kind === "loading")
    return (
      <span className="shot" role="status" aria-label={s.loading}>
        <span className="sk av" style={{ width: 96, height: 60, borderRadius: 4 }} />
        {label}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className="shot"
        aria-label={`${label}${t.common.colon}${s.open}`}
        onClick={() => setOpen(true)}
      >
        <img src={picture.uri} alt={label} />
        {label}
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the overlay; Escape closes it too
        <div className="shot-ovl" role="presentation" onClick={() => setOpen(false)}>
          <img src={picture.uri} alt={label} />
          <button type="button" className="x" aria-label={t.incidentShots.close}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </>
  );
}
