/**
 * Phase C (docs/web.md): a picture read with the session (the account's latest screenshot,
 * an incident's 当时的画面), from the web branch of AccountDetail's LatestShot and IncidentShot:
 * fetched into an object URL (an <img> cannot carry the Authorization header), revoked when it
 * goes. A 404 or any failure reads as no picture.
 */
import type { MuseApi } from "@m/api";
import { useEffect, useState } from "react";

export type Picture = { kind: "loading" } | { kind: "image"; uri: string } | { kind: "none" };

export function usePicture(api: MuseApi, path: string, enabled = true): [Picture, () => void] {
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
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
  }, [api, path, enabled]);
  return [picture, () => setPicture({ kind: "none" })];
}
