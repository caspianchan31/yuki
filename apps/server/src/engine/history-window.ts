/**
 * v1.7.2 提示只带近的: how much of a conversation goes to the model each turn. The whole thread
 * went (on 2026-11-09 one turn of a 78-message chat was a 146 KB request, and the model took
 * thirteen seconds to read it before its first word). The model now sees the system prompt (which
 * travels apart from the history), the newest turns up to a budget (MODEL_HISTORY_KB, default 32;
 * 0 for everything), and a line at the start of the oldest kept turn saying how much came before. The cut falls on a turn's start (a user message), so no tool call
 * is left without its result; the newest user message and what follows it always stay, whatever
 * the budget. The run's own record keeps every message (this changes `providerMessages` only).
 * The budget is in bytes of UTF-8, what goes on the wire (a Chinese character is three), and it
 * is a budget of words: a picture, sound, video or document part counts a small fixed cost
 * whatever its size, because its base64 is not text the model reads and one screenshot is several
 * times the whole budget (the screenshot pruning bounds how many of those travel).
 */
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

export const defaultHistoryKb = 32;

export function historyBudgetKb(env: NodeJS.ProcessEnv = process.env): number {
  const given = env.MODEL_HISTORY_KB?.trim();
  if (!given) return defaultHistoryKb;
  const value = Number(given);
  if (!Number.isInteger(value) || value < 0 || value > 4096)
    throw new Error("MODEL_HISTORY_KB must be a whole number from 0 (everything) to 4096");
  return value;
}

export const omittedTurns = (messages: number) =>
  `[${messages} earlier messages of this conversation are not shown; the member's memory and files keep what mattered from them. Ask the person if something from before is needed.]`;

/** What one picture, sound, video or document part counts against the budget. */
export const mediaPartBytes = 256;

const mediaKinds = new Set(["image", "audio", "video", "document", "binary", "file"]);

/** The message's bytes on the wire as UTF-8, each part that is not text at the fixed cost. */
function size(message: ModelMessage): number {
  const content: unknown = message.content;
  if (!Array.isArray(content)) return Buffer.byteLength(JSON.stringify(message), "utf8");
  // Only what is known to carry a file's bytes is counted flat; any other part (text, and
  // whatever kind a later version adds) is counted in full, so nothing slips under the budget.
  const words = content.filter(
    (part) => !mediaKinds.has(String((part as { type?: unknown } | null)?.type)),
  );
  return (
    Buffer.byteLength(JSON.stringify({ ...message, content: words }), "utf8") +
    (content.length - words.length) * mediaPartBytes
  );
}

/** `message` with `note` put before its words (a text part first when the content is parts). */
function noted(message: ModelMessage, note: string): ModelMessage {
  if (typeof message.content === "string")
    return { ...message, content: `${note}\n\n${message.content}` };
  if (Array.isArray(message.content))
    return {
      ...message,
      content: [
        { type: "text", content: note } as (typeof message.content)[number],
        ...message.content,
      ],
    };
  return { ...message, content: note };
}

/**
 * v1.7.4 不断片: an older message longer than this goes to the model as its start only. On
 * 2026-11-10 one long tool result in the turn before pushed the whole conversation out of the
 * window (707 messages became the newest one alone) and the member went on with no idea what had
 * been done. The current turn is never shortened: the model is working on it.
 */
export const olderMessageBytes = 6 * 1024;
/** How much of a shortened text stays (characters). */
const keptStart = 1500;

function shortened(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= olderMessageBytes) return text;
  const head = text.slice(0, keptStart);
  const rest = Math.max(1, Math.round((bytes - Buffer.byteLength(head, "utf8")) / 1024));
  return `${head}\n…[the rest of this, about ${rest} KB, is not shown]`;
}

/** An older message within olderMessageBytes: its texts cut to their start, and arguments of a
 * tool call too long to show replaced by a note (still JSON, as the provider expects). */
