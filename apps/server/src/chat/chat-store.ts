// Chat threads, runs and the running-run journal in this
// server's own database (chat_threads, chat_runs, chat_events; ported from the open-source
// standalone build). A plain statement runs on its own pooled connection, so every multi-row state
// change below is ONE statement (Postgres runs data-modifying CTEs atomically); the cloud import
// and the main-thread switch, which span several, run in one transaction (ChatDatabase).
import type { BaseEvent, Message } from "@ag-ui/client";
import {
  indexedTextLimit,
  messageSearchText,
  searchQuery,
  searchTokens,
  snippetOf,
} from "../../../../packages/domain/src/chat-search.ts";
import { connectionOf, type Store, type StoreQuery } from "../db.ts";
import { backgroundFailure } from "../log.ts";
import { compactLeniently, messagesFromEvents } from "./events.ts";
import type {
  DeleteResult,
  FeedbackVerdict,
  ListThreadsQuery,
  MessageHit,
  SupersededSegment,
  SupersedeResult,
  ThreadPage,
  ThreadPatch,
  ThreadRecord,
  ThreadStore,
  ThreadTurn,
} from "./types.ts";

/** A malformed or forged list cursor; the thread routes answer 400. */
export class CursorError extends Error {
  override name = "CursorError";
  constructor() {
    super("Invalid cursor");
  }
}

export type RunStatus = "running" | "finished" | "error" | "stopped" | "interrupted";

export type BeginResult =
  | { status: "begun"; stopRequested: boolean }
  | { status: "locked"; holder: string | null; stale: boolean }
  | { status: "missing" }
  | { status: "duplicate" };

/** Holders known to be dead, whose locks are recovered at once (see staleRuns). */
export interface DeadLocks {
  /** A previous process that used this instance id. */
  instanceId?: string;
  /** Every holder: this process is the only one that can use the database. */
  all?: boolean;
}

/** See ChatStore.connectHistory. */
export interface ConnectHistory {
  closed: BaseEvent[][];
  running: BaseEvent[] | null;
}

export interface ClaimRow {
  claimed: boolean;
  owner: string | null;
  holder: string | null;
  stale: boolean;
}

// One advisory lock serialises concurrent first starts (API and worker) on the same Postgres.
const schema = `DO $$ BEGIN
PERFORM pg_advisory_xact_lock(7316010401);
CREATE TABLE IF NOT EXISTS chat_threads(
  id text PRIMARY KEY,
  owner text NOT NULL,
  agent_id text NOT NULL,
  name text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  run_id text,
  run_instance text,
  run_claimed_at timestamptz,
  run_heartbeat_at timestamptz,
  stop_requested boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS chat_threads_owner_recent
  ON chat_threads(owner, agent_id, (coalesce(last_run_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS chat_threads_locked ON chat_threads(run_heartbeat_at) WHERE run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_runs(
  run_id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  position bigserial,
  parent_run_id text,
  status text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS chat_runs_thread ON chat_runs(thread_id, position);
-- The sweep's scan (every 15 s in each process): running runs.
CREATE INDEX IF NOT EXISTS chat_runs_running ON chat_runs(thread_id) WHERE status='running';
-- Fork (v0.5 threads): the one-time copy of the conversations kept in CopilotKit's cloud, one row
-- per cloud thread (cloud-migration.ts).
CREATE TABLE IF NOT EXISTS chat_migration(
  thread_id text PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL,
  cloud_messages integer,
  imported_messages integer,
  cloud_archived boolean NOT NULL DEFAULT false,
  error text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_events(
  run_id text NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
  seq integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY(run_id, seq)
);
-- Fork (v0.5 spaces): the member who sent a run's new messages (claimed with the thread, kept on
-- the run), so a conversation of several members shows who said what.
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS run_speaker text;
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS speaker text;
-- v1.6 聊天基础动作: a run the person went back on (a message edited and sent again, a reply asked
-- for again) is superseded, never deleted: superseded_at says when, superseded_by the run that
-- took its place (filled in when that run begins). The conversation (history, connect, replay,
-- reports) reads the runs that are not superseded; the chat shows a superseded stretch folded.
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS superseded_by text;
-- v1.6 聊天基础动作: 点赞 / 点踩 on a reply, one verdict per message, gone with the thread.
CREATE TABLE IF NOT EXISTS chat_feedback(
  thread_id text NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  verdict text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(thread_id, message_id)
);
-- v1.6 搜对话内容: the search index, one row per message with words (the person's and the
-- members'), filled when a run closes (and for older runs by the backlog at start). tokens are
-- the message's CJK bigrams and words (packages/domain/src/chat-search.ts) as a tsvector: no
-- extension, so embedded PGlite and Postgres index the same. A message sent again with the same
-- id moves to the new run; a superseded run's messages stay but the search skips them; a deleted
-- thread takes its rows.
CREATE TABLE IF NOT EXISTS chat_messages(
  thread_id text NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  run_id text NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
  role text NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  tokens tsvector NOT NULL,
  PRIMARY KEY(thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS chat_messages_tokens ON chat_messages USING gin(tokens);
CREATE INDEX IF NOT EXISTS chat_messages_at ON chat_messages(at DESC);
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS indexed_at timestamptz;
CREATE INDEX IF NOT EXISTS chat_runs_unindexed ON chat_runs(position)
  WHERE indexed_at IS NULL AND status<>'running';
END $$`;

/** A closed run that still counts in the conversation (not superseded). */
const live = "r.status<>'running' AND r.superseded_at IS NULL";

// Timestamps as ISO text built here: node-pg cannot parse timestamptz output in a non-ISO DateStyle.
const isoText = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
const threadColumns = `id, name, agent_id, archived, ${isoText("created_at")}, ${isoText("updated_at")}, ${isoText("last_run_at")}`;
const ms = "::double precision * interval '1 millisecond'";
const unlock =
  "run_id=NULL, run_instance=NULL, run_claimed_at=NULL, run_heartbeat_at=NULL, stop_requested=false, run_speaker=NULL";

interface ThreadRow {
  id: string;
  name: string | null;
  agent_id: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    organizationId: "",
    createdById: "",
    archived: row.archived,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastRunAt: row.last_run_at == null ? null : iso(row.last_run_at),
  };
}

