/**
 * Phase C (docs/web.md): 「当时的画面」, the desktop's picture at the moment the AI could not
 * go on, as a small thumbnail that opens full size, from shell/components/IncidentShot.tsx (a
 * React Native file of another area; this is the web's minimal copy for the desktop sheet). The
 * picture is read with the session through fetch into an object URL; one that cannot be read
 * (gone after 30 days) says so.
 */
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

type Picture = { kind: "loading" } | { kind: "image"; uri: string } | { kind: "none" };
const s = t.incidentShots;

function usePicture(path: string): [Picture, () => void] {
  const { api } = useWorkspace();
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
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
  return [picture, () => setPicture({ kind: "none" })];
}

export function IncidentShot({ path, site }: { path: string; site?: string | null }) {
  const [picture, failed] = usePicture(path);
  const [open, setOpen] = useState(false);
  const label = site ? s.thumbAlt(site) : s.thumb;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (picture.kind === "none") return <p className="hint">{s.missing}</p>;
  return (
    <>
      <button
        type="button"
        className="lg-shot"
        aria-label={`${label}${t.common.colon}${s.open}`}
        disabled={picture.kind !== "image"}
        onClick={() => setOpen(true)}
      >
        <span className="lg-shot-img">
          {picture.kind === "image" ? (
            <img src={picture.uri} alt={label} onError={failed} />
          ) : (
            <span
              className="sk"
              role="status"
              aria-label={s.loading}
              style={{ height: "100%", margin: 0 }}
            />
          )}
        </span>
        <span className="hint">{site ? `${s.thumb} · ${site}` : s.thumb}</span>
      </button>
      {open && picture.kind === "image" ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the close button close it from the keyboard
        <div
          className="lg-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setOpen(false)}
        >
          <button type="button" className="lg-lightbox-x" onClick={() => setOpen(false)}>
            {label}
            <X size={18} aria-label={t.common.close} />
          </button>
          <img src={picture.uri} alt={label} />
        </div>
      ) : null}
    </>
  );
}
