/**
 * The one module the shared logic (providers, hooks, the API client)
 * asks about the platform it runs on. Everything else that logic imports is free of React Native,
 * so apps/web can import it as it is and swap only this file (apps/web/src/platform/
 * platform-env.ts). Keep the surface small: each export is one fact or one subscription.
 */
import { AppState, Platform, useWindowDimensions } from "react-native";

/** Running in a browser (Expo web, or the web app's overlay). */
export const isWeb = Platform.OS === "web";

/** Running on Android (the emulator reaches the host's API at 10.0.2.2). */
export const isAndroid = Platform.OS === "android";

/** The native app is in the background or inactive now (never consulted on the web). */
export function appInBackground(): boolean {
  return AppState.currentState === "background" || AppState.currentState === "inactive";
}

/** Calls `listener` whenever the app comes back to the foreground; returns the unsubscribe. */
export function onAppActive(listener: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state: string) => {
    if (state === "active") listener();
  });
  return () => subscription?.remove();
}

/** Calls `listener` whenever the app goes to the background or comes back (what is on screen
 * changed); returns the unsubscribe. */
export function onAppStateChange(listener: () => void): () => void {
  const subscription = AppState.addEventListener("change", () => listener());
  return () => subscription?.remove();
}

/** The window's width in points; re-renders when it changes. */
export function useWindowWidth(): number {
  return useWindowDimensions().width;
}
