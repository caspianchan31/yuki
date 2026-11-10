// v1.7.2 对话快: this device's copy of a conversation's last messages, drawn at once when the
// conversation opens while the server's own copy is on its way (as the chat apps that open at
// once do: draw the local copy, then let the server's take over). The server replays a
// conversation event by event, which would double a list that already holds messages, so the
// copy is never put into the agent: it is what the screen shows until the replay has caught up,
// then the agent's list is shown and the copy is written again.
//
// Kept with the other last-seen entries (last-seen.ts): this device only, per space and project,
// seven days, cleared at sign-out; the few conversations opened last.

import { type LastSeenStorage, readLastSeen, removeLastSeen, writeLastSeen } from "./last-seen";

/** How many conversations keep a copy on a device (per space and project). */
export const threadCopiesKept = 6;
/** The newest messages of a conversation that are kept. */
export const threadCopyMessages = 120;

const nameOf = (threadId: string) => `thread:${threadId}`;
const indexName = "threads";

export interface CopiedMessage {
  id: string;
  role: string;
}

/** The copy of this conversation, or nothing. */
export function readThreadCopy<M extends CopiedMessage>(
  storage: LastSeenStorage | null,
  scope: string,
  threadId: string,
  now = Date.now(),
): M[] | undefined {
  const copy = readLastSeen<M[]>(storage, scope, nameOf(threadId), now);
  if (!Array.isArray(copy) || !copy.length) return undefined;
  // Anything that is not a list of messages (an older shape) counts as nothing.
  if (!copy.every((m) => m && typeof m.id === "string" && typeof m.role === "string"))
    return undefined;
  return copy;
}

/** Keeps the conversation's newest messages; the conversations opened least recently lose theirs. */
export function writeThreadCopy(
  storage: LastSeenStorage | null,
  scope: string,
  threadId: string,
  messages: CopiedMessage[],
  now = Date.now(),
) {
  if (!storage || !messages.length) return;
  writeLastSeen(storage, scope, nameOf(threadId), messages.slice(-threadCopyMessages), now);
  const known = readLastSeen<string[]>(storage, scope, indexName, now);
  const order = [threadId, ...(Array.isArray(known) ? known : []).filter((id) => id !== threadId)];
  for (const dropped of order.slice(threadCopiesKept))
    removeLastSeen(storage, scope, nameOf(dropped));
  writeLastSeen(storage, scope, indexName, order.slice(0, threadCopiesKept), now);
}

/** The conversation is gone or not this person's: its copy goes too. */
export function dropThreadCopy(storage: LastSeenStorage | null, scope: string, threadId: string) {
  removeLastSeen(storage, scope, nameOf(threadId));
}

/**
 * Whether the screen may leave the copy for the server's list: once the conversation has
 * finished loading, or as soon as the replay has reached the copy's last message (a reply still
 * running keeps the load open for as long as it runs; its words must show as they come).
 */
export function replayCaughtUp(
  copy: CopiedMessage[] | undefined,
  live: CopiedMessage[],
  syncing: boolean,
  loaded: boolean,
): boolean {
  if (!copy?.length) return true;
  if (loaded && !syncing) return true;
  const last = copy[copy.length - 1]?.id;
  return live.some((message) => message.id === last);
}
