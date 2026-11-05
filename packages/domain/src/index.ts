import { z } from "zod";

export type WorkspaceMode = "sample" | "live";
export type Section =
  | "today"
  | "chat"
  | "mail"
  | "calendar"
  | "browser"
  | "files"
  | "activity"
  | "connections"
  | "ideas"
  | "goals"
  | "apps"
  | "environments";
export interface Mail {
  id: string;
  threadId: string;
  from: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  date: string;
  unread: boolean;
  label: string;
  attachments: string[];
}
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
}
export const calendarRangeSchema = z
  .object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
  })
  .refine(({ timeMin, timeMax }) => {
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    return duration > 0 && duration <= 366 * 86400000;
  }, "Calendar range must end after it starts and span at most 366 days");
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  url: string;
  createdAt: string;
  source: string;
  parentId?: string;
  fields?: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}
export interface BrowserSession {
  id: string;
  title: string;
  url: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
}
export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: z.string().min(1).max(100000),
  attachmentIds: z.array(z.string()).max(10).default([]),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
});
export const eventDraftSchema = z
  .object({
    calendarId: z.string().default("primary"),
    title: z.string().trim().min(1).max(500),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().default(false),
    timeZone: z.string().default("America/Los_Angeles"),
    location: z.string().max(2000).default(""),
    description: z.string().max(10000).default(""),
    attendees: z.array(z.email()).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      !Number.isFinite(Date.parse(value.start)) ||
      !Number.isFinite(Date.parse(value.end)) ||
      Date.parse(value.end) <= Date.parse(value.start)
    ) {
      ctx.addIssue({ code: "custom", message: "End must be after a valid start", path: ["end"] });
    }
    const dateOnly = z.iso.date();
    const timed = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
    // Validate the calendar date separately so timed values can retain minute precision.
    const validTimestamp = (timestamp: string) =>
      value.allDay
        ? dateOnly.safeParse(timestamp).success
        : timed.test(timestamp) && dateOnly.safeParse(timestamp.slice(0, 10)).success;
    if (!validTimestamp(value.start) || !validTimestamp(value.end)) {
      ctx.addIssue({
        code: "custom",
        message: value.allDay
          ? "All-day events need valid date-only values"
          : "Timed events need valid date-times with an explicit offset",
        path: ["start"],
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid time zone", path: ["timeZone"] });
    }
  });
/** A call of a connected MCP server's tool that is not read-only. */
export const appCallSchema = z.object({
  /** The app's slug (`app_<slug>__<tool>` in the tool's name). */
  app: z.string().min(1).max(60),
  appName: z.string().max(100),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
/** A Slack message, prepared as a draft. */
export const slackMessageSchema = z.object({
  channel: z.string().min(1).max(100),
  channelName: z.string().max(200).optional(),
  text: z.string().trim().min(1).max(4000),
  threadTs: z.string().max(40).optional(),
  /** Who wrote the message a reply answers, and the start of it (for the draft card). */
  threadPreview: z.string().max(200).optional(),
});
export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email.send"), data: emailDraftSchema }),
  z.object({ kind: z.literal("app.call"), data: appCallSchema }),
  z.object({ kind: z.literal("slack.send"), data: slackMessageSchema }),
  z.object({ kind: z.literal("calendar.create"), data: eventDraftSchema }),
  z.object({
    kind: z.literal("calendar.update"),
    data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })),
  }),
  z.object({
    kind: z.literal("calendar.delete"),
    data: z.object({ calendarId: z.string(), eventId: z.string().min(1), title: z.string() }),
  }),
]);
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EventDraft = z.infer<typeof eventDraftSchema>;
export type ProposalInput = z.infer<typeof proposalSchema>;
export interface ActionProposal {
  target?: CalendarEvent;
  targetVersion?: string;
  taskId?: string;
  account?: string;
  connectionId?: string;
  id: string;
  title: string;
  kind: ProposalInput["kind"];
  data: Record<string, unknown>;
  status:
    | "awaiting_review"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  result?: string;
  error?: string;
  /** The check of what an email says about the sender
   * (apps/server/src/mail/claim-check.ts): the statements no source supports, which the review
   * shows, or that the check did not work. */
  claimCheck?:
    | { status: "checked"; unsupported: string[] }
    | { status: "unchecked"; reason: string };
  /** The owner asked to approve this kind first
   * (「以后都先问我」): unanswered, it expires unsent instead of being sent. */
  askFirst?: boolean;
  /** Sent with no decision: its window ended undeclined (`window`), or the owner's
   * 「以后总是允许」 (`rule`). */
  autoApproved?: "window" | "rule" | "review";
  /** The action review's reason, for a run it let through
   * (`autoApproved: "review"`) or for the card it asked on. */
  reviewReason?: string;
  /** A message to people (`isMessageToPeople`): the card says 草稿, 发送 · 不发. */
  draft?: boolean;
  /** A draft a routine made: no rule or review lets it go, it never expires, and its
   * run did not wait on it. */
  fromRoutine?: boolean;
  /** Waits for the owner with no expiry (a chat-started task's, a routine draft). */
  noExpiry?: boolean;
}

