import { z } from "zod";
import { actionKindPattern, activeHourRange } from "./environments.ts";
import type { JobView } from "./jobs.ts";
import type { Routine } from "./routines.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status: TaskStatus;
  goalId?: string;
  milestoneId?: string;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
  /** Fork: a repeating task runs again this many minutes after each run; null runs once. */
  repeatMinutes?: number | null;
  /** Fork: completed runs of a repeating task. */
  runs?: number;
  /** Set on a routine: its trigger and the history of its runs. */
  routine?: Routine | null;
  /** The conversation thread the task was delegated from; its reports
   * appear there. Unset for tasks created elsewhere (they report to the main thread). */
  originThreadId?: string | null;
  /** The member who asked for the task (in the chat, the one whose message
   * delegated it); unset for tasks made before spaces or by the system. */
  createdBy?: string;
  /** Times the task was resumed, by the person (an answer, Retry, Resume, a
   * decided review) or after a wait_until wait. A report or question repeated after one is
   * shown again. */
  resumes?: number;
  /** An instruction the person gave while the task was
   * running or waiting, picked up by its next run. Top-level, not in `state`: a run's checkpoints
   * write its whole `state` back, which would drop a value written there meanwhile. A wait of an
   * account task that finds it set resumes at once instead of after the wait. */
  pendingAnswer?: string | null;
  /** The person typed this prompt in the new-task form (POST
   * /api/agent/tasks with `typed: true`). A task the chat delegated has `originThreadId` instead;
   * any other task (a goal plan, an idea, a watch) has neither. */
  typedByOwner?: boolean;
  /** An account's loop was given a job while it ran; a wait
   * it ends that run with resumes at once, so it sees the job now. */
  wakeAt?: string | null;
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind: "plan" | "step" | "observation" | "approval" | "result" | "error" | "status" | "report";
  title: string;
  detail: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
}
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  /** v1.2: set when the fact was remembered while this member's desktop was in use. */
  accountId?: string;
}
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
/** A background task's report, shown inline in
 * the conversation it belongs to. `report` comes from the run's report_to_user tool; `outcome`
 * is a task result, failure, question, review or repeating-run result (same dedupe key as its
 * notification). Stored per owner in `chat-reports`. */
export interface ChatReport {
  id: string;
  taskId: string;
  taskTitle: string;
  threadId: string;
  kind: "report" | "outcome";
  /** A short label: "Update", "Finished", "Needs attention", "Needs your input", … */
  title: string;
  /** For the person, in their language: what happened, in a sentence or two. */
  text: string;
  links: string[];
  /** The exact text posted or sent (or affected), verbatim, shown as a
   * quote under `text`; absent when there is none. */
  posted?: string;
  /** An action report's site and the action the AI named. */
  action?: { site: string; action: string };
  /** `missing` on a report that says the
   * account put something on a site without the address of that item itself (or its site or
   * action): recorded, and shown as not confirmed. Absent on every other report. */
  evidence?: "missing";
  /** Why a report with `evidence: "missing"` is not
   * confirmed (`ReportUnconfirmed`); absent on reports stored before it (no item address). */
  evidenceWhy?: ReportUnconfirmed;
  /** On a confirmed action, what the run says it saw when it
   * looked at the item after acting, the id of the picture of that look (the step's own picture,
   * served as an incident's picture, `/api/incidents/<id>/shot`), and when the look happened
   *. */
  seen?: string;
  shot?: string;
  seenAt?: string;
  /** A card about the project's jobs or an account's
   * persona; clients show it on its own, in their words, from these facts. */
  notice?: ChatReportNotice;
  /** Who speaks, when the conversation's project has no such account: the founder's
   * report of a job, copied into the conversation of the project that gave the job. */
  speaker?: { name: string; founder: boolean };
  /** The project a founder's report in the hall is for (its name). */
  project?: string;
  createdAt: string;
  /** When a client first showed it in its conversation; null until then. */
  readAt: string | null;
  /** The last conversation message shown when it was first seen ("" before any message);
   * every client places the report after that message. Null until first seen. */
  afterMessageId?: string | null;
}
/** An account declined a job (`reason` in its own words), took one the owner gave
 * it again after its reason, a job is done and archived, or a task changed an account's persona
 * (`changed` parts, `reason`, `version`). */
export interface ChatReportNotice {
  /** `founder_request`, in the hall: a project's 运营专员 asks the founder
   * for a job (`project`, `jobTitle`, `account` the founder); `in_hall`, in a project: the
   * founder reported on its job there (`jobTitle`), the report itself is in the hall. */
  kind:
    | "job_declined"
    | "job_taken"
    | "job_done"
    | "persona"
    | "founder_request"
    | "in_hall"
    /** In the hall, the founder asks a project's 运营专员 to carry a piece of work on
     * (`project`, `jobTitle`, `account` the founder; `jobId` when it became a job). */
    | "project_request"
    /** In the hall, the owner has been away: the question
     * whether to go on, then the pause (`account` the founder when it says it). */
    | "owner_away";
  project?: string;
  jobId?: string;
  jobTitle?: string;
  environmentId?: string;
  account?: string;
  changed?: string[];
  reason?: string;
  version?: number;
}
export const reportTextMax = 4000;
/** The label of a watch's "change found" report. Its text is the changed page content, so the
 * chat model gets only the label and links (docs/report-back.md). */
export const watchChangeLabel = "Change found";
/** The outcome labels that ask for the person's attention (the card shows them in the danger
 * colour). Labels are fixed strings, never a task's own title, so "Review inbox" is not one. */
export const attentionReportLabels: readonly string[] = [
  "Needs attention",
  "Needs your input",
  "Ready for your review",
  "Run failed",
  "Paused after repeated failures",
  "Watch needs attention",
];
/** The fixed titles of an account task's report cards, in
 * English; clients map them to their own language. A report of an action the task took is
 * titled `actionReportLabel` (the report carries its site and action, which the client shows as
 * they are), any other report by its `topic` (else "Update"); a report that exceeded the
 * account's pacing gets `overPaceSuffix`. Only tasks bound to an account get these titles. */
