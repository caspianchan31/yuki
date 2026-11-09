/**
 * v1.6 搜对话内容: a search hit as the web shows it in ⌘K's 对话 group. The server's
 * GET /api/copilotkit/threads/search?q= gives the hits (apps/server/src/chat/types.ts MessageHit);
 * this reads them leniently and names the conversation and the day.
 */
export interface MessageHit {
  threadId: string;
  threadName: string | null;
  archived: boolean;
  messageId: string;
  role: "user" | "assistant";
  /** ISO 8601: when the message's turn began. */
  at: string;
  snippet: { before: string; match: string; after: string };
}

/** The hits of a search response; anything malformed is left out. */
export function normalizeHits(payload: unknown): MessageHit[] {
  const list = (payload as { hits?: unknown })?.hits;
  if (!Array.isArray(list)) return [];
  const out: MessageHit[] = [];
  for (const item of list) {
    const loose = item as Partial<MessageHit> & { snippet?: Partial<MessageHit["snippet"]> };
    if (typeof loose?.threadId !== "string" || typeof loose.messageId !== "string") continue;
    out.push({
      threadId: loose.threadId,
      threadName: typeof loose.threadName === "string" ? loose.threadName : null,
      archived: loose.archived === true,
      messageId: loose.messageId,
      role: loose.role === "user" ? "user" : "assistant",
      at: typeof loose.at === "string" ? loose.at : "",
      snippet: {
        before: typeof loose.snippet?.before === "string" ? loose.snippet.before : "",
        match: typeof loose.snippet?.match === "string" ? loose.snippet.match : "",
        after: typeof loose.snippet?.after === "string" ? loose.snippet.after : "",
      },
    });
  }
  return out;
}

/** What the hit's conversation is called: its name, 主聊天 for the main chat, else 未命名对话; an
 * archived one says so. */
export function hitConversationLabel(
  hit: Pick<MessageHit, "threadId" | "threadName" | "archived">,
  words: { mainId: string; main: string; untitled: string; archived: string },
): string {
  const name = hit.threadName || (hit.threadId === words.mainId ? words.main : words.untitled);
  return hit.archived ? `${name}（${words.archived}）` : name;
}

/** The hit's day, short: 今天 / 昨天 / 11月8日 / 2025年11月8日 (another year). */
export function hitDayLabel(iso: string, now: Date | number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(at, today)) return "今天";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(at, yesterday)) return "昨天";
  const day = `${at.getMonth() + 1}月${at.getDate()}日`;
  return at.getFullYear() === today.getFullYear() ? day : `${at.getFullYear()}年${day}`;
}
