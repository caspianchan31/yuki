/**
 * Phase C (docs/web.md): the live desktop stream's URL, kept fresh while shown, from
 * desktop-stream.tsx, free of React Native so the web app's desktop view keeps the computer
 * awake by the same rules.
 */
import { useEffect, useState } from "react";
import { appVisible, errorText } from "./computer-workspace-state";
import { keepAwakeMs, keepViewAwake } from "./desktop-keep-awake";
import { onAppActive } from "./platform-env";
import { useWorkspace } from "./workspace";

/** Calls `mark` whenever the person does something in this window: a key, a click, a scroll,
 * the window coming back, or focus moving into the desktop's frame (the window's blur). */
function onPersonActive(mark: () => void): () => void {
  const target = typeof window !== "undefined" ? window : null;
  if (!target?.addEventListener) return () => {};
  const events = ["pointerdown", "keydown", "wheel", "focus", "blur"] as const;
  for (const name of events) target.addEventListener(name, mark, { passive: true });
  return () => {
    for (const name of events) target.removeEventListener(name, mark);
  };
}

/** The live desktop stream URL of the running computer, kept fresh while shown. */
export function useDesktopStream(running: boolean) {
  const { api } = useWorkspace();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!running) return;
    let alive = true,
      loaded = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      lastActive = Date.now();
    const load = (force = false) => {
      if (!force && (!appVisible() || !keepViewAwake(Date.now(), lastActive))) return;
      void api
        .request<{ url: string }>("/api/computer/desktop")
        .then((value) => {
          if (!alive) return;
          loaded = true;
          setUrl(value.url);
          setError("");
        })
        .catch((e) => {
          // A loaded stream survives a failed refresh; a first load shows the error and
          // retries shortly instead of waiting for the next refresh.
          if (!alive || loaded) return;
          setError(errorText(e));
          clearTimeout(retry);
          // Forced: until the first URL arrives, retry even while the app is hidden.
          retry = setTimeout(() => load(true), 5000);
        });
    };
    load(true);
    const interval = setInterval(load, keepAwakeMs);
    // Returning to the app (e.g. from the externally opened desktop), or anything the person
    // does in it, counts as someone looking; a refresh that had lapsed is asked again at once.
    const active = () => {
      const lapsed = !keepViewAwake(Date.now(), lastActive);
      lastActive = Date.now();
      if (lapsed) load();
    };
    const unsubscribe = onAppActive(active);
    const unsubscribePerson = onPersonActive(active);
    return () => {
      alive = false;
      clearInterval(interval);
      clearTimeout(retry);
      unsubscribe();
      unsubscribePerson();
    };
  }, [api, running]);
  return { url, error, setError };
}

/** A fresh stream URL, for opening the desktop in a window of its own. */
export async function desktopUrl(api: ReturnType<typeof useWorkspace>["api"]): Promise<string> {
  return (await api.request<{ url: string }>("/api/computer/desktop")).url;
}
