// The one-time copy of the conversations kept in
// CopilotKit's cloud (Intelligence) to this server.
//
// Run by the API process (index.ts) in the background after it starts, while the config still
// has CPK_INTELLIGENCE_API_KEY and the copy is not complete; the chat works meanwhile. For every
// existing owner (each real owner and each project that is not being deleted) it lists the cloud
// threads (every page, archived ones too), adds the ids the server knows but the list lacks (the
// main chat and those it replaced, tasks' origin threads, reports' threads), and writes each one
// as a local thread with one finished import run: RUN_STARTED, MESSAGES_SNAPSHOT (every message in
// the cloud's order, ids unchanged) and RUN_FINISHED. Each thread is checked right after: the
// stored message ids must equal the cloud's, one by one, or it is not done. chat_migration keeps
// one row per thread (done, missing in the cloud, or failed with the reason); a thread that is
// done is skipped next time and the import run is inserted with ON CONFLICT DO NOTHING, so running
// it again changes nothing. Nothing in the cloud is changed or deleted. When every thread is done
// (or known missing in the cloud), `system/chat-migration/cloud` records it with the totals; from
// then on the key is never used.
import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { parseOwner, projectOwner } from "../../../../packages/domain/src/projects.ts";
import { firstSpaceKey } from "../auth.ts";
import type { Store } from "../db.ts";
import { type ChatStore, chatDatabase } from "./chat-store.ts";
import { chatAgentId } from "./main-thread.ts";

/** What the copy reads from CopilotKit's cloud (CopilotKitIntelligence implements it). */
export interface CloudThreadSource {
  listThreads(params: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    cursor?: string;
  }): Promise<{ threads: CloudThread[]; nextCursor?: string | null }>;
  getThread(params: { threadId: string; userId: string }): Promise<CloudThread>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: CloudMessage[] }>;
}

/** A cloud thread's metadata (the platform's ThreadSummary). */
export interface CloudThread {
  id: string;
  name: string | null;
  lastRunAt?: string;
  lastUpdatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  agentId?: string;
}

/** A cloud message (the platform's ThreadMessage: tool calls as `{ id, name, args }`). */
export interface CloudMessage {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
}

/** The cloud's user id for an owner, exactly as the runtime's identifyUser sent it before v0.5:
 * the cloud accepts `[\w.@:=-]` (at most 128 characters), so a project owner's `/` became `=`. */
export function intelligenceUserId(owner: string): string {
  const id = owner.replace(/[^\w.@:=-]/g, "=");
  if (!id || id.length > 128) throw new Error("Owner cannot be used as a cloud user id");
  return id;
}

/** The import run's id: one per thread, so a second import inserts nothing. */
export const cloudImportRunId = (threadId: string) => `cloud-import:${threadId}`;

const markerOwner = "system";
const markerKind = "chat-migration";
const markerId = "cloud";

/** `system/chat-migration/cloud`. `done` once every thread is copied (or known missing). */
export interface MigrationMarker {
  id: typeof markerId;
  status: "pending" | "done";
  /** Totals of the completed copy. */
  owners?: number;
  threads?: number;
  archived?: number;
  messages?: number;
  /** Threads this server knew of that the cloud did not have. */
  missing?: number;
  /** The last run's failure that kept it from completing (plain Chinese, no ids or keys). */
  reason?: string | null;
  at?: string;
}

/** The fact the owner sees while the copy is not complete (rendered from strings.ts). */
export type CloudThreadsFact =
  | { state: "failed"; pending: number; reason: string }
  | { state: "no-key" };

export type MigrationRowStatus = "done" | "missing" | "failed";

export interface MigrationSummary {
  complete: boolean;
  owners: number;
  threads: number;
  archived: number;
  messages: number;
  missing: number;
  failed: number;
  reason: string | null;
}

export async function readMarker(db: Store): Promise<MigrationMarker | null> {
  return db.get<MigrationMarker>(markerOwner, markerKind, markerId);
}

export async function migrationComplete(db: Store): Promise<boolean> {
  return (await readMarker(db))?.status === "done";
}

