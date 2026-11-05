/**
 * What this device last read, shown at once on the next
 * opening and replaced as soon as the server answers (like Notion's local cache, much smaller).
 * One entry per space, project and name (the main chat's id, the accounts, the projects'
 * overview, the main chat's reports, the task snapshot). Each entry is kept at most 7 days and
 * 512 KB; anything unreadable counts as nothing; a sign-out clears every entry.
 * Pure but for the storage it is handed (tests pass a map; the app the browser's localStorage).
 */

export interface LastSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

const prefix = "openmuse.lastSeen.v1:";
export const lastSeenMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
export const lastSeenMaxChars = 512 * 1024;

/** The space and project an entry belongs to ("-" for none: the default project). */
export function lastSeenScope(spaceId: string | null, projectId: string | null): string {
  return `${spaceId ?? "-"}|${projectId ?? "-"}`;
}

const keyOf = (scope: string, name: string) => `${prefix}${scope}:${name}`;

export function readLastSeen<T>(
  storage: LastSeenStorage | null,
  scope: string,
  name: string,
  now = Date.now(),
): T | undefined {
  try {
    const raw = storage?.getItem(keyOf(scope, name));
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as { at?: unknown; value?: unknown };
    if (typeof entry.at !== "number" || now - entry.at > lastSeenMaxAgeMs) return undefined;
    return entry.value as T;
  } catch {
    return undefined;
  }
}

export function writeLastSeen(
  storage: LastSeenStorage | null,
  scope: string,
  name: string,
  value: unknown,
  now = Date.now(),
) {
  try {
    const raw = JSON.stringify({ at: now, value });
    if (raw.length > lastSeenMaxChars) {
      storage?.removeItem(keyOf(scope, name));
      return;
    }
    storage?.setItem(keyOf(scope, name), raw);
  } catch {
    // Full or blocked storage: the next opening just waits for the server, as before.
  }
}

/** Every entry of this app on this device (a sign-out). */
export function clearLastSeen(storage: LastSeenStorage | null) {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Blocked storage: nothing was kept either.
  }
}
