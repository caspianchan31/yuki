/**
 * Background task reports that reach the chat.
 *
 * A report is stored once per owner in `chat-reports` under a deterministic id, so a run that
 * is interrupted and continued, and the maintenance loop that re-publishes outcomes every
 * minute, never report the same thing twice. Each report belongs to one conversation thread:
 * the side chat the task was delegated from, or, for a member's own result that would have
 * gone to the project's main chat, that member's conversation. A handoff stays in the group.
 *
 *   GET  /api/chat-reports?[threadId=…][&taskId=…][&after=ISO | &before=ISO[&beforeId=…]][&limit=N]
 *        { reports: ChatReport[] } oldest first: the
 *        latest `limit`; with `after`, the first `limit` created at or after it (the client
 *        merges by id); with `before`, the latest `limit` before (`before`, `beforeId`), for
 *        loading older pages. `threadId` keeps one conversation's, `taskId` one task's (any
 *        conversation), both together both; neither is the whole project across every
 *        conversation (UI redesign N2: the live panel's latest reports, a task's own reports).
 *        There are no task limits to send (fork, report line): waits and automatic
 *        continuations have none. With `threadId`, also
 *        `thread: { lastRunId, running }` (that conversation's latest run).
 *   POST /api/chat-reports/read  { ids: string[] (1..100), afterMessageId?: string | null }
 *        { reports: ChatReport[] } records when and where each report was first shown, in one
 *        request for every report a client shows at once; a report seen before is returned
 *        unchanged, and an unknown id is left out
 *   POST /api/chat-reports/:id/read  { afterMessageId?: string | null }  the same for one report
 *        (404 when unknown); kept for clients loaded before the batch route
 *
 * Both are owner-scoped by the auth and project middleware like the rest of /api.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  type AgentTask,
  type ChatReport,
  clipText,
  legacyWaitCardTitle,
  type ReportEvidenceGap,
  type ReportEvidenceInput,
  type ReportUnconfirmed,
  type RunStep,
  reportCheck,
  reportExisted,
  reportLink,
  reportLinksMax,
  reportLook,
  reportProof,
  reportTextMax,
  reportUnconfirmedReasons,
  reportUnconfirmedWords,
  withheldValuePattern,
} from "../../../../packages/domain/src/agent.ts";
import { reportThread } from "../../../../packages/domain/src/member-thread.ts";
import { taskEnvironmentId } from "../../../../packages/domain/src/task-phase.ts";
import type { ThreadActivity } from "../chat/chat-store.ts";
import { mainRecord } from "../chat/main-thread.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const kind = "chat-reports";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** A handoff stays on the group's thread. Her own write-up, even one that names the project,
 * is stored on her conversation. */
const handoffNotices = new Set([
  "founder_request",
  "project_request",
  "owner_away",
  "job_taken",
  "job_declined",
  "job_done",
]);
const isHandoffNotice = (notice: string | undefined) =>
  notice !== undefined && handoffNotices.has(notice);
export type StoredChatReport = ChatReport & { owner: string };
export const threadIdSchema = z.string().trim().min(1).max(200);
/** The task filter of the report list; task ids are UUIDs or hashes. */
export const reportTaskIdSchema = z.string().trim().min(1).max(200);

/** Which reports one list request reads: a conversation's, a task's, both, or every one. */
export interface ReportFilter {
  threadId?: string;
  taskId?: string;
}

/** The usable links (absolute http(s), deduplicated, at most 10) and the ones dropped. */
export function reportLinks(values: readonly string[] = []) {
  const links: string[] = [];
  const ignored: string[] = [];
  for (const value of values) {
    const link = reportLink(value);
    if (!link) ignored.push(clipText(value, 200));
    else if (!links.includes(link) && links.length < reportLinksMax) links.push(link);
  }
  return { links, ignored };
}

/** The run event mark of a report shown as not
 * confirmed (the clients read it in their words). */
export const unconfirmedMark = `[not confirmed: ${reportUnconfirmedWords.address}]`;
/** The run event mark for each reason a report is not
 * confirmed (task_events gives it to the chat, the clients show it in their words). */
