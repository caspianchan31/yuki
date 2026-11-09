// v1.6 回顾: a conversation played back step by step. The frames come from the thread's event
// log (chat_events, through messagesFromEvents): what the person said, what the member replied,
// and each step the member took on the computer, with the screenshot it kept (shotId, on disk
// since v1.6). A frame carries only what the player shows: tool results are not copied (a page's
// words or a file's contents stay in the conversation), apart from the picture's id and a
// browser page's title and address. The same frames serve the owner's player and a shared link.
import type { BaseEvent, Message } from "@ag-ui/core";
import { messageText } from "../../../../packages/domain/src/chat-attachments.ts";
import { messagesFromEvents } from "./events.ts";

interface ToolCallLike {
  id: string;
  function: { name: string; arguments: string };
}

export type ReplayFrame =
  | { kind: "person"; text: string }
  | { kind: "member"; text: string }
  | {
      kind: "step";
      tool: string;
      /** The arguments the step line is worded from (the safe ones, cut short). */
      args: Record<string, string | number>;
      failed: boolean;
      shotId?: string;
      /** A browser step's page, when the result named one. */
      page?: { url: string; title: string };
    };

/** The computer tools that are steps of a replay (the chat's folded 过程 lines, plus the
 * screenshot card); any other tool call is not played. */
const stepTools = new Set([
  "computer_status",
  "start_computer",
  "stop_computer",
  "run_computer_command",
  "list_computer_files",
  "read_computer_file",
  "write_computer_file",
  "mkdir_computer",
  "import_computer_pdf",
  "export_computer_pdf",
  "computer_browser",
  "computer_desktop",
  "computer_screenshot",
]);
/** Argument fields a step line may show; everything else stays out of the frame. */
const shownArgs = ["action", "url", "text", "path", "key", "n", "app", "command", "field"];
const maxArg = 200;

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function shownArgsOf(raw: unknown): Record<string, string | number> {
  const args = parseJson(raw) ?? {};
  const out: Record<string, string | number> = {};
  for (const key of shownArgs) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && value.trim())
      out[key] = value.length > maxArg ? `${value.slice(0, maxArg - 1)}…` : value;
  }
  return out;
}

function failed(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  if (typeof result.error === "string" || typeof result.failure === "string") return true;
  return (
    result.status === "failed" || result.status === "timed_out" || result.status === "interrupted"
  );
}

const shotIdPattern = /^[A-Za-z0-9_-]{16,32}$/;

/** The frames of a conversation, in order. */
export function replayFrames(events: BaseEvent[]): ReplayFrame[] {
  const messages = messagesFromEvents(events);
  const results = new Map<string, Record<string, unknown> | null>();
  for (const message of messages) {
    const loose = message as Message & { toolCallId?: string; content?: unknown };
    if (message.role === "tool" && typeof loose.toolCallId === "string")
      results.set(loose.toolCallId, parseJson(loose.content));
  }
  const frames: ReplayFrame[] = [];
  for (const message of messages) {
    const loose = message as Message & { content?: unknown; toolCalls?: ToolCallLike[] };
    if (message.role === "user") {
      const text = messageText(loose.content).trim();
      if (text) frames.push({ kind: "person", text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = typeof loose.content === "string" ? loose.content.trim() : "";
    if (text) frames.push({ kind: "member", text });
    for (const call of loose.toolCalls ?? []) {
      const tool = call.function.name;
      if (!stepTools.has(tool)) continue;
      const result = results.get(call.id) ?? null;
      const frame: ReplayFrame = {
        kind: "step",
        tool,
        args: shownArgsOf(call.function.arguments),
        failed: failed(result),
      };
      const shotId = result?.shotId;
      if (typeof shotId === "string" && shotIdPattern.test(shotId)) frame.shotId = shotId;
      if (tool === "computer_browser" && result) {
        const url = typeof result.url === "string" ? result.url : "";
        const title = typeof result.title === "string" ? result.title : "";
        if (url || title) frame.page = { url: url.slice(0, 500), title: title.slice(0, 200) };
      }
      frames.push(frame);
    }
  }
  return frames;
}

/** The pictures a replay shows (so a shared link serves those and no other). */
export function replayShotIds(frames: ReplayFrame[]): Set<string> {
  const ids = new Set<string>();
  for (const frame of frames) if (frame.kind === "step" && frame.shotId) ids.add(frame.shotId);
  return ids;
}