export const actionReportLabel = "Action";
export const topicReportLabels = { summary: "Summary", notice: "Notice" } as const;
export const overPaceSuffix = " · over pace";
/** An action on something another account of the same
 * project made or on that account itself (`siblingInteractionSuffix`), and an action in the same
 * place another account of the project acted in (`sameTargetSuffix`, naming that account). */
export const siblingInteractionSuffix = " · sibling touched";
export const sameTargetSuffix = (name: string) => ` · same place as ${name}`;
export const sameTargetSuffixPattern = / · same place as (.+)$/;
/** The card of a persona a task changed, one per version. */
export const personaReportLabel = (version: number) => `Persona v${version}`;
export const personaReportLabelPattern = /^Persona v(\d+)$/;
/** The run event of set_account_persona. */
export const personaSetLabel = "Persona set";
/** The card an operating plan sends, one per version. */
export const planReportLabel = (version: number) => `Plan v${version}`;
export const planReportLabelPattern = /^Plan v(\d+)$/;
/** The run event of a wait the server counted as pacing. A wait is never a chat card (fork,
 * report line, docs/report-back.md). */
export const pacingWaitLabel = (minutes: number) =>
  `Waiting ${minutes} ${minutes === 1 ? "minute" : "minutes"} (pacing)`;
/** The title of a card a wait wrote before a wait stopped being a card
 * ("Waiting 30 minutes", "Waiting 30 minutes (pacing)", kind outcome). Those cards are left out
 * of every list of reports (`GET /api/chat-reports`, and the clients). A pattern both a
 * JavaScript RegExp and PostgreSQL's `~` read the same way. */
export const legacyWaitCardTitle = "^Waiting [0-9]+ minutes?( \\(pacing\\))?$";
/** The tool result the chat runtime
 * (@tanstack/ai executeToolCalls) hands the model when a call's arguments did not fit the tool's
 * schema: `{ error: "Input validation failed for tool <name>: …" }`. The model reads it and calls
 * again; it is the model's own working state, never a card for the owner (the clients leave the
 * call out of the conversation). The ToolCallManager path says the same after
 * "Error executing tool: ". Arguments that are not JSON at all are answered
 * "Failed to parse tool arguments as JSON: …" (tanstack-agent.ts `withStrictToolArgs`). */
export const toolInputRejectedPattern =
  /^(?:Error executing tool: )?(?:Input validation failed for tool |Failed to parse tool arguments as JSON: )/;
export function toolInputRejected(result: unknown): boolean {
  let value = result;
  if (typeof value === "string") {
    if (toolInputRejectedPattern.test(value)) return true;
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  const error =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { error?: unknown }).error
      : undefined;
  return typeof error === "string" && toolInputRejectedPattern.test(error);
}
/** The run event of set_plan (its detail: the steps, one per line). */
export const planSetLabel = "Plan set";
/** The run event of set_account_pacing (what the task set for the account, and why). */
export const pacingSetLabel = "Pacing set";
/** The run event of record_account_profile (facts about the account on a site, as read). */
export const profileRecordedLabel = "Profile recorded";
/** Every fixed pacing card label; the plan label carries a number, see its pattern. */
export const pacingReportLabels: readonly string[] = [
  actionReportLabel,
  ...Object.values(topicReportLabels),
];
export const reportLinksMax = 10;
/** The part of the infrastructure an incident is
 * about: what a task waits out and tries again by itself, never a question for the person. */
export const incidentKinds = [
  "proxy",
  "desktop",
  "network",
  "model",
  "rate_limit",
  "sign_in",
] as const;
export type IncidentKind = (typeof incidentKinds)[number];
/** The incident kinds that are the system a run stands on (the
 * operator's to fix), not a site's check, a sign-in or a site's rate limit, which the run itself
 * works around. */
export const systemIncidentKinds: ReadonlySet<IncidentKind> = new Set([
  "proxy",
  "desktop",
  "network",
  "model",
]);
/** The task's infrastructure incident, a fact the server keeps in
 * `state.incident`: what keeps failing (`kind`) and since when. A run sets it by a wait_until
 * with `blocked`; the server sets it when the infrastructure stops a run (`runStopped`). It is
 * open until `resolvedAt`: a wait without `blocked`, an action recorded on the account, or a
 * finished run. The open incident is itself the notice the owner
 * sees (it goes away by itself), and no run reports it. `reportedAt` (and `toldOverAt`) only
 * remain on incidents stored while runs still sent a notice; such an incident that is over is
 * dropped at the next run. */
export interface TaskIncident {
  kind: IncidentKind;
  since: string;
  reportedAt?: string;
  resolvedAt?: string;
  /** When a run was told the incident is over; the next run ends it. */
  toldOverAt?: string;
  /** How many waits in a row the same part has blocked. */
  waits?: number;
}
export function taskIncident(state: AgentTask["state"] | undefined): TaskIncident | null {
  const value = state?.incident as Partial<TaskIncident> | null | undefined;
  if (!value || typeof value !== "object") return null;
  if (!incidentKinds.includes(value.kind as IncidentKind) || typeof value.since !== "string")
    return null;
  return {
    kind: value.kind as IncidentKind,
    since: value.since,
    ...(typeof value.reportedAt === "string" ? { reportedAt: value.reportedAt } : {}),
    ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
    ...(typeof value.toldOverAt === "string" ? { toldOverAt: value.toldOverAt } : {}),
    ...(typeof value.waits === "number" ? { waits: value.waits } : {}),
  };
}
/** The incident while it lasts; null once it is over (or when there is none). */
export function openIncident(state: AgentTask["state"] | undefined): TaskIncident | null {
  const incident = taskIncident(state);
  return incident && !incident.resolvedAt ? incident : null;
}
/** The incident after the infrastructure failed again with `kind` at `at`: the same incident
 * while the same part fails (its `since` and `reportedAt` stay), a new one when another part
 * fails or the last one was over. */
export function incidentAfterFailure(
  current: TaskIncident | null,
  kind: IncidentKind,
  at: string,
): TaskIncident {
  if (current && !current.resolvedAt && current.kind === kind)
    return { ...current, waits: (current.waits ?? 1) + 1 };
  return { kind, since: at, waits: 1 };
}
/** The incident once it is over at `at`: kept (with `resolvedAt`) only when the person was told
 * about it, so the notice that it is over can still be shown once; otherwise gone. */