export const unconfirmedMarks = Object.fromEntries(
  reportUnconfirmedReasons.map((why) => [why, `[not confirmed: ${reportUnconfirmedWords[why]}]`]),
) as Record<ReportUnconfirmed, string>;
/** The reason a run event's mark names, or null when it carries none. */
export function unconfirmedOf(detail: string): ReportUnconfirmed | null {
  for (const [why, mark] of Object.entries(unconfirmedMarks))
    if (detail.includes(mark)) return why as ReportUnconfirmed;
  return null;
}
const gapWords: Record<ReportEvidenceGap, string> = {
  site: "the site it was on (site)",
  action: "what you did (action)",
  permalink: "an address on which what you did shows",
  not_item: "an address on which what you did shows (permalink is not that page, by its kind)",
  masked:
    "an address that opens as given (the one you gave holds a value withheld from you, REDACTED or ***)",
  target:
    "the address of the item itself (permalink is the address of what you posted in or replied to, given in target)",
};
/** What the run is told when it did not look at the address
 * it gave after acting (`reportCheck`). */
const uncheckedWords =
  "you did not look at that address after acting (a page read or a screenshot of it in this run after the action), with verified true and what you saw there in seen";
/** What the run is told when it gave an item's address but
 * never read that page's words after acting, or read them and the posted text is not there. */
const unreadWords =
  "you did not read the words of that page after acting (read_page_text at the item's own address; a screenshot or the browser's address line is not that)";
const goneWords =
  "the words of the item's own page, as you read them after acting, do not show the text you posted; what you posted is not there:";
/** What every not-confirmed report's note ends with: what to do when it is not there. */
const notThereWords =
  " If it does not show there (removed, held for review, never posted), say that plainly in a notice with what stopped it; when only the owner can clear that (a check the site asks of the account), record it with record_sign_in needs_owner for the site instead of trying again.";
/** What report_to_user tells the run about the action a report claims. `confirms`: the
 * reference of a not-confirmed report's row on the account's ledger (`confirmsWords`). */
export interface ReportEvidenceReply {
  confirmed: boolean;
  missing?: ReportEvidenceGap[];
  evidenceNote?: string;
  confirms?: string;
}
/** The address that keys an action's ledger
 * row (pacing.ts `ledgerKey`), alone for an item, with the sentence for what an action without
 * text was done to. */
export interface ReportKey {
  address: string;
  withText: boolean;
}
/** What a not-confirmed report on an account's ledger adds to its note,
 * so the report of the same action with its address is that action, not a second one (service.ts
 * `ledgerEntry`). */
export const confirmsWords = (ref: string) =>
  `When you report it again with the address, give confirms "${ref}": it is this same action, not another.`;
/**
 * What a report shows of an action it claims, without knowing any site
 * (`reportProof`). The address that confirms it leads the card's links, then the permalink the
 * run gave (unless it holds a withheld value: it does not open). `permalink` is what the action
 * made (the ledger row's, which tells another account of the project what this one made): an
 * item's own address only. `key` is the address that tells this action from another on the
 * ledger: the item it made, alone; or what an action that posts no text was done to, with its
 * sentence (two profile edits on the account's page are two; the same words for likes on two
 * comments are two). A list page given for two posts would count them as one, so a listing never
 * keys a row. A report that claims an action without such an address is recorded and shown as
 * not confirmed (`unconfirmed`), and the run is told what is missing and how to find it: for an
 * item it made, in the account's list or the place; for an action that posts no text, on what it
 * was done to. One that lacks only its site or action is told to add them. A report that claims
 * no action gets no `reply`.
 */
