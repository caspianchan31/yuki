/**
 * Phase C (docs/web.md): 「当时的画面」, from shell/components/IncidentShot.tsx: the desktop's
 * picture at the moment the AI could not go on, as a small thumbnail; a click opens it full size
 * (Escape or a click closes it). Read with the session; a picture that cannot be read (gone after
 * 30 days) says so. Exported for the areas that show incidents (need cards, the guide card).
 */
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePicture } from "./picture";
import "./accounts.css";

const s = t.incidentShots;

export function IncidentShot({ path, site }: { path: string; site?: string | null }) {
  const { api } = useWorkspace();
  const [picture, failed] = usePicture(api, path);
  const [open, setOpen] = useState(false);
  const label = site ? s.thumbAlt(site) : s.thumb;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (picture.kind === "none") return <p className="acc-small">{s.missing}</p>;
  return (
    <>
      <button
        type="button"
        className="acc-thumb"
        aria-label={`${label}${t.common.colon}${s.open}`}
        disabled={picture.kind !== "image"}
        onClick={() => setOpen(true)}
      >
        <span className="box">
          {picture.kind === "image" ? (
            <img src={picture.uri} alt={label} onError={failed} />
          ) : (
            <span className="spin" role="status" aria-label={s.loading} />
          )}
        </span>
        <span>{site ? `${s.thumb}${t.common.sep}${site}` : s.thumb}</span>
      </button>
      {open && picture.kind === "image" ? (
        <div
          className="acc-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <figure>
            <button type="button" onClick={() => setOpen(false)} aria-label={t.common.close}>
              {label}
              <X size={18} aria-hidden="true" />
            </button>
            <img src={picture.uri} alt={label} />
          </figure>
        </div>
      ) : null}
    </>
  );
}