export function incidentAfterRecovery(
  current: TaskIncident | null,
  at: string,
): TaskIncident | null {
  if (!current) return null;
  if (current.resolvedAt) return current;
  return current.reportedAt ? { ...current, resolvedAt: at } : null;
}
/** A model provider's answer that its balance, quota or billing needs the
 * owner (OpenAI's `insufficient_quota`, "You exceeded your current quota, please check your plan
 * and billing details"; Anthropic's "credit balance is too low"). It does not go away by itself,
 * though some of them come as a 429. The provider's own words only: an error that merely mentions
 * billing (a page a run could not load) is not one (fixer round 3). */
export const providerQuotaPattern =
  /insufficient_quota|exceeded your current quota|billing_not_active|billing (?:details|hard limit|account)|credit balance is too low/i;
/** A relay's own words that the failure is upstream of it (`Upstream request failed`,
 * `"type":"upstream_error"`), as opposed to a refusal of the request itself. */
export const gatewayUpstreamPattern = /\bupstream[ _](?:request|error)\b/i;
/** Whether what stopped a run (a task's, or a chat
 * reply) is the infrastructure, which goes away by itself, rather than a setting only the person
 * can fix. Going away by itself: the run's own deadline (`runDeadline`, a desktop that stopped
 * answering), a dropped stream or connection, an error event inside a stream the provider had
 * already started, and a provider status the provider SDKs themselves retry (408, 409, 429, 5xx:
 * `shouldRetry` in openai and @anthropic-ai/sdk, `retry_codes` in @google/genai). Everything else
 * fails the run as before, so the person sees it: a provider 4xx such as a refused key or an
 * unknown model, a model string or key that is not configured. The message is the only part of
 * the error a run sees (the AG-UI RUN_ERROR event carries no code), so the status is read from it:
 * the leading `401 …` of openai and @anthropic-ai/sdk, or the `"code":401` of @google/genai.
 * A provider answer that names the balance, quota or billing (`providerQuotaPattern`) is never
 * the infrastructure, whatever its status: the task fails into 需要你. Shared with the clients
 * (the chat words such a failure in Chinese instead of showing the relay's line). */
export function stoppedByInfrastructure(detail: string) {
  const message = detail.trim();
  // A balance, quota or billing answer does not go away by itself, even as a 429 (OpenAI's
  // insufficient_quota): only the owner can top up or change the plan.
  if (providerQuotaPattern.test(message)) return false;
  // A gateway that says its upstream failed is reporting the provider behind it, not our request:
  // the same request worked before and works again later, whatever status the gateway relays.
  if (gatewayUpstreamPattern.test(message)) return true;
  const status = Number(
    /^(\d{3})\b/.exec(message)?.[1] ?? /"code":\s*(\d{3})\b/.exec(message)?.[1] ?? "",
  );
  if (status)
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
  return infrastructureStops.some((pattern) => pattern.test(message));
}
const infrastructureStops = [
  /^Model run timed out/, // runDeadline: no progress (a hung desktop) or the hard cap
  /^Connection error\.?$/i, // openai, @anthropic-ai/sdk: no connection
  /^Request timed out\.?$/i, // openai, @anthropic-ai/sdk: the request's own timeout
  /^(fetch failed|terminated)$/i, // undici: no connection; the stream was cut off
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|other side closed)\b/i,
  /response\.failed|stream failed/i, // an error event inside a started Responses stream
  /overloaded|api_error|rate_limit/i, // an error event inside a started Anthropic stream
  // A relay that answered with no events at all; the next request goes through.
  /^empty[ _]stream$/i,
];
/** The action a report names is a short lower-case word the AI
 * chooses (post, comment, reply, message, like, follow...); `none` is not an action. */
export const reportActionPattern = /^[a-z][a-z0-9_-]*$/;
/** What a report's `permalink` is, as the run
 * says: the one item's own page, or a listing (a feed, a search, a place's list), a profile, or
 * something else. Given with every permalink (`reportInputWithSiteSchema`): the server never
 * guesses what an address is. `item` confirms an action; `profile` only one that posts no text,
 * a follow or a profile edit (`reportProof`). */
export const reportLinkKinds = ["item", "listing", "profile", "other"] as const;
/** Report_to_user arguments. */
export const reportInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(reportTextMax)
    .describe(
      "For the person: one or two sentences of what happened (for an action: where and why); the posted text goes in posted",
    ),
  links: z
    .array(z.string().trim().min(1).max(2048))
    .max(reportLinksMax)
    .optional()
    .describe("Addresses of what you report on besides permalink (http or https)"),
  // The posted text apart from the sentence, so the card quotes it.
  posted: z
    .string()
    .trim()
    .min(1)
    .max(reportTextMax)
    .optional()
    .describe(
      "The exact text you posted or sent, verbatim; on a notice, only a text no earlier report quoted",
    ),
  // The action is what the AI says it did, on the site it
  // names; the server infers nothing from links.
  action: z
    .string()
    .trim()
    .toLowerCase()
    .max(32)
    .regex(reportActionPattern, "action must be one short lower-case word, such as post or reply")
    .optional()
    .describe(
      "The kind of action you took as the account, one short lower-case word you keep using for that kind; none or left out when the report is not an action of yours",
    ),
  site: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "The website the action was taken on (its domain or any address on it); required with an action",
    ),
  // The address of the item an action made, as
  // the run opened it after acting; an action report without one (or with one the run itself
  // calls something else) is recorded as not confirmed, unless it posted no text and names what
  // it was done to (`reportProof`).
  permalink: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .describe(
      "The address of the item itself (the post, the reply, the message), never that of what it answers",
    ),
  permalinkKind: z
    .enum(reportLinkKinds)
    .optional()
    .describe(
      "Required with permalink, what it is: item for that one item's own page; listing for a feed, a search or a place's list of items; profile for an account's page; other for anything else",
    ),
  // Whether the run looked at the address after acting, and what it saw
  // there, in its own words. The server checks only that its own steps show that look
  // (`reportCheck`); what the page shows is the run's judgement.
  verified: z
    .boolean()
    .optional()
    .describe(
      "With an action: true only when, after acting, you opened its permalink (or its target), looked at it and saw what you did there",
    ),
  seen: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      "With verified: what you saw there that shows what you did, briefly: the item as others see it and its own address",
    ),
  // What the action was done to, so the server can tell an
  // action on another account of the project. For an action that posts
  // no text (a vote, a like, a follow) it is also what confirms it.
  target: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .describe(
      "When the action was done to something or someone else (a reply, a vote, a like, a follow): the address of that post, comment or person's page",
    ),
  targetUser: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("When the action was done to a person or their content: that user name"),
  // The job the action was for, kept on its ledger row.
  jobId: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("When the action was for a job given to this account: its jobId"),
  // The not-confirmed report of the same
  // action, by the reference its answer gave; the two are one action on the ledger.
  confirms: z
    .string()
    .trim()
    .toLowerCase()
    .max(64)
    .optional()
    .describe(
      "When this report gives the address an earlier report of the same action lacked: the confirms value that report's answer gave",
    ),
  topic: z
    .enum(["summary", "notice"])
    .optional()
    .describe("For a report that is not an action: summary or notice"),
  // No `incident` any more. Infrastructure trouble is never the
  // agent's to report: the server keeps the task's incident and shows it by itself.
});
/** A report with an action names the site it was taken on. Fork
 * (report evidence, docs/report-back.md): a permalink comes with what it is
 * (`permalinkKind`); without it the address would have to be guessed, and a listing given
 * without a kind would read as the item. */
