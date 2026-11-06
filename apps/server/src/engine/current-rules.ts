import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";

/**
 * v1.5: this version's rules, said again right before the person's latest words on every model
 * call of a chat reply. A long conversation teaches the model how earlier replies did things, and
 * after an update those replies may come from an older version (one claimed a screenshot and
 * showed none); a rule only in the system prompt, far above them, loses to them. The reminder
 * rides on the provider's copy of the context (`providerMessages`, as prune-screenshots.ts does):
 * it is never stored or shown, and an update needs no new conversation. A release that changes how
 * something is done says so here, or in its environment's `rules()` (environment-tools).
 */

export const currentRulesTag = "current-rules";

/** Always said: earlier replies may come from an older version. */
export const olderRepliesRule =
  "Earlier replies in this conversation may come from an older version of you with other tools or rules: do things the way your tools and instructions say now, never copy how an earlier reply did it, and never claim an action you did not take in this reply.";

/** The rules as one note, tagged so the model reads them as the app's words, not the person's. */
export function rulesNote(rules: readonly string[]): string {
  const lines = rules.map((rule) => `- ${rule}`).join("\n");
  return `<${currentRulesTag}>\n${lines}\n</${currentRulesTag}>`;
}

const hasNote = (content: ModelMessage["content"]) => {
  const tag = `<${currentRulesTag}>`;
  if (typeof content === "string") return content.includes(tag);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = (part as { type: string; content?: unknown }).content;
    return part.type === "text" && typeof text === "string" && text.includes(tag);
  });
};

/**
 * The messages with the rules added to the latest user message. Pure: the input is not modified;
 * with no rules, no user message, or the note already there, the input array itself is returned.
 */
export function withCurrentRules(
  messages: ModelMessage[],
  rules: readonly string[],
): ModelMessage[] {
  if (!rules.length) return messages;
  let at = messages.length - 1;
  while (at >= 0 && messages[at]?.role !== "user") at--;
  if (at < 0) return messages;
  const message = messages[at] as ModelMessage;
  const content = message.content;
  if (hasNote(content)) return messages;
  const note = rulesNote(rules);
  const next: ModelMessage = Array.isArray(content)
    ? { ...message, content: [...content, { type: "text", content: note } as ContentPart] }
    : { ...message, content: content ? `${content}\n\n${note}` : note };
  const result = [...messages];
  result[at] = next;
  return result;
}

/** withCurrentRules before every model call of a TanStack `chat()` run; `rules` is read each time. */
export function currentRulesMiddleware(rules: () => readonly string[]): ChatMiddleware {
  return {
    name: "current-rules",
    onConfig: (_ctx, config) => {
      const current = config.providerMessages ?? config.messages;
      const next = withCurrentRules(current, rules());
      return next === current ? undefined : { providerMessages: next };
    },
  };
}
