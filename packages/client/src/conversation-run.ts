import { stoppedByInfrastructure } from "../../../packages/domain/src/agent";
import { t } from "./shell/strings";

type RunError = { error: unknown; code?: string; context?: { agentId?: string } };

/** The server's CUSTOM event between a reply's failed attempt and its retry
 * (apps/server/src/engine/reply-retry.ts); the chat shows 「服务暂时出错，正在重试…」 on it. */
export const replyRetryEvent = "reply_retry";

/** A RUN_ERROR event from the thread's saved history, not a failure of this call. */
export const replayedRunError = "agent_run_error_event";

/** The thread is busy with another run, so the server refused this one before starting it. */
export const threadLocked = "agent_thread_locked";

/**
 * The server could not read the thread's history for a connect. It ends the
 * replay with a RUN_ERROR carrying this code, which CopilotKit copies onto the reported error. It
 * is a failure of this load, not a replayed past failure, so ignoring replayed errors keeps it.
 */
export const historyUnavailable = "history_unavailable";

function isHistoryUnavailable(error: unknown) {
  return (
    error instanceof Error && (error as Error & { code?: unknown }).code === historyUnavailable
  );
}

/** CopilotKit reports a lock as agent_thread_locked, then again as agent_run_failed. */
export function isThreadLocked(event: Pick<RunError, "error" | "code">) {
  return (
    event.code === threadLocked ||
    (event.error instanceof Error && event.error.name === "AgentThreadLockedError") ||
    // The runtime streams over SSE, so a lock arrives as HTTP.
    isHttpThreadLock(event.error)
  );
}

/**
 * The server refuses a busy thread with HTTP 409
 * `{ error, code: "agent_thread_locked" }` before streaming. HttpAgent turns that into an Error
 * with `status`, the parsed `payload` and the message `HTTP 409: <body>`, and CopilotKit reports
 * it as agent_run_failed. A lock found after the stream began is a RUN_ERROR event whose code
 * CopilotKit copies onto the error.
 */
function isHttpThreadLock(error: unknown) {
  if (!(error instanceof Error)) return false;
  const { status, payload, code } = error as Error & {
    status?: unknown;
    payload?: unknown;
    code?: unknown;
  };
  if (code === threadLocked) return true;
  if (status === 409 && typeof payload === "object" && payload !== null)
    return (payload as { code?: unknown }).code === threadLocked;
  // The body was not parsed as JSON (for example a proxy changed its content type).
  return error.message.startsWith("HTTP 409:") && error.message.includes(threadLocked);
}

/** A failed turn, carrying the CopilotKit error code that reported it. */
export class ConversationTurnError extends Error {
  constructor(
    readonly cause: Error,
    readonly code?: string,
  ) {
    super(cause.message);
    this.name = cause.name;
  }
}

/**
 * CopilotKit's codes for a run or connect request that did not get through: the chat service
 * (this server, or the way there) was unreachable or answered with an error. Not the
 * agent's own RUN_ERROR (agent_run_error_event), which carries what the agent said.
 */
const transportCodes: ReadonlySet<string> = new Set([
  "agent_run_failed",
  "agent_run_failed_event",
  "agent_connect_failed",
  // The runtime's /info (read before a run or a connect) did not answer.
  "runtime_info_fetch_failed",
]);

/** The HTTP status of a failed chat request: @ag-ui/client's `status`, CopilotKit's
 * `runtimeInfoStatus` for /info. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, runtimeInfoStatus } = error as { status?: unknown; runtimeInfoStatus?: unknown };
  if (typeof status === "number") return status;
  return typeof runtimeInfoStatus === "number" ? runtimeInfoStatus : undefined;
}

/** What kind of failure a chat error is: the thread busy, the way to the chat service, or the
 * agent's own error (anything else, shown as it is). */
export type ChatErrorKind = "locked" | "transport" | "agent";

export function chatErrorKind(event: Pick<RunError, "error" | "code">): ChatErrorKind {
  if (isThreadLocked(event)) return "locked";
  if (event.code && transportCodes.has(event.code)) return "transport";
  // A request the server answered with an error status, whatever code CopilotKit gave it.
  return httpStatus(event.error) !== undefined ? "transport" : "agent";
}

/**
 * The chat's error line for a failed reply, by kind: the transport (too many requests on its own)
 * and the lock in plain Chinese (never the raw request error, which is English and JSON), anything
 * else as it is.
 */
