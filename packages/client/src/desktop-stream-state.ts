/**
 * Phase C (docs/web.md): the live desktop stream's URL, kept fresh while shown, from
 * desktop-stream.tsx, free of React Native so the web app's desktop view keeps the computer
 * awake by the same rules.
 */
import { useEffect, useState } from "react";
import { appVisible, errorText } from "./computer-workspace-state";
import { onAppActive } from "./platform-env";
import { useWorkspace } from "./workspace";

// Each URL request keeps the computer awake for 30 minutes; a visible stream repeats
// it every 2 minutes, for at most an hour.
const keepAwakeMs = 120000,
  keepAwakeLimitMs = 60 * 60000;

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
      since = Date.now();
    const load = (force = false) => {
      if (!force && (!appVisible() || Date.now() - since > keepAwakeLimitMs)) return;
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
    // Returning to the app (e.g. from the externally opened desktop) restarts the hour.
    const unsubscribe = onAppActive(() => {
      since = Date.now();
      load();
    });
    return () => {
      alive = false;
      clearInterval(interval);
      clearTimeout(retry);
      unsubscribe();
    };
  }, [api, running]);
  return { url, error, setError };
}

/** A fresh stream URL, for opening the desktop in a window of its own. */
export async function desktopUrl(api: ReturnType<typeof useWorkspace>["api"]): Promise<string> {
  return (await api.request<{ url: string }>("/api/computer/desktop")).url;
}
