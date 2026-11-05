import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

/** The page reads
 * the model still sees in one run, newest first; an older one becomes a line naming the page. */
export const keepPageTexts = 2;
/** The tools whose results are a page's words (read_page_text on the desktop, read_web). */
export const pageTextTools: ReadonlySet<string> = new Set(["read_page_text", "read_web"]);
export const omittedPageText = (address: string | null) =>
  `[earlier page read omitted${address ? `: ${address}` : ""}; read the page again if you need its words or links]`;

/** The address a page read's result names (its `url`), when it is JSON that carries one. */
function addressOf(content: unknown): string | null {
  if (typeof content !== "string") return null;
  try {
    const value = JSON.parse(content) as { url?: unknown };
    return typeof value?.url === "string" ? value.url.slice(0, 300) : null;
  } catch {
    const found = content.match(/https?:\/\/[^\s"'<>]+/);
    return found ? found[0].slice(0, 300) : null;
  }
}

/**
 * Keeps the `keep` most recent results of page-reading tools (`pageTextTools`) and replaces each
 * older one, in the context sent to the provider, with `omittedPageText`. The tool call and its
 * result message stay (the provider needs every call answered); only the result's words go.
 * Pure: unchanged messages keep their identity, and with nothing to drop the input is returned.
 */
export function prunePageTexts(messages: ModelMessage[], keep: number): ModelMessage[] {
  const names = new Map<string, string>();
  for (const message of messages)
    for (const call of message.toolCalls ?? []) names.set(call.id, call.function.name);
  let seen = 0;
  let result: ModelMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as ModelMessage;
    if (message.role !== "tool" || !message.toolCallId) continue;
    if (!pageTextTools.has(names.get(message.toolCallId) ?? "")) continue;
    if (++seen <= keep) continue;
    const content = message.content;
    if (typeof content === "string" && content.startsWith("[earlier page read omitted")) continue;
    result ??= [...messages];
    result[index] = { ...message, content: omittedPageText(addressOf(content)) };
  }
  return result ?? messages;
}

/** Applies prunePageTexts before every model call, on `providerMessages` only (as
 * pruneScreenshotsMiddleware): the run's own history keeps every result. */
export function prunePageTextsMiddleware(keep = keepPageTexts): ChatMiddleware {
  return {
    name: "prune-page-texts",
    onConfig: (_ctx, config) => {
      const current = config.providerMessages ?? config.messages;
      const pruned = prunePageTexts(current, keep);
      return pruned === current ? undefined : { providerMessages: pruned };
    },
  };
}
