// Two model slips seen in testing (a model on an OpenAI-compatible route):
// - The model ended a turn with its own native tool-call markup as the reply's words
//   (`<seed:tool_call><function name="app_fakenotes__create_note">…`). The provider had not made a
//   call of it, so the chat showed the markup and nothing ran: no card, no note.
// - The model answered 「已发起…正在等待你的审核」 in a reply that called no tool: no card was waiting.
// Both are caught here, one model turn at a time, around the adapter (as ask-again.ts is):
// - Markup is held back as it streams (the words before it go out as they come) and is never shown.
//   A turn that has it and no real call is asked once more, with a note that the call was written as
//   text; a second slip ends the turn with plain words that it was not done. Markup is never made
//   into a call: its arguments never passed the provider's own parsing, and the model never made
//   the call through the interface, so nothing shows it is the call the model meant to make.
// - A turn with no tool call, in a reply that has called none (the hall's routing aside), whose
//   words say something was started or waits for the person's review, is asked once more with a
//   note: its words were already shown, so the retry is to do what they said. The retry's words wait
//   for its call. With no call, words that still say so are dropped for one plain line that nothing
//   was started; other words (it spoke of something earlier) follow the first, and an empty answer
//   adds nothing. Chat replies only: a task run's words are its report, not the person's chat.
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { currentRulesTag } from "./current-rules.ts";
import { screenshotsNote } from "./tool-images.ts";

/** How tool-call markup starts in the text of the models a gateway serves, by the form each model
 * family writes it in: tags (`<seed:tool_call>`, `<tool_call>`, `<function=…>`), special tokens
 * (`<|tool_calls_section_begin|>`, `<｜tool▁calls▁begin｜>`, `<|python_tag|>`), `[TOOL_CALLS]`,
 * XML-style calls (`<function_calls>`, `<invoke name=…>`) and an older `✿FUNCTION✿`. */
export const toolMarkupOpeners = [
  "<seed:tool_call",
  "<function name=",
  "<function=",
  "<function_calls",
  "<tool_call",
  "<|tool_call",
  "<|tool_calls",
  "<｜tool▁call",
  "<invoke name=",
  "[TOOL_CALLS]",
  "<|python_tag|>",
  "✿FUNCTION✿",
] as const;
const openerFirsts = new Set(toolMarkupOpeners.map((opener) => opener[0]));

/** Whether the point after `before` (a reply's words) is inside code: an open ``` fence, or an odd
 * number of backticks on its line. Markup inside code is something the model shows, not a slip. */
export function insideCode(before: string): boolean {
  if ((before.split("```").length - 1) % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf("\n") + 1).replaceAll("```", "");
  return (line.split("`").length - 1) % 2 === 1;
}

/**
 * A turn's words as they stream, with tool-call markup held back: `push` answers the words that can
 * go out now. A possible start of markup (a `<` at the end of a chunk) waits for the next chunk; a
 * real start outside code holds everything from there to the end of the turn (`slipped`). `end`
 * lets out a start that never became markup.
 */
export class MarkupGate {
  slipped = false;
  private held = "";
  private passed = "";
  /** `before`: the turn's words already shown, for telling whether a point is inside code. */
  constructor(private readonly before = "") {}
  push(delta: string): string {
    if (this.slipped) {
      this.held += delta;
      return "";
    }
    const text = this.held + delta;
    this.held = "";
    for (let at = 0; at < text.length; at++) {
      if (!openerFirsts.has(text[at] as string)) continue;
      const rest = text.slice(at);
      const whole = toolMarkupOpeners.some((opener) => rest.startsWith(opener));
      if (!whole && !toolMarkupOpeners.some((opener) => opener.startsWith(rest))) continue;
      if (insideCode(this.before + this.passed + text.slice(0, at))) continue;
      this.held = rest;
      this.slipped = whole;
      return this.pass(text.slice(0, at));
    }
    return this.pass(text);
  }
  end(): string {
    if (this.slipped) return "";
    const rest = this.held;
    this.held = "";
    return this.pass(rest);
  }
  /** The markup held back, for the log. */
  get markup(): string {
    return this.slipped ? this.held : "";
  }
  private pass(words: string) {
    this.passed += words;
    return words;
  }
}

/** The tool a piece of markup names, when it names one plainly. */
export function markupTool(markup: string): string | undefined {
  const found = markup.match(
    /<function(?:\s+name)?=\s*"?([\w.:-]+)|<invoke\s+name="([\w.:-]+)"|"name"\s*:\s*"([\w.:-]+)"|functions\.([\w-]+)|tool▁sep｜>([\w.:-]+)/,
  );
  return found?.slice(1).find(Boolean);
}

/** Words that say something was started, or is waiting for the person's review or approval now.
 * Not words about what would happen (「发起后需要等待你的审核」, "it will be awaiting your
 * approval"): a model asking first is no slip. */
