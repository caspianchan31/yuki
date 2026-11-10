// v1.6 回顾 by link: GET /api/replays/:token answers a shared conversation's frames to anyone
// who has the token (no sign-in), and GET /api/replays/:token/shots/:id a picture that replay
// shows and no other. Mounted before the session check; the token is the whole secret.
import { Hono } from "hono";
import { sniffImage } from "../image-generation.ts";
import { chatAgentId } from "./main-thread.ts";
import { type ReplayFrame, replayFrames, replayShotIds } from "./replay.ts";
import type { ReplayShares } from "./replay-shares.ts";
import type { ThreadStore } from "./types.ts";

export interface SharedReplay {
  name: string | null;
  createdAt: string;
  expiresAt: string;
  frames: ReplayFrame[];
}

export function replayPublicRoutes(
  shares: ReplayShares,
  threads: ThreadStore,
  /** A kept picture's PNG bytes (the open build's computer), null when there is none. */
  shotPng: (id: string) => Buffer | null,
) {
  const app = new Hono();
  const gone = { error: "This replay link is not available (expired, revoked or unknown)" };
  const load = async (token: string) => {
    const share = await shares.byToken(token);
    if (!share) return null;
    const events = await threads.threadEvents(share.owner, share.threadId);
    if (!events) return null;
    return { share, frames: replayFrames(events) };
  };
  app.get("/:token", async (c) => {
    const found = await load(c.req.param("token"));
    if (!found) return c.json(gone, 404);
    const thread = await threads.updateThread(
      found.share.owner,
      found.share.threadId,
      chatAgentId,
      {},
    );
    const body: SharedReplay = {
      name: thread?.name ?? null,
      createdAt: found.share.createdAt,
      expiresAt: found.share.expiresAt,
      frames: found.frames,
    };
    c.header("Cache-Control", "private, no-store");
    return c.json(body);
  });
  app.get("/:token/shots/:id", async (c) => {
    const found = await load(c.req.param("token"));
    if (!found) return c.json(gone, 404);
    const id = c.req.param("id");
    if (!replayShotIds(found.frames).has(id)) return c.json({ error: "No such picture" }, 404);
    const png = shotPng(id);
    if (!png) return c.json({ error: "This screenshot is gone" }, 404);
    c.header("Content-Type", sniffImage(png) ?? "image/png");
    c.header("Cache-Control", "private, max-age=3600");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(png));
  });
  return app;
}