export const reportInputWithSiteSchema = reportInputSchema.superRefine((value, ctx) => {
  if (value.action && value.action !== "none" && !value.site)
    ctx.addIssue({
      code: "custom",
      path: ["site"],
      message: "site is required with an action: the website the action was taken on",
    });
  if (value.permalink && !value.permalinkKind)
    ctx.addIssue({
      code: "custom",
      path: ["permalinkKind"],
      message:
        "permalinkKind is required with permalink: say what the address is (item, listing, profile or other)",
    });
});
/** A report link as an absolute http(s) URL, or null: no user name or password, and a host a
 * person can open, a name with a dot, an IP address or the machine's own (`localhost`). An
 * address without its scheme gets https: a bare host (`forum.example/t/9`, with its port too)
 * and one written without it (`//forum.example/t/9`) alike. A relative
 * path such as `/t/9` or `t/9` read as the host `t` before, and its card's link opened nothing;
 * the machine's own name stays a host (a link on a person's own install, and cards stored with
 * one before, which the clients read through this too). */
export function reportLink(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  // A host with its port (`forum.example:8443/t/9`) is no scheme.
  const scheme = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(text);
  const bare = text.startsWith("//") ? text.slice(2) : text;
  if (!scheme && /^[/\\.?#]/.test(bare)) return null;
  try {
    const url = new URL(scheme ? text : `https://${bare}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    if (url.username || url.password) return null;
    const host = url.hostname;
    if (!host.startsWith("[") && host !== "localhost" && !/^[^.]+(\.[^.]+)+\.?$/.test(host))
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
/** A value withheld from the run, as it reads in what the run copied:
 * the desktop browser's `REDACTED` (`openmuse-browser page`) or the server scrub's `***`
 * (credentials/store.ts). An address holding one does not open as shown. */
export const withheldValuePattern = /REDACTED|\*\*\*/;
/** What an action report lacks before anyone can tell it happened.
 * `masked`: its address holds a withheld value. `target`, the
 * permalink of posted text is the address of what it was put in or replied to. */
export type ReportEvidenceGap = "site" | "action" | "permalink" | "not_item" | "masked" | "target";
/** Why an action report is shown as not confirmed, as the
 * owner reads it: `address`, no address of the item itself; `unverified`, the run did not look at
 * that address after acting and say what it saw there (「没有亲眼确认」). Reports stored with an
 * earlier reason (`target`, `existed`) read as not confirmed without one. */
export const reportUnconfirmedReasons = ["address", "unverified", "unread", "gone"] as const;
export type ReportUnconfirmed = (typeof reportUnconfirmedReasons)[number];
/** Each reason in English, as the run event mark (`[not confirmed: …]`) and the chat read it.
 * `unread`, the run never read the words of
 * the item's own page after acting; `gone`, it read them and they do not show the posted text. */
export const reportUnconfirmedWords: Record<ReportUnconfirmed, string> = {
  address: "no address of the item itself",
  unverified: "the run did not look at it after acting",
  unread: "the item's own page was not read after acting",
  gone: "the item's own page does not show the posted text",
};
/** The address that confirms an action, and what it is to the action:
 * the item it made (`item`), or what an action without text was done to (`profile`, a person's
 * page or the account's own; `target`). */
export interface ReportProof {
  link: string;
  as: "item" | "profile" | "target";
}
export type ReportEvidenceInput = {
  action?: string;
  site?: string;
  posted?: string;
  topic?: string;
  permalink?: string;
  permalinkKind?: (typeof reportLinkKinds)[number];
  target?: string;
  targetUser?: string;
  verified?: boolean;
  seen?: string;
};
/**
 * A report claims that the account did something on a site when
 * it names an `action` (not none) or quotes `posted` without being a notice or a summary. Such a
 * report needs its site, its action and an address on which what it did shows, one that opens as
 * given (no withheld value) and is not a site's front page (the path `/` with no query):
 * - the item it made: `permalink` of kind `item`, never the address it was put in (`target`; fork
 *  , permalinks);
 * - for an action that posts no text (a vote, a like, a follow, a profile edit: no item of its
 *   own), what it was done to: `target`, or a person's page as `permalink` of kind `profile`.
 * What posted text made shows on that item: a profile (the account's own, or the page of the
 * person it was sent or replied to) does not show it, nor does a listing or other, a missing
 * kind, a link only in `links` (a reply naming its `targetUser` was confirmed
 * by the account's own profile, the incident's link). Nothing here knows any site. Null for a
 * report that claims no action (a progress note, a notice, a summary); otherwise what it lacks
 * (empty: confirmed) and the address that confirms it.
 */
export function reportProof(
  input: ReportEvidenceInput,
): { gaps: ReportEvidenceGap[]; proof: ReportProof | null } | null {
  const action = input.action && input.action !== "none" ? input.action : null;
  if (!action && !(input.posted && !input.topic)) return null;
  const gaps: ReportEvidenceGap[] = [];
  if (!input.site?.trim()) gaps.push("site");
  if (!action) gaps.push("action");
  const posted = !!input.posted?.trim();
  const target = posted ? null : openableLink(input.target);
  const link = input.permalink ? reportLink(input.permalink) : null;
  // What posted text was put in or replied to is not what it made.
  const into = posted ? openableLink(input.target) : null;
  let gap: ReportEvidenceGap = "permalink";
  if (link) {
    if (withheldValuePattern.test(input.permalink ?? "")) gap = "masked";
    else if (isFrontPage(link)) gap = "not_item";
    else if (into && sameLink(link, into)) gap = "target";
    else if (input.permalinkKind === "item")
      return { gaps, proof: { link, as: target && sameLink(link, target) ? "target" : "item" } };
    else if (input.permalinkKind === "profile" && !posted)
      return { gaps, proof: { link, as: "profile" } };
    else gap = "not_item";
  }
  if (target) return { gaps, proof: { link: target, as: "target" } };
  if (!link && input.target && !posted && withheldValuePattern.test(input.target)) gap = "masked";
  return { gaps: [...gaps, gap], proof: null };
}
/** What an action report lacks (`reportProof`): null when it claims no action, empty when it
 * is confirmed. */
export function reportEvidenceGaps(input: ReportEvidenceInput): ReportEvidenceGap[] | null {
  return reportProof(input)?.gaps ?? null;
}
/** An address a person can open as given: http(s), no withheld value, not a front page. */
function openableLink(value: string | undefined) {
  const link = value ? reportLink(value) : null;
  return link && !withheldValuePattern.test(value ?? "") && !isFrontPage(link) ? link : null;
}
/** Two report links to the same page: the same address, a trailing slash aside. */
function sameLink(a: string, b: string) {
  const bare = (link: string) => link.replace(/\/+(?=$|[?#])/, "");
  return bare(a) === bare(b);
}
/** One step of a run on its desktop, as the run's own log
 * keeps it in order (model.ts): a page read (`openmuse-browser page`'s addresses, or read_web's,
 * marked `web`: the server's fetch, not this desktop's browser), an input that may carry text (a
 * typed text, a command), or a look at the desktop's screen (a use_desktop screenshot). `at` is
 * when the step happened. A look (a read of this desktop's browser, a screenshot) keeps the
 * desktop's picture at that moment (`shot`: the screenshot the action returned, or one taken as
 * the page was read); the picture of the look that confirms an action is the proof the owner
 * sees (`reportLook`), never the desktop's latest picture at report time. */
export type RunStep =
  | {
      kind: "read";
      urls: readonly string[];
      web?: true;
      at?: string;
      shot?: Uint8Array;
      /** The addresses of the links the page showed (read_page_text),
       * which existed when it was read; never a look at them. */
      links?: readonly string[];
      /** The words the page showed (read_page_text), so a read
       * of an item's own page can be held against the text the run says it posted there. */
      text?: string;
    }
  | { kind: "input"; text: string; at?: string }
  | { kind: "screenshot"; at?: string; shot?: Uint8Array };
/** The whitespace-free form of a text, to find posted text inside what was typed. */
const squeezed = (text: string) => text.replace(/\s+/g, "");
/**
 * The last of a run's steps from `from` on that shows it looked
 * at a page `names` matches, or null: a page read that lists it (one of this desktop's browser
 * only, with `desktop`), or a look at the screen while the browser was last sent there (a command
 * or typed text naming it, or a read listing it, earlier in the run). With `pictured`, only a look
 * that kept its picture counts (the proof shown to the owner is that picture). Only addresses are
 * matched; what the page shows is the run's judgement and never read here. Shared by
 * record_sign_in and report_to_user.
 */
export function lookedAtPage(
  steps: readonly RunStep[],
  names: (word: string) => boolean,
  options: { from?: number; desktop?: boolean; pictured?: boolean } = {},
): number | null {
  const from = options.from ?? 0;
  let there = false;
  let found: number | null = null;
  const look = (at: number, step: RunStep) => {
    if (at < from) return;
    if (options.pictured && !(step.kind !== "input" && step.shot?.length)) return;
    found = at;
  };
  for (const [at, step] of steps.entries()) {
    if (step.kind === "read") {
      if (options.desktop && step.web) continue;
      there = step.urls.some(names);
      if (there) look(at, step);
    } else if (step.kind === "input") {
      const words = step.text.split(/[\s"'`<>()]+/).filter(Boolean);
      if (words.some(names)) there = true;
      // Sent somewhere else (a command or typed text naming another address; production: the
      // desktop went to another site's login page after the reply): not there any more.
      else if (words.some((word) => reportLink(word) !== null)) there = false;
    } else if (there) look(at, step);
  }
  return found;
}
/**
 * The step of a run that is its
 * look at the address confirming an action (`reportProof`), or null: a look (`lookedAtPage`) that
 * kept its picture, after the last step that typed the posted text, or, when no step carries it
 * (typed from a file, in pieces), after the run's last input on the desktop that names no address
 * (one naming an address only sends the browser somewhere): a look from before the typing is the
 * page before the action. What the page shows is the run's judgement.
 */
