import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import type { ChatMiddleware } from "@tanstack/ai";
import {
  chat,
  isContentPartArray,
  maxIterations,
  type SchemaInput,
  toolDefinition,
} from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiChatCompletions, openaiText } from "@tanstack/ai-openai";
import { map, mergeMap, type Observable } from "rxjs";
import { z } from "zod";
import { MODEL_MAX_RETRIES } from "../config.ts";
import { askAgain } from "./ask-again.ts";
import { historyWindowMiddleware } from "./history-window.ts";
import { thinkingFetch, thinkingSetting } from "./model-thinking.ts";
import type { ModelUsage } from "./model-usage.ts";
import { prunePageTextsMiddleware } from "./prune-page-texts.ts";
import { defaultKeepScreenshots, pruneScreenshotsMiddleware } from "./prune-screenshots.ts";
import { toolImagesMiddleware } from "./tool-images.ts";

/** Whether `spec` goes out over the Chat Completions wire
 * format (`openai/...` with OPENAI_CHAT_COMPLETIONS=true), which cannot carry images in a tool
 * result. */
export function chatCompletionsRoute(spec: string) {
  return /^openai[/:]/i.test(spec.trim()) && process.env.OPENAI_CHAT_COMPLETIONS === "true";
}
/** The adapter reads `reasoning_content` (or
 * `reasoning`) from each chunk's delta, as the package's own compatible adapter does, so the
 * reasoning becomes reasoning events. The adapter is the same object, with that one method. */
export function reasoningOf(chunk: unknown): { text: string } | undefined {
  const delta = (chunk as { choices?: { delta?: Record<string, unknown> }[] } | undefined)
    ?.choices?.[0]?.delta;
  const raw = delta?.reasoning_content ?? delta?.reasoning;
  return typeof raw === "string" && raw.length > 0 ? { text: raw } : undefined;
}
export function withReasoning<T extends object>(adapter: T): T {
  Object.defineProperty(adapter, "extractReasoning", {
    value: reasoningOf,
    configurable: true,
    writable: true,
  });
  return adapter;
}
/** When a call's own
 * arguments are not JSON, its end carries no input, so the chat runtime's own check answers the
 * model "Failed to parse tool arguments as JSON: …" as the tool result, as it answers arguments
 * that do not fit the schema, and the model calls again. The step limit bounds the retries. */