export const claimPatterns: readonly RegExp[] = [
  /(?<![会要将后再得需])(?:等待|等着)(?:你|您)的?(?:审核|审批|批准|核准)/,
  /已(?:经)?(?:发起|提交)/,
  /(?<!(?:will|would|to) be |once |after |until )\b(?:awaiting|waiting for|pending)\s+(?:your\s+)?(?:review|approval)\b/i,
  /\bI(?:'ve| have)\s+(?:started|submitted|kicked off)\b/i,
];
export const claimsAction = (words: string) => claimPatterns.some((pattern) => pattern.test(words));

/** Tools whose call is no action: the hall's routing, which every hall reply makes first. */
export const defaultNotActions: ReadonlySet<string> = new Set(["route_request"]);

/** The note a turn is asked again with after it wrote a call as text. It describes the markup
 * without writing any, so the note does not show the model the form to repeat. */
export const markupNote = (tool?: string) =>
  `[A note from the app, not from the person] Your last turn wrote a tool call as text (its markup) instead of making the call${tool ? ` to ${tool}` : ""}, so nothing ran and the markup was not shown. Make the call now through the tool-calling interface, never as text. If you decided not to call it, say so in plain words.`;
/** The note a turn is asked again with after it said something was started with no call. */
export const claimNote =
  "[A note from the app, not from the person] Your last turn says something was started or is waiting for the person's review, but no tool was called in this reply, so nothing was started and no card is waiting. Your words above were already shown. If you meant to take that action, call its tool now and do not repeat your words. If your words asked the person first, explained how something works, or spoke of something done earlier, nothing is wrong: answer with nothing at all.";

/** What the person reads when the call was written as text twice. */
export const notDoneWords = {
  zh: "这一步没有做成：我没能正确发起这个操作，所以什么都没有执行。要我再试一次吗？",
  en: "That step was not done: I could not start it properly, so nothing ran. Shall I try again?",
} as const;
/** What the person reads after words that said something was started, twice, with no call. */
export const nothingStartedWords = {
  zh: "（说明：这次回复里我没有发起任何操作，也没有新的待你审核的卡片。）",
  en: "(Note: nothing was started in this reply, and no new card is waiting for your review.)",
} as const;

type Message = { role?: unknown; content?: unknown; toolCalls?: unknown };
const messagesOf = (options: unknown): Message[] => {
  const messages = (options as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? (messages as Message[]) : [];
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => {
            const { type, content: text } = (part ?? {}) as { type?: unknown; content?: unknown };
            return type === "text" && typeof text === "string" ? text : "";
          })
          .join("\n")
      : "";
/** A user message that only carries a step's screenshots (tool-images.ts), not the person's words. */
const carriesScreenshots = (message: Message) =>
  message.role === "user" &&
  Array.isArray(message.content) &&
  textOf(message.content).startsWith(screenshotsNote);
const isPersons = (message: Message) => message.role === "user" && !carriesScreenshots(message);

/** Whether the messages since the person's last words hold a call of a tool that is an action
 * (a reply tried again after a failure carries what it did so far, reply-retry.ts). */
export function actedSincePerson(messages: readonly Message[], notActions: ReadonlySet<string>) {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at] as Message;
    if (isPersons(message)) return false;
    if (
      message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.some((call) => {
        const name = (call as { function?: { name?: unknown } } | undefined)?.function?.name;
        return typeof name !== "string" || !notActions.has(name);
      })
    )
      return true;
  }
  return false;
}

const rulesBlock = new RegExp(`<${currentRulesTag}>[\\s\\S]*?</${currentRulesTag}>`, "g");
/** The language of the person's last words, for the lines this file writes: Chinese when they
 * have Chinese characters, English otherwise. The app's own notes in the message are left out. */
export function personLanguage(messages: readonly Message[]): "zh" | "en" {
  const said = [...messages].reverse().find(isPersons);
  return /\p{Script=Han}/u.test(textOf(said?.content).replace(rulesBlock, "")) ? "zh" : "en";
}

/** `options` for the turn asked again: the words already shown as the assistant's, then the note. */
export function retried(options: unknown, shown: string, note: string): unknown {
  const o = (options ?? {}) as { messages?: unknown };
  return {
    ...o,
    messages: [
      ...messagesOf(options),
      ...(shown.trim() ? [{ role: "assistant", content: shown }] : []),
      { role: "user", content: note },
    ],
  };
}

/** A retry's answer that adds nothing (the note allows an empty one; some models say "OK"). */
const addsNothing = (words: string) => /^\s*(?:ok(?:ay)?|好的?|嗯)?\s*[.。!！]?\s*$/i.test(words);

const joinAfter = (shown: string) =>
  !shown.trim() || shown.endsWith("\n\n") ? "" : shown.endsWith("\n") ? "\n" : "\n\n";

type Chunk = { type: string; [key: string]: unknown };
// `never` as the parameter: an adapter's own, narrower options type is assignable to it.
type Streaming = { chatStream: (options: never) => AsyncIterable<unknown> };

