// v1.6 回顾: a conversation's replay shared by link. The owner makes one link per conversation
// (making another replaces it), it opens without signing in, it expires (30 days by default) and
// the owner can revoke it. The token is the whole secret: 32 random bytes, base64url.
import { randomBytes } from "node:crypto";
import type { Store } from "../db.ts";
import { chatDatabase } from "./chat-store.ts";

export const defaultShareDays = 30;
const dayMs = 24 * 60 * 60_000;
const tokenPattern = /^[A-Za-z0-9_-]{40,48}$/;

export interface ReplayShare {
  token: string;
  owner: string;
  threadId: string;
  createdAt: string;
  expiresAt: string;
}

// PGlite runs one statement per prepared call: the table and its index are two statements.
const schema = [
  `CREATE TABLE IF NOT EXISTS replay_shares(
  token text PRIMARY KEY,
  owner text NOT NULL,
  thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
)`,
  "CREATE INDEX IF NOT EXISTS replay_shares_thread ON replay_shares(owner, thread_id)",
];

interface Row {
  token: string;
  owner: string;
  thread_id: string;
  created_at: string;
  expires_at: string;
}

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
const columns = `token, owner, thread_id, ${iso("created_at")}, ${iso("expires_at")}`;

function toShare(row: Row): ReplayShare {
  return {
    token: row.token,
    owner: row.owner,
    threadId: row.thread_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class ReplayShares {
  private constructor(
    private readonly db: Store,
    private readonly now: () => number,
  ) {}
  static async open(db: Store, options: { now?: () => number } = {}): Promise<ReplayShares> {
    for (const statement of schema) await chatDatabase(db).sql(statement);
    return new ReplayShares(db, options.now ?? Date.now);
  }
  private sql<T = Record<string, unknown>>(text: string, params?: unknown[]) {
    return chatDatabase(this.db).sql<T>(text, params);
  }
  /** The owner's live link for a thread, or null. */
  async current(owner: string, threadId: string): Promise<ReplayShare | null> {
    const rows = await this.sql<Row>(
      `/* replay:current */ SELECT ${columns} FROM replay_shares
       WHERE owner=$1 AND thread_id=$2 AND revoked_at IS NULL AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [owner, threadId, new Date(this.now()).toISOString()],
    );
    return rows[0] ? toShare(rows[0]) : null;
  }
  /** A new link for the thread; the owner's earlier links for it are revoked. */
  async create(owner: string, threadId: string, days = defaultShareDays): Promise<ReplayShare> {
    const at = new Date(this.now());
    const token = randomBytes(32).toString("base64url");
    await this.sql(
      `/* replay:revoke-earlier */ UPDATE replay_shares SET revoked_at=$3
       WHERE owner=$1 AND thread_id=$2 AND revoked_at IS NULL`,
      [owner, threadId, at.toISOString()],
    );
    const rows = await this.sql<Row>(
      `/* replay:create */ INSERT INTO replay_shares(token, owner, thread_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${columns}`,
      [
        token,
        owner,
        threadId,
        at.toISOString(),
        new Date(at.getTime() + days * dayMs).toISOString(),
      ],
    );
    return toShare(rows[0] as Row);
  }
  /** Revokes the owner's live links for the thread; how many there were. */
  async revoke(owner: string, threadId: string): Promise<number> {
    const rows = await this.sql<{ token: string }>(
      `/* replay:revoke */ UPDATE replay_shares SET revoked_at=$3
       WHERE owner=$1 AND thread_id=$2 AND revoked_at IS NULL RETURNING token`,
      [owner, threadId, new Date(this.now()).toISOString()],
    );
    return rows.length;
  }
  /** The share a token names, when it is live; null for an unknown, revoked or expired one.
   * A malformed token is null without a query. */
  async byToken(token: string): Promise<ReplayShare | null> {
    if (!tokenPattern.test(token)) return null;
    const rows = await this.sql<Row>(
      `/* replay:by-token */ SELECT ${columns} FROM replay_shares
       WHERE token=$1 AND revoked_at IS NULL AND expires_at > $2`,
      [token, new Date(this.now()).toISOString()],
    );
    return rows[0] ? toShare(rows[0]) : null;
  }
}