/**
 * Called at every start before anything is served: a database without any conversation record
 * has nothing in the cloud to copy (a new install, or one made after v0.5), so the copy is
 * recorded complete at once; otherwise it is pending until it runs. Idempotent.
 */
export async function initMigrationMarker(db: Store): Promise<void> {
  if (await readMarker(db)) return;
  const rows = await chatDatabase(db).sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM records WHERE kind='conversation-settings'",
  );
  const empty = (rows[0]?.n ?? 0) === 0;
  await db.insertIfAbsent<MigrationMarker>(markerOwner, markerKind, {
    id: markerId,
    ...(empty
      ? { status: "done", owners: 0, threads: 0, archived: 0, messages: 0, missing: 0 }
      : { status: "pending" }),
    at: new Date().toISOString(),
  });
}

/** Every owner whose conversations may be in the cloud: the first space (v0.5 spaces: its key is
 * the one owner there was before spaces, `local-user`) and each of its projects that is not being
 * deleted. Deleted projects' records are gone, so they are not here. Spaces made since never had
 * a conversation in the cloud, so their keys are never sent there. */
export async function migrationOwners(db: Store): Promise<string[]> {
  const sql = chatDatabase(db).sql;
  const rows = await sql<{ owner: string }>(
    "SELECT DISTINCT owner FROM records WHERE kind IN ('conversation-settings','projects') ORDER BY owner",
  );
  const owners = new Set<string>();
  for (const { owner } of rows) {
    const { real, projectId } = parseOwner(owner);
    if (owner.includes("#") || real !== firstSpaceKey) continue;
    if (projectId === null) owners.add(real);
  }
  for (const real of [...owners]) {
    const projects = await db.list<{ id: string; deleting?: boolean }>(real, "projects");
    for (const project of projects)
      if (!project.deleting) owners.add(projectOwner(real, project.id));
  }
  return [...owners].sort();
}

/** Thread ids the server knows for an owner: its main chat and those it replaced, the threads
 * its tasks were delegated from and the threads its reports went to. */
export async function knownThreadIds(db: Store, owner: string): Promise<string[]> {
  const ids = new Set<string>();
  const main = await db.get<{ threadId?: string; formerIds?: string[] }>(
    owner,
    "conversation-settings",
    "main",
  );
  if (main?.threadId) ids.add(main.threadId);
  for (const id of main?.formerIds ?? []) ids.add(id);
  const rows = await chatDatabase(db).sql<{ id: string | null }>(
    `SELECT DISTINCT data->>'originThreadId' AS id FROM records WHERE owner=$1 AND kind='tasks'
    UNION SELECT DISTINCT data->>'threadId' FROM records WHERE owner=$1 AND kind='chat-reports'`,
    [owner],
  );
  for (const row of rows) if (row.id) ids.add(row.id);
  return [...ids];
}

/** The cloud's messages as AG-UI messages (the client validates a MESSAGES_SNAPSHOT). */
export function toAgUiMessages(messages: CloudMessage[]): Message[] {
  return messages.map((message): Message => {
    const content = message.content;
    switch (message.role) {
      case "assistant":
        return {
          id: message.id,
          role: "assistant",
          ...(content !== undefined && content !== null ? { content: content as string } : {}),
          ...(message.toolCalls?.length
            ? {
                toolCalls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.args },
                })),
              }
            : {}),
        };
      case "tool":
        return {
          id: message.id,
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
          toolCallId: message.toolCallId ?? "",
        };
      case "activity":
        return {
          id: message.id,
          role: "activity",
          activityType: message.activityType ?? "",
          content: (content ?? {}) as Record<string, unknown>,
        } as Message;
      default:
        return {
          id: message.id,
          role: message.role,
          ...(content !== undefined && content !== null ? { content } : {}),
        } as Message;
    }
  });
}

