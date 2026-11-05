/**
 * The account's time zone (GET/PUT /api/account-settings) as the web shows it: one value for the
 * whole app, read once when the workspace opens. While the account has none, the browser's zone
 * is shown, and the first open saves it (only when none was ever set).
 */

import { browserZone } from "@m/shell/task/settings-core";
import { useSyncExternalStore } from "react";

interface Requester {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
}
interface ZoneState {
  stored: string | null;
  loaded: boolean;
}

let state: ZoneState = { stored: null, loaded: false };
const listeners = new Set<() => void>();
const publish = (next: ZoneState) => {
  state = next;
  for (const listener of listeners) listener();
};

/** Called by the settings pane after a save. */
export function setAccountZone(zone: string | null) {
  publish({ stored: zone, loaded: true });
}

/** Reads the zone; with none stored, saves the browser's once. A failure leaves it unset. */
export async function loadAccountZone(api: Requester): Promise<void> {
  try {
    const read = await api.request<{ timezone: string | null }>("/api/account-settings");
    if (read.timezone) return setAccountZone(read.timezone);
    const own = browserZone();
    if (!own) return setAccountZone(null);
    try {
      const saved = await api.request<{ timezone: string }>(
        "/api/account-settings",
        { timezone: own },
        "PUT",
      );
      setAccountZone(saved.timezone);
    } catch {
      setAccountZone(null);
    }
  } catch {
    // Unreadable now; the browser's zone is shown meanwhile.
  }
}

/** `stored`: what the account holds; `zone`: what to show (the browser's while unset). */
export function useAccountZone(): { stored: string | null; zone: string | null; loaded: boolean } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  return { ...current, zone: current.stored ?? browserZone() };
}