/** A kind that is a message to people (email, Slack): prepared as a draft,
 * and never let through by the action review's own judgment. One place to add a kind. */
export const messageKinds: readonly ProposalInput["kind"][] = ["email.send", "slack.send"];
export const isMessageToPeople = (kind: string) =>
  (messageKinds as readonly string[]).includes(kind);

/** Who a message to people goes to, lowercased: an email's
 * addresses, a Slack message's channel. Empty for any other kind. */
export function messageRecipients(input: ProposalInput): string[] {
  if (input.kind === "email.send") {
    const { to, cc, bcc } = input.data;
    return [...new Set([...to, ...cc, ...bcc].map((address) => address.toLowerCase()))];
  }
  if (input.kind === "slack.send") return [`slack:${input.data.channel}`];
  return [];
}

/** A space's action review (`/api/review-settings`). */
export interface ReviewSettings {
  actionReview: boolean;
  askFirst: string[];
  autoAllow: string[];
}
export const reviewRuleListMax = 20;
export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  status: string;
  actionId?: string;
}
export interface Connection {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "sample" | "unconfigured" | "unavailable";
  account?: string;
  capabilities: string[];
}
export interface Workspace {
  mode: WorkspaceMode;
  profile: { name: string; email: string };
  mail: Mail[];
  events: CalendarEvent[];
  files: Artifact[];
  browsers: BrowserSession[];
  actions: ActionProposal[];
  activity: ActivityEntry[];
  connections: Connection[];
  runtime: {
    provider: "sample" | "model" | "openbot";
    configured: boolean;
    openbotConfigured: boolean;
    richThreads?: boolean;
    /** Conversations live on this server. */
    threads?: "local";
    /** Whether a computer is connected; false (未接电脑) hides everything about desktops. Absent
     * from older servers. */
    computer?: boolean;
    /** Conversations still in CopilotKit's cloud (absent when none). */
    cloudThreads?: { state: "failed"; pending: number; reason: string } | { state: "no-key" };
  };
}

/** Provider-independent boundary: OpenBot/AG-UI runs never dictate presentation. */
export interface ExecutionBackend {
  readonly kind: "standalone" | "openbot";
  readonly capabilities: readonly string[];
  health(): Promise<{ available: boolean; detail: string }>;
}

export type { ComputerCommand, ComputerDirectory, ComputerSnapshot } from "./computer.ts";
export { isDesktopProvider } from "./computer.ts";
export type {
  Environment,
  EnvironmentRef,
  EnvironmentSelection,
  EnvironmentSettingsView,
  EnvironmentStatus,
  EnvironmentView,
} from "./environments.ts";
export {
  canonicalLocale,
  canonicalTimezone,
  defaultEnvironmentName,
  environmentAccountLabelMax,
  environmentNameMax,
  environmentsMax,
  isReservedEnvironmentName,
  normalizeEnvironmentName,
  supportedTimezones,
  timezoneCandidates,
} from "./environments.ts";
export * from "./member-templates.ts";
export type { Project, ProjectView } from "./projects.ts";
export {
  defaultProjectName,
  isProjectId,
  isProjectOwner,
  isReservedProjectName,
  normalizeProjectName,
  PROJECT_HEADER,
  parseOwner,
  projectNameMax,
  projectOwner,
  projectsMax,
  realOwnerOf,
} from "./projects.ts";
export type {
  TaskInputReason,
  TaskPhase,
  TaskPhaseCounts,
  TaskPhaseKey,
  TaskPhaseTone,
  TaskPhaseWords,
} from "./task-phase.ts";
export {
  clockLabel,
  durationLabel,
  endedRecently,
  failedNeedsYouMs,
  firstLine,
  inputReason,
  planProgress,
  recentlyEndedMs,
  rhythmLabel,
  runEndedWithoutCompletionQuestion,
  showsSteps,
  taskEnvironmentId,
  taskPhase,
  taskPhaseCounts,
  taskPhaseWordsZh,
} from "./task-phase.ts";
