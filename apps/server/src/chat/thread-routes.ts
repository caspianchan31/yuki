// The thread menu's /api/copilotkit/threads* routes, served from this server's database
// and scoped to the signed-in owner. Mounted before the CopilotKit runtime.
import type { BaseEvent } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import { shotIdsOf } from "../desktop-shots-store.ts";
import { AppError } from "../errors.ts";
import { attachmentIdsOf } from "./attachment-store.ts";
import { CursorError } from "./chat-store.ts";
import { compactLeniently, messagesFromEvents, stateFromEvents, toWireMessages } from "./events.ts";
import { chatAgentId } from "./main-thread.ts";
import { replayFrames } from "./replay.ts";
import type { ReplayShares } from "./replay-shares.ts";
import { threadLockedMessage, threadNotFoundMessage } from "./runtime-hooks.ts";
import {
  type FeedbackVerdict,
  type ThreadStore,
  threadLockedCode,
  type WireMessage,
} from "./types.ts";

/** How stored events become the /messages and /state bodies (the runtime's local mapping). */
export interface ThreadView {
  messages(events: BaseEvent[]): WireMessage[];
  state(events: BaseEvent[]): Record<string, unknown> | null;
}

export const defaultThreadView: ThreadView = {
  messages: (events) => toWireMessages(messagesFromEvents(events)),
  state: (events) => stateFromEvents(events),
};

const agentId = z
  .string({ error: "agentId is required" })
  .min(1, "agentId is required")
  .max(128, "agentId is too long");
