/**
 * The app's handle on last-seen.ts: the browser's localStorage on the web (the
 * phone apps keep nothing for now), and the scope of an API client (its space and project).
 */
import { activeSpaceId } from "./api-client";
import { type LastSeenStorage, lastSeenScope } from "./last-seen";
import { isWeb } from "./platform-env";

export function lastSeenStorage(): LastSeenStorage | null {
  if (!isWeb) return null;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The scope of what an API client reads: the active space and its project. */
export function scopeOf(api: { projectId: string | null }): string {
  return lastSeenScope(activeSpaceId(), api.projectId);
}
