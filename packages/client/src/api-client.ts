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
import { afterOpening } from "./opening";

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
  /** v1.7 启动链瘦身: the ETag and body of each GET answered with one, so the next read of the same
   * path asks "only if it changed" and a 304 costs no body (the browser's own cache does not do
   * this for requests carrying Authorization). Per client: another project or space is another
   * client. At most `conditionalKeep` entries, the oldest dropped. */
  private readonly conditional = new Map<string, { etag: string; payload: unknown }>();
  private static readonly conditionalKeep = 64;
  /** v1.7.2: the GETs in flight, so two readers of one path at the same moment cost one request
   * (the shell read some paths several times while mounting). Each remembers the write count it
   * started under: a read is shared only among readers that saw no write start or end since it
   * was sent, because a read issued after a write must not get an answer the server may have
   * produced before that write. A failed read fails its sharers only; the next one asks again. */
  private readonly inflight = new Map<string, { run: Promise<unknown>; writes: number }>();
  /** Bumped when any non-GET starts and again when it settles, whatever its path and whichever
   * client sent it (a step on another project's account goes through that project's client):
   * a write to one path can change what another answers. */
  private static writes = 0;
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const verb = method ?? (body === undefined ? "GET" : "POST");
    if (verb !== "GET") {
      MuseApiClient.writes++;
      try {
        return await this.fetchOnce<T>(path, body, verb);
      } finally {
        // a read sent while the write was under way may have been answered before it landed
        MuseApiClient.writes++;
      }
    }
    // v1.7.2 对话快: while the page opens, a read its first screen does not need waits a moment.
    const opening = afterOpening(verb, path);
    if (opening) await opening;
    const running = this.inflight.get(path);
    if (running && running.writes === MuseApiClient.writes) return running.run as Promise<T>;
    const entry = {
      writes: MuseApiClient.writes,
      run: this.fetchOnce<T>(path, body, verb).finally(() => {
        // an older read that settles late must not drop the newer one that replaced it
        if (this.inflight.get(path) === entry) this.inflight.delete(path);
      }) as Promise<unknown>,
    };
    this.inflight.set(path, entry);
    return entry.run as Promise<T>;
  }
  private keep(path: string, etag: string, payload: unknown) {
    this.conditional.delete(path);
    this.conditional.set(path, { etag, payload });
    if (this.conditional.size > MuseApiClient.conditionalKeep) {
      const oldest = this.conditional.keys().next().value;
      if (oldest !== undefined) this.conditional.delete(oldest);
    }
  }
  private async fetchOnce<T>(path: string, body: unknown, verb: string): Promise<T> {
    const kept = verb === "GET" ? this.conditional.get(path) : undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: verb,
      headers: {
        ...this.headers(),
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(kept ? { "If-None-Match": kept.etag } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (response.status === 401) unauthorized?.();
    else if (spaceLost && (await isSpaceLost(response))) spaceLost();
    if (kept && response.status === 304) return kept.payload as T;
    const payload = await readApiPayload<T>(response);
    if (verb === "GET") {
      const etag = response.headers.get("etag");
      if (etag && response.ok) this.keep(path, etag, payload);
      else if (this.conditional.has(path)) this.conditional.delete(path);
    }
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }
}
