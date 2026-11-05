/**
 * The pure model of the conversation switcher behind 「主聊天 ▾」
 * (the old ≡ sheet's conversation part, threads.tsx ThreadsSheet) and of the thread bar's label.
 * No react-native, so node:test can pin it.
 *
 * Side chats come from CopilotKit's useThreads (saved ones) and from ThreadsProvider's `visited`
 * (opened in this app, maybe not saved yet: a new side chat has no row until its first run is
 * persisted). The thread bar shows a side chat's name without its own useThreads subscription:
 * the switcher records the names it reads (rememberThreads) and the bar reads them back.
 */
import { isMemberConversationId } from "../chat/member-thread.ts";
import { t } from "../strings.ts";

export interface SavedThread {
  id: string;
  name: string | null;
  archived: boolean;
}

export interface ThreadRowModel {
  id: string;
  label: string;
  /** Saved on the server (rename / archive / restore apply); false = visited, not saved yet. */
  saved: boolean;
  archived: boolean;
  selected: boolean;
}

const named = (name: string | null | undefined) =>
  typeof name === "string" && name.trim() ? name.trim() : t.threads.untitled;

/**
 * The side chat rows: in the active view, the side chats opened here that are not saved yet
 * (「侧聊 n」) and then the saved ones that are not archived; in the archived view, only the saved
 * archived ones. The main chat is never a side chat, and neither is a member's own conversation.
 */
export function sideThreadRows(input: {
  visited: readonly { id: string }[];
  saved: readonly SavedThread[];
  mainId: string;
  selectedId: string;
  archived: boolean;
}): ThreadRowModel[] {
  const savedIds = new Set(input.saved.map((thread) => thread.id));
  const listed = (id: string) => id !== input.mainId && !isMemberConversationId(id);
  const unsaved = input.archived
    ? []
    : input.visited
        .filter((item) => listed(item.id) && !savedIds.has(item.id))
        .map(
          (item, index): ThreadRowModel => ({
            id: item.id,
            label: t.threads.sideNumbered(index + 1),
            saved: false,
            archived: false,
            selected: item.id === input.selectedId,
          }),
        );
  const saved = input.saved
    .filter((thread) => listed(thread.id) && thread.archived === input.archived)
    .map(
      (thread): ThreadRowModel => ({
        id: thread.id,
        label: named(thread.name),
        saved: true,
        archived: thread.archived,
        selected: thread.id === input.selectedId,
      }),
    );
  return [...unsaved, ...saved];
}

/**
 * The thread bar's label: 主聊天; a side chat's saved name (未命名对话 when it has none); 「侧聊 n」
 * for a side chat opened here and not saved yet (numbered like the switcher numbers it); 侧聊
 * when nothing else is known.
 */
export function threadBarLabel(input: {
  selectedId: string;
  mainId: string;
  visited: readonly { id: string }[];
  /** id → name of the saved threads known so far (null = saved without a name). */
  names: ReadonlyMap<string, string | null>;
}): string {
  const { selectedId, mainId, names } = input;
  if (selectedId === mainId) return t.threads.main;
  if (names.has(selectedId)) return named(names.get(selectedId));
  const unsaved = input.visited.filter((item) => item.id !== mainId && !names.has(item.id));
  const index = unsaved.findIndex((item) => item.id === selectedId);
  return index >= 0 ? t.threads.sideNumbered(index + 1) : t.threads.side;
}

// ───────────────────────────── names the switcher read ─────────────────────────────

const names = new Map<string, string | null>();
let snapshot: ReadonlyMap<string, string | null> = new Map();
const listeners = new Set<() => void>();

/** Records the saved threads' names (called by the switcher whenever its list changes). */
export function rememberThreads(threads: readonly Pick<SavedThread, "id" | "name">[]) {
  let changed = false;
  for (const thread of threads) {
    const name = thread.name ?? null;
    if (!names.has(thread.id) || names.get(thread.id) !== name) {
      names.set(thread.id, name);
      changed = true;
    }
  }
  if (!changed) return;
  snapshot = new Map(names);
  for (const listener of listeners) listener();
}
/** The names known so far; a new object after every change (useSyncExternalStore). */
export function threadNames(): ReadonlyMap<string, string | null> {
  return snapshot;
}
/** Forgets every name (sign-out: the next session may be another account's threads). */
export function forgetThreadNames() {
  if (!names.size) return;
  names.clear();
  snapshot = new Map();
  for (const listener of listeners) listener();
}
export function subscribeThreadNames(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