export function reportLook(
  proof: ReportProof,
  input: Pick<ReportEvidenceInput, "posted">,
  steps: readonly RunStep[],
): number | null {
  const names = (word: string) => {
    const link = reportLink(word);
    return !!link && sameLink(link, proof.link);
  };
  return lookedAtPage(steps, names, { from: actionStep(input, steps) + 1, pictured: true });
}
/** The step of a run that is its action (`reportLook`): the last that typed the posted text, else
 * the run's last input that names no address; -1 when there is none (an action by clicks). */
function actionStep(input: Pick<ReportEvidenceInput, "posted">, steps: readonly RunStep[]) {
  const head = squeezed(input.posted ?? "").slice(0, 24);
  let typed = -1;
  let last = -1;
  steps.forEach((step, at) => {
    if (step.kind !== "input") return;
    if (head && squeezed(step.text).includes(head)) typed = at;
    else if (!step.text.split(/[\s"'`<>()]+/).some((word) => !!word && reportLink(word))) last = at;
  });
  return typed >= 0 ? typed : last;
}
/**
 * Whether the address that confirms posted text
 * as its item already existed before the run acted: a page the run read before the step that is
 * its action (`actionStep`), or a link on one (read_page_text's links). What posting makes has an
 * address of its own that did not exist before; the place it was posted in, the account's profile
 * or any address the run could already see is not that item. Nothing here knows any site.
 */
export function reportExisted(
  proof: ReportProof,
  input: Pick<ReportEvidenceInput, "posted">,
  steps: readonly RunStep[],
): boolean {
  if (proof.as !== "item" || !input.posted?.trim()) return false;
  const before = actionStep(input, steps);
  const names = (url: string) => {
    const link = reportLink(url);
    return !!link && sameLink(link, proof.link);
  };
  return steps
    .slice(0, Math.max(before, 0))
    .some((step) => step.kind === "read" && [...step.urls, ...(step.links ?? [])].some(names));
}
/**
 * Whether a report whose address confirms an action (`reportProof`) is also verified: the run
 * says it looked at that address after acting and what it saw there (`verified`, `seen`), and,
 * when the run's steps are known, they hold that look with its picture (`reportLook`). Null when
 * verified, else `unverified` (「没有亲眼确认」).
 */
export function reportCheck(
  proof: ReportProof,
  input: Pick<ReportEvidenceInput, "posted" | "verified" | "seen">,
  steps?: readonly RunStep[],
): "unverified" | "unread" | "gone" | null {
  // A caller without the run's steps takes the run's
  // word; with them, the steps decide (a pictured look at the address after acting, and, for
  // posted text, a read of that page's words that hold it), and the run's word is not needed.
  if (!steps) return input.verified === true && input.seen?.trim() ? null : "unverified";
  if (reportLook(proof, input, steps) === null) return "unverified";
  return reportRead(proof, input, steps);
}
/**
 * For posted text confirmed by its item, the run's
 * last read of that address's words (`RunStep.text`, from read_page_text) after the step that is
 * the action: `unread` when there is none (a screenshot or the browser's address line is not a
 * read of the words), `gone` when those words do not hold the posted text's head (the item's page
 * does not show it: removed, held, or never kept), null when they do. An action without text,
 * or one confirmed by what it was done to, is not read this way. Nothing here knows any site.
 */
export function reportRead(
  proof: ReportProof,
  input: Pick<ReportEvidenceInput, "posted">,
  steps: readonly RunStep[],
): "unread" | "gone" | null {
  const head = squeezed(input.posted ?? "").slice(0, 24);
  if (proof.as !== "item" || !head) return null;
  const from = actionStep(input, steps) + 1;
  let read: string | undefined;
  for (const [at, step] of steps.entries()) {
    if (at < from || step.kind !== "read" || step.web || step.text === undefined) continue;
    if (step.urls.some((url) => reportLink(url) && sameLink(reportLink(url) ?? "", proof.link)))
      read = step.text;
  }
  if (read === undefined) return "unread";
  return squeezed(read).includes(head) ? null : "gone";
}
/** A site's front page: the path `/` with no query and no fragment (a page a single-page site
 * routes by its fragment is not one). */
function isFrontPage(link: string) {
  const url = new URL(link);
  return url.pathname === "/" && !url.search && (!url.hash || url.hash === "#");
}
/** Set_operating_plan arguments, the plan a task working toward an
 * operating goal (promote, run or grow something on an account) drafts itself before its first
 * action. Nobody approves it: the run goes on with it at once. */
export const operatingPlanSchema = z.object({
  communities: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100).describe("The place, as the site names it"),
        why: z.string().trim().max(300).describe("Why it suits the goal"),
        rule: z.string().trim().max(300).describe("The one rule that matters there"),
      }),
    )
    .describe("选区: the places you chose to act in"),
  forms: z.string().trim().max(1000).describe("内容形式: per place, the kinds of action you chose"),
  voice: z
    .string()
    .trim()
    .max(1500)
    .describe(
      "口径: how this plan carries out the account's persona toward the goal, what it may claim and what it never says",
    ),
  pace: z.string().trim().max(300).describe("节奏: the pacing set for this account, and why"),
  review: z.string().trim().max(300).describe("复盘: when you send summary reports"),
  horizon: z.string().trim().min(1).max(300).describe("期限: how long it runs"),
});
export type OperatingPlanInput = z.output<typeof operatingPlanSchema>;
/** Set_account_pacing arguments. The task bound to an
 * account decides the account's pacing itself, from the facts in its pacing block, and records
 * it here with its reason; an omitted field (or kind) is left as it is, null unsets the task's
 * value. Only the type is checked: whole numbers, not negative; hours inside a day with the start
 * before the end; a kind is `<site>/<action>`. A field or kind the person set by hand is left as
 * it is and reported back as owner-locked. */
