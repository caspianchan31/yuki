import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";

/** Default for AGENT_KEEP_SCREENSHOTS: the screenshots the model still sees in one run. v1.7.5: one
 * (it was four). Every model call sends again each picture kept, and on a slow way to the model
 * service four pictures made each desktop step wait up to a minute. */
export const defaultKeepScreenshots = 1;
/** What an older screenshot turns into, so the step and its text result stay visible. */
export const omittedScreenshot = "[earlier screenshot omitted]";

/**
 * Fork: every use_desktop action returns a JPEG screenshot as an image part of its tool
 * result, and a model run keeps all of them, so the context grows by one image per step.
 * This keeps the `keep` most recent image parts of tool results (since v1.7.5 only those: a
 * picture the person sent is not a screenshot) and replaces each older one with a text part.
 * Text, tool calls, tool-call arguments and reasoning are never touched. Pure: the input is
 * not modified; unchanged messages keep their identity, and with nothing to drop the input
 * array itself is returned.
 */
export function pruneScreenshots(messages: ModelMessage[], keep: number): ModelMessage[] {
  let seen = 0;
  let result: ModelMessage[] | undefined;
  // Newest first, so the most recent images are the ones counted against `keep`.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as ModelMessage;
    const content = message.content;
    // v1.7.5: only tool results' pictures (screenshots, a click's picture) count and go. The
    // person's own pictures are not screenshots: they keep their own cap (keepAttachedImages).
    if (message.role !== "tool" || !Array.isArray(content)) continue;
    let parts: ContentPart[] | undefined;
    for (let at = content.length - 1; at >= 0; at--) {
      if ((content[at] as ContentPart).type !== "image") continue;
      if (++seen <= keep) continue;
      parts ??= [...content];
      parts[at] = { type: "text", content: omittedScreenshot };
    }
    if (!parts) continue;
    result ??= [...messages];
    result[index] = { ...message, content: parts };
  }
  return result ?? messages;
}

/**
 * Applies pruneScreenshots before every model call of a TanStack `chat()` run. It sets only
 * `providerMessages`, the context sent to the provider: the canonical history (`messages`)
 * that tool execution and the AG-UI events read keeps every result as it was. The engine
 * rebuilds the config from that history at the start of each iteration and runs `onConfig`
 * again, so the window moves forward one screenshot per step.
 */
export function pruneScreenshotsMiddleware(keep: number): ChatMiddleware {
  return {
    name: "prune-screenshots",
    onConfig: (_ctx, config) => {
      const current = config.providerMessages ?? config.messages;
      const pruned = pruneScreenshots(current, keep);
      return pruned === current ? undefined : { providerMessages: pruned };
    },
  };
}
