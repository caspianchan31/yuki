/**
 * v1.6 回顾: where the player gets its frames and pictures. The owner's view reads the thread's
 * replay with the stored session (and the project and space the chat was opened in, carried in
 * the page's query so the server scopes the thread the same way); a shared link reads the public
 * /api/replays/<token> with nothing else.
 */
import { API_URL } from "@m/api";
import { projectHeaders, spaceHeaders } from "@m/api-client";
import { readStoredSession } from "@m/session-core";
import { base } from "../base";
import type { Replay, ReplaySource, ShareInfo } from "./ReplayPage";

async function json<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // no body
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function objectUrl(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

/** The signed-in owner's own replay of a thread; null when there is no stored session. */
export function ownReplaySource(
  threadId: string,
  scope: { projectId: string | null; spaceId: string | null },
  fallback: string,
): ReplaySource | null {
  const session = readStoredSession(typeof localStorage === "undefined" ? undefined : localStorage);
  if (!session) return null;
  const headers = {
    Authorization: `Bearer ${session.token}`,
    ...projectHeaders(scope.projectId),
    ...spaceHeaders(scope.spaceId),
  };
  const threadApi = `${API_URL}/api/copilotkit/threads/${encodeURIComponent(threadId)}`;
  // The link is this web app's own address: on a hosted site the API lives elsewhere.
  const shareOf = (body: { share: ShareInfo | null }) =>
    body.share
      ? { ...body.share, url: `${location.origin}${base}r/${encodeURIComponent(body.share.token)}` }
      : null;
  return {
    load: async () => json<Replay>(await fetch(`${threadApi}/replay`, { headers }), fallback),
    shot: async (id) =>
      objectUrl(
        await fetch(`${API_URL}/api/computer/screenshots/${encodeURIComponent(id)}`, {
          headers,
          cache: "no-store",
        }),
      ),
    share: {
      current: async () => {
        const body = await json<{ share: ShareInfo | null; available: boolean }>(
          await fetch(`${threadApi}/replay-share`, { headers }),
          fallback,
        );
        if (!body.available) throw new Error("unavailable");
        return shareOf(body);
      },
      create: async () =>
        shareOf(
          await json(
            await fetch(`${threadApi}/replay-share`, { method: "POST", headers }),
            fallback,
          ),
        ),
      revoke: async () => {
        await json(
          await fetch(`${threadApi}/replay-share`, { method: "DELETE", headers }),
          fallback,
        );
      },
    },
  };
}

/** A shared link's replay: public, the token is the whole key. */
export function sharedReplaySource(token: string, fallback: string, gone: string): ReplaySource {
  const base = `${API_URL}/api/replays/${encodeURIComponent(token)}`;
  return {
    load: async () => {
      const response = await fetch(base);
      // 404 is the link itself (expired, revoked, unknown): say so in the page's own words.
      if (response.status === 404) throw new Error(gone);
      return json<Replay>(response, fallback);
    },
    shot: async (id) => objectUrl(await fetch(`${base}/shots/${encodeURIComponent(id)}`)),
  };
}
