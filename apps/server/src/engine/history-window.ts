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

/** `messages` within `budgetBytes`, cut at the start of a turn; the input itself when it fits.
 * (The system prompt travels apart from these, as `systemPrompts`.) */
export function windowHistory(messages: ModelMessage[], budgetBytes: number): ModelMessage[] {
  if (budgetBytes <= 0) return messages;
  let total = 0;
  for (const message of messages) total += size(message);
  if (total <= budgetBytes) return messages;
  // The newest user message and everything after it stay; before that, whole turns as they fit.
  let lastUser = messages.length - 1;
  while (lastUser > 0 && messages[lastUser]?.role !== "user") lastUser--;
  let left = budgetBytes;
  for (let index = messages.length - 1; index >= lastUser; index--)
    left -= size(messages[index] as ModelMessage);
  let cut = lastUser;
  for (let index = lastUser - 1; index >= 0; index--) {
    const message = messages[index] as ModelMessage;
    left -= size(message);
    if (left < 0) break;
    if (message.role === "user") cut = index;
  }
  if (cut === 0) return messages;
  const kept = messages.slice(cut);
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