export function reportEvidence(
  input: ReportEvidenceInput,
  links: readonly string[],
  /** The run's own steps on its desktop, in order (model.ts); unknown for a caller without a run. */
  steps?: readonly RunStep[],
): {
  links: string[];
  permalink: string | undefined;
  key: ReportKey | undefined;
  invalid: string | null;
  unconfirmed: boolean;
  reply?: ReportEvidenceReply;
  why?: ReportUnconfirmed;
  /** On an action confirmed by a run's steps, the step that
   * is its look at the address (`reportLook`), whose picture and time the card shows. */
  look?: RunStep;
} {
  const evidence = reportProof(input);
  const given = input.permalink ? reportLink(input.permalink) : null;
  const opens = given && !withheldValuePattern.test(input.permalink ?? "") ? given : null;
  const proof = evidence?.proof ?? null;
  const shown = [
    ...new Set([...(proof ? [proof.link] : []), ...(opens ? [opens] : []), ...links]),
  ].slice(0, reportLinksMax);
  const invalid = input.permalink && !given ? clipText(input.permalink, 200) : null;
  if (!evidence)
    return {
      links: shown,
      permalink: opens ?? undefined,
      key: undefined,
      invalid,
      unconfirmed: false,
    };
  const posted = !!input.posted?.trim();
  const permalink = proof?.as === "item" ? proof.link : undefined;
  const key = proof ? { address: proof.link, withText: proof.as !== "item" } : undefined;
  const { gaps } = evidence;
  // The
  // address of what posted text made did not exist before the run acted (`reportExisted`); one
  // the run had already read, or seen as a link, is the place, the profile or another page.
  if (proof && !gaps.length && steps && reportExisted(proof, { posted: input.posted }, steps))
    return {
      links: shown,
      permalink: undefined,
      key: undefined,
      invalid,
      unconfirmed: true,
      why: "address",
      reply: {
        confirmed: false,
        evidenceNote: `Recorded and shown to the person as not confirmed: ${proof.link} was there before you acted (a page you read, or a link on one), so it is not the address of what you made. Read the place you posted in, or the account's own list of what it posted, with read_page_text and take this item's own address from its links; open it, look that what you did shows there and report again with that address in permalink, permalinkKind item, verified true and what you saw in seen.${notThereWords} When no link of its own can be read, leave it not confirmed and go on.`,
      },
    };
  // An address that confirms the action confirms it only once
  // the run opened it after acting and saw it there; until then the action is recorded as one
  // without an address (its row waits for one, `confirms`).
  const check = proof && !gaps.length ? reportCheck(proof, input, steps) : null;
  if (check && proof)
    return {
      links: shown,
      permalink: undefined,
      key: undefined,
      invalid,
      unconfirmed: true,
      why: check,
      reply: {
        confirmed: false,
        // The item's page is read as words, not looked at.
        evidenceNote:
          check === "unread"
            ? `Recorded and shown to the person as not confirmed: ${unreadWords}. Open ${proof.link} in the desktop browser, read it with read_page_text and check that the words you posted are on it; then report again with that address, verified true and what the read showed in seen.${notThereWords}`
            : check === "gone"
              ? `Recorded and shown to the person as not confirmed: ${goneWords} ${proof.link}.${notThereWords}`
              : `Recorded and shown to the person as not confirmed: ${uncheckedWords}. Open ${proof.link} and look whether what you did shows there; then report again with that address, verified true and what you saw in seen.${notThereWords}`,
      },
    };
  if (!gaps.length) {
    const look = proof && steps ? reportLook(proof, input, steps) : null;
    return {
      links: shown,
      permalink,
      key,
      invalid,
      unconfirmed: false,
      reply: { confirmed: true },
      ...(look !== null && steps ? { look: steps[look] } : {}),
    };
  }
  const unconfirmed = !proof;
  const others = gaps.some((gap) => gap === "site" || gap === "action");
  const lacks = `it lacks ${gaps.map((gap) => gapWords[gap]).join(", ")}.`;
  const also = others ? ", with the site and the action" : "";
  const masked = gaps.includes("masked")
    ? " If every address of it holds a withheld value, say in a notice that it shows but its address cannot be given."
    : "";
  const evidenceNote = !unconfirmed
    ? `Recorded: ${lacks} Report it again with the site and the action.`
    : posted
      ? `Recorded and shown to the person as not confirmed: ${lacks} Open the account's own list of what it posted, or the place you posted in, find this item, open it and check that what you did shows there; then report again with that page's address in permalink, permalinkKind item, verified true and what you saw in seen${also}.${notThereWords}${masked}`
      : `Recorded and shown to the person as not confirmed: ${lacks} Open what you did it to (the post or comment, the person's page) and check that what you did shows there; then report again with that page's address in target, verified true and what you saw in seen${also}.${notThereWords}${masked}`;
  return {
    links: shown,
    permalink,
    key,
    invalid,
    unconfirmed,
    ...(unconfirmed ? { why: "address" as const } : {}),
    reply: { confirmed: !unconfirmed, missing: gaps, evidenceNote },
  };
}

/** The command that prints where the desktop's browser is
 * (`openmuse-browser page`, or the client it calls), whose addresses are a page read. */
