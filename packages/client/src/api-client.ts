/**
 * The API client, kept free of react-native so the node:test suite can construct
 * it against a fetch mock; api.ts binds it to the platform's API URL. Every request carries the
 * session token. With a project id it also carries the X-OpenMuse-Project header, which scopes
 * conversations, tasks, files, memories and the default desktop to that project; without it the
 * server acts on the default project. The project routes themselves (/api/projects*) ignore the
 * header, so the project list is always read with an unscoped client.
 */

import { SPACE_HEADER } from "../../../packages/domain/src/me.ts";
import { PROJECT_HEADER } from "../../../packages/domain/src/projects.ts";
import { readApiPayload } from "./api-response.ts";

/** The project header for a scoped request; nothing for the default project. */
export function projectHeaders(projectId: string | null | undefined): Record<string, string> {
  return projectId ? { [PROJECT_HEADER]: projectId } : {};
}

// The space every request of this page acts in, chosen once the user's
// spaces are known (spaces.tsx). The whole app is keyed by it, so a switch remounts everything
// and no request of one space is ever sent with another's header.
let activeSpace: string | null = null;
export function setActiveSpace(spaceId: string | null) {
  activeSpace = spaceId;
}
export function activeSpaceId() {
  return activeSpace;
}
/** The space header (nothing before a space is chosen: user-level calls). */
export function spaceHeaders(
  spaceId: string | null | undefined = activeSpace,
): Record<string, string> {
  return spaceId ? { [SPACE_HEADER]: spaceId } : {};
}

// A 401 on any authenticated call means the session ended (expired, signed out
// elsewhere, password changed). The app registers a handler that returns to the sign-in screen.
let unauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  unauthorized = handler;
}

// The space this page acts in is no longer the user's (removed from it):
// the server answers its own words for that. The app registers a handler that reads the user's
// spaces again, so the page says so instead of retrying as if the server were down.
let spaceLost: (() => void) | undefined;
export function setSpaceLostHandler(handler: (() => void) | undefined) {
  spaceLost = handler;
}
const spaceLostAnswers = new Set(["Space not found", "You are not a member of any space"]);
/** Whether a refused request says the user is not (or no longer) in the space it named. */
export async function isSpaceLost(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 404) return false;
  try {
    const payload = (await response.clone().json()) as { error?: unknown } | null;
    return typeof payload?.error === "string" && spaceLostAnswers.has(payload.error);
  } catch {
    return false;
  }
}

export class MuseApiClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly projectId: string | null = null,
  ) {}
  /** The headers every authenticated request carries; for direct fetches, images and downloads. */
  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...spaceHeaders(),
      ...projectHeaders(this.projectId),
    };
  }
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...this.headers(),
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (response.status === 401) unauthorized?.();
    else if (spaceLost && (await isSpaceLost(response))) spaceLost();
    const payload = await readApiPayload<T>(response);
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }
}
