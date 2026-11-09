// The contract between the local chat runner/store and the HTTP layer.
// The CopilotKit runtime runs in SSE mode on LocalAgentRunner,
// and conversations live in this server's own database (chat_threads, chat_runs, chat_events).
import type { BaseEvent, Message } from "@ag-ui/client";

/** A thread as the runtime's thread endpoints and CopilotKit's useThreads expect it. */
export interface ThreadRecord {
  id: string;
  name: string | null;
  agentId: string;
  /** Always "" locally; kept for the runtime's thread record shape. */
  organizationId: string;
  /** Always "" locally; the owner is never exposed. */
  createdById: string;
  archived: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /** ISO 8601 time the latest run began; null before the first run. */
  lastRunAt: string | null;
}

export interface ThreadPage {
  threads: ThreadRecord[];
  /** Opaque; pass back as `cursor` for the next page. */
  nextCursor: string | null;
}

export interface ListThreadsQuery {
  agentId: string;
  includeArchived?: boolean;
  /** 1-100. */
  limit?: number;
  cursor?: string;
}

export interface ThreadPatch {
  name?: string;
  archived?: boolean;
}

/** Thread ids are global: a thread of another owner is "forbidden" and served as 404. */
export type ClaimResult = { ok: true } | { ok: false; reason: "locked" | "forbidden" };

export type DeleteResult = "deleted" | "not_found" | "running";

/** v1.6 聊天基础动作: supersedeFrom's outcome ("no_message": no live run brought that message). */
export type SupersedeResult = "superseded" | "not_found" | "running" | "no_message";

/** v1.6 聊天基础动作: a stretch of the conversation the person went back on, folded in the chat. */
export interface SupersededSegment {
  /** The live run standing where the stretch stood (its first message anchors the fold); null
   * while it has not begun or is gone. */
  anchor: string | null;
  /** ISO 8601: when the stretch was superseded. */
  at: string;
  /** Its compacted events (the thread view turns them into messages). */
  events: BaseEvent[];
}

/** v1.6 聊天基础动作: 点赞 / 点踩. */
export type FeedbackVerdict = "up" | "down";

/** v1.6 搜对话内容: one message found by a search, with the conversation it is in. */
export interface MessageHit {
  threadId: string;
  threadName: string | null;
  agentId: string;
  archived: boolean;
  messageId: string;
  role: "user" | "assistant";
  /** ISO 8601: when the message's turn began. */
  at: string;
  /** The words around the first phrase found (`match` is that phrase as written). */
  snippet: { before: string; match: string; after: string };
}

/** Error code the client already understands as "thread busy, hold the message". */
export const threadLockedCode = "agent_thread_locked";

/**
 * RUN_ERROR code ending a connect whose history could not be read: the app fails the load (and
 * offers Retry) instead of taking what it received for the whole conversation.
 */
export const historyUnavailableCode = "history_unavailable";