const pageReadPattern = /\bopenmuse-browser\s+page\b|\bbrowser_client\.py\s+page\b/;
const addressPattern = /https?:\/\/[^\s"'<>\\]+/g;
/**
 * The step of the run's own log (`RunStep`, model.ts) a
 * desktop or browser tool call is, or null: a page read (`openmuse-browser page`'s addresses, from
 * its receipt; read_web's page; read_page_text's address), a typed text (use_desktop type or key), a look at the screen (any
 * other use_desktop action), or any other command (it may type). A receipt started before this run (`since`, a repeated operation id) is no step of it.
 */
export function runStepOf(
  name: string,
  args: unknown,
  result: unknown,
  since: string,
): RunStep | null {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const output = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  if ("error" in output) return null;
  if (name === "read_web")
    return {
      kind: "read",
      urls: [input.url, output.url].filter((url): url is string => typeof url === "string"),
      web: true,
    };
  // Read_page_text read a page of this desktop's browser
  // at its address.
  // With the addresses of the links it showed, which existed then.
  if (name === "read_page_text") {
    if (output.ok !== true || typeof output.url !== "string") return null;
    const links = Array.isArray(output.links)
      ? output.links
          .map((link) => (link as { href?: unknown } | null)?.href)
          .filter((href): href is string => typeof href === "string")
      : [];
    // The words the page showed, so a read of an item's own
    // page can be held against the posted text (`reportRead`); clipped, whitespace folded.
    const text =
      typeof output.text === "string" ? output.text.replace(/\s+/g, " ").slice(0, 60_000) : "";
    return links.length
      ? { kind: "read", urls: [output.url], links, text }
      : { kind: "read", urls: [output.url], text };
  }
  // Every use_desktop action returns the screen; one that types is an input first. The
  // screenshot it returned (the image part) stays with the step: a look's own picture.
  if (name === "use_desktop") {
    if ((input.action === "type" || input.action === "key") && typeof input.text === "string")
      return { kind: "input", text: input.text };
    const shot = desktopShotOf(result);
    return shot ? { kind: "screenshot", shot } : { kind: "screenshot" };
  }
  if (name !== "run_computer_command" || typeof output.command !== "string") return null;
  if (typeof output.startedAt === "string" && output.startedAt < since) return null;
  if (pageReadPattern.test(output.command) && output.status === "succeeded")
    return {
      kind: "read",
      urls: String(output.stdout ?? "").match(addressPattern) ?? [],
    };
  return { kind: "input", text: output.command };
}

/** The screenshot a use_desktop result carries (computer-tools.ts: a text part and an image part
 * with the picture as base64), as bytes; null when it carries none. */
function desktopShotOf(result: unknown): Uint8Array | null {
  if (!Array.isArray(result)) return null;
  for (const part of result) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "image")
      continue;
    const source = (part as { source?: { type?: unknown; value?: unknown } }).source;
    if (source?.type === "data" && typeof source.value === "string" && source.value)
      return Buffer.from(source.value, "base64");
  }
  return null;
}

/** The first non-empty line, for an event title (cut on a code point boundary, see clipText). */
export function reportTitle(text: string) {
  const line =
    text
      .split("\n")
      .map((item) => item.trim())
      .find(Boolean) ?? "Report";
  return clipText(line, 160);
}

/** The client view: the owner stays on the server. */
export function publicReport({ owner: _, ...report }: StoredChatReport): ChatReport {
  return report;
}

/** Reports per request: the default and the most a client may ask for (also the most ids one
 * "seen" request may carry). */
export const reportsPageDefault = 50;
export const reportsPageMax = 100;