export function withStrictToolArgs<T extends object>(adapter: T): T {
  const stream = (adapter as { chatStream?: (...args: unknown[]) => AsyncIterable<unknown> })
    .chatStream;
  if (typeof stream !== "function") return adapter;
  const parses = (text: string) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  Object.defineProperty(adapter, "chatStream", {
    value: async function* (this: unknown, ...args: unknown[]) {
      const given = new Map<string, string>();
      for await (const chunk of stream.apply(this, args)) {
        const event = chunk as {
          type?: string;
          toolCallId?: string;
          delta?: unknown;
          args?: unknown;
          input?: unknown;
        };
        const id = event.toolCallId;
        if (event.type === EventType.TOOL_CALL_ARGS && id)
          given.set(
            id,
            typeof event.args === "string" && event.args !== ""
              ? event.args
              : (given.get(id) ?? "") + (typeof event.delta === "string" ? event.delta : ""),
          );
        else if (event.type === EventType.TOOL_CALL_END && id && event.input !== undefined) {
          const raw = given.get(id)?.trim();
          if (raw && !parses(raw)) {
            yield { ...event, input: undefined };
            continue;
          }
        }
        yield chunk;
      }
    },
    configurable: true,
    writable: true,
  });
  return adapter;
}
// v1.2: one usage entry, in AG-UI's spec counts or TanStack's own.
type UsageEntry = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedInputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  promptTokensDetails?: { cachedTokens?: unknown; cacheWriteTokens?: unknown } | null;
};
function finiteCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
// v1.2: the first count `values` names, or 0: a provider reports one spelling, not both.
function firstCount(...values: unknown[]) {
  for (const value of values) {
    const count = finiteCount(value);
    if (count !== undefined) return count;
  }
  return 0;
}
function usageOf(raw: unknown): ModelUsage {
  const entries = (Array.isArray(raw) ? raw : [raw]) as UsageEntry[];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const details = entry.promptTokensDetails;
    usage.input += firstCount(entry.inputTokens, entry.promptTokens);
    usage.output += firstCount(entry.outputTokens, entry.completionTokens);
    usage.cacheRead += firstCount(entry.cachedInputTokens, details?.cachedTokens);
    usage.cacheWrite += firstCount(entry.cacheWriteInputTokens, details?.cacheWriteTokens);
  }
  return usage;
}
// v1.2: the token usage the adapter reports at the end of a model turn (a RUN_FINISHED
// or RUN_ERROR chunk), handed to `onUsage` once per turn. `usage` is one object or an array of them
// (an array is summed). Every chunk passes through unchanged, and a listener that throws never
// breaks the stream.
export function withUsage<T extends object>(adapter: T, onUsage: (usage: ModelUsage) => void): T {
  const stream = (adapter as { chatStream?: (...args: unknown[]) => AsyncIterable<unknown> })
    .chatStream;
  if (typeof stream !== "function") return adapter;
  Object.defineProperty(adapter, "chatStream", {
    value: async function* (this: unknown, ...args: unknown[]) {
      for await (const chunk of stream.apply(this, args)) {
        const event = chunk as { type?: string; usage?: unknown };
        if (
          (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) &&
          event.usage !== undefined &&
          event.usage !== null
        ) {
          try {
            onUsage(usageOf(event.usage));
          } catch (error) {
            console.error(
              `[model usage] ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        yield chunk;
      }
    },
    configurable: true,
    writable: true,
  });
  return adapter;
}
// Same "provider/model" strings, env vars and base URL formats as the AI SDK resolver in
// @copilotkit/runtime. Each provider SDK retries transient failures up to MODEL_MAX_RETRIES times.
export function adapter(spec: string) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  switch (provider.toLowerCase()) {
    case "openai":
      // OpenAI-compatible endpoints that do not implement the Responses API
      // tool loop (e.g. DeepSeek) can opt into the Chat Completions wire format.
      if (process.env.OPENAI_CHAT_COMPLETIONS === "true")
        return withStrictToolArgs(
          withReasoning(
            openaiChatCompletions(id as OpenAIChatModel, {
              baseURL: process.env.OPENAI_BASE_URL,
              maxRetries: MODEL_MAX_RETRIES,
              // v1.7.2 回复先开口: no hidden thinking before the first word (MODEL_THINKING).
              fetch: thinkingFetch(thinkingSetting(), process.env.OPENAI_BASE_URL),
            }),
          ),
        );
      return withStrictToolArgs(
        openaiText(id as OpenAIChatModel, {
          baseURL: process.env.OPENAI_BASE_URL,
          maxRetries: MODEL_MAX_RETRIES,
        }),
      );
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "google":
    case "gemini":
    case "google-gemini":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(id as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          // @google/genai counts the first call in `attempts`.
          retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
        },
      });
    default:
      throw unknownProvider(provider, spec);
  }
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).${hint}`,
  );
}

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

/** A BuiltInAgent in TanStack factory mode with the options of the classic AI SDK mode. */
export function tanstackAgent(options: {
  model: string;
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
  /** Checked between model turns, after the current turn's tools have settled. */
  shouldContinue?: () => boolean;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
  /** Fork: screenshots (image parts) the model still sees; older ones become a text note.
   * AGENT_KEEP_SCREENSHOTS; default 4 (see prune-screenshots.ts). */
  keepScreenshots?: number;
  /** Middleware of the caller's, after the fork's own (the hall's gate). */
  middleware?: ChatMiddleware[];
  // v1.2: the token usage of each model turn of a run, with the model it was on.
  onUsage?: (usage: ModelUsage & { model: string }) => void;
}) {
  const agent = new BuiltInAgent({
    type: "tanstack",
    factory: ({ input, abortController }) => {
      const converted = convertInputToTanStackAI(input);
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = options.prompt;
      if (input.context.length) {
        system += "\n## Context from the application\n";
        for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
      }
      if (
        input.state !== undefined &&
        input.state !== null &&
        !(typeof input.state === "object" && Object.keys(input.state).length === 0)
      )
        system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\`\n`;
      // v1.7.2: where the system prompt's bytes are (the engine's own words, the context the
      // app sends, the state), once per run, beside the model-call line.
      console.info(
        `[model prompt] base ${Math.round((options.prompt?.length ?? 0) / 1024)} KB, context ${input.context.length} items ${Math.round(input.context.reduce((n, ctx) => n + ctx.value.length + ctx.description.length, 0) / 1024)} KB, state ${Math.round((system.length - (options.prompt?.length ?? 0)) / 1024)} KB in all beyond the base`,
      );
      // v1.2: the adapter reports each model turn's token counts to the caller.
      const onUsage = options.onUsage;
      const modelAdapter = adapter(options.model);
      if (onUsage) withUsage(modelAdapter, (usage) => onUsage({ ...usage, model: options.model }));
      return chat({
        // A turn with reasoning only is asked again.
        adapter: askAgain(modelAdapter),
        messages: converted.messages,
        systemPrompts: system ? [system] : [],
        tools: [
          ...converted.tools,
          ...[...options.tools, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args) => (tool.execute as (args: unknown) => Promise<unknown>)(args)),
          ),
        ],
        agentLoopStrategy: (state) =>
          maxIterations(options.maxSteps)(state) && (options.shouldContinue?.() ?? true),
        // Fork: without this every desktop step adds a screenshot to the context for the rest
        // of the run, which a high AGENT_MAX_STEPS turns into a context-window overflow.
        middleware: [
          pruneScreenshotsMiddleware(options.keepScreenshots ?? defaultKeepScreenshots),
          // Older page reads leave the context.
          prunePageTextsMiddleware(),
          // v1.7.2 提示只带近的: the newest turns up to a budget (MODEL_HISTORY_KB).
          historyWindowMiddleware(),
          // On the Chat Completions route (OPENAI_CHAT_COMPLETIONS,
          // production's) a tool result's screenshot reaches the model only as a user message
          // with image parts; the Responses, Anthropic and Gemini adapters carry it themselves.
          ...(chatCompletionsRoute(options.model) ? [toolImagesMiddleware()] : []),
          ...(options.middleware ?? []),
        ],
        abortController,
        debug: modelTurnLogger(),
      });
    },
  });
  const run = agent.run.bind(agent);
  agent.run = (input: RunAgentInput) => {
    const events = splitTextAtToolCalls(run(input)).pipe(map(textOnlyToolResult));
    return options.stepLimitNote
      ? reportStepLimit(events, options.maxSteps, options.stepLimitNote)
      : events;
  };
  return agent;
}

/** The adapter's provider
 * log, kept to the one line per model turn that carries the finish reason (`finish_reason=stop`,
 * `length`, `content_filter`...) and whether that chunk had words or tool calls, on stderr as
 * `[model turn]`; the chunks between are dropped. Errors are logged as before. */
export function modelTurnLogger() {
  const turn = (message: string) => {
    if (/finish_reason=(?!none\b)/.test(message)) console.error(`[model turn] ${message}`);
  };
  return {
    logger: {
      debug: turn,
      info: () => {},
      warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? ""),
      error: (message: string, meta?: Record<string, unknown>) =>
        console.error(message, meta ?? ""),
    },
    provider: true,
    errors: true,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    request: false,
    sandbox: false,
  };
}

/**
 * A tool can return TanStack content parts, e.g. text plus a screenshot. Inside the run
 * the adapters send them to the model as multimodal tool results. The AG-UI result event
 * would carry the same parts JSON-encoded, image data included, into the stored thread,
 * and later turns replay that history as plain text. Keep only the text parts there.
 */
export function textOnlyToolResult(event: BaseEvent): BaseEvent {
  if (event.type !== EventType.TOOL_CALL_RESULT) return event;
  const content = (event as { content?: unknown }).content;
  if (typeof content !== "string" || !content.startsWith("[")) return event;
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return event;
  }
  if (!isContentPartArray(parts)) return event;
  const text = parts.flatMap((part) => (part.type === "text" ? [part.content] : []));
  return { ...event, content: text.join("\n") } as BaseEvent;
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// ponytail: the TanStack converter in @copilotkit/runtime 1.70.1 uses one message ID for the
// whole run. Remove this when it starts a new ID for each step, like the classic mode does.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
