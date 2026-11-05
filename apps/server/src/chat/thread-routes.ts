// The thread menu's /api/copilotkit/threads* routes, served from this server's database
// and scoped to the signed-in owner. Mounted before the CopilotKit runtime.
import type { BaseEvent } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { CursorError } from "./chat-store.ts";
import { messagesFromEvents, stateFromEvents, toWireMessages } from "./events.ts";
import { threadLockedMessage, threadNotFoundMessage } from "./runtime-hooks.ts";
import { type ThreadStore, threadLockedCode, type WireMessage } from "./types.ts";

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
 * POST /:threadId/archive, DELETE /:threadId; POST /subscribe answers 404 (no realtime). Another
 * owner's thread is 404. Owner-like fields in the query or body (userId) are ignored: the owner is
 * always the authenticated session's.
 */
/** Who said what, and the space's activity. */
export interface ThreadRouteHooks {
  /** The usernames of the members of the space `owner` belongs to, by user id. */
  usernames?(owner: string): Promise<Map<string, string>>;
  /** A thread was deleted (the space's activity). */
  deleted?(owner: string, name: string | null): Promise<void>;
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
  // Realtime thread updates need Intelligence; /info tells the client realtimeMetadata: false.
  routes.post("/subscribe", (c) => c.json({ error: realtimeUnavailable }, 404));
  routes.get("/:threadId/messages", async (c) => {
    const events = await eventsOf(c.get("owner"), c.req.param("threadId"));
    return c.json({ messages: view.messages(events) });
  });
  routes.get("/:threadId/events", async (c) =>
    c.json({ events: await eventsOf(c.get("owner"), c.req.param("threadId")) }),
  );
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
    const result = await threads.deleteThread(c.get("owner"), id, body.agentId);
    if (result === "not_found") throw notFound();
    if (result === "running")
      return c.json({ error: threadLockedMessage, code: threadLockedCode }, 409);
    await hooks.deleted?.(c.get("owner"), name);
    return c.json({ threadId: id, deleted: true });
  });
  return routes;
}

/** A thread's name for the activity line (an update with no change reads the row). */
async function threadName(threads: ThreadStore, owner: string, id: string, agentId: string) {
  return (await threads.updateThread(owner, id, agentId, {}))?.name ?? null;
}
