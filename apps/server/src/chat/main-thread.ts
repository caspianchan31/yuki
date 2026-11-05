// Each project's main chat, and 开新主聊天.
//
// `conversation-settings/main` under the project owner holds the current main thread id and the
// ids of the main chats it replaced (`formerIds`). A replaced main chat stays in chat_threads,
// archived, so it can be found under 已归档; restored, it is an ordinary side chat. Reports of a
// task delegated from a former main chat go to the current one (chat-reports.ts threadOf).
import { randomUUID } from "node:crypto";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { chatDatabase, storableText, storeQuery } from "./chat-store.ts";

const kind = "conversation-settings";

export interface MainRecord {
  id: "main";
  threadId: string;
  /** Upstream field, kept: the main thread record exists. */
  existing?: boolean;
  /** Main chats this one replaced, oldest first. */
  formerIds?: string[];
  /** When 开新主聊天 last replaced it (ISO). */
  switchedAt?: string;
  /** Who did (a member's user id once spaces have members; null before). */
  switchedBy?: string | null;
}

/** The agent every OpenMuse conversation runs (the runtime's only agent). */
export const chatAgentId = "default";

/** The 409 for 开新主聊天 while the current main chat is replying. */
export const mainThreadBusyMessage = "主聊天正在回话，说完再开新的";

/** The project's main chat record, created with a new id on first use. */
export async function mainRecord(db: Store, owner: string): Promise<MainRecord> {
  await db.insertIfAbsent<MainRecord>(owner, kind, {
    id: "main",
    threadId: randomUUID(),
    existing: false,
  });
  const main = await db.get<MainRecord>(owner, kind, "main");
  if (!main?.threadId) throw new AppError("Main conversation could not be loaded", 503);
  return main;
}

/** The project's main conversation thread id, created on first use (GET /api/main-thread). */
export async function mainThreadId(db: Store, owner: string): Promise<string> {
  return (await mainRecord(db, owner)).threadId;
}

/** The current main thread id without creating one (null before the project's first chat). */
export async function currentMainThreadId(db: Store, owner: string): Promise<string | null> {
  return (await db.get<MainRecord>(owner, kind, "main"))?.threadId ?? null;
}

/**
 * 开新主聊天: archives the current main chat (named `formerName` when it has no name) and makes a
 * new empty thread the main chat, in one transaction. `replacing` is the main chat the caller is
 * looking at: when another request replaced it first, the current main chat is returned and
 * nothing else changes (two clicks at once switch once). While the main chat is replying: 409.
 */
export async function startNewMain(
  db: Store,
  owner: string,
  input: { replacing: string; formerName: string; by?: string | null },
): Promise<{ threadId: string; formerThreadId: string | null }> {
  await mainRecord(db, owner);
  return chatDatabase(db).transaction(async (sql) => {
    const via = storeQuery(sql);
    const main = await db.lockRecord<MainRecord>(owner, kind, "main", via);
    if (!main?.threadId) throw new AppError("Main conversation could not be loaded", 503);
    if (main.threadId !== input.replacing) return { threadId: main.threadId, formerThreadId: null };
    const old = main.threadId;
    const held = await sql<{ owner: string; run_id: string | null }>(
      "/* chat:main-lock */ SELECT owner, run_id FROM chat_threads WHERE id=$1 FOR UPDATE",
      [old],
    );
    if (held[0] && held[0].owner !== owner)
      throw new AppError("Main conversation could not be loaded", 503);
    if (held[0]?.run_id) throw new AppError(mainThreadBusyMessage, 409);
    await sql(
      `/* chat:main-archive */ UPDATE chat_threads SET archived=true,
        name=coalesce(name, $3::text), updated_at=now()
      WHERE id=$1 AND owner=$2`,
      [old, owner, storableText(input.formerName)],
    );
    const threadId = randomUUID();
    await sql(
      "/* chat:main-new */ INSERT INTO chat_threads(id, owner, agent_id) VALUES($1, $2, $3)",
      [threadId, owner, chatAgentId],
    );
    const swapped = await db.compareAndSwap<MainRecord>(
      owner,
      kind,
      "main",
      { threadId: old },
      {
        threadId,
        formerIds: [...(main.formerIds ?? []), old],
        switchedAt: new Date().toISOString(),
        switchedBy: input.by ?? null,
      },
      via,
    );
    if (!swapped) throw new AppError("Main conversation could not be loaded", 503);
    return { threadId, formerThreadId: old };
  });
}