export class ChatReports {
  constructor(private readonly db: Store) {}
  /** The conversation a task reports to: the side chat it was delegated from, else the
   * project's current main chat. A task delegated from a main chat that
   * 开新主聊天 has since replaced (`formerIds`) reports to the current one, so a repeating task
   * keeps reporting where the project's conversation now is. Reports already written stay. */
  async threadOf(owner: string, task: Pick<AgentTask, "originThreadId">) {
    const main = await mainRecord(this.db, owner);
    const origin = task.originThreadId;
    if (!origin || origin === main.threadId || main.formerIds?.includes(origin))
      return main.threadId;
    return origin;
  }
  /** Stores a report once under `id`; `created` is false when it already existed. */
  async enqueue(
    owner: string,
    task: Pick<AgentTask, "id" | "title" | "originThreadId"> & {
      input?: AgentTask["input"];
    },
    value: Pick<
      ChatReport,
      | "id"
      | "kind"
      | "title"
      | "text"
      | "links"
      | "posted"
      | "action"
      | "evidence"
      | "evidenceWhy"
      | "seen"
      | "shot"
      | "seenAt"
      | "notice"
      | "speaker"
      | "project"
    >,
  ): Promise<{ report: StoredChatReport; created: boolean }> {
    const existing = await this.db.get<StoredChatReport>(owner, kind, value.id);
    if (existing) return { report: existing, created: false };
    const placed = await this.threadOf(owner, task);
    const main = await mainRecord(this.db, owner);
    const report: StoredChatReport = {
      id: value.id,
      owner,
      taskId: task.id,
      taskTitle: task.title,
      threadId: reportThread(
        placed,
        main.threadId,
        task.input ? taskEnvironmentId(task) : null,
        isHandoffNotice(value.notice?.kind),
      ),
      kind: value.kind,
      title: value.title,
      // Outcome texts can be longer (a finish_task summary allows 8000): cut on a code point
      // boundary, or half an emoji makes the JSON invalid for jsonb and the write fails.
      text: clipText(value.text.trim() || value.title, reportTextMax),
      links: value.links.slice(0, reportLinksMax),
      ...(value.posted ? { posted: clipText(value.posted, reportTextMax) } : {}),
      ...(value.action ? { action: value.action } : {}),
      ...(value.evidence ? { evidence: value.evidence } : {}),
      ...(value.evidence && value.evidenceWhy ? { evidenceWhy: value.evidenceWhy } : {}),
      ...(value.seen ? { seen: clipText(value.seen, 500) } : {}),
      ...(value.shot ? { shot: value.shot } : {}),
      ...(value.seen && value.seenAt ? { seenAt: value.seenAt } : {}),
      ...(value.notice ? { notice: value.notice } : {}),
      ...(value.speaker ? { speaker: value.speaker } : {}),
      ...(value.project ? { project: value.project } : {}),
      createdAt: new Date().toISOString(),
      readAt: null,
      afterMessageId: null,
    };
    // createdAt is the poll cursor, so it is stamped by the database in the insert itself
    // (the value above only stands in when the insert loses a race).
    const inserted = await this.db.insertIfAbsentStamped(owner, kind, report, "createdAt");
    if (inserted) return { report: inserted, created: true };
    return {
      report: (await this.db.get<StoredChatReport>(owner, kind, value.id)) ?? report,
      created: false,
    };
  }
  get(owner: string, id: string) {
    return this.db.get<StoredChatReport>(owner, kind, id);
  }
  /** The card `value.id` written again with what
   * this report says, stamped now and unread again, so a client polling by createdAt fetches it
   * and keeps one card (clients merge by id). Without that card, it is enqueued. */
  async rewrite(
    owner: string,
    task: Pick<AgentTask, "id" | "title" | "originThreadId">,
    value: Parameters<ChatReports["enqueue"]>[2],
  ): Promise<{ report: StoredChatReport; created: boolean }> {
    const existing = await this.db.get<StoredChatReport>(owner, kind, value.id);
    if (!existing) return this.enqueue(owner, task, value);
    await this.db.remove(owner, kind, value.id);
    return this.enqueue(owner, task, value);
  }
  /** A task outcome under its notification key (the id is the notification's id too). */
  outcome(
    owner: string,
    task: Pick<AgentTask, "id" | "title" | "originThreadId">,
    title: string,
    text: string,
    key: string,
  ) {
    return this.enqueue(owner, task, { id: hash(key), kind: "outcome", title, text, links: [] });
  }
  /** A thread's reports, oldest first (by createdAt, then id): the latest `limit`; with
   * `after` the first `limit` created at or after it (so a client cursor never skips any);
   * with `before` the latest `limit` strictly before that createdAt and id (older pages).
   * `filter` is a thread id, or `{ threadId?, taskId? }`: a task's
   * reports in any thread, or with neither every report of the owner (the whole project);
   * each access path has its own page index (db.ts pageIndexes). */
  async list(
    owner: string,
    filter: string | ReportFilter,
    options: { after?: string; before?: { createdAt: string; id?: string }; limit?: number } = {},
  ) {
    const { threadId, taskId }: ReportFilter =
      typeof filter === "string" ? { threadId: filter } : filter;
    const where =
      threadId !== undefined
        ? {
            field: "threadId",
            value: threadId,
            ...(taskId !== undefined ? { also: { taskId } } : {}),
          }
        : taskId !== undefined
          ? { field: "taskId", value: taskId }
          : {};
    return this.db.listPage<StoredChatReport>(owner, kind, {
      ...where,
      // The cards a wait wrote before a wait stopped being a card are never
      // listed, so a page of the newest reports is not taken up by them.
      except: { equal: { kind: "outcome" }, match: { title: legacyWaitCardTitle } },
      order: "createdAt",
      limit: options.limit ?? reportsPageDefault,
      after: options.after,
      before: options.before && {
        value: options.before.createdAt,
        id: options.before.id ?? "",
      },
    });
  }
  /** Records the first time a client shows each report, and after which message, in two
   * statements however many: the current copy of each (unknown ids are left out). */
  async markReadMany(owner: string, ids: string[], afterMessageId: string | null) {
    const unique = [...new Set(ids)];
    await this.db.compareAndSwapMany(
      owner,
      kind,
      unique,
      { readAt: null },
      { readAt: new Date().toISOString(), afterMessageId },
    );
    return this.db.getMany<StoredChatReport>(owner, kind, unique);
  }
  /** Records the first time a client shows the report, and after which message. */
  async markRead(owner: string, id: string, afterMessageId: string | null) {
    const report = await this.db.get<StoredChatReport>(owner, kind, id);
    if (!report) throw new AppError("Report not found", 404);
    if (report.readAt) return report;
    const updated = await this.db.compareAndSwap<StoredChatReport>(
      owner,
      kind,
      id,
      { readAt: null },
      { readAt: new Date().toISOString(), afterMessageId },
    );
    return updated ?? (await this.db.get<StoredChatReport>(owner, kind, id)) ?? report;
  }
}