/** v1.6 搜对话内容: the index rows of one run's events: its user and assistant messages with
 * words (file names count), each cut to the indexed length, with their tokens. */
export function indexRows(
  events: BaseEvent[],
): { id: string; role: "user" | "assistant"; body: string; tokens: string[] }[] {
  const rows: { id: string; role: "user" | "assistant"; body: string; tokens: string[] }[] = [];
  const seen = new Set<string>();
  for (const message of messagesFromEvents(events)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (seen.has(message.id)) continue;
    const body = storableText(
      messageSearchText((message as { content?: unknown }).content).slice(0, indexedTextLimit),
    );
    if (!body) continue;
    seen.add(message.id);
    rows.push({ id: message.id, role: message.role, body, tokens: searchTokens(body) });
  }
  return rows;
}

// Unpaired UTF-16 surrogates (as in a reply cut in the middle of an emoji): jsonb rejects them.
// String.prototype.toWellFormed, but the project targets ES2023 (as wellFormed in
// packages/integrations/src/google.ts).
const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const unpairedAll = new RegExp(unpaired.source, "g");

/** The text with NUL characters (Postgres rejects them) and unpaired surrogates as U+FFFD. */
export function storableText(text: string): string {
  const withoutNul = text.includes("\u0000") ? text.replaceAll("\u0000", "\uFFFD") : text;
  return unpaired.test(withoutNul) ? withoutNul.replace(unpairedAll, "\uFFFD") : withoutNul;
}

/** jsonb text for a value; its strings and keys are made storable (see storableText). */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return storableText(item);
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const keys = Object.keys(item);
    if (keys.every((key) => storableText(key) === key)) return item;
    return Object.fromEntries(
      keys.map((key) => [storableText(key), (item as Record<string, unknown>)[key]]),
    );
  });
}

/** A list cursor's sort key: microseconds since 1970 (independent of the server's DateStyle). */
const epochMicros = /^\d{1,18}$/;

function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: key, id })).toString("base64url");
}

function decodeCursor(cursor: string): { k: string; id: string } {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorError();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new CursorError();
    const { k, id } = value as { k?: unknown; id?: unknown };
    if (typeof k !== "string" || !epochMicros.test(k)) throw new CursorError();
    if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new CursorError();
    return { k, id };
  } catch {
    throw new CursorError();
  }
}

function isDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("22");
}

/** Raw SQL for the chat tables, on the Store's own connection. One object per Store (tests
 * replace `sql` on it to make statements fail); the chat store looks it up on every call. */
export interface ChatDatabase {
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs `work` in one transaction: every statement through its `sql`, committed together. */
  transaction<T>(work: (sql: ChatSql) => Promise<T>): Promise<T>;
}
export type ChatSql = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

const databases = new WeakMap<Store, ChatDatabase>();
/** The chat tables' access to `store`'s database (the same object every time). */
export function chatDatabase(store: Store): ChatDatabase {
  let database = databases.get(store);
  if (!database) {
    const connection = connectionOf(store);
    const rows =
      (query: StoreQuery): ChatSql =>
      async <T>(text: string, params?: unknown[]) =>
        (await query(text, params)).rows as unknown as T[];
    database = {
      sql: (text, params) => rows(connection.query)(text, params),
      transaction: (work) => connection.transaction((query) => work(rows(query))),
    };
    databases.set(store, database);
  }
  return database;
}
/** The transaction's statements as a Store `via` (compareAndSwap inside the same transaction). */
export function storeQuery(sql: ChatSql): StoreQuery {
  return async (text, params) => ({
    rows: (await sql(text, params)) as { data: Record<string, unknown> }[],
  });
}

/** A thread's latest run, for following a conversation other people talk in (chat reports). */
export interface ThreadActivity {
  /** The run with the highest position (any status); null before the first one. */
  lastRunId: string | null;
  /** A reply is claimed or running on the thread. */
  running: boolean;
}

export class ChatStore implements ThreadStore {
  private constructor(readonly store: Store) {}

