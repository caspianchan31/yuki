// CopilotKit runtime hooks. They run after the runtime's own router, so
// owner checks and the busy-thread 409 apply to every path the runtime would serve.
import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import { isMemberConversationId } from "../../../../packages/domain/src/member-thread.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { AppError } from "../errors.ts";
import type { PlanGate } from "../gate.ts";
import { currentActor } from "../request-actor.ts";
import { type RunControl, type ThreadStore, threadLockedCode } from "./types.ts";

/** The owner a request acts as (its session, then its project header); one
 * resolver for the Hono middleware, these hooks and the agents factory (resolveRequestOwner). */
export type RequestOwner = (request: Request) => Promise<string>;

export interface ChatHookDeps {
  owner: RequestOwner;
  threads: Pick<ThreadStore, "threadOwner" | "adoptThread">;
  runs: RunControl;
  /** Null while the owner's space may run; else why it may not (402). */
  gate?: Pick<PlanGate, "refusal">;
}

export type ChatRuntimeHooks = Required<
  Pick<CopilotRuntimeHooks, "onBeforeHandler" | "onResponse">
>;

/** The /info thread capabilities local mode serves (list, inspect and mutations; no realtime). */
export const localThreadEndpoints = {
  list: true,
  inspect: true,
  mutations: true,
  realtimeMetadata: false,
} as const;

/** Body of the 409 a run on a busy thread receives before any SSE byte. */
export const threadLockedMessage = "这个对话还在回复，等它说完再发。";

/** Body of the 503 a request receives when the chat database fails during the hook's checks. */
export const chatUnavailableMessage = "对话记录暂时读不到，稍后再试";

/** Thread and run ids longer than this are refused with 400 before the runtime runs. */
const maxIdLength = 256;

/** Body of the 400 a run receives when its threadId or runId is missing, empty or too long. */
export const runIdsRequired = `threadId and runId are required (1-${maxIdLength} characters)`;

// `new Response`, not `Response.json`: @hono/node-server replaces the global Response class, and the
// runtime recognises a thrown answer with `instanceof Response`, which a static Response.json()
// result (built by the original class) fails, turning the 409 into a 500.
const jsonError = (status: number, error: string, code?: string) =>
  new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const threadNotFound = () => jsonError(404, threadNotFoundMessage);
/** Body of every 404 for a thread that is missing or another owner's (the same answer). */
export const threadNotFoundMessage = "找不到这个对话";

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxIdLength;

/** The JSON body without consuming it; undefined when it is not a JSON object. */
async function peekBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.clone().json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * agent/run: claim the thread for the session owner before the SSE response (busy -> 409
 * agent_thread_locked, another owner's thread -> 404, unusable ids -> 400) and release the claim
 * if the runtime answers non-200. agent/connect and agent/stop: another owner's thread -> 404.
 * info: threadEndpoints rewritten to localThreadEndpoints.
 * cpk-debug-events: 404, because the debug bus carries every owner's run events.
 * A database failure during these checks: 503 JSON, before any SSE byte.
 */
export function chatRuntimeHooks({ owner, threads, runs, gate }: ChatHookDeps): ChatRuntimeHooks {
  const claims = new WeakMap<Request, { threadId: string; runId: string }>();

  async function ownerOf(request: Request) {
    try {
      return await owner(request);
    } catch (error) {
      // A missing session (401) or an unknown project (404) answers as the rest of /api does.
      if (error instanceof AppError) throw jsonError(error.status, error.message);
      throw error;
    }
  }

  /** A member's own conversation belongs to the scope she is in. One made before
   * she joined a group (or after she left it) is still held by the other scope: it follows her
   * here, so opening it is not a 404. */
  async function adoptMemberThread(owner: string, threadId: string) {
    if (!threads.adoptThread || !isMemberConversationId(threadId)) return;
    const holder = await threads.threadOwner(threadId);
    if (holder === null || holder === owner) return;
    await threads.adoptThread(threadId, realOwnerOf(owner), owner);
  }

  async function assertOwnThread(request: Request, threadId: string, mustExist = false) {
    const owner = await ownerOf(request);
    await adoptMemberThread(owner, threadId);
    const holder = await threads.threadOwner(threadId);
    if (holder !== null && holder !== owner) throw threadNotFound();
    // A stop names a thread; one that does not exist is answered like
    // another owner's, so a stop never tells whether an id is in use elsewhere.
    if (mustExist && holder === null) throw threadNotFound();
  }

  return {
    async onBeforeHandler({ request, route }) {
      try {
        switch (route.method) {
          case "agent/run": {
            const owner = await ownerOf(request);
            const body = await peekBody(request);
            // A body that is not a JSON object is answered 400 by the runtime. Any other run must
            // carry ids this hook can claim: the runtime accepts every string (an empty or very
            // long id too), and an unclaimed run would skip the owner check.
            if (!body) return;
            if (!isId(body.threadId) || !isId(body.runId)) throw jsonError(400, runIdsRequired);
            // A read-only space's conversations are kept but get no reply.
            const refused = gate ? await gate.refusal(owner) : null;
            if (refused) throw jsonError(402, refused);
            const { threadId, runId } = body;
            await adoptMemberThread(owner, threadId);
            // The member sending this run's message, kept on the run.
            const speaker = currentActor()?.userId ?? null;
            const claim = await runs.claim({
              owner,
              threadId,
              agentId: route.agentId,
              runId,
              ...(speaker ? { speaker } : {}),
            });
            if (!claim.ok)
              throw claim.reason === "locked"
                ? jsonError(409, threadLockedMessage, threadLockedCode)
                : threadNotFound();
            claims.set(request, { threadId, runId });
            return;
          }
          case "agent/connect": {
            const body = await peekBody(request);
            // Threads are only ever created with ids that pass isId, so other ids replay nothing.
            if (isId(body?.threadId)) await assertOwnThread(request, body.threadId);
            else await ownerOf(request);
            return;
          }
          case "agent/stop":
            await assertOwnThread(request, route.threadId, true);
            return;
          case "cpk-debug-events":
            throw jsonError(404, "Not found");
          default:
            return;
        }
      } catch (error) {
        if (error instanceof Response) throw error;
        // The database failed while checking the owner or claiming the thread: a JSON 503 before
        // any SSE byte, without the error's details. Nothing is claimed (a claim is one statement).
        console.error(
          `[OpenMuse] Local chat check failed: ${error instanceof Error ? error.name : "Error"}`,
        );
        throw jsonError(503, chatUnavailableMessage);
      }
    },
    async onResponse({ request, response, route }) {
      if (route.method === "agent/run") {
        const claim = claims.get(request);
        claims.delete(request);
        // The run never began (bad body, unknown agent, runtime error): undo the claim. A failed
        // release keeps the runtime's answer; the unstarted claim is then recovered as stale.
        if (claim && response.status !== 200)
          await runs.release(claim.threadId, claim.runId).catch((error: unknown) => {
            console.error(
              `[OpenMuse] Releasing an unstarted chat run failed: ${error instanceof Error ? error.name : "Error"}`,
            );
          });
        return;
      }
      if (route.method === "info" && response.ok) return withLocalThreadEndpoints(response);
    },
  };
}

/** The runtime's /info body with threadEndpoints pointing the client at the local thread routes. */
async function withLocalThreadEndpoints(response: Response): Promise<Response | undefined> {
  let info: unknown;
  try {
    info = await response.clone().json();
  } catch {
    return undefined;
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...info, threadEndpoints: localThreadEndpoints }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