/** The import run: the whole cloud conversation as one snapshot, ids unchanged. */
export function importRunEvents(threadId: string, messages: Message[]): BaseEvent[] {
  const runId = cloudImportRunId(threadId);
  return [
    {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      input: { threadId, runId, messages: [], tools: [], context: [] },
    } as BaseEvent,
    { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
  ];
}

/** The message ids of a stored import run's snapshot, in order. */
function snapshotIds(events: BaseEvent[]): string[] {
  const snapshot = events.find((event) => event.type === EventType.MESSAGES_SNAPSHOT) as
    | { messages?: { id?: unknown }[] }
    | undefined;
  return (snapshot?.messages ?? []).map((message) => String(message.id));
}

const iso = (value: string | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** A failure as the owner reads it: what happened, never a body, id or key. */
export function failureReason(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return "CopilotKit 云不认这个 key";
    if (status === 429) return "CopilotKit 云说请求太多";
    if (status >= 500) return "CopilotKit 云暂时出错";
    return "CopilotKit 云没给读";
  }
  if (error instanceof TypeError) return "连不上 CopilotKit 云";
  return error instanceof Error && error.name !== "Error" ? error.name : "搬的时候出错了";
}

async function recordRow(
  db: Store,
  row: {
    threadId: string;
    owner: string;
    status: MigrationRowStatus;
    cloudMessages: number | null;
    importedMessages: number | null;
    cloudArchived: boolean;
    error: string | null;
  },
) {
  await chatDatabase(db).sql(
    `/* chat:migration-row */ INSERT INTO chat_migration(thread_id, owner, status, cloud_messages,
      imported_messages, cloud_archived, error, at)
    VALUES($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (thread_id) DO UPDATE SET owner=excluded.owner, status=excluded.status,
      cloud_messages=excluded.cloud_messages, imported_messages=excluded.imported_messages,
      cloud_archived=excluded.cloud_archived, error=excluded.error, at=now()
    WHERE chat_migration.status<>'done'`,
    [
      row.threadId,
      row.owner,
      row.status,
      row.cloudMessages,
      row.importedMessages,
      row.cloudArchived,
      row.error,
    ],
  );
}

async function resolvedIds(db: Store): Promise<Set<string>> {
  const rows = await chatDatabase(db).sql<{ thread_id: string }>(
    "SELECT thread_id FROM chat_migration WHERE status IN ('done','missing')",
  );
  return new Set(rows.map((row) => row.thread_id));
}

/** Copies one cloud thread and checks it; returns its row. */
async function copyThread(
  db: Store,
  chats: ChatStore,
  cloud: CloudThreadSource,
  owner: string,
  thread: CloudThread,
): Promise<{
  status: MigrationRowStatus;
  messages: number;
  archived: boolean;
  error: string | null;
}> {
  const userId = intelligenceUserId(owner);
  const archived = thread.archived === true;
  let cloudCount: number | null = null;
  try {
    const { messages } = await cloud.getThreadMessages({ threadId: thread.id, userId });
    const list = Array.isArray(messages) ? messages : [];
    cloudCount = list.length;
    const converted = toAgUiMessages(list);
    const ids = list.map((message) => message.id);
    const stored = await chats.importThread({
      owner,
      threadId: thread.id,
      agentId: thread.agentId || chatAgentId,
      name: thread.name ?? null,
      archived,
      createdAt: iso(thread.createdAt),
      // A thread with messages has run; the cloud's other times stand in when lastRunAt is absent.
      lastRunAt:
        iso(thread.lastRunAt) ??
        (list.length
          ? (iso(thread.lastUpdatedAt) ?? iso(thread.updatedAt) ?? iso(thread.createdAt))
          : null),
      runId: cloudImportRunId(thread.id),
      events: importRunEvents(thread.id, converted),
      messageIds: ids,
    });
    if (stored === "forbidden") throw new MigrationError("本地已有同一编号的别的对话");
    const local = snapshotIds(stored.events);
    const same = local.length === ids.length && local.every((id, index) => id === ids[index]);
    if (!same) throw new MigrationError("搬过来的消息和云上的对不上");
    const row = {
      threadId: thread.id,
      owner,
      status: "done" as const,
      cloudMessages: cloudCount,
      importedMessages: local.length,
      cloudArchived: archived,
      error: null,
    };
    await recordRow(db, row);
    return { status: "done", messages: local.length, archived, error: null };
  } catch (error) {
    const reason = error instanceof MigrationError ? error.message : failureReason(error);
    await recordRow(db, {
      threadId: thread.id,
      owner,
      status: "failed",
      cloudMessages: cloudCount,
      importedMessages: null,
      cloudArchived: archived,
      error: reason,
    });
    return { status: "failed", messages: 0, archived, error: reason };
  }
}

class MigrationError extends Error {
  override name = "MigrationError";
}

/**
 * Copies every cloud thread not copied yet. Never throws for the cloud's failures: they are
 * recorded (per thread, or for an owner whose list could not be read) and the next start tries
 * again. Writes the marker `done` with the totals once nothing is left.
 */
export async function migrateCloudThreads(
  db: Store,
  chats: ChatStore,
  cloud: CloudThreadSource,
): Promise<MigrationSummary> {
  const owners = await migrationOwners(db);
  const resolved = await resolvedIds(db);
  let failed = 0;
  /** Owners whose cloud list could not be read (their threads are unknown, so not copied). */
  let unlisted = 0;
  let reason: string | null = null;
  for (const owner of owners) {
    const userId = intelligenceUserId(owner);
    const listed = new Map<string, CloudThread>();
    try {
      let cursor: string | undefined;
      do {
        const page = await cloud.listThreads({
          userId,
          agentId: chatAgentId,
          includeArchived: true,
          ...(cursor ? { cursor } : {}),
        });
        for (const thread of page.threads ?? []) listed.set(thread.id, thread);
        cursor = page.nextCursor || undefined;
      } while (cursor);
    } catch (error) {
      // The owner's list could not be read: what this server knows of it is not copied yet.
      reason = failureReason(error);
      unlisted++;
      for (const threadId of await knownThreadIds(db, owner)) {
        if (resolved.has(threadId)) continue;
        await recordRow(db, {
          threadId,
          owner,
          status: "failed",
          cloudMessages: null,
          importedMessages: null,
          cloudArchived: false,
          error: reason,
        });
        failed++;
      }
      continue;
    }
    for (const threadId of await knownThreadIds(db, owner)) {
      if (listed.has(threadId) || resolved.has(threadId)) continue;
      try {
        const thread = await cloud.getThread({ threadId, userId });
        listed.set(threadId, { ...thread, id: threadId });
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 404) {
          await recordRow(db, {
            threadId,
            owner,
            status: "missing",
            cloudMessages: null,
            importedMessages: null,
            cloudArchived: false,
            error: null,
          });
          resolved.add(threadId);
          continue;
        }
        reason = failureReason(error);
        await recordRow(db, {
          threadId,
          owner,
          status: "failed",
          cloudMessages: null,
          importedMessages: null,
          cloudArchived: false,
          error: reason,
        });
        failed++;
      }
    }
    for (const thread of listed.values()) {
      if (resolved.has(thread.id)) continue;
      const result = await copyThread(db, chats, cloud, owner, thread);
      if (result.status === "failed") {
        failed++;
        reason = result.error;
      } else resolved.add(thread.id);
    }
  }
  const { failedRows: _, ...totals } = await migrationTotals(db);
  const complete = failed === 0 && unlisted === 0;
  const summary: MigrationSummary = {
    complete,
    owners: owners.length,
    ...totals,
    failed,
    reason: complete ? null : reason,
  };
  if (summary.complete)
    await db.put<MigrationMarker>(markerOwner, markerKind, {
      id: markerId,
      status: "done",
      owners: summary.owners,
      threads: summary.threads,
      archived: summary.archived,
      messages: summary.messages,
      missing: summary.missing,
      reason: null,
      at: new Date().toISOString(),
    });
  else
    await db.put<MigrationMarker>(markerOwner, markerKind, {
      id: markerId,
      status: "pending",
      reason: summary.reason,
      at: new Date().toISOString(),
    });
  return summary;
}