const pacingWhole = (name: string) =>
  z.number().int(`${name} must be a whole number`).min(0, `${name} must not be negative`);
const pacingHour = z
  .number()
  .int("activeHours must be whole hours")
  .min(activeHourRange[0])
  .max(activeHourRange[1]);
export const pacingKindSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(actionKindPattern, "a kind is <site>/<action>, such as example.com/post");
export const pacingCapsSchema = z.record(pacingKindSchema, pacingWhole("a cap").nullable());
// An array of exactly two, not z.tuple: a tuple becomes prefixItems (or array items), which the
// model API rejects in a tool's input schema (activeHoursPair gives the [start, end] pair).
export const pacingActiveHoursSchema = z
  .array(pacingHour)
  .length(2)
  .refine(
    ([start, end]) => start !== undefined && end !== undefined && start < end,
    "activeHours start must be before its end",
  );
/** The parsed hours as the [start, end) pair they are (the schema checked there are two). */
export const activeHoursPair = (hours: readonly number[]): [number, number] =>
  hours.slice(0, 2) as [number, number];
export const accountPacingInputSchema = z
  .object({
    minGapMinutes: pacingWhole("minGapMinutes")
      .nullable()
      .optional()
      .describe("Minutes between two actions of any kind"),
    activeHours: pacingActiveHoursSchema
      .nullable()
      .optional()
      .describe("Local hours [start, end) in the account's time zone in which it acts"),
    caps: pacingCapsSchema
      .optional()
      .describe(
        "Actions per local day by kind (<site>/<action>, as in usedToday); 0 turns a kind off",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe("Why these values, from the facts; the person reads it on the account"),
  })
  .refine(
    (input) =>
      input.minGapMinutes !== undefined ||
      input.activeHours !== undefined ||
      (input.caps !== undefined && Object.keys(input.caps).length > 0),
    "set_account_pacing needs at least one of minGapMinutes, activeHours, caps",
  );
export type AccountPacingInput = z.output<typeof accountPacingInputSchema>;
/** Record_account_profile arguments: facts about the account
 * on one site, as the task read them there itself (its own profile page, settings, counters).
 * Free-form keys and values, kept as written: the server does not interpret them. */
export const accountProfileInputSchema = z.object({
  site: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe("The website these facts are about (its domain or any address on it)"),
  facts: z
    .record(
      z.string().trim().min(1).max(64),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((facts) => Object.keys(facts).length > 0, "facts needs at least one fact")
    .refine(
      (facts) => JSON.stringify(facts).length <= reportTextMax,
      `facts must be ${reportTextMax} characters or fewer as JSON`,
    )
    .describe("What you read about the account there"),
});
export type AccountProfileInput = z.output<typeof accountProfileInputSchema>;
/** The saved plan (`task.state.operatingPlan`): the latest version, 1 for the first. */
export interface OperatingPlan extends OperatingPlanInput {
  version: number;
  setAt: string;
}
/** The plan a task saved, or null. */
export function operatingPlanOf(state: Record<string, unknown> | undefined): OperatingPlan | null {
  const plan = state?.operatingPlan as Partial<OperatingPlan> | null | undefined;
  return plan && typeof plan === "object" && typeof plan.version === "number" && plan.communities
    ? (plan as OperatingPlan)
    : null;
}
/** The headings of a plan card's sections, in the card's order. */
export const operatingPlanHeadings = {
  communities: "选区",
  forms: "内容形式",
  voice: "口径",
  pace: "节奏",
  review: "复盘",
  horizon: "期限",
} as const;
/** The text of a plan (the card titled `planReportLabel(version)` and the `plan` run event): six
 * sections. With `max` (the card: `reportTextMax`) a plan longer than that keeps all six
 * sections and their headings: the space left after the headings is shared out, a section
 * shorter than its share keeps its whole text and leaves the rest to the others, and a longer
 * one is clipped to its share (`clipText`, on a code point boundary), so the card never loses
 * 复盘 or 期限 at its end. Without `max` the whole text (the run event). */
export function operatingPlanText(plan: OperatingPlanInput, max?: number) {
  const h = operatingPlanHeadings;
  const communities = plan.communities
    .map(
      (item) =>
        `- ${item.name}${item.why ? ` — ${item.why}` : ""}${item.rule ? `（规则：${item.rule}）` : ""}`,
    )
    .join("\n");
  const sections: [heading: string, body: string][] = [
    [`${h.communities}：\n`, communities],
    [`${h.forms}：`, plan.forms],
    [`${h.voice}：`, plan.voice],
    [`${h.pace}：`, plan.pace],
    [`${h.review}：`, plan.review],
    [`${h.horizon}：`, plan.horizon],
  ];
  const text = (parts: [string, string][]) =>
    parts.map(([heading, body]) => heading + body).join("\n\n");
  const whole = text(sections);
  if (max === undefined || whole.length <= max) return whole;
  let left = max - (whole.length - sections.reduce((sum, [, body]) => sum + body.length, 0));
  const shares = new Array<number>(sections.length);
  const shortestFirst = sections
    .map((_, index) => index)
    .sort((a, b) => sections[a][1].length - sections[b][1].length);
  shortestFirst.forEach((index, position) => {
    const share = Math.max(
      0,
      Math.min(sections[index][1].length, Math.floor(left / (sections.length - position))),
    );
    shares[index] = share;
    left -= share;
  });
  return text(
    sections.map(([heading, body], index) => [
      heading,
      shares[index] > 0 ? clipText(body, shares[index]) : "",
    ]),
  );
}
/** A new instruction for a task the person already started
 * (`POST /api/agent/tasks/:id/redirect`, the chat's redirect_task). */
export const redirectInputSchema = z.object({ text: z.string().trim().min(1).max(4000) });
/** Where the person resumed a task, in the instructions its runs read
 * (`state.answer`). What they said before the mark about pausing for now is done; the run told
 * so goes on instead of pausing again. Their own words on resuming follow it. */
export const resumedMark = "[resumed by the person]";
/** The task's answer with the resume mark (and the person's words on resuming) added. */
export function resumedAnswer(previous: string, words?: string) {
  const said = words?.trim();
  const mark = said ? `${resumedMark} ${said}` : resumedMark;
  return previous ? `${previous}\n---\n${mark}` : mark;
}
/** The result a task paused by the person (or by its run, on their words) keeps. */
export const pausedResult = "Paused. Resume when you're ready.";
/** The project brief, the person's own notes on the project's product
 * (what it is, links, prices, what never to say). One per project; empty text when none. */
export const projectBriefMax = 4000;
export const projectBriefSchema = z.object({ text: z.string().trim().max(projectBriefMax) });
export interface ProjectBrief {
  text: string;
  updatedAt: string | null;
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  showChatUpdates?: boolean;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string };
  /** The project's jobs (archived ones without their brief). */
  jobs?: JobView[];
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan"]).default("agent"),
  goalId: z.string().optional(),
  milestoneId: z.string().min(1).max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  // Fork: minutes between runs of a repeating task (agent and plan kinds); omit or null = once.
  repeatMinutes: z.number().int().min(1).max(10080).nullable().optional(),
});
export const repeatMinutesMax = 10080;
/** The first `max` UTF-16 code units of `text`, never ending in the first half of a surrogate
 * pair: a lone surrogate is escaped by JSON.stringify and refused by Postgres jsonb, so a
 * record holding one cannot be written. */