const threadId = z.string().min(1).max(256, "Thread id is too long");
const listQuery = z.object({
  agentId,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const mutationBody = z.object({ agentId });
const patchBody = z.object({
  agentId,
  name: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});
const messageId = z.string().min(1).max(256, "Message id is too long");
const supersedeBody = z.object({ messageId });
const olderQuery = z.object({
  before: messageId,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  until: messageId.optional(),
});
const feedbackBody = z.object({ verdict: z.enum(["up", "down"]).nullable() });

/** v1.6 聊天基础动作: the 404 for a message no live run of the thread brought in. */
/** v1.6 搜对话内容: a search without words. */
export const searchEmptyMessage = "要搜什么？";
export const messageNotFoundMessage = "找不到这条消息";

/** Validation failures are 400 here (the runtime's thread routes answer 400 too). */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(result.error.issues.map((issue) => issue.message).join("; "), 400);
  return result.data;
}

const notFound = () => new AppError(threadNotFoundMessage, 404);

/** Body of the 404 POST /threads/subscribe receives in local mode. */
export const realtimeUnavailable = "Realtime thread updates are not available without Intelligence";

/** The 409 for archiving or deleting the project's current main chat. */
export const mainThreadKeptMessage = "主聊天要换就点开新主聊天";

/** Which thread is the owner's current main chat (null before it exists). */
export type MainThreadOf = (owner: string) => Promise<string | null>;

/**
 * GET / (list), GET /:threadId/{messages,events,state,speakers,turns}, PATCH /:threadId (rename/unarchive),
 * POST /:threadId/archive, DELETE /:threadId; POST /subscribe answers 404 (no realtime). v1.6
 * 聊天基础动作: POST /:threadId/supersede, GET /:threadId/superseded, GET /:threadId/feedback,
 * PUT /:threadId/feedback/:messageId. Another owner's thread is 404. Owner-like fields in the
 * query or body (userId) are ignored: the owner is always the authenticated session's.
 */
/** Who said what, and the space's activity. */
export interface ThreadRouteHooks {
  /** The usernames of the members of the space `owner` belongs to, by user id. */
  usernames?(owner: string): Promise<Map<string, string>>;
  /** A thread was deleted (the space's activity). */
  deleted?(owner: string, name: string | null): Promise<void>;
  /** v1.6: a deleted thread's kept screenshots (the ids its events name) are removed. */
  forgetShots?(ids: string[]): Promise<void>;
  /** v1.6 聊天里发文件: a deleted thread's sent files (the ids its messages name) are removed. */
  forgetAttachments?(ids: string[]): Promise<void>;
  /** v1.6 回顾: where share links are kept, and the page a token opens. Without them a replay
   * can be watched but not shared. */
  replayShares?: ReplayShares;
  replayUrl?(token: string): string;
}

export function threadRoutes(
  threads: ThreadStore,
  view: ThreadView = defaultThreadView,
  mainThreadOf: MainThreadOf = async () => null,
  hooks: ThreadRouteHooks = {},
) {
  const routes = new Hono<{ Variables: { owner: string } }>();
  // The current main chat is replaced with 开新主聊天, never archived or
  // deleted on its own (the project would be left without one).
  async function assertNotMain(owner: string, id: string) {
    if ((await mainThreadOf(owner)) === id) throw new AppError(mainThreadKeptMessage, 409);
  }

  async function eventsOf(owner: string, id: string) {
    const events = await threads.threadEvents(owner, parse(threadId, id));
    if (!events) throw notFound();
    return events;
  }

  routes.get("/", async (c) => {
    const query = parse(listQuery, c.req.query());
    try {
      return c.json(
        await threads.listThreads(c.get("owner"), {
          agentId: query.agentId,
          includeArchived: c.req.query("includeArchived") === "true",
          limit: query.limit ?? 50,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof CursorError) throw new AppError("Invalid cursor", 400);
      throw error;
    }
  });
  // v1.6 搜对话内容: ⌘K's 对话 group. ?q= the typed words (every one must appear), ?limit= at most
  // 50 (20 by default); the hits newest first, each naming its conversation and message.
  routes.get("/search", async (c) => {
    const typed = (c.req.query("q") ?? "").trim();
    if (!typed) throw new AppError(searchEmptyMessage, 400);
    const limit = Number(c.req.query("limit"));
    const hits = await threads.searchMessages?.(c.get("owner"), typed, {
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });
    return c.json({ hits: hits ?? [] });
  });
  // Realtime thread updates need Intelligence; /info tells the client realtimeMetadata: false.
  routes.post("/subscribe", (c) => c.json({ error: realtimeUnavailable }, 404));
  routes.get("/:threadId/messages", async (c) => {
    const events = await eventsOf(c.get("owner"), c.req.param("threadId"));
    return c.json({ messages: view.messages(events) });
  });
  // v1.7 打开对话不重放整条历史: the messages before `before` (the oldest the page holds), as the
  // agent holds them (the shape of the replayed events); `limit` closed runs at a time, or with
  // `until` everything back to the run that brought that message in (a jump from the search).
  routes.get("/:threadId/older", async (c) => {
    const query = parse(olderQuery, c.req.query());
    const page = await threads.olderRuns?.(
      c.get("owner"),
      parse(threadId, c.req.param("threadId")),
      query.before,
      {
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.until ? { untilMessageId: query.until } : {}),
      },
    );
    if (page === undefined) throw new AppError("Older messages are not available here", 404);
    if (page === null) throw new AppError(messageNotFoundMessage, 404);
    return c.json({
      messages: messagesFromEvents(compactLeniently(page.runs.flat())),
      more: page.more,
    });
  });
  routes.get("/:threadId/events", async (c) =>
    c.json({ events: await eventsOf(c.get("owner"), c.req.param("threadId")) }),
  );
  // v1.6 回顾: the conversation as frames to play back, and its share link.
  routes.get("/:threadId/replay", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const events = await eventsOf(c.get("owner"), id);
    const row = await threads.updateThread(c.get("owner"), id, chatAgentId, {});
    return c.json({ name: row?.name ?? null, frames: replayFrames(events) });
  });
  const shareOf = (share: { token: string; createdAt: string; expiresAt: string } | null) =>
    share
      ? {
          token: share.token,
          url: hooks.replayUrl?.(share.token) ?? null,
          createdAt: share.createdAt,
          expiresAt: share.expiresAt,
        }
      : null;
  routes.get("/:threadId/replay-share", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    if (!hooks.replayShares) return c.json({ share: null, available: false });
    await eventsOf(c.get("owner"), id);
    return c.json({
      share: shareOf(await hooks.replayShares.current(c.get("owner"), id)),
      available: true,
    });
  });
  routes.post("/:threadId/replay-share", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    if (!hooks.replayShares) throw new AppError("Sharing a replay is not available here", 404);
    await eventsOf(c.get("owner"), id);
    return c.json({ share: shareOf(await hooks.replayShares.create(c.get("owner"), id)) });
  });
  routes.delete("/:threadId/replay-share", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    if (!hooks.replayShares) throw new AppError("Sharing a replay is not available here", 404);
    return c.json({ revoked: await hooks.replayShares.revoke(c.get("owner"), id) });
  });
  // Message id -> the username of the member who sent it (members who left
  // the space are not named).
  routes.get("/:threadId/speakers", async (c) => {
    const owner = c.get("owner");
    const speakers = await threads.speakers?.(owner, parse(threadId, c.req.param("threadId")));
    if (speakers === null) throw notFound();
    const names = (await hooks.usernames?.(owner)) ?? new Map<string, string>();
    const out: Record<string, string> = {};
    for (const [messageId, userId] of Object.entries(speakers ?? {})) {
      const name = names.get(userId);
      if (name) out[messageId] = name;
    }
    return c.json({ speakers: out });
  });
  // When each turn was had, so the chat places a need's
  // card by the moment it was raised, the same on every device.
  routes.get("/:threadId/turns", async (c) => {
    const turns = await threads.turns?.(c.get("owner"), parse(threadId, c.req.param("threadId")));
    if (turns === null) throw notFound();
    return c.json({ turns: turns ?? [] });
  });
  routes.get("/:threadId/state", async (c) => {
    const events = await eventsOf(c.get("owner"), c.req.param("threadId"));
    return c.json({ state: view.state(events) });
  });
  // v1.6 聊天基础动作: the person goes back on the conversation from one of their messages (edits
  // it and sends it again, or asks for the reply again). The stretch from there is superseded;
  // the run the client starts next takes its place.
  routes.post("/:threadId/supersede", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(supersedeBody, await c.req.json());
    if (!threads.supersedeFrom) throw new AppError("Going back is not available here", 404);
    const result = await threads.supersedeFrom(c.get("owner"), id, body.messageId);
    if (result === "not_found") throw notFound();
    if (result === "no_message") throw new AppError(messageNotFoundMessage, 404);
    if (result === "running")
      return c.json({ error: threadLockedMessage, code: threadLockedCode }, 409);
    return c.json({ threadId: id, messageId: body.messageId, superseded: true });
  });
  // The superseded stretches, as messages, each with the live run its fold stands before.
  routes.get("/:threadId/superseded", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const segments = await threads.superseded?.(c.get("owner"), id);
    if (segments === null) throw notFound();
    return c.json({
      segments: (segments ?? []).map((segment) => ({
        anchor: segment.anchor,
        at: segment.at,
        messages: view.messages(segment.events),
      })),
    });
  });
  // 点赞 / 点踩 on a reply: kept per message, read back after a reload.
  routes.get("/:threadId/feedback", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const given = await threads.feedback?.(c.get("owner"), id);
    if (given === null) throw notFound();
    return c.json({ feedback: given ?? {} });
  });
  routes.put("/:threadId/feedback/:messageId", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const message = parse(messageId, c.req.param("messageId"));
    const body = parse(feedbackBody, await c.req.json());
    if (!threads.setFeedback) throw new AppError("Feedback is not available here", 404);
    if (!(await threads.setFeedback(c.get("owner"), id, message, body.verdict))) throw notFound();
    return c.json({
      threadId: id,
      messageId: message,
      verdict: body.verdict satisfies FeedbackVerdict | null,
    });
  });
  routes.patch("/:threadId", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(patchBody, await c.req.json());
    if (body.archived === true) await assertNotMain(c.get("owner"), id);
    const thread = await threads.updateThread(c.get("owner"), id, body.agentId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
    });
    if (!thread) throw notFound();
    return c.json(thread);
  });
  routes.post("/:threadId/archive", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(mutationBody, await c.req.json());
    await assertNotMain(c.get("owner"), id);
    if (!(await threads.updateThread(c.get("owner"), id, body.agentId, { archived: true })))
      throw notFound();
    return c.json({ threadId: id, archived: true });
  });
  routes.delete("/:threadId", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(mutationBody, await c.req.json());
    await assertNotMain(c.get("owner"), id);
    const name = hooks.deleted ? await threadName(threads, c.get("owner"), id, body.agentId) : null;
    // The superseded stretches' screenshots and files go too.
    const events =
      hooks.forgetShots || hooks.forgetAttachments
        ? ((await threads.threadEvents(c.get("owner"), id, { superseded: true })) ?? [])
        : [];
    const shots = hooks.forgetShots ? shotIdsOf(events) : [];
    const sent = hooks.forgetAttachments ? attachmentIdsOf(events) : [];
    const result = await threads.deleteThread(c.get("owner"), id, body.agentId);
    if (result === "not_found") throw notFound();
    if (result === "running")
      return c.json({ error: threadLockedMessage, code: threadLockedCode }, 409);
    await hooks.deleted?.(c.get("owner"), name);
    if (shots.length) await hooks.forgetShots?.(shots);
    if (sent.length) await hooks.forgetAttachments?.(sent);
    return c.json({ threadId: id, deleted: true });
  });
  return routes;
}

/** A thread's name for the activity line (an update with no change reads the row). */
async function threadName(threads: ThreadStore, owner: string, id: string, agentId: string) {
  return (await threads.updateThread(owner, id, agentId, {}))?.name ?? null;
}