export interface SlipOptions {
  /** Ask again after words that say something was started with no call (chat replies). */
  claims?: boolean;
  /** Tools whose call is no action. */
  notActions?: ReadonlySet<string>;
  say?: (line: string) => void;
}

/**
 * `inner.chatStream` with both slips caught; every other member as it is. One wrapper serves one
 * run (tanstack-agent.ts makes the adapter per run), so it remembers whether an earlier turn of the
 * run called a tool. Each turn's text goes out as one message: one START, its words, one END just
 * before the turn's RUN_FINISHED; a retry's RUN_STARTED is dropped (the turn started once).
 */
export function catchToolSlips<T extends Streaming>(inner: T, options: SlipOptions = {}): T {
  const notActions = options.notActions ?? defaultNotActions;
  const say = options.say ?? ((line: string) => console.error(line));
  let acted = false;
  const stream = async function* (asked: unknown): AsyncGenerator<unknown> {
    const messages = messagesOf(asked);
    const actedBefore = acted || actedSincePerson(messages, notActions);
    const language = personLanguage(messages);
    let shown = "";
    let openId: string | undefined;
    let start: Chunk | undefined;
    let joinNext = false;
    function* words(text: string, like?: Chunk): Generator<Chunk> {
      if (!text) return;
      if (joinNext) {
        text = joinAfter(shown) + text;
        joinNext = false;
      }
      if (!openId) {
        const id = start?.messageId ?? like?.messageId;
        openId = typeof id === "string" && id ? id : randomUUID();
        yield {
          role: "assistant",
          ...start,
          type: EventType.TEXT_MESSAGE_START,
          messageId: openId,
        };
      }
      shown += text;
      yield {
        ...like,
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: openId,
        delta: text,
        content: shown,
      };
    }
    function* close(): Generator<Chunk> {
      if (openId) yield { type: EventType.TEXT_MESSAGE_END, messageId: openId };
      openId = undefined;
    }
    let slip: { kind: "markup"; tool?: string } | { kind: "claim" } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = attempt > 0;
      const request =
        again && slip
          ? retried(asked, shown, slip.kind === "markup" ? markupNote(slip.tool) : claimNote)
          : asked;
      const gate = new MarkupGate(shown);
      let called = false;
      // A retry's words wait for its call, or for its end.
      let holding = again;
      let held = "";
      let said = "";
      let finish: Chunk | undefined;
      joinNext = again;
      for await (const raw of inner.chatStream(request as never)) {
        const chunk = raw as Chunk;
        switch (chunk.type) {
          case EventType.RUN_STARTED:
            if (!again) yield chunk;
            break;
          case EventType.TEXT_MESSAGE_START:
            start ??= chunk;
            break;
          case EventType.TEXT_MESSAGE_CONTENT: {
            const out = gate.push(typeof chunk.delta === "string" ? chunk.delta : "");
            said += out;
            if (holding) held += out;
            else yield* words(out, chunk);
            break;
          }
          case EventType.TEXT_MESSAGE_END:
            break;
          case EventType.TOOL_CALL_START: {
            called = true;
            const name = chunk.toolCallName ?? chunk.toolName;
            if (typeof name !== "string" || !notActions.has(name)) acted = true;
            if (holding) {
              holding = false;
              yield* words(held);
              held = "";
            }
            yield chunk;
            break;
          }
          case EventType.RUN_FINISHED:
            finish = chunk;
            break;
          case EventType.RUN_ERROR:
            // What a retry held is dropped: its words may be the slip again.
            if (!holding) yield* words(gate.end());
            yield* close();
            yield chunk;
            return;
          default:
            yield chunk;
        }
      }
      const rest = gate.end();
      said += rest;
      if (holding) held += rest;
      else yield* words(rest);
      if (!finish) {
        yield* close();
        return;
      }
      if (!called && gate.slipped) {
        const tool = markupTool(gate.markup);
        if (!again) {
          slip = { kind: "markup", tool };
          say(
            `[model turn] tool call written as text${tool ? ` (${tool})` : ""}: not shown; asked again`,
          );
          continue;
        }
        say(`[model turn] tool call written as text again: said it was not done`);
        joinNext = true;
        yield* words(notDoneWords[language]);
        yield* close();
        yield { ...finish, finishReason: "stop" };
        return;
      }
      if (!called && options.claims && !actedBefore && claimsAction(said)) {
        if (!again) {
          slip = { kind: "claim" };
          say("[model turn] said something was started with no tool called: asked again");
          continue;
        }
        say("[model turn] said something was started again with no tool called: said so");
        joinNext = true;
        yield* words(nothingStartedWords[language]);
        yield* close();
        yield finish;
        return;
      }
      if (called && gate.slipped) say("[model turn] tool-call markup beside a real call: left out");
      if (!addsNothing(held)) yield* words(held);
      yield* close();
      yield finish;
      return;
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