  /** The statements' database (looked up per call, see ChatDatabase). */
  get database(): ChatDatabase {
    return chatDatabase(this.store);
  }
  private sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    return this.database.sql<T>(text, params);
  }

  /** Creates the chat_* tables if needed (idempotent on PGlite and Postgres). */
  static async open(db: Store): Promise<ChatStore> {
    await chatDatabase(db).sql(schema);
    return new ChatStore(db);
  }

  async ensureThread(
    owner: string,
    threadId: string,
    agentId: string,
  ): Promise<"ok" | "forbidden"> {
    const rows = await this.sql<{ owner: string }>(
      `/* chat:ensure */ WITH ins AS (
        INSERT INTO chat_threads(id, owner, agent_id) VALUES($1, $2, $3)
        ON CONFLICT (id) DO NOTHING RETURNING owner
      )
      SELECT owner FROM ins UNION ALL SELECT owner FROM chat_threads WHERE id=$1`,
      [threadId, owner, agentId],
    );
    // A row inserted concurrently after this statement's snapshot is only visible to a new one.
    const found = rows[0]?.owner ?? (await this.threadOwner(threadId));
    return found === owner ? "ok" : "forbidden";
  }

  async threadOwner(threadId: string): Promise<string | null> {
    const rows = await this.sql<{ owner: string }>("SELECT owner FROM chat_threads WHERE id=$1", [
      threadId,
    ]);
    return rows[0]?.owner ?? null;
  }

  async listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 50) || 50));
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    let rows: (ThreadRow & { sort_key: string })[];
    try {
      rows = await this.sql(
        `/* chat:list */ SELECT ${threadColumns},
          (extract(epoch FROM coalesce(last_run_at, created_at)) * 1000000)::bigint::text AS sort_key
        FROM chat_threads
        WHERE owner=$1 AND agent_id=$2 AND last_run_at IS NOT NULL AND ($3::boolean OR NOT archived)
          AND ($4::bigint IS NULL OR (coalesce(last_run_at, created_at), id)
            < (timestamptz 'epoch' + $4::bigint * interval '1 microsecond', $5::text))
        ORDER BY coalesce(last_run_at, created_at) DESC, id DESC
        LIMIT $6`,
        [
          owner,
          query.agentId,
          query.includeArchived === true,
          after?.k ?? null,
          after?.id ?? null,
          limit + 1,
        ],
      );
    } catch (error) {
      if (after && isDataError(error)) throw new CursorError();
      throw error;
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      threads: page.map(toRecord),
      nextCursor: rows.length > limit && last ? encodeCursor(last.sort_key, last.id) : null,
    };
  }

  async updateThread(
    owner: string,
    threadId: string,
    agentId: string,
    patch: ThreadPatch,
  ): Promise<ThreadRecord | null> {
    const name = patch.name === undefined ? null : storableText(patch.name);
    const archived = patch.archived ?? null;
    const rows = await this.sql<ThreadRow>(
      `/* chat:update */ UPDATE chat_threads SET name=coalesce($4::text, name),
        archived=coalesce($5::boolean, archived),
        updated_at=CASE WHEN $4::text IS NULL AND $5::boolean IS NULL THEN updated_at ELSE now() END
      WHERE id=$1 AND owner=$2 AND agent_id=$3
      RETURNING ${threadColumns}`,
      [threadId, owner, agentId, name, archived],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult> {
    const rows = await this.sql<{ found: number; deleted: number }>(
      `/* chat:delete */ WITH target AS (
        SELECT id FROM chat_threads WHERE id=$1 AND owner=$2 AND agent_id=$3
      ), gone AS (
        DELETE FROM chat_threads t USING target WHERE t.id=target.id AND t.run_id IS NULL RETURNING t.id
      )
      SELECT (SELECT count(*) FROM target)::int AS found, (SELECT count(*) FROM gone)::int AS deleted`,
      [threadId, owner, agentId],
    );
    const row = rows[0];
    if (!row?.found) return "not_found";
    return row.deleted ? "deleted" : "running";
  }

  async threadEvents(
    owner: string,
    threadId: string,
    options: { superseded?: boolean } = {},
  ): Promise<BaseEvent[] | null> {
    const rows = await this.sql<{ owner: string; runs: BaseEvent[][] }>(
      `/* chat:thread-events */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(r.events ORDER BY r.position) FROM chat_runs r
        WHERE r.thread_id=t.id AND ${options.superseded ? "r.status<>'running'" : live}
      ), '[]'::jsonb) AS runs
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    return compactLeniently(row.runs.flat());
  }

  /**
   * The thread's stored conversation (its closed runs, oldest first, as the
   * model will see it) and every message id stored for it. The runner builds the model's history
   * from this, not from the client's copy, which can lack a turn someone else just had. A
   * superseded run (v1.6 聊天基础动作) is left out of both: the model never sees what the person
   * went back on, and its person's message, sent again, is new to the conversation.
   */
  async history(threadId: string): Promise<{ messages: Message[]; ids: Set<string> }> {
    const rows = await this.sql<{ runs: BaseEvent[][]; ids: string[] }>(
      `/* chat:history */ SELECT coalesce((
        SELECT jsonb_agg(r.events ORDER BY r.position) FROM chat_runs r
        WHERE r.thread_id=$1 AND ${live}
      ), '[]'::jsonb) AS runs, coalesce((
        SELECT jsonb_agg(DISTINCT i.value) FROM chat_runs r, jsonb_array_elements_text(r.message_ids) i
        WHERE r.thread_id=$1 AND ${live}
      ), '[]'::jsonb) AS ids`,
      [threadId],
    );
    const row = rows[0];
    const messages = messagesFromEvents(compactLeniently((row?.runs ?? []).flat()));
    return { messages, ids: new Set([...(row?.ids ?? []), ...messages.map((m) => m.id)]) };
  }

  /**
   * Who sent each user message of the thread (message id -> user id), from
   * the runs that recorded their member; null when the thread is missing or another owner's.
   * Messages copied from the cloud or sent before spaces have no entry.
   */
  async speakers(owner: string, threadId: string): Promise<Record<string, string> | null> {
    const rows = await this.sql<{
      owner: string;
      runs: { speaker: string; started: { input?: { messages?: unknown[] } } | null }[];
    }>(
      `/* chat:speakers */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(jsonb_build_object('speaker', r.speaker, 'started', r.events->0)
          ORDER BY r.position)
        FROM chat_runs r WHERE r.thread_id=t.id AND r.speaker IS NOT NULL
      ), '[]'::jsonb) AS runs
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    const out: Record<string, string> = {};
    for (const run of row.runs)
      for (const message of run.started?.input?.messages ?? []) {
        const { id, role } = (message ?? {}) as { id?: unknown; role?: unknown };
        if (role === "user" && typeof id === "string" && !(id in out)) out[id] = run.speaker;
      }
    return out;
  }

  /**
   * When each turn of the thread was had, oldest first:
   * the run's start (`at`), its end (`end`, null while it runs) and the messages it brought into
   * the conversation (`messages`: the ones no earlier run had, the person's message first). A
   * running run counts with the messages it was started with. Null when the thread is missing or
   * another owner's. The chat places a need's card against these times.
   */
  async turns(owner: string, threadId: string): Promise<ThreadTurn[] | null> {
    const rows = await this.sql<{
      owner: string;
      runs: {
        runId: string;
        at: string;
        end: string | null;
        ids: unknown;
        started: { input?: { messages?: unknown[] } } | null;
      }[];
    }>(
      `/* chat:turns */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'runId', r.run_id,
          'at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'end', to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'ids', r.message_ids, 'started', r.events->0) ORDER BY r.position)
        FROM chat_runs r WHERE r.thread_id=t.id AND r.superseded_at IS NULL
      ), '[]'::jsonb) AS runs
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    const seen = new Set<string>();
    return row.runs.map((run) => {
      // The person's message comes in with the run's input; what the run said, after it.
      const started = (run.started?.input?.messages ?? []).flatMap((message) => {
        const id = (message as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      });
      const stored = Array.isArray(run.ids)
        ? run.ids.filter((id): id is string => typeof id === "string")
        : [];
      const messages: string[] = [];
      for (const id of [...started, ...stored])
        if (!seen.has(id)) {
          seen.add(id);
          messages.push(id);
        }
      return { runId: run.runId, at: iso(run.at), end: run.end ? iso(run.end) : null, messages };
    });
  }

  /** The thread's latest run and whether a reply holds it; null when the
   * thread does not exist or belongs to another owner. */
  async activity(owner: string, threadId: string): Promise<ThreadActivity | null> {
    const rows = await this.sql<{ owner: string; running: boolean; last_run_id: string | null }>(
      `/* chat:activity */ SELECT t.owner, t.run_id IS NOT NULL AS running, (
        SELECT r.run_id FROM chat_runs r WHERE r.thread_id=t.id ORDER BY r.position DESC LIMIT 1
      ) AS last_run_id
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    return { lastRunId: row.last_run_id, running: row.running };
  }

  /**
   * Writes one cloud thread as a local thread row and one
   * finished import run, in one transaction that first locks the thread row. A thread that
   * already has local runs (someone chatted while it was not yet copied) gets the import run
   * ahead of them, so a replay shows the cloud history first. An existing row keeps its own
   * name, archived flag and lock; its times widen to cover the cloud's. The run id is fixed per
   * thread and inserted with ON CONFLICT DO NOTHING, so a second import changes nothing. Returns
   * the stored import run (events and message ids) for the caller's check, or "forbidden" when
   * another owner holds the id.
   */
  async importThread(input: {
    owner: string;
    threadId: string;
    agentId: string;
    name: string | null;
    archived: boolean;
    createdAt: string | null;
    lastRunAt: string | null;
    runId: string;
    events: BaseEvent[];
    messageIds: string[];
  }): Promise<{ events: BaseEvent[]; messageIds: string[] } | "forbidden"> {
    return this.database.transaction(async (sql) => {
      await sql(
        `/* chat:import-thread */ INSERT INTO chat_threads(id, owner, agent_id, name, archived,
          created_at, updated_at, last_run_at)
        VALUES($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), now(), $7::timestamptz)
        ON CONFLICT (id) DO NOTHING`,
        [
          input.threadId,
          input.owner,
          input.agentId,
          input.name === null ? null : storableText(input.name),
          input.archived,
          input.createdAt,
          input.lastRunAt,
        ],
      );
      const locked = await sql<{ owner: string }>(
        "/* chat:import-lock */ SELECT owner FROM chat_threads WHERE id=$1 FOR UPDATE",
        [input.threadId],
      );
      if (locked[0]?.owner !== input.owner) return "forbidden" as const;
      await sql(
        `/* chat:import-widen */ UPDATE chat_threads SET name=coalesce(name, $2::text),
          created_at=least(created_at, $3::timestamptz),
          last_run_at=greatest(last_run_at, $4::timestamptz)
        WHERE id=$1`,
        [
          input.threadId,
          input.name === null ? null : storableText(input.name),
          input.createdAt,
          input.lastRunAt,
        ],
      );
      await sql(
        `/* chat:import-run */ INSERT INTO chat_runs(run_id, thread_id, position, status, events,
          message_ids, created_at, finished_at)
        VALUES($1, $2, coalesce(
          (SELECT min(position) - 1 FROM chat_runs WHERE thread_id=$2),
          nextval(pg_get_serial_sequence('chat_runs', 'position'))
        ), 'finished', $3::jsonb, $4::jsonb, coalesce($5::timestamptz, now()),
          coalesce($5::timestamptz, now()))
        ON CONFLICT (run_id) DO NOTHING`,
        [
          input.runId,
          input.threadId,
          toJsonb(input.events),
          toJsonb(input.messageIds),
          input.lastRunAt ?? input.createdAt,
        ],
      );
      const stored = await sql<{ events: BaseEvent[]; message_ids: string[] }>(
        "/* chat:import-read */ SELECT events, message_ids FROM chat_runs WHERE run_id=$1 AND thread_id=$2",
        [input.runId, input.threadId],
      );
      const run = stored[0];
      if (!run) throw new Error("The imported run was not stored");
      return { events: run.events, messageIds: run.message_ids };
    });
  }

  /** A member's own conversation follows the member when she joins or leaves a
   * group (a project): its id comes from her account id and is the same in every scope, so its
   * owner becomes `to` when it is held by the space (`real`) or by one of the space's projects.
   * False when it is missing, already `to`'s, or another space's. */
  async adoptThread(threadId: string, real: string, to: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }>(
      `/* chat:adopt-thread */ UPDATE chat_threads SET owner=$3
        WHERE id=$1 AND owner<>$3
          AND (owner=$2 OR left(owner, length($2) + 6) = $2 || '/proj:')
        RETURNING id`,
      [threadId, real, to],
    );
    return rows.length > 0;
  }

  /** A deleted project's conversations go with it (its runs and journal by
   * cascade). Returns how many threads were removed. */
  async purgeOwner(owner: string): Promise<number> {
    const rows = await this.sql<{ n: number }>(
      `/* chat:purge-owner */ WITH gone AS (
        DELETE FROM chat_threads WHERE owner=$1 RETURNING 1
      ) SELECT count(*)::int AS n FROM gone`,
      [owner],
    );
    return rows[0]?.n ?? 0;
  }

  // ---- Runner statements (LocalAgentRunner). Not owner-scoped: the hooks check ownership. ----

  /** Inserts the thread for owner if absent and takes the lock iff it is owned by owner and idle. */
  async claimRun(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
    instanceId: string;
    staleAfterMs: number;
    /** The member sending the run's new messages. */
    speaker?: string | null;
  }): Promise<ClaimRow> {
    const rows = await this.sql<{
      claimed: number;
      owner: string | null;
      holder: string | null;
      stale: boolean | null;
    }>(
      `/* chat:claim */ WITH claimed AS (
        INSERT INTO chat_threads AS t (id, owner, agent_id, run_id, run_instance, run_claimed_at,
          run_heartbeat_at, stop_requested, run_speaker)
        VALUES ($1, $2, $3, $4, $5, now(), now(), false, $7)
        ON CONFLICT (id) DO UPDATE SET run_id=excluded.run_id, run_instance=excluded.run_instance,
          run_claimed_at=now(), run_heartbeat_at=now(), stop_requested=false,
          run_speaker=excluded.run_speaker
        WHERE t.owner=excluded.owner AND t.run_id IS NULL
        RETURNING t.id
      )
      SELECT (SELECT count(*) FROM claimed)::int AS claimed, t.owner, t.run_id AS holder,
        (t.run_heartbeat_at < now() - $6${ms}) AS stale
      FROM (SELECT 1) one LEFT JOIN chat_threads t ON t.id=$1`,
      [
        input.threadId,
        input.owner,
        input.agentId,
        input.runId,
        input.instanceId,
        input.staleAfterMs,
        input.speaker ?? null,
      ],
    );
    const row = rows[0];
    return {
      claimed: Boolean(row?.claimed),
      owner: row?.owner ?? null,
      holder: row?.holder ?? null,
      stale: row?.stale === true,
    };
  }

  /**
   * Undoes a claim whose run is not running (never began, or its start failed). A thread row that
   * has never run, has no runs and was not renamed or archived is deleted instead of kept unlocked,
   * so refused runs leave no rows behind (/api/main-thread records the main thread again).
   */
  async releaseClaim(threadId: string, runId: string): Promise<boolean> {
    const rows = await this.sql<{ released: number }>(
      `/* chat:release */ WITH gone AS (
        DELETE FROM chat_threads t
        WHERE t.id=$1 AND t.run_id=$2 AND t.last_run_at IS NULL AND t.name IS NULL AND NOT t.archived
          AND NOT EXISTS (SELECT 1 FROM chat_runs r WHERE r.thread_id=t.id)
        RETURNING t.id
      ), kept AS (
        UPDATE chat_threads t SET ${unlock}
        WHERE t.id=$1 AND t.run_id=$2 AND NOT EXISTS (SELECT 1 FROM gone)
          AND NOT EXISTS (
            SELECT 1 FROM chat_runs r WHERE r.run_id=$2 AND r.thread_id=t.id AND r.status='running')
        RETURNING t.id
      )
      SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM kept))::int AS released`,
      [threadId, runId],
    );
    return Boolean(rows[0]?.released);
  }

  /** Ids of every message already stored for the thread (closed runs). */
  async historicMessageIds(threadId: string): Promise<string[]> {
    const rows = await this.sql<{ ids: string[] }>(
      `/* chat:historic */ SELECT coalesce(jsonb_agg(DISTINCT i.value), '[]'::jsonb) AS ids
      FROM chat_runs r, jsonb_array_elements_text(r.message_ids) i
      WHERE r.thread_id=$1 AND ${live}`,
      [threadId],
    );
    return rows[0]?.ids ?? [];
  }

  /**
   * Starts a run: the thread must be claimed for runId (or idle, which claims it now); inserts the
   * running chat_runs row (events = [the persisted RUN_STARTED]) and sets last_run_at. Runs
   * superseded since the last run began (supersedeFrom) are recorded as superseded by this one.
   */
  async beginRun(input: {
    threadId: string;
    runId: string;
    instanceId: string;
    started: BaseEvent;
    staleAfterMs: number;
  }): Promise<BeginResult> {
    const rows = await this.sql<{
      begun: number;
      stop_requested: boolean | null;
      found: number;
      holder: string | null;
      stale: boolean | null;
      dup_status: string | null;
    }>(
      `/* chat:begin */ WITH thread AS (
        SELECT run_id, (run_id IS NOT NULL AND run_heartbeat_at < now() - $5${ms}) AS stale,
          CASE WHEN run_id=$2 THEN run_speaker END AS speaker
        FROM chat_threads WHERE id=$1
      ), dup AS (
        SELECT status FROM chat_runs WHERE run_id=$2
      ), parent AS (
        SELECT run_id FROM chat_runs r WHERE r.thread_id=$1 AND ${live}
        ORDER BY position DESC LIMIT 1
      ), lock AS (
        UPDATE chat_threads t SET run_id=$2, run_instance=$3,
          run_claimed_at=CASE WHEN t.run_id=$2 THEN t.run_claimed_at ELSE now() END,
          run_heartbeat_at=now(), last_run_at=now(), updated_at=now(),
          stop_requested=CASE WHEN t.run_id=$2 THEN t.stop_requested ELSE false END
        WHERE t.id=$1 AND (t.run_id=$2 OR t.run_id IS NULL) AND NOT EXISTS (SELECT 1 FROM dup)
        RETURNING t.id, t.stop_requested
      ), run AS (
        INSERT INTO chat_runs(run_id, thread_id, parent_run_id, status, events, speaker)
        SELECT $2, lock.id, (SELECT run_id FROM parent), 'running', $4::jsonb,
          (SELECT speaker FROM thread) FROM lock
        RETURNING run_id
      ), adopted AS (
        UPDATE chat_runs s SET superseded_by=$2
        WHERE s.thread_id=$1 AND s.superseded_at IS NOT NULL AND s.superseded_by IS NULL
          AND EXISTS (SELECT 1 FROM run)
        RETURNING s.run_id
      )
      SELECT (SELECT count(*) FROM run)::int AS begun,
        (SELECT stop_requested FROM lock) AS stop_requested,
        (SELECT count(*) FROM thread)::int AS found,
        (SELECT run_id FROM thread) AS holder,
        (SELECT stale FROM thread) AS stale,
        (SELECT status FROM dup) AS dup_status`,
      [input.threadId, input.runId, input.instanceId, toJsonb([input.started]), input.staleAfterMs],
    );
    const row = rows[0];
    if (row?.begun) return { status: "begun", stopRequested: row.stop_requested === true };
    if (!row?.found) return { status: "missing" };
    // The same runId already ran: a duplicate request while it runs is "locked", later "duplicate".
    if (row.dup_status && row.dup_status !== "running") return { status: "duplicate" };
    return { status: "locked", holder: row.holder, stale: row.stale === true };
  }

  /** Appends events to a running run's journal at seq0, seq0+1, ... (idempotent on retry). */
  async appendJournal(runId: string, seq0: number, events: BaseEvent[]): Promise<void> {
    await this.sql(
      `/* chat:journal */ INSERT INTO chat_events(run_id, seq, event)
      SELECT $1, $2::int + (x.ord::int - 1), x.value
      FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS x(value, ord)
      WHERE EXISTS (SELECT 1 FROM chat_runs WHERE run_id=$1 AND status='running')
      ON CONFLICT DO NOTHING`,
      [runId, seq0, toJsonb(events)],
    );
  }

  /**
   * Closes a run in one statement: saves its compacted events, deletes its journal and releases
   * the thread lock (guarded by runId). With staleAfterMs (recovery), only a lock whose heartbeat
   * is older than that is touched. A missing run row just releases the lock.
   */
  async closeRun(input: {
    threadId: string;
    runId: string;
    status: Exclude<RunStatus, "running">;
    events: BaseEvent[];
    messageIds: string[];
    staleAfterMs?: number;
  }): Promise<{ closed: boolean; released: boolean }> {
    const rows = await this.sql<{ closed: number; released: number }>(
      `/* chat:close */ WITH guard AS (
        SELECT 1 AS ok WHERE $6::double precision IS NULL OR NOT EXISTS (
          SELECT 1 FROM chat_threads WHERE id=$1 AND run_id=$2
            AND run_heartbeat_at >= now() - $6${ms})
      ), run AS (
        UPDATE chat_runs SET events=$3::jsonb, message_ids=$4::jsonb, status=$5, finished_at=now()
        WHERE run_id=$2 AND thread_id=$1 AND status='running' AND EXISTS (SELECT 1 FROM guard)
        RETURNING run_id
      ), journal AS (
        DELETE FROM chat_events WHERE run_id IN (SELECT run_id FROM run) RETURNING 1
      ), thread AS (
        UPDATE chat_threads SET ${unlock}, updated_at=now()
        WHERE id=$1 AND run_id=$2 AND EXISTS (SELECT 1 FROM guard)
        RETURNING id
      )
      SELECT (SELECT count(*) FROM run)::int AS closed, (SELECT count(*) FROM thread)::int AS released`,
      [
        input.threadId,
        input.runId,
        toJsonb(input.events),
        toJsonb(input.messageIds),
        input.status,
        input.staleAfterMs ?? null,
      ],
    );
    const closed = Boolean(rows[0]?.closed);
    // v1.6 搜对话内容: the run's words go into the search index. A failure here is logged, not
    // the close's: the run stays unindexed and the backlog (indexBacklog) picks it up later.
    if (closed)
      await this.indexRun(input.threadId, input.runId, input.events).catch((error) =>
        backgroundFailure("chat index", error),
      );
    return { closed, released: Boolean(rows[0]?.released) };
  }

  /** Refreshes this instance's locks for the given runs; returns their stop requests. */
  async heartbeat(
    instanceId: string,
    runIds: string[],
  ): Promise<{ threadId: string; runId: string; stopRequested: boolean }[]> {
    if (runIds.length === 0) return [];
    const rows = await this.sql<{ id: string; run_id: string; stop_requested: boolean }>(
      `/* chat:heartbeat */ UPDATE chat_threads SET run_heartbeat_at=now()
      WHERE run_instance=$1 AND run_id IN (SELECT jsonb_array_elements_text($2::jsonb))
      RETURNING id, run_id, stop_requested`,
      [instanceId, toJsonb(runIds)],
    );
    return rows.map((row) => ({
      threadId: row.id,
      runId: row.run_id,
      stopRequested: row.stop_requested,
    }));
  }

  /**
   * Locks to recover: heartbeat older than staleAfterMs, every lock of dead.instanceId (a previous
   * process with this instance id), every lock when dead.all (no other process can hold one), and
   * running runs no lock points at. Locks of a dead holder are not guarded by their heartbeat.
   */
  async staleRuns(
    staleAfterMs: number,
    dead: DeadLocks = {},
  ): Promise<{ threadId: string; runId: string; guarded: boolean }[]> {
    const rows = await this.sql<{ thread_id: string; run_id: string; guarded: boolean }>(
      `/* chat:stale */ SELECT id AS thread_id, run_id,
        NOT ($3::boolean OR ($2::text IS NOT NULL AND run_instance=$2)) AS guarded
      FROM chat_threads
      WHERE run_id IS NOT NULL
        AND ($3::boolean OR run_heartbeat_at < now() - $1${ms}
          OR ($2::text IS NOT NULL AND run_instance=$2))
      UNION
      SELECT r.thread_id, r.run_id, false AS guarded FROM chat_runs r
      WHERE r.status='running' AND NOT EXISTS (
        SELECT 1 FROM chat_threads t WHERE t.id=r.thread_id AND t.run_id=r.run_id)`,
      [staleAfterMs, dead.instanceId ?? null, dead.all === true],
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      runId: row.run_id,
      guarded: row.guarded,
    }));
  }

  /** A running run's persisted RUN_STARTED record and journal, or null when it is not running. */
  async runningRun(
    threadId: string,
    runId: string,
  ): Promise<{ started: BaseEvent | null; journal: BaseEvent[] } | null> {
    const rows = await this.sql<{ events: BaseEvent[]; journal: BaseEvent[] }>(
      `/* chat:running-run */ SELECT r.events, coalesce((
        SELECT jsonb_agg(e.event ORDER BY e.seq) FROM chat_events e WHERE e.run_id=r.run_id
      ), '[]'::jsonb) AS journal
      FROM chat_runs r WHERE r.run_id=$1 AND r.thread_id=$2 AND r.status='running'`,
      [runId, threadId],
    );
    const row = rows[0];
    return row ? { started: row.events[0] ?? null, journal: row.journal } : null;
  }

  /**
   * What a connect replays, read in ONE statement so both parts come from the same snapshot: the
   * thread's closed runs (compacted per run, oldest first) and the journal of its running run
   * (whichever instance holds it). excludeRunId (the live run the caller tails) is left out of both.
   * Two statements could miss a run that another process saves between them.
   */
  async connectHistory(threadId: string, excludeRunId?: string): Promise<ConnectHistory> {
    const rows = await this.sql<{ events: BaseEvent[] | null; journal: BaseEvent[] | null }>(
      `/* chat:connect-history */ SELECT r.events, NULL::jsonb AS journal, r.position
      FROM chat_runs r
      WHERE r.thread_id=$1 AND ${live} AND ($2::text IS NULL OR r.run_id<>$2)
      UNION ALL
      SELECT NULL, coalesce((
        SELECT jsonb_agg(e.event ORDER BY e.seq) FROM chat_events e WHERE e.run_id=r.run_id
      ), '[]'::jsonb), NULL
      FROM chat_threads t JOIN chat_runs r ON r.run_id=t.run_id AND r.status='running'
      WHERE t.id=$1 AND ($2::text IS NULL OR r.run_id<>$2)
      ORDER BY position NULLS LAST`,
      [threadId, excludeRunId ?? null],
    );
    const closed: BaseEvent[][] = [];
    let running: BaseEvent[] | null = null;
    for (const row of rows) {
      if (row.journal) running = row.journal;
      else if (row.events) closed.push(row.events);
    }
    return { closed, running };
  }

  /**
   * v1.6 聊天基础动作: the person goes back on the conversation from `messageId` (their message
   * edited and sent again, or the reply to it asked for again): the closed run that brought that
   * message in and every closed run after it are superseded now. The next run to begin on the
   * thread is recorded as the one that took their place. Nothing while a reply holds the thread.
   */
  async supersedeFrom(
    owner: string,
    threadId: string,
    messageId: string,
  ): Promise<SupersedeResult> {
    const rows = await this.sql<{ found: number; idle: number; anchored: number; done: number }>(
      `/* chat:supersede */ WITH target AS (
        SELECT id, run_id FROM chat_threads WHERE id=$1 AND owner=$2
      ), anchor AS (
        SELECT min(r.position) AS position FROM chat_runs r, target
        WHERE r.thread_id=target.id AND target.run_id IS NULL AND ${live} AND r.message_ids ? $3
      ), done AS (
        UPDATE chat_runs r SET superseded_at=now() FROM anchor
        WHERE r.thread_id=$1 AND ${live} AND r.position>=anchor.position
        RETURNING r.run_id
      )
      SELECT (SELECT count(*) FROM target)::int AS found,
        (SELECT count(*) FROM target WHERE run_id IS NULL)::int AS idle,
        (SELECT count(*) FROM anchor WHERE position IS NOT NULL)::int AS anchored,
        (SELECT count(*) FROM done)::int AS done`,
      [threadId, owner, messageId],
    );
    const row = rows[0];
    if (!row?.found) return "not_found";
    if (!row.idle) return "running";
    if (!row.anchored) return "no_message";
    return "superseded";
  }

  /**
   * v1.6 聊天基础动作: the thread's superseded stretches, oldest first, each with the conversation
   * it held (compacted events) and the live run that stands where it stood (`anchor`: the run that
   * took its place, followed through runs that were themselves superseded; null while that run
   * has not begun or is gone). Null when the thread is missing or another owner's.
   */
  async superseded(owner: string, threadId: string): Promise<SupersededSegment[] | null> {
    const rows = await this.sql<{
      owner: string;
      runs: { runId: string; by: string | null; at: string; events: BaseEvent[] }[];
      live: string[];
    }>(
      `/* chat:superseded */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(jsonb_build_object('runId', r.run_id, 'by', r.superseded_by,
          'at', to_char(r.superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'events', r.events) ORDER BY r.position)
        FROM chat_runs r WHERE r.thread_id=t.id AND r.superseded_at IS NOT NULL
      ), '[]'::jsonb) AS runs, coalesce((
        SELECT jsonb_agg(r.run_id) FROM chat_runs r
        WHERE r.thread_id=t.id AND r.superseded_at IS NULL
      ), '[]'::jsonb) AS live
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    const by = new Map(row.runs.map((run) => [run.runId, run.by]));
    const liveRuns = new Set(row.live);
    // The live run a superseded run leads to, through runs that were superseded in their turn.
    const anchorOf = (runId: string | null): string | null => {
      let current = runId;
      for (let hops = 0; current && hops <= row.runs.length; hops++) {
        if (liveRuns.has(current)) return current;
        current = by.get(current) ?? null;
      }
      return null;
    };
    const segments: SupersededSegment[] = [];
    let open: (SupersededSegment & { runs: BaseEvent[][] }) | undefined;
    for (const run of row.runs) {
      const anchor = anchorOf(run.by);
      if (open && open.anchor === anchor) {
        open.runs.push(run.events);
        continue;
      }
      if (open)
        segments.push({
          anchor: open.anchor,
          at: open.at,
          events: compactLeniently(open.runs.flat()),
        });
      open = { anchor, at: iso(run.at), events: [], runs: [run.events] };
    }
    if (open)
      segments.push({
        anchor: open.anchor,
        at: open.at,
        events: compactLeniently(open.runs.flat()),
      });
    return segments;
  }

  /** v1.6 聊天基础动作: the verdicts given on the thread's replies (message id -> up | down);
   * null when the thread is missing or another owner's. */
  async feedback(owner: string, threadId: string): Promise<Record<string, FeedbackVerdict> | null> {
    const rows = await this.sql<{ owner: string; given: { id: string; verdict: string }[] }>(
      `/* chat:feedback */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', f.message_id, 'verdict', f.verdict) ORDER BY f.at)
        FROM chat_feedback f WHERE f.thread_id=t.id
      ), '[]'::jsonb) AS given
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    const out: Record<string, FeedbackVerdict> = {};
    for (const item of row.given)
      if (item.verdict === "up" || item.verdict === "down") out[item.id] = item.verdict;
    return out;
  }

  /** v1.6 聊天基础动作: gives (or with null takes back) the verdict on one reply. False when the
   * thread is missing or another owner's. */
  async setFeedback(
    owner: string,
    threadId: string,
    messageId: string,
    verdict: FeedbackVerdict | null,
  ): Promise<boolean> {
    const rows = await this.sql<{ found: number }>(
      verdict
        ? `/* chat:feedback-set */ WITH target AS (
            SELECT id FROM chat_threads WHERE id=$1 AND owner=$2
          ), put AS (
            INSERT INTO chat_feedback(thread_id, message_id, verdict)
            SELECT target.id, $3, $4 FROM target
            ON CONFLICT (thread_id, message_id) DO UPDATE SET verdict=EXCLUDED.verdict, at=now()
            RETURNING 1
          )
          SELECT (SELECT count(*) FROM target)::int AS found`
        : `/* chat:feedback-clear */ WITH target AS (
            SELECT id FROM chat_threads WHERE id=$1 AND owner=$2
          ), gone AS (
            DELETE FROM chat_feedback f USING target
            WHERE f.thread_id=target.id AND f.message_id=$3 RETURNING 1
          )
          SELECT (SELECT count(*) FROM target)::int AS found`,
      verdict ? [threadId, owner, messageId, verdict] : [threadId, owner, messageId],
    );
    return Boolean(rows[0]?.found);
  }

  /** v1.6 搜对话内容: puts a closed run's messages with words (the person's and the members',
   * not tool results or reasoning) into the search index, replacing a message of the same id
   * (sent again after an edit: it moves to this run), and marks the run indexed. */
  async indexRun(threadId: string, runId: string, events: BaseEvent[]): Promise<void> {
    const rows = indexRows(events);
    await this.sql(
      `/* chat:index */ WITH run AS (
        SELECT r.run_id, r.thread_id, r.created_at FROM chat_runs r
        WHERE r.run_id=$1 AND r.thread_id=$2
      ), put AS (
        INSERT INTO chat_messages(thread_id, message_id, run_id, role, body, at, tokens)
        SELECT run.thread_id, m.id, run.run_id, m.role, m.body, run.created_at,
          array_to_tsvector(m.tokens)
        FROM run, jsonb_to_recordset($3::jsonb) AS m(id text, role text, body text, tokens text[])
        ON CONFLICT (thread_id, message_id) DO UPDATE SET run_id=EXCLUDED.run_id,
          role=EXCLUDED.role, body=EXCLUDED.body, at=EXCLUDED.at, tokens=EXCLUDED.tokens
        RETURNING 1
      )
      UPDATE chat_runs SET indexed_at=now() WHERE run_id=$1 AND thread_id=$2`,
      [runId, threadId, toJsonb(rows)],
    );
  }

  /** v1.6 搜对话内容: indexes every closed run not indexed yet (the conversations from before
   * the index, and runs whose indexing failed), oldest first, in batches; returns how many runs it
   * did. Called in the background at start; safe to run twice (the index is replaced per message). */
  async indexBacklog(batch = 50): Promise<number> {
    let done = 0;
    for (;;) {
      const rows = await this.sql<{ run_id: string; thread_id: string; events: BaseEvent[] }>(
        `/* chat:index-backlog */ SELECT run_id, thread_id, events FROM chat_runs
        WHERE indexed_at IS NULL AND status<>'running' ORDER BY position LIMIT $1`,
        [batch],
      );
      if (!rows.length) return done;
      for (const row of rows) {
        await this.indexRun(row.thread_id, row.run_id, row.events);
        done++;
      }
    }
  }

  /** v1.6 搜对话内容: the owner's messages holding every typed phrase, newest first, from every
   * conversation of theirs (archived too), skipping superseded stretches. The tokens narrow the
   * candidates through the GIN index; each phrase is then checked as a substring. */
  async searchMessages(
    owner: string,
    typed: string,
    options: { limit?: number } = {},
  ): Promise<MessageHit[]> {
    const query = searchQuery(typed);
    if (!query) return [];
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20) || 20));
    const params: unknown[] = [owner, limit, ...query.phrases];
    const phraseTests = query.phrases.map((_, i) => `strpos(lower(m.body), $${i + 3}) > 0`);
    if (query.tsquery) params.push(query.tsquery);
    const narrowed = query.tsquery
      ? `m.tokens @@ to_tsquery('simple', $${params.length}) AND `
      : "";
    const rows = await this.sql<{
      thread_id: string;
      message_id: string;
      role: string;
      body: string;
      at: string;
      name: string | null;
      agent_id: string;
      archived: boolean;
    }>(
      `/* chat:search */ SELECT m.thread_id, m.message_id, m.role, m.body,
        to_char(m.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
        t.name, t.agent_id, t.archived
      FROM chat_messages m
      JOIN chat_threads t ON t.id=m.thread_id AND t.owner=$1
      JOIN chat_runs r ON r.run_id=m.run_id AND r.superseded_at IS NULL
      WHERE ${narrowed}${phraseTests.join(" AND ")}
      ORDER BY m.at DESC, m.message_id
      LIMIT $2`,
      params,
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      threadName: row.name,
      agentId: row.agent_id,
      archived: row.archived,
      messageId: row.message_id,
      role: row.role === "user" ? "user" : "assistant",
      at: iso(row.at),
      snippet: snippetOf(row.body, query),
    }));
  }

  /** Flags the thread's current run (optionally only runId) to stop; true when one is locked. */
  async requestStop(threadId: string, runId?: string): Promise<boolean> {
    const rows = await this.sql(
      `/* chat:stop */ UPDATE chat_threads SET stop_requested=true
      WHERE id=$1 AND run_id IS NOT NULL AND ($2::text IS NULL OR run_id=$2) RETURNING id`,
      [threadId, runId ?? null],
    );
    return rows.length > 0;
  }

  /** True while a run is claimed, running, or stale but not yet recovered. */
  async isLocked(threadId: string): Promise<boolean> {
    const rows = await this.sql<{ locked: boolean }>(
      "SELECT run_id IS NOT NULL AS locked FROM chat_threads WHERE id=$1",
      [threadId],
    );
    return rows[0]?.locked === true;
  }

  /** Releases this instance's claims whose runs never began (shutdown). */
  async releaseInstanceClaims(instanceId: string): Promise<number> {
    const rows = await this.sql(
      `/* chat:release-instance */ UPDATE chat_threads t SET ${unlock}
      WHERE t.run_instance=$1 AND t.run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chat_runs r WHERE r.run_id=t.run_id AND r.status='running')
      RETURNING t.id`,
      [instanceId],
    );
    return rows.length;
  }
}
