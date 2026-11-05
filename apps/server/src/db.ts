import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
interface Database {
  /** Several processes may share this database (a server, not the embedded one). */
  shared?: boolean;
  query: Query;
  /** Runs `work` in one transaction: every statement through its `query`, committed together
   * or rolled back on a throw. */
  transaction: <T>(work: (query: Query) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}
/** The connection behind a Store, for the
 * credential store only, which keeps its own tables on the same database. A module-level map,
 * not a Store method: nothing that holds a Store can reach those tables through it. */
const connections = new WeakMap<Store, Database>();
export function connectionOf(store: Store): Database {
  const connection = connections.get(store);
  if (!connection) throw new Error("This store has no database connection");
  return connection;
}
export type { Database as StoreConnection, Query as StoreQuery };

export class Store {
  constructor(private readonly db: Database) {
    connections.set(this, db);
  }
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async listByGoalId<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    goalId: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'goalId'=$3 ORDER BY updated_at DESC,id",
      [owner, kind, goalId],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Records whose top-level `field` equals `value` (as text), newest update first. */
  async listByField<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4 ORDER BY updated_at DESC,id",
      [owner, kind, field, value],
    );
    return result.rows.map((row) => row.data as T);
  }
  /**
   * One page of the records whose top-level `field` equals `value`, in
   * ascending byte order of the text of `order`, then id; always returned oldest first.
   * `after`: the first `limit` with `order` at or after it. `before`: the last `limit` strictly
   * before (`before.value`, `before.id`). Neither: the last `limit`. Filtering, ordering and the
   * limit run in SQL, so a long history is never loaded to answer a poll.
   * `field` and `value` may both be left out (every record of the kind
   * under the owner), and `also` adds more top-level fields that must equal their values. A
   * call with one `field` and no `also` sends exactly the statement it always did.
   * `except` leaves out the records whose top-level fields equal every
   * `equal` value and match every `match` pattern (PostgreSQL `~`), in SQL, so a page still holds
   * `limit` records and a cursor never lands on one that is left out.
   */
  async listPage<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    query: {
      field?: string;
      value?: string;
      also?: Readonly<Record<string, string>>;
      order: string;
      limit: number;
      after?: string;
      before?: { value: string; id: string };
      except?: {
        equal: Readonly<Record<string, string>>;
        match: Readonly<Record<string, string>>;
      };
    },
  ): Promise<T[]> {
    const equal = Object.entries(query.also ?? {});
    if (query.field !== undefined && query.value !== undefined)
      equal.unshift([query.field, query.value]);
    else if (query.field !== undefined || query.value !== undefined)
      throw new Error("listPage needs both field and value, or neither");
    const params: unknown[] = [owner, kind];
    let filter = "";
    for (const [field, value] of equal) {
      params.push(field, value);
      filter += ` AND data->>$${params.length - 1}=$${params.length}`;
    }
    if (query.except) {
      const parts: string[] = [];
      for (const [field, value] of Object.entries(query.except.equal)) {
        params.push(field, value);
        parts.push(`data->>$${params.length - 1}=$${params.length}`);
      }
      for (const [field, pattern] of Object.entries(query.except.match)) {
        params.push(field, pattern);
        parts.push(`data->>$${params.length - 1} ~ $${params.length}`);
      }
      if (parts.length) filter += ` AND NOT COALESCE(${parts.join(" AND ")}, false)`;
    }
    params.push(query.order);
    const key = `(data->>$${params.length}) COLLATE "C"`;
    let where = "";
    if (query.after !== undefined) {
      params.push(query.after);
      where = ` AND ${key} >= $${params.length}`;
    } else if (query.before) {
      params.push(query.before.value, query.before.id);
      const [value, id] = [`$${params.length - 1}`, `$${params.length}`];
      where = ` AND (${key} < ${value} OR (${key} = ${value} AND id COLLATE "C" < ${id}))`;
    }
    params.push(query.limit);
    const direction = query.after !== undefined ? "ASC" : "DESC";
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind=$2${filter}${where} ORDER BY ${key} ${direction},id COLLATE "C" ${direction} LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.map((row) => row.data as T);
    return direction === "ASC" ? rows : rows.reverse();
  }
  /** How many records have the top-level `field` equal to `value`. */
  async countByField(owner: string, kind: string, field: string, value: string): Promise<number> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('count',count(*)) AS data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4",
      [owner, kind, field, value],
    );
    return Number(result.rows[0]?.data.count ?? 0);
  }
  async listByStatus<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    status: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'status'=$3 ORDER BY updated_at DESC,id",
      [owner, kind, status],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  /** Deletes the record only while it still contains `expected`; true when it did. */
  async removeMatching(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING id",
      [owner, kind, id, JSON.stringify(expected)],
    );
    return result.rows.length > 0;
  }
  /** `via`: run inside a transaction of the same database (the credential store's), so the
   * swap commits or rolls back with the rest of that transaction. */
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
    via?: Query,
  ): Promise<T | null> {
    const result = await (via ?? this.db.query)(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** The record, locked until the transaction `via` runs in ends; a write
   * to it from elsewhere waits for that transaction. */
  async lockRecord<T>(owner: string, kind: string, id: string, via: Query): Promise<T | null> {
    const result = await via(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3 FOR UPDATE",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** CompareAndSwap for every listed id in one statement; returns the
   * records it changed. The ids travel as one JSON array, which both drivers pass alike. */
  async compareAndSwapMany<T>(
    owner: string,
    kind: string,
    ids: string[],
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T[]> {
    if (!ids.length) return [];
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb)) AND data @> $4::jsonb RETURNING data",
      [owner, kind, JSON.stringify(ids), JSON.stringify(expected), JSON.stringify(patch)],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** The records with the listed ids (unknown ones left out), by id. */
  async getMany<T>(owner: string, kind: string, ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY id",
      [owner, kind, JSON.stringify(ids)],
    );
    return result.rows.map((row) => row.data as T);
  }
  // Update only the selected checkbox against the current row, preserving concurrent
  // additions, renames, reordering and other milestones' completion state.
  async setMilestoneDone<T>(owner: string, goalId: string, milestoneId: string, done: boolean) {
    const result = await this.db.query(
      `UPDATE records SET data=jsonb_set(data, '{milestones}', (
        SELECT jsonb_agg(CASE WHEN item->>'id'=$3
          THEN item || jsonb_build_object('done', $4::boolean) ELSE item END ORDER BY ordinal)
        FROM jsonb_array_elements(data->'milestones') WITH ORDINALITY AS milestones(item, ordinal)
      )), updated_at=now()
      WHERE owner=$1 AND kind='goals' AND id=$2
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'milestones') item WHERE item->>'id'=$3)
      RETURNING data`,
      [owner, goalId, milestoneId, done],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** InsertIfAbsent that sets the top-level `field` to the database clock
   * (ISO 8601 UTC, milliseconds, like toISOString) in the insert statement itself. Records
   * stamped this way become visible in nearly stamp order, whichever process writes them, so
   * a reader paging by that field does not pass over one still being written. */
  async insertIfAbsentStamped<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
    field: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb || jsonb_build_object($5::text,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ON CONFLICT DO NOTHING RETURNING data`,
      [owner, kind, value.id, JSON.stringify(value), field],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  /** `pastWindow` claims a review past its window too
   * (one not asked first is sent when its window ends, and may still be decided until then). */
  async claim<T>(
    owner: string,
    id: string,
    status: string,
    now: string,
    pastWindow = false,
  ): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND ($5::boolean OR (data->>'expiresAt')::timestamptz>$3::timestamptz)
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR data->>'fromRoutine'='true' OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status), pastWindow],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  // Fork hook (projects): a deleted project takes every record under its owner with it.
  async purgeOwner(owner: string): Promise<number> {
    const result = await this.db.query("DELETE FROM records WHERE owner=$1 RETURNING id", [owner]);
    return result.rows.length;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** [index name, kind, filter field, order field] of the paged collections.
 * A null filter field indexes the whole kind per owner by the order
 * field (the project-wide latest reports). */
export const pageIndexes: readonly (readonly [string, string, string | null, string])[] = [
  ["records_chat_reports_page", "chat-reports", "threadId", "createdAt"],
  ["records_run_events_page", "run-events", "taskId", "date"],
  ["records_chat_reports_task_page", "chat-reports", "taskId", "createdAt"],
  ["records_chat_reports_owner_page", "chat-reports", null, "createdAt"],
];

/** The statement that creates one page index (see pageIndexes). */
export function pageIndexStatement([name, kind, field, order]: (typeof pageIndexes)[number]) {
  const filter = field === null ? "" : `(data->>'${field}'),`;
  return `CREATE INDEX IF NOT EXISTS ${name} ON records (owner,${filter}((data->>'${order}') COLLATE "C"),(id COLLATE "C")) WHERE kind='${kind}'`;
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = {
      shared: true,
      query: async (sql, params) => pool.query(sql, params),
      transaction: async (work) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await work(async (sql, params) => client.query(sql, params));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      transaction: (work) =>
        embedded.transaction((tx) => work((sql, params) => tx.query<Row>(sql, params))),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  // The report polls of every open conversation (every 5 seconds) and
  // task_events page these by one field and a time (Store.listPage, countByField); these
  // partial indexes serve the filter and the order, so they never scan and sort every report
  // and run event of the owner. Only a speed-up: a failure (two processes creating one at the
  // same moment) is logged, not fatal.
  // Chat reports are also paged by task and across the whole project.
  for (const index of pageIndexes)
    await database
      .query(pageIndexStatement(index))
      .catch((error) => backgroundFailure("create index", error));
  return new Store(database);
}