function capped(message: ModelMessage): ModelMessage {
  if (size(message) <= olderMessageBytes) return message;
  let next: ModelMessage = message;
  if (typeof message.content === "string") next = { ...next, content: shortened(message.content) };
  else if (Array.isArray(message.content))
    next = {
      ...next,
      content: message.content.map((part) => {
        const text = part as { type?: unknown; content?: unknown };
        return text?.type === "text" && typeof text.content === "string"
          ? ({ ...text, content: shortened(text.content) } as typeof part)
          : part;
      }) as typeof message.content,
    };
  const calls = (message as { toolCalls?: { function?: { arguments?: unknown } }[] }).toolCalls;
  if (Array.isArray(calls))
    next = {
      ...next,
      toolCalls: calls.map((call) => {
        const args = call?.function?.arguments;
        if (typeof args !== "string" || Buffer.byteLength(args, "utf8") <= olderMessageBytes)
          return call;
        const kb = Math.round(Buffer.byteLength(args, "utf8") / 1024);
        return {
          ...call,
          function: { ...call.function, arguments: JSON.stringify({ notShown: `${kb} KB` }) },
        };
      }),
    } as ModelMessage;
  return next;
}

/** A turn's final words: its last assistant message with text and no tool call. */
function finalAnswer(messages: ModelMessage[], from: number, to: number): number {
  for (let index = to - 1; index > from; index--) {
    const message = messages[index] as ModelMessage & { toolCalls?: unknown[] };
    const words = typeof message.content === "string" ? message.content.trim() : "";
    if (message.role === "assistant" && words && !message.toolCalls?.length) return index;
  }
  return -1;
}

export const stepsNotShown =
  "[Of the turn below only what was asked and the final answer are shown; its steps are not.]";

/** `messages` within `budgetBytes`, cut at the start of a turn; the input itself when it fits.
 * (The system prompt travels apart from these, as `systemPrompts`.) */
export function windowHistory(messages: ModelMessage[], budgetBytes: number): ModelMessage[] {
  if (budgetBytes <= 0) return messages;
  let total = 0;
  for (const message of messages) total += size(message);
  if (total <= budgetBytes) return messages;
  // The newest user message and everything after it stay as they are; before that, each message
  // within olderMessageBytes, then whole turns as they fit.
  let lastUser = messages.length - 1;
  while (lastUser > 0 && messages[lastUser]?.role !== "user") lastUser--;
  const work = [...messages.slice(0, lastUser).map(capped), ...messages.slice(lastUser)];
  total = 0;
  for (const message of work) total += size(message);
  if (total <= budgetBytes) return work;
  let left = budgetBytes;
  for (let index = work.length - 1; index >= lastUser; index--)
    left -= size(work[index] as ModelMessage);
  let cut = lastUser;
  for (let index = lastUser - 1; index >= 0; index--) {
    const message = work[index] as ModelMessage;
    left -= size(message);
    if (left < 0) break;
    if (message.role === "user") cut = index;
  }
  if (cut === 0) return work;
  if (cut === lastUser && lastUser > 0) {
    // Not even the turn before fits: still what was asked in it and how it ended, so the
    // conversation does not start over.
    let previous = lastUser - 1;
    while (previous > 0 && work[previous]?.role !== "user") previous--;
    if (work[previous]?.role === "user") {
      const answer = finalAnswer(work, previous, lastUser);
      const asked = work[previous] as ModelMessage;
      const note = previous > 0 ? `${omittedTurns(previous)} ${stepsNotShown}` : stepsNotShown;
      return [
        noted(asked, note),
        ...(answer > 0 ? [work[answer] as ModelMessage] : []),
        ...work.slice(lastUser),
      ];
    }
  }
  const kept = work.slice(cut);
  return [noted(kept[0] as ModelMessage, omittedTurns(cut)), ...kept.slice(1)];
}

export function historyWindowMiddleware(budgetKb = historyBudgetKb()): ChatMiddleware {
  return {
    name: "history-window",
    onConfig: (_ctx, config) => {
      const current = config.providerMessages ?? config.messages;
      const windowed = windowHistory(current, budgetKb * 1024);
      // One line a model call: what the window was given and what it let through (no content).
      const kinds = new Map<string, number>();
      for (const message of windowed) {
        const content: unknown = message.content;
        const key = Array.isArray(content)
          ? `${message.role}[${content.map((part) => String((part as { type?: unknown } | null)?.type)).join("+")}]`
          : `${message.role}:${typeof content}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      console.log(
        `[history window] ${current.length} → ${windowed.length} msgs, ${Math.round(windowed.reduce((sum, message) => sum + size(message), 0) / 1024)} of ${budgetKb} KB; ${[...kinds].map(([key, count]) => `${key}×${count}`).join(" ")}`,
      );
      return windowed === current ? undefined : { providerMessages: windowed };
    },
  };
}