/** Counts of chat_migration: threads copied, of them archived, their messages, and missing. */
export async function migrationTotals(db: Store) {
  const rows = await chatDatabase(db).sql<{
    threads: number;
    archived: number;
    messages: number;
    missing: number;
    failed: number;
  }>(
    `SELECT count(*) FILTER (WHERE status='done')::int AS threads,
      count(*) FILTER (WHERE status='done' AND cloud_archived)::int AS archived,
      coalesce(sum(imported_messages) FILTER (WHERE status='done'), 0)::int AS messages,
      count(*) FILTER (WHERE status='missing')::int AS missing,
      count(*) FILTER (WHERE status='failed')::int AS failed
    FROM chat_migration`,
  );
  const row = rows[0];
  return {
    threads: row?.threads ?? 0,
    archived: row?.archived ?? 0,
    messages: row?.messages ?? 0,
    missing: row?.missing ?? 0,
    failedRows: row?.failed ?? 0,
  };
}

/** What the members of the space with key `spaceKey` see while the copy is not complete; null
 * when there is nothing to say (done, or still running for the first time) and for every space
 * but the first, whose conversations alone were in the cloud. */
export async function cloudThreadsFact(
  db: Store,
  keyConfigured: boolean,
  spaceKey: string,
): Promise<CloudThreadsFact | null> {
  if (spaceKey !== firstSpaceKey) return null;
  const marker = await readMarker(db);
  if (!marker || marker.status === "done") return null;
  if (!keyConfigured) return { state: "no-key" };
  const rows = await chatDatabase(db).sql<{ n: number; error: string | null }>(
    `SELECT count(*)::int AS n, (SELECT error FROM chat_migration WHERE status='failed'
      AND (owner=$1 OR starts_with(owner, $1 || '/')) ORDER BY at DESC LIMIT 1) AS error
    FROM chat_migration WHERE status='failed' AND (owner=$1 OR starts_with(owner, $1 || '/'))`,
    [spaceKey],
  );
  const pending = rows[0]?.n ?? 0;
  const reason = rows[0]?.error ?? marker.reason ?? null;
  if (!pending && !reason) return null;
  return { state: "failed", pending, reason: reason ?? "" };
}