export function sliceText(text: string, max: number) {
  const cut = text.slice(0, Math.max(0, max));
  return cut.length < text.length && /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** `text` cut to at most `max` code units with an ellipsis, on a code point boundary. */
export function clipText(text: string, max: number) {
  return text.length > max ? `${sliceText(text, max - 1).trimEnd()}…` : text;
}
/** A task's default title: the prompt, cut with an ellipsis when it is long. */
export function taskTitle(prompt: string) {
  return clipText(prompt.trim(), 90);
}
export const repeatableTaskKinds = new Set(["agent", "plan"]);
/** Fork: the longest single wait_until (one day); a longer wait calls it again. */
export const waitMinutesMax = 1440;
/** Fork: wait_until arguments. A background run pauses its own task and runs it again later. */
export const waitUntilSchema = z.object({
  minutes: z
    .number()
    .int()
    .min(1)
    .max(waitMinutesMax)
    .describe("Whole minutes until the task runs again (a longer wait is several waits)"),
  note: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Your handoff to the next run; only that run reads it"),
  // A wait because the infrastructure failed opens or keeps the task's
  // incident; any other wait ends it.
  blocked: z
    .enum(incidentKinds)
    .optional()
    .describe("Only when waiting because something failed: the part that failed"),
});
/** Fork: saved in `state.wait` when a run ends with wait_until. */
export interface TaskWait {
  minutes: number;
  note: string;
  since: string;
  until: string;
  /** Set when the first run after the wait starts: that run picks up where the note leaves off,
   * and later runs of the task check whether the note's next step was already done. */
  resumedAt?: string;
  /** The server found this wait to be the account's pacing (docs/pacing.md);
   * it is not counted in `state.waits`. */
  pacing?: boolean;
}
/** Fork: the wait_until record whose resume time is still the task's next run, whatever the
 * status (a task paused during its wait); null when there is none, when Run now or a later run
 * has moved the next run, or once the run after the wait has started. */
export function taskWait(task: Pick<AgentTask, "nextRunAt" | "state">): TaskWait | null {
  const wait = task.state?.wait as Partial<TaskWait> | null | undefined;
  if (!wait || typeof wait !== "object" || typeof wait.note !== "string") return null;
  if (typeof wait.until !== "string" || wait.until !== task.nextRunAt) return null;
  if (wait.resumedAt) return null;
  return wait as TaskWait;
}
/** Fork: the wait a task is in right now: scheduled to resume at the time its wait_until set. */
export function currentWait(
  task: Pick<AgentTask, "status" | "nextRunAt" | "state">,
): TaskWait | null {
  return task.status === "scheduled" ? taskWait(task) : null;
}
/** A run of a task bound to an account that the
 * infrastructure stopped outside the model's tools (the model provider failed, the network
 * dropped, the run's deadline passed because a desktop hung). `state.runFailure` holds it until
 * the next run starts, which is told about it and decides itself whether to wait longer. */
export interface TaskRunFailure {
  /** What stopped the run, as the server saw it (data, never shown in the chat). */
  detail: string;
  /** When this run was stopped. */
  at: string;
  /** When the first of the runs stopped in a row was stopped (`at` for the first). */
  since: string;
  /** How many runs were stopped in a row, this one included (1 for the first). */
  count: number;
}
export function taskRunFailure(state: AgentTask["state"] | undefined): TaskRunFailure | null {
  const failure = state?.runFailure as Partial<TaskRunFailure> | null | undefined;
  if (!failure || typeof failure !== "object") return null;
  if (typeof failure.detail !== "string" || typeof failure.at !== "string") return null;
  return {
    detail: failure.detail,
    at: failure.at,
    since: typeof failure.since === "string" ? failure.since : failure.at,
    count:
      typeof failure.count === "number" && Number.isInteger(failure.count) && failure.count > 0
        ? failure.count
        : 1,
  };
}
/** How much longer than the worker's lease the next run waits after `count`
 * runs in a row were stopped by the infrastructure (a model provider down, a desktop that does
 * not answer). The first is taken up again as before (the lease, about a minute); then 2, 4, 8, 16
 * minutes, at most 30, so an outage of hours costs a few runs an hour, not one a minute. Any run
 * that is not stopped starts the count over. The same for every task, account and service. */
export function stoppedRetryDelayMs(count: number): number {
  if (count <= 1) return 0;
  return Math.min(30, 2 ** (count - 1)) * 60_000;
}
/** v1.2: the
 * time a stopped run's error says its limit comes back, plus a minute, as an ISO date; null when it
 * names none, one already past, or one more than `quotaResetMaxDays` away (not to be trusted). */
export const quotaResetMaxDays = 8;
export function quotaResetAt(detail: string, now: number): string | null {
  const said =
    /\breset(?:s)? at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}) ?([+-]\d{2}):?(\d{2})/i.exec(
      detail,
    );
  if (!said) return null;
  const at = Date.parse(`${said[1]}T${said[2]}${said[3]}:${said[4]}`);
  if (!Number.isFinite(at) || at <= now || at > now + quotaResetMaxDays * 86_400_000) return null;
  return new Date(at + 60_000).toISOString();
}
/** The run event of a one-off run that ended without a completion call and
 * continues by itself (no count and no limit: there is none). */
export const continuingLabel = "Continuing automatically";
/** The run event of such a run (its detail: what stopped it, then `Resumes at <time>`). */
export const runStoppedLabel = "Run stopped by the infrastructure; it runs again by itself";
/** The run event of a run that reached the run's own time limit
 * (model.ts `runDeadline`'s hard cap). Not the infrastructure and no incident: the next run goes on
 * at once. */
export const runCappedLabel = "Run reached its time limit; the next run goes on";
/** Whether what ended a run is the run's own time limit (`runDeadline`'s hard cap), not its idle
 * deadline (a desktop that stopped answering). */
export const runCapped = (detail: string) =>
  /^Model run timed out after \d+ minutes\b/.test(detail.trim());
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
  });
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default("Personal"),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});
