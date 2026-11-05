// On that
// route a screenshot goes to the model as what the API takes images in: a user message with
// image parts, placed after the tool results of the step (the API wants every tool result of
// an assistant turn before anything else). The tool result keeps its text and says the
// screenshot follows. The Anthropic adapter sends image parts inside tool_result itself, so
// this is for the OpenAI-compatible routes only. Pure; with no image in any tool result the
// input array is returned.
import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";

/** What the tool result says in place of the image it carried. */
export const screenshotFollows = "[the screenshot of this step follows as the next message]";
/** The words before the images in the message that carries them. */
export const screenshotsNote =
  "The screenshot(s) returned by the tool call(s) just above, in order. Look at them before deciding the next step.";

export function toolImagesAsUserMessages(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let changed = false;
  let pending: ContentPart[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: "user",
      content: [{ type: "text", content: screenshotsNote }, ...pending],
    } as ModelMessage);
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      const parts = message.content as ContentPart[];
      const images = parts.filter((part) => part.type === "image");
      if (images.length) {
        changed = true;
        const text = parts
          .flatMap((part) => (part.type === "text" ? [part.content] : []))
          .join("\n");
        out.push({
          ...message,
          content: text ? `${text}\n${screenshotFollows}` : screenshotFollows,
        });
        pending.push(...images);
        continue;
      }
    }
    if (message.role !== "tool") flush();
    out.push(message);
  }
  flush();
  return changed ? out : messages;
}

/** Applies toolImagesAsUserMessages to the context sent to the provider, after any earlier
 * middleware (the screenshot pruning) has had its say. */
export function toolImagesMiddleware(): ChatMiddleware {
  return {
    name: "tool-images",
    onConfig: (_ctx, config) => {
      const current = config.providerMessages ?? config.messages;
      const moved = toolImagesAsUserMessages(current);
      return moved === current ? undefined : { providerMessages: moved };
    },
  };
}
