import { EventType } from "@ag-ui/core";

/**
 * the adapter's turn is asked again, up to `askAgainTimes` times, when its stream carried
 * reasoning (the compatible adapter's `reasoning_content`) and ended without one chunk that is a
 * word of the answer or a tool call. The chunks of such a turn (the run's start, the reasoning,
 * its end) are held back and dropped; the turn that answers streams as it comes. A turn with
 * neither reasoning nor an answer is the model stopping, as it was (the run ends on it). An
 * error chunk is an answer: it is passed on, never retried here (the SDKs retry the transport
 * themselves). A run's events say nothing of it; stderr gets one `[model turn]` line. */
export const askAgainTimes = 2;
/** The turn asked again carries
 * one more user message, so the model sees that its last turn was empty and what is wanted. */
export const askAgainNudge =
  "Your last turn had no words and no tool call. Go on now with a tool call: the next step of your work, or wait_until if nothing is left for this run.";
type WithMessages = { messages?: unknown[] };
/** `options` with the nudge appended as a user message (for the turn asked again). */
export function nudged(options: unknown): unknown {
  const o = (options ?? {}) as WithMessages;
  const messages = Array.isArray(o.messages) ? o.messages : [];
  return { ...o, messages: [...messages, { role: "user", content: askAgainNudge }] };
}

type Chunk = { type: string; delta?: unknown };
// `never` as the parameter: an adapter's own, narrower options type is assignable to it.
type Streaming = { chatStream: (options: never) => AsyncIterable<unknown> };

/** Whether `chunk` makes the turn an answer: words for the person, a tool call, or an error. */
export function answers(chunk: Chunk): boolean {
  switch (chunk.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return typeof chunk.delta === "string" && chunk.delta.length > 0;
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.RUN_ERROR:
      return true;
    default:
      return false;
  }
}

/** Whether `chunk` is the model's reasoning (the AG-UI reasoning or thinking events). */
export function thinks(chunk: Chunk): boolean {
  return chunk.type.startsWith("REASONING") || chunk.type.startsWith("THINKING");
}

/** `inner.chatStream` asked again on a thought-only turn; every other member as it is. */
export function askAgain<T extends Streaming>(
  inner: T,
  times = askAgainTimes,
  say: (line: string) => void = (line) => console.error(line),
): T {
  const stream = async function* (options: unknown) {
    for (let attempt = 0; ; attempt++) {
      const held: unknown[] = [];
      let answered = false;
      let thought = false;
      const asked = attempt === 0 ? options : nudged(options);
      for await (const chunk of inner.chatStream(asked as never)) {
        if (answered) {
          yield chunk;
          continue;
        }
        if (answers(chunk as Chunk)) {
          answered = true;
          yield* held;
          held.length = 0;
          yield chunk;
          continue;
        }
        if (thinks(chunk as Chunk)) thought = true;
        held.push(chunk);
      }
      if (answered || !thought || attempt >= times) {
        yield* held;
        return;
      }
      say(
        `[model turn] thought only: no words, no tool call; asked again (${attempt + 1} of ${times})`,
      );
    }
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "chatStream") return stream;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