/** A thread's latest run, sent with a thread's reports so an open
 * conversation follows what other members say in it (null for a thread the owner does not have). */
export type ThreadActivityOf = (owner: string, threadId: string) => Promise<ThreadActivity | null>;

export function chatReportRoutes(
  reports: ChatReports,
  activity?: ThreadActivityOf,
): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => {
    const iso = (value: string | undefined) => value && new Date(value).toISOString();
    const query = z
      .object({
        // Both optional; neither lists the whole project.
        threadId: threadIdSchema.optional(),
        taskId: reportTaskIdSchema.optional(),
        after: z.iso.datetime({ offset: true }).optional(),
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.string().min(1).max(200).optional(),
        limit: z.coerce.number().int().min(1).max(reportsPageMax).default(reportsPageDefault),
      })
      .refine((value) => !(value.after && value.before), "Use either after or before")
      .refine((value) => !value.beforeId || value.before, "beforeId needs before")
      .parse(c.req.query());
    const before = iso(query.before);
    const list = await reports.list(
      c.get("owner"),
      { threadId: query.threadId, taskId: query.taskId },
      {
        after: iso(query.after),
        before: before ? { createdAt: before, id: query.beforeId } : undefined,
        limit: query.limit,
      },
    );
    // The conversation's latest run rides on the 5-second report poll the
    // client already makes; when it changes while the conversation is idle, the client loads it
    // again (another member spoke), with no extra request.
    const thread =
      query.threadId && activity ? await activity(c.get("owner"), query.threadId) : null;
    return c.json({ reports: list.map(publicReport), ...(thread ? { thread } : {}) });
  });
  const json = async (raw: string): Promise<unknown> => {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new AppError("The request body is not valid JSON", 400);
    }
  };
  // A lone surrogate is valid JSON for zod but not for jsonb; refuse it here as a 422 instead of
  // letting the store fail the write (a 502). Real ids and message ids never contain one.
  const wellFormed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };
  const textId = (min: number) =>
    z.string().min(min).max(200).refine(wellFormed, "must be well-formed text");
  const afterMessageId = textId(0).nullable().optional();
  // One request for every report a client shows at once: opening a thread with many unread
  // reports must not spend the per-IP rate limit the chat itself needs.
  app.post("/read", async (c) => {
    const body = z
      .object({
        ids: z.array(textId(1)).min(1).max(reportsPageMax),
        afterMessageId,
      })
      .parse(await json(await c.req.text()));
    const list = await reports.markReadMany(c.get("owner"), body.ids, body.afterMessageId ?? null);
    return c.json({ reports: list.map(publicReport) });
  });
  app.post("/:id/read", async (c) => {
    const body = z.object({ afterMessageId }).parse(await json(await c.req.text()));
    const report = await reports.markRead(
      c.get("owner"),
      c.req.param("id"),
      body.afterMessageId ?? null,
    );
    return c.json(publicReport(report));
  });
  return app;
}
