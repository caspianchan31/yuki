/**
 * v1.6 聊天基础动作: the stretches of a conversation the person went back on (a message edited
 * and sent again, a reply asked for again). The server keeps them (GET …/superseded) and the
 * chat shows each folded where it stood: before the first message of the run that took its
 * place, or at the end while that run has not begun. Pure, shared with the phone.
 */
import type { TurnTime } from "./turn-time";

export type FeedbackVerdict = "up" | "down";

/** A message of a superseded stretch, as the thread view gives it. */
export interface SupersededMessage {
  id: string;
  role: string;
  content?: unknown;
}

export interface SupersededSegment {
  /** The live run the fold stands before; null while it has not begun or is gone. */
  anchor: string | null;
  /** ISO 8601: when the person went back on it. */
  at: string;
  messages: SupersededMessage[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** GET …/superseded, read defensively. */
export function normalizeSegments(payload: unknown): SupersededSegment[] {
  const list = record(payload).segments;
  return (Array.isArray(list) ? list : []).flatMap((raw): SupersededSegment[] => {
    const item = record(raw);
    const at = typeof item.at === "string" ? item.at : "";
    const messages = (Array.isArray(item.messages) ? item.messages : []).flatMap(
      (entry): SupersededMessage[] => {
        const message = record(entry);
        return typeof message.id === "string" && typeof message.role === "string"
          ? [{ id: message.id, role: message.role, content: message.content }]
          : [];
      },
    );
    return [{ anchor: typeof item.anchor === "string" ? item.anchor : null, at, messages }];
  });
}

/** GET …/feedback, read defensively. */
export function normalizeFeedback(payload: unknown): Record<string, FeedbackVerdict> {
  const given = record(record(payload).feedback);
  const out: Record<string, FeedbackVerdict> = {};
  for (const [id, verdict] of Object.entries(given))
    if (verdict === "up" || verdict === "down") out[id] = verdict;
  return out;
}

export interface SupersededPlacement {
  /** Folds by the id of the visible message each stands before. */
  before: Map<string, SupersededSegment[]>;
  /** Folds whose place has not begun yet (shown after everything). */
  atEnd: SupersededSegment[];
}

/**
 * Where each fold goes among the visible messages (`visible`: the messages the transcript
 * draws, in order). A stretch keeps only what the person reads (their messages and the replies
 * with words; not a reply that only called a tool); a message that is visible again (the person's
 * message, sent again as it was when a reply is asked for again) is not repeated in the fold.
 * The fold stands before the first visible message of its anchor run that the stretch did not
 * hold itself (after the re-sent question, before the new answer); while that run has only
 * begun, right after the last of its messages shown; a stretch with nothing left to show is
 * dropped.
 */
export function supersededPlacement(
  segments: readonly SupersededSegment[],
  turns: readonly TurnTime[] | null,
  visible: readonly { id: string }[],
): SupersededPlacement {
  const shown = new Map(visible.map((message, index) => [message.id, index]));
  const before = new Map<string, SupersededSegment[]>();
  const atEnd: SupersededSegment[] = [];
  const place = (id: string | undefined, segment: SupersededSegment) => {
    if (!id) {
      atEnd.push(segment);
      return;
    }
    const list = before.get(id) ?? [];
    list.push(segment);
    before.set(id, list);
  };
  for (const segment of segments) {
    const held = new Set(segment.messages.map((message) => message.id));
    const messages = segment.messages.filter(
      (message) =>
        !shown.has(message.id) &&
        (message.role === "user" ||
          (message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.trim() !== "")),
    );
    if (!messages.length) continue;
    const kept = { ...segment, messages };
    const turn = segment.anchor
      ? turns?.find((candidate) => candidate.runId === segment.anchor)
      : undefined;
    if (!turn) {
      place(undefined, kept);
      continue;
    }
    const first = turn.messages.find((id) => shown.has(id) && !held.has(id));
    if (first) {
      place(first, kept);
      continue;
    }
    const last = [...turn.messages].reverse().find((id) => shown.has(id));
    const index = last === undefined ? undefined : shown.get(last);
    place(index === undefined ? undefined : visible[index + 1]?.id, kept);
  }
  return { before, atEnd };
}
