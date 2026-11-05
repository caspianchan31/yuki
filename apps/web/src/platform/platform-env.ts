/**
 * Phase C (docs/web.md): the browser's answers to packages/client/src/platform-env.ts, swapped in
 * by the Vite overlay so the shared logic never reaches React Native.
 */
import { useSyncExternalStore } from "react";

export const isWeb = true;
export const isAndroid = false;

/** A page has no background state of its own; poll.ts reads visibility on the web. */
export function appInBackground(): boolean {
  return false;
}

/** The page coming back into view stands for the app coming to the foreground. */
export function onAppActive(listener: () => void): () => void {
  const onVisible = () => {
    if (!document.hidden) listener();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/** The page shown or hidden stands for the app going to the background or coming back. */
export function onAppStateChange(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

const subscribeWidth = (change: () => void) => {
  window.addEventListener("resize", change);
  return () => window.removeEventListener("resize", change);
};
const width = () => window.innerWidth;

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeWidth, width, width);
}
