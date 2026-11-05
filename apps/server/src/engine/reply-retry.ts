// A reply whose model request the infrastructure
// stopped (`stoppedByInfrastructure`: a relay's upstream failure, a 5xx, an empty stream, a dropped
// connection) is tried once more by itself, as the same reply. The person sees one line that it
// is retrying (the client words the CUSTOM event below); only when the second attempt fails too
// does the reply end with an error. The reply's hold on the desktop goes with the reply, so it
// stays through the retry.
import { type BaseEvent, EventType, type Message, type RunAgentInput } from "@ag-ui/core";
import { Observable, type Subscription } from "rxjs";
import { messagesFromEvents } from "../chat/events.ts";

/** The CUSTOM event between the failed attempt and the retry; `value.message` is what failed. */
export const replyRetryEvent = "reply_retry";
/** How long the reply waits before its second attempt. */
export const replyRetryDelayMs = 2000;

export interface ReplyRetryOptions {
  /** Whether a RUN_ERROR's message is a failure that goes away by itself. */
  transient: (message: string) => boolean;
  delayMs: number;
}

type Loose = BaseEvent & Record<string, unknown>;
const messageOf = (event: BaseEvent) => {
  const message = (event as Loose).message;
  return typeof message === "string" ? message : "";
};

/**
 * Runs `start(input)` once more after a transient RUN_ERROR, continuing the same reply: every
 * event of the first attempt is kept (nothing is sent twice), the second attempt's input carries
 * what the reply did so far (its text, its tool calls and their results) as messages after the
 * conversation, and a CUSTOM `reply_retry` event goes out in between. The second attempt's
 * RUN_STARTED is dropped (the reply started once); its failure, or a failure that is not
 * transient, ends the reply as before. Unsubscribing during the wait starts nothing more.
 */
export function withOneRetry(
  start: (input: RunAgentInput) => Observable<BaseEvent>,
  input: RunAgentInput,
  options: ReplyRetryOptions,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    let inner: Subscription | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const attempt = (attemptInput: RunAgentInput, retried: boolean) => {
      const seen: BaseEvent[] = [];
      const openCalls = new Set<string>();
      let retrying = false;
      inner = start(attemptInput).subscribe({
        next: (event) => {
          if (retrying || cancelled) return;
          if (retried && event.type === EventType.RUN_STARTED) return;
          if (
            !retried &&
            event.type === EventType.RUN_ERROR &&
            options.transient(messageOf(event))
          ) {
            retrying = true;
            // A tool call the failure cut off is closed, so the stream stays well formed; the
            // retry's input leaves it out (`continued`).
            for (const toolCallId of openCalls)
              subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
            subscriber.next({
              type: EventType.CUSTOM,
              name: replyRetryEvent,
              value: { message: messageOf(event) },
            } as BaseEvent);
            timer = setTimeout(() => {
              timer = undefined;
              if (!cancelled) attempt(continued(attemptInput, seen), true);
            }, options.delayMs);
            return;
          }
          if (event.type === EventType.TOOL_CALL_START)
            openCalls.add(String((event as Loose).toolCallId));
          if (event.type === EventType.TOOL_CALL_END)
            openCalls.delete(String((event as Loose).toolCallId));
          seen.push(event);
          subscriber.next(event);
        },
        error: (error: unknown) => {
          if (!retrying && !cancelled) subscriber.error(error);
        },
        complete: () => {
          if (!retrying && !cancelled) subscriber.complete();
        },
      });
    };
    attempt(input, false);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      inner?.unsubscribe();
    };
  });
}

/** The retry's input: the attempt's conversation, then what the reply did so far as messages. */
export function continued(input: RunAgentInput, events: readonly BaseEvent[]): RunAgentInput {
  const known = new Set(input.messages.map((message) => message.id));
  const produced = replyMessages(events).filter((message) => !known.has(message.id));
  return { ...input, messages: [...input.messages, ...produced] };
}

/**
 * The messages a reply's events so far amount to (`messagesFromEvents` over them, text chunks
 * folded first): an assistant message per text and per step of tool calls, each tool's result.
 * A tool call without a result (the failure cut it off) is left out, and an assistant message
 * left with nothing is too: the model continues from what was done, never from a call it owes a
 * result for.
 */
export function replyMessages(events: readonly BaseEvent[]): Message[] {
  const folded: BaseEvent[] = [];
  const started = new Set<string>();
  for (const event of events) {
    if (event.type === EventType.RUN_STARTED) continue;
    if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
      const { messageId, delta, role } = event as Loose;
      if (typeof messageId !== "string") continue;
      if (!started.has(messageId)) {
        started.add(messageId);
        folded.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: role ?? "assistant",
        } as BaseEvent);
      }
      if (typeof delta === "string" && delta)
        folded.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as BaseEvent);
      continue;
    }
    folded.push(event);
  }
  const messages = messagesFromEvents(folded);
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "tool" && typeof message.toolCallId === "string" ? [message.toolCallId] : [],
    ),
  );
  return messages.flatMap((message): Message[] => {
    if (message.role !== "assistant") return [message];
    const calls = (message.toolCalls ?? []).filter((call) => answered.has(call.id));
    const content = typeof message.content === "string" ? message.content : "";
    if (!calls.length && !content) return [];
    const kept = { ...message, ...(calls.length ? { toolCalls: calls } : {}) } as Message & {
      toolCalls?: unknown;
    };
    if (!calls.length) delete kept.toolCalls;
    return [kept as Message];
  });
}