/** Owner-scoped thread storage used by the thread routes. Implemented by ChatStore. */
export interface ThreadStore {
  /** Create the thread for owner if absent. "forbidden" when another owner holds the id. */
  ensureThread(owner: string, threadId: string, agentId: string): Promise<"ok" | "forbidden">;
  /** Owner of a thread, or null when it does not exist. Not owner-scoped: callers compare. */
  threadOwner(threadId: string): Promise<string | null>;
  /** A member's conversation moves to `to` (the space `real`'s own scope or one
   * of its projects) when she joins or leaves a group. True when it moved. */
  adoptThread?(threadId: string, real: string, to: string): Promise<boolean>;
  /** Threads that have run at least once, newest first; archived only when requested. */
  listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage>;
  /** null when the thread is missing, owned by someone else, or has another agentId. */
  updateThread(
    owner: string,
    threadId: string,
    agentId: string,
    patch: ThreadPatch,
  ): Promise<ThreadRecord | null>;
  /** Deletes the thread with its runs and journal. "running" while a run holds the lock. */
  deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult>;
  /** Compacted events of the thread's closed runs (the superseded ones too only with
   * `superseded`); null when missing or another owner's. */
  threadEvents(
    owner: string,
    threadId: string,
    options?: { superseded?: boolean },
  ): Promise<BaseEvent[] | null>;
  /** Message id -> the member who sent it; null when missing or another
   * owner's. */
  speakers?(owner: string, threadId: string): Promise<Record<string, string> | null>;
  /** When each turn was had (ChatStore `turns`); null when missing or another
   * owner's. */
  turns?(owner: string, threadId: string): Promise<ThreadTurn[] | null>;
  /** v1.6 聊天基础动作: supersedes the conversation from `messageId` on (ChatStore). */
  supersedeFrom?(owner: string, threadId: string, messageId: string): Promise<SupersedeResult>;
  /** v1.6 聊天基础动作: the superseded stretches; null when missing or another owner's. */
  superseded?(owner: string, threadId: string): Promise<SupersededSegment[] | null>;
  /** v1.6 聊天基础动作: the verdicts on the thread's replies; null when missing or another owner's. */
  feedback?(owner: string, threadId: string): Promise<Record<string, FeedbackVerdict> | null>;
  /** v1.7 打开对话不重放整条历史: the closed runs before the one holding `beforeMessageId`
   * (ChatStore `olderRuns`); null when missing, another owner's, or the message unknown. */
  olderRuns?(
    owner: string,
    threadId: string,
    beforeMessageId: string,
    options?: { limit?: number; untilMessageId?: string },
  ): Promise<{ runs: BaseEvent[][]; more: boolean } | null>;
  /** v1.6 搜对话内容: the owner's messages holding the typed words, newest first (ChatStore). */
  searchMessages?(
    owner: string,
    typed: string,
    options?: { limit?: number },
  ): Promise<MessageHit[]>;
  /** v1.6 聊天基础动作: gives or takes back a verdict; false when missing or another owner's. */
  setFeedback?(
    owner: string,
    threadId: string,
    messageId: string,
    verdict: FeedbackVerdict | null,
  ): Promise<boolean>;
}

/** One turn of a conversation (one run) in time. */
export interface ThreadTurn {
  /** The run (v1.6 聊天基础动作: a superseded stretch's fold stands before its anchor run). */
  runId?: string;
  /** ISO 8601: when the run began (the person's message was sent). */
  at: string;
  /** ISO 8601: when the run's reply ended; null while it runs. */
  end: string | null;
  /** The messages the turn brought into the conversation, in order (the person's first). */
  messages: string[];
}

/** Lock control used by the runtime hooks before the runtime answers. Implemented by LocalAgentRunner. */
export interface RunControl {
  /**
   * Atomically create the thread for owner if absent and reserve it for runId.
   * Must be called before the runtime starts the SSE response so a busy thread answers 409.
   */
  claim(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
    /** The member sending the run's new messages, kept on the run. */
    speaker?: string | null;
  }): Promise<ClaimResult>;
  /** Undo a claim whose run never began (the runtime answered non-200). No-op otherwise. */
  release(threadId: string, runId: string): Promise<void>;
}

export interface LocalRunnerOptions {
  /** Identifies this process's locks; default randomUUID(). start() recovers locks left under it. */
  instanceId?: string;
  /** v1.7 打开对话不重放整条历史: how many of the newest closed runs a connect replays (the rest
   * load as the person scrolls up); default 40; 0 replays everything. */
  replayRuns?: number;
  /** Lock heartbeat interval; default 5000. */
  heartbeatMs?: number;
  /** A lock without a heartbeat for this long is recovered; default 30000. */
  staleAfterMs?: number;
  /** Recovery sweep interval; default 15000. */
  sweepMs?: number;
  /** Journal flush interval for a running run; default 250. */
  flushMs?: number;
  /**
   * No other process can use the database (embedded PGlite): every lock found at start() belongs
   * to a previous process and is recovered at once instead of after staleAfterMs.
   */
  exclusive?: boolean;
}

/** Messages rebuilt from stored events, in the runtime's /threads/:id/messages wire shape. */
export type WireMessage =
  | {
      id: string;
      role: "assistant";
      content?: string;
      toolCalls?: { id: string; name: string; args: string }[];
    }
  | { id: string; role: "tool"; content: string; toolCallId: string }
  | { id: string; role: Exclude<Message["role"], "assistant" | "tool">; content?: unknown };