export function chatErrorText(event: Pick<RunError, "error" | "code">): string {
  const kind = chatErrorKind(event);
  if (kind === "transport")
    return httpStatus(event.error) === 429 ? t.chat.tooManyRequests : t.chat.transportFailed;
  if (kind === "locked") return t.chat.threadBusy;
  const message = event.error instanceof Error ? event.error.message : String(event.error);
  // What the
  // infrastructure stopped (the server already tried the reply once more) reads in Chinese; the
  // model's or the server's own words (already Chinese, or the person's to read) stay.
  return stoppedByInfrastructure(message) ? t.chat.serviceFailed : message;
}

/** `chatErrorText` for an error a turn threw (a `ConversationTurnError` carries its code). */
export function turnErrorText(error: unknown): string {
  return chatErrorText({
    error,
    ...(error instanceof ConversationTurnError ? { code: error.code } : {}),
  });
}

/**
 * The wait before loading the conversation again after a transport failure: 1 s, 2 s, 4 s, 8 s,
 * then every 10 s while the chat is open. A transport backoff (the server's own retry uses the
 * same), not a strategy.
 */
export function chatRetryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/** Whether the chat's error banner shows an error reported while these are in progress. */
export function showsRunError(
  event: Pick<RunError, "error" | "code">,
  during: { replaying: boolean; queuedTurn: boolean },
) {
  // A failed turn saved in history is already over; it is not a failure of this session.
  if (during.replaying && event.code === replayedRunError) return false;
  // Loading the conversation reports its own transport failure (and tries again) above the chat.
  if (during.replaying && chatErrorKind(event) === "transport") return false;
  // A queued message refused by a lock goes back on hold. Retry is not a queued turn, so it shows.
  if (during.queuedTurn && isThreadLocked(event)) return false;
  return true;
}

/**
 * What claimThreadLock needs from the agent (an @ag-ui/client AbstractAgent). Results are
 * `unknown` because @ag-ui/client types onRunFailed's result without stopPropagation, although
 * AbstractAgent.onError honours it (it then neither logs nor rethrows the failure);
 * tests/chat-client.test.ts pins that against the real client.
 */
export interface LockableAgent {
  subscribe(subscriber: {
    onRunFailed?(params: { error: Error }): unknown;
    onRunErrorEvent?(params: { event: { code?: string; message?: string } }): unknown;
  }): { unsubscribe(): void };
}

/**
 * Claims a thread-lock refusal of the agent's next run, for a turn that puts
 * its message back on hold, so the refusal is expected rather than an error. Returning
 * stopPropagation from the agent subscriber keeps @ag-ui/client ("Agent execution failed") and
 * CopilotKit (its onError, which CopilotKitProvider logs) from reporting it on the console; this
 * subscriber runs before CopilotKit's own run subscriber. The refusal is a 409 before streaming,
 * or a RUN_ERROR with the lock code. Other failures pass. If a client version stopped honouring
 * stopPropagation here, the refusal would still be held: CopilotKit would then report it as
 * before, and runConversationTurn rethrows it either way.
 */
export function claimThreadLock(agent: LockableAgent) {
  let refusal: Error | undefined;
  const subscription = agent.subscribe({
    onRunFailed: ({ error }) => {
      if (!isThreadLocked({ error })) return undefined;
      refusal ??= error;
      return { stopPropagation: true };
    },
    onRunErrorEvent: ({ event }) => {
      if (event.code !== threadLocked) return undefined;
      refusal ??= Object.assign(new Error(event.message ?? t.chat.threadBusy), {
        code: threadLocked,
      });
      return { stopPropagation: true };
    },
  });
  return { refusal: () => refusal, unsubscribe: () => subscription.unsubscribe() };
}

/**
 * CopilotKit emits run failures through onError even when runAgent resolves. With holdOnLock, a
 * thread-lock refusal of that agent's run is claimed (see claimThreadLock) and rethrown here as a
 * threadLocked turn error.
 */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
  ignore: readonly string[] = [],
  holdOnLock?: LockableAgent,
) {
  let failure: ConversationTurnError | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    if (event.code && ignore.includes(event.code) && !isHistoryUnavailable(event.error)) return;
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    // The first report is the specific one; CopilotKit follows it with a generic agent_run_failed.
    failure ??= new ConversationTurnError(error, isThreadLocked(event) ? threadLocked : event.code);
  });
  const lock = holdOnLock ? claimThreadLock(holdOnLock) : undefined;
  try {
    await execute();
    const refusal = lock?.refusal();
    if (refusal) throw new ConversationTurnError(refusal, threadLocked);
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
    lock?.unsubscribe();
  }
}