/** Counts for /api/health (no ids). */
export async function migrationHealth(db: Store) {
  const marker = await readMarker(db);
  const totals = await migrationTotals(db);
  return {
    status: marker?.status ?? "pending",
    threads: totals.threads,
    archived: totals.archived,
    messages: totals.messages,
    missing: totals.missing,
    failed: totals.failedRows,
  };
}

/** What the API process does at start (index.ts): nothing more once the copy is complete (the
 * key is not used; the log says it can go), the copy in the background while the key is set, or
 * the fact that the old conversations are still in the cloud without a key to copy them. */
export async function startCloudMigration(
  db: Store,
  chats: ChatStore,
  apiKey: string | undefined,
  client: (apiKey: string) => CloudThreadSource,
  log: Pick<Console, "log" | "warn" | "error"> = console,
): Promise<{ state: "done" | "started" | "no-key"; run?: Promise<MigrationSummary | null> }> {
  if (await migrationComplete(db)) {
    if (apiKey) log.log("以前的对话已经全部搬回，CPK_INTELLIGENCE_API_KEY 可以从配置里删掉");
    return { state: "done" };
  }
  if (!apiKey) {
    log.warn("以前的对话还在 CopilotKit 云上，没搬回来：配置里没有云 key");
    return { state: "no-key" };
  }
  const run = migrateCloudThreads(db, chats, client(apiKey))
    .then((summary) => {
      log.log(
        summary.complete
          ? `以前的对话已经全部搬回：${summary.owners} 个分区，${summary.threads} 个对话（其中归档 ${summary.archived} 个），${summary.messages} 条消息；本地知道但云上没有的 ${summary.missing} 个。CPK_INTELLIGENCE_API_KEY 可以从配置里删掉`
          : `以前的对话至少还有 ${summary.failed} 个没搬回来：${summary.reason ?? ""}。下次启动会再搬。`,
      );
      return summary;
    })
    .catch((error: unknown) => {
      log.error(
        `[OpenMuse] Copying conversations from CopilotKit's cloud failed: ${error instanceof Error ? error.name : "Error"}`,
      );
      return null;
    });
  return { state: "started", run };
}
