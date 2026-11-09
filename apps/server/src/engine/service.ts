import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMemory,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  actionReportLabel,
  clipText,
  continuingLabel,
  createTaskSchema,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  type IncidentKind,
  incidentAfterFailure,
  incidentAfterRecovery,
  type Monitor,
  monitorInputSchema,
  type ProjectBrief,
  pausedResult,
  projectBriefSchema,
  providerQuotaPattern,
  quotaResetAt,
  type RunEvent,
  type RunStep,
  redirectInputSchema,
  repeatableTaskKinds,
  repeatMinutesMax,
  reportInputWithSiteSchema,
  reportLink,
  reportProof,
  reportUnconfirmedWords,
  resumedAnswer,
  runCapped,
  runCappedLabel,
  runStoppedLabel,
  sliceText,
  stoppedRetryDelayMs,
  type TaskIncident,
  type TaskRunFailure,
  type TaskWait,
  taskIncident,
  taskRunFailure,
  taskTitle,
  taskWait,
  topicReportLabels,
  watchChangeLabel,
} from "../../../../packages/domain/src/agent.ts";
import type {
  CredentialRequestView,
  CredentialUsedBy,
  SiteSignInFact,
} from "../../../../packages/domain/src/credentials.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import { isMessageToPeople, messageRecipients } from "../../../../packages/domain/src/index.ts";
import { identityName } from "../../../../packages/domain/src/member-face.ts";
import { yukiMemberId } from "../../../../packages/domain/src/member-files.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import {
  type AuthBlock,
  authBlockOf,
  isRoutine,
  mailPollMs,
  type Routine,
} from "../../../../packages/domain/src/routines.ts";
import {
  failedRunsBeforeOwner,
  infrastructureNoteLabel,
  isStandingTask,
  ownerOnlyFailure,
  runTroubleLabel,
  standingRevivedLabel,
} from "../../../../packages/domain/src/standing.ts";
import { taskEnvironmentId } from "../../../../packages/domain/src/task-phase.ts";
import { firstRunPlan, nextClockRun } from "../../../../packages/domain/src/template-setup.ts";
import { readAccountZone } from "../account-settings.ts";
import { AccountOperating } from "../accounts/operating.ts";
import { type ActionService, isAppKind, reviewExpired } from "../actions.ts";
import type { AppsService } from "../apps/service.ts";
import type { BrowserService } from "../browser.ts";
import type { AttachmentStore } from "../chat/attachment-store.ts";
import { ComputerService, desktopConflict } from "../computer.ts";
import type { Config } from "../config.ts";
import {
  handledStands,
  type OwnerHandled,
  ownerHandledKind,
  readSignIns,
  signInKind,
  writeSignIn,
} from "../credentials/facts.ts";
import { siteOf } from "../credentials/site.ts";
import { SignInTools } from "../credentials/tools.ts";
import type { Store } from "../db.ts";
import {
  EnvironmentService,
  envOwner,
  isEnvironmentId,
  parseEnvOwner,
  scopeOfOwner,
} from "../environments.ts";
import { AppError } from "../errors.ts";
import type { AgentExtension } from "../extensions.ts";
import type { Files } from "../files.ts";
import { allowAllGate, type PlanGate, type SpaceScopes } from "../gate.ts";
import type { ImageGeneration } from "../image-generation.ts";
import { backgroundFailure } from "../log.ts";
import { isMailboxConnection } from "../mail/channels.ts";
import { MemberFiles, type MemberRef } from "../member-files/service.ts";
import { DiskMemberFileStore, MemoryMemberFileStore } from "../member-files/store.ts";
import { currentActor } from "../request-actor.ts";
import {
  askActionReview,
  decideReview,
  needsModel,
  readReviewSettings,
} from "../review/action-review.ts";
import { SearchService } from "../search.ts";
import { Skills } from "../skills.ts";
import type { WorkspaceService } from "../workspace.ts";
import {
  type AccountAction,
  accountActionsKind,
  confirmsRef,
  ledgerDays,
  ledgerKey,
  lookOnly,
  normalizeLink,
} from "./action-ledger.ts";
import {
  ChatReports,
  confirmsWords,
  type ReportEvidenceReply,
  type ReportKey,
  reportEvidence,
  reportLinks,
  reportTitle,
  threadIdSchema,
  unconfirmedMark,
  unconfirmedMarks,
  unconfirmedOf,
} from "./chat-reports.ts";
import { analyzeSpending } from "./finance.ts";
import { executeModelTask, runEndedWithoutCompletion, stoppedIncidentKind } from "./model.ts";
import { backupState, backupWords, modelSpec, takeBackup } from "./model-fallback.ts";
import {
  countPageDiff,
  describePageDiff,
  diffPage,
  pageLines,
  withoutRelativeTimes,
} from "./page-diff.ts";
import {
  type ReviewRule,
  reviewRuleFor,
  reviewRuleId,
  reviewRulesKind,
  ruleKindOf,
  settleDueReview,
} from "./review-window.ts";
import { Routines } from "./routines.ts";
import { actionLedgerOf } from "./standing.ts";
import { drainFileName, LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** A ledger row a report adds. `replaces` is the row a report of the same action without its
 * address wrote, which this one takes over (`ledgerEntry`). */
type LedgerEntry = AccountAction & { replaces?: string };
/** A change watch's last saved page: its hash, relative-time-free fingerprint and lines. */
type MonitorPage = { id: string; hash?: string; timelessHash?: string; lines: string[] };
const date = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled"]);
function planTitles(kind: AgentTask["kind"]) {
  return kind === "document"
    ? [
        "Find the source document",
        "Fill a new copy",
        "Prepare a reply",
        "Wait for your decision",
        "Record the outcome",
      ]
    : kind === "monitor"
      ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
      : kind === "finance"
        ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
        : ["Understand the outcome", "Plan the work", "Use connected tools", "Return a result"];
}
/** The chat report label of a repeating run's or a watch's notice. Labels
 * are fixed strings (the card's colour follows them, see attentionReportLabels); a notice title
 * that carries the task's own title is never one. */
export function noticeLabel(notice: { title: string; key: string }) {
  if (notice.key.startsWith("task-run:")) return `Run ${notice.key.split(":").at(-1)} finished`;
  if (notice.key.startsWith("task-run-error:"))
    return notice.key.endsWith(":paused") ? "Paused after repeated failures" : "Run failed";
  if (notice.key.startsWith("monitor:")) return watchChangeLabel;
  if (notice.key.startsWith("watch-error:")) return "Watch needs attention";
  return notice.title;
}
/** What report_to_user returns to the run. `reported`
 * is false for an incident notice that is not shown (a repeat, or the end of an incident the
 * person was never told about); `incident` is the task's incident as the server keeps it after
 * the report, present only when the report changed it (the run writes it into the task's
 * state, model.ts). */
export interface ReportReply {
  reported: boolean;
  alreadyReported?: boolean;
  links?: string[];
  ignoredLinks?: string[];
  note?: string;
  progress?: boolean;
  /** When the action this report recorded was taken (the run keeps it as the
   * task's latest action, `state.planActivity`; not shown to the model). */
  actedAt?: string;
  /** `confirms` named no report waiting for its address. */
  confirmsNote?: string;
  incident?: TaskIncident | null;
}
/** The reply also says whether an action the report claims can be told
 * apart from nothing (`confirmed`), and when not, what it lacks and how to find it. */
export type ReportReplyWithEvidence = ReportReply & Partial<ReportEvidenceReply>;
/** A report's posted text; a placeholder the model writes when nothing was posted ("none",
 * "N/A", "无") is no text. */
export function postedText(posted: string | undefined): string | undefined {
  return posted && !/^\s*(none|null|n\/?a|nothing|-+|无|没有)\s*\.?\s*$/i.test(posted)
    ? posted
    : undefined;
}

/** What a review ends in when the person did not approve it. */
const notApprovedStatuses = new Set<ActionProposal["status"]>(["denied", "expired", "cancelled"]);

/** How long after it failed a standing task on the default desktop is still
 * taken up again by itself (its own window, not the display rule's). */
/** A routine is a repeating task that carries a `routine` field. */
const isRoutineTask = (task: AgentTask) => !!task.routine;
const standingReviveWindowMs = 7 * 24 * 60 * 60 * 1000;
/** The loop is told of an owner's turn with this run event, and a
 * owner's turn this old that nothing confirmed and no check took gets its own check (maintain). */
export const ownerTookOverLabel = "Owner took over";
/** The run event of a run that ended because another run had its
 * desktop (`desktopHeld`); the task runs again after `desktopHeldRetryMs`. */
export const desktopHeldLabel = "Desktop in use by another run; it runs again by itself";
export const desktopHeldRetryMs = 60 * 1000;
export const ownerHandledStaleMs = 10 * 60 * 1000;
/** What a loop mid-run is told of a
 * owner's turn, through the redirect channel (read with its next tool's result, or at its next run). */
export const ownerHandledHandIn = (site: string) =>
  `${site}：主人在桌面里处理过了。先看一眼并用 record_sign_in 记下所见，过了就接着做。`;

/** When the run only opened pages (`reportsEarlierAction`), the row of this task's that
 * waits for its address (unconfirmed, the same site and action, written in the last day) which a
 * report without `confirms` is about: the one whose
 * target is the report's target, or whose target or links share with the reported address a
 * path that names an item (a segment with a digit: the thread the reply is in). The latest such
 * row; none when nothing ties them. */
/** Whether a report is about an action of an earlier run (it is told again), by the run's steps:
 * this run typed nothing (every input names an address: it only opened pages). A run that typed
 * words or keys acted itself, and its report is an action of its own; unknown steps, the same. */
export function reportsEarlierAction(steps: readonly RunStep[] | undefined): boolean {
  if (!steps) return false;
  return !steps.some(
    (step) =>
      step.kind === "input" &&
      !step.text.split(/[\s"'`<>()]+/).some((word) => !!word && reportLink(word) !== null),
  );
}
export function waitingRowFor(
  rows: readonly AccountAction[],
  of: { taskId: string; site: string; action: string; now: number },
  reported: { address: string | null; target: string | null; links: readonly string[] },
): AccountAction | undefined {
  const bare = (value: string) => {
    try {
      const url = new URL(value);
      return {
        host: url.host.replace(/^www\./, ""),
        path: url.pathname.split("/").filter(Boolean),
      };
    } catch {
      return null;
    }
  };
  const sharesItem = (a: string | null | undefined, b: string | null | undefined) => {
    const x = a ? bare(a) : null;
    const y = b ? bare(b) : null;
    if (!x || !y || x.host !== y.host) return false;
    for (let i = 0; i < Math.min(x.path.length, y.path.length); i++) {
      if (x.path[i] !== y.path[i]) return false;
      if (/\d/.test(x.path[i])) return true;
    }
    return false;
  };
  const sameTarget = (a: string | null | undefined, b: string | null | undefined) => {
    const x = a ? bare(a) : null;
    const y = b ? bare(b) : null;
    return !!x && !!y && x.host === y.host && x.path.join("/") === y.path.join("/");
  };
  return rows
    .filter(
      (row) =>
        !!row.unconfirmed &&
        row.taskId === of.taskId &&
        row.site === of.site &&
        row.action === of.action &&
        of.now - Date.parse(row.at) < 86400000,
    )
    .filter((row) => {
      const theirs = [row.target ?? null, ...(row.links ?? [])];
      return (
        sameTarget(reported.target, row.target) ||
        theirs.some((link) => sharesItem(reported.address, link)) ||
        theirs.some((link) => reported.links.some((mine) => sharesItem(mine, link)))
      );
    })
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}
/** Whether `next` is another incident than `current` (not the same one
 * counted again: its waits change, its part and start do not). */
function isNewIncident(next: TaskIncident | null, current: TaskIncident | null) {
  return !!next && (next.kind !== current?.kind || next.since !== current?.since);
}
/** v1.7 启动链瘦身: the snapshot's worker field. The heartbeat time moves every few seconds and
 * would make every poll a new body (no 304); the page only reads it once the worker is down
 * (the down bar says since when), so a running worker gives its state alone. */
function workerField(
  running: boolean,
  lastTickAt: string | undefined,
): { running: boolean; lastTickAt?: string } {
  return running ? { running } : { running, ...(lastTickAt ? { lastTickAt } : {}) };
}

export class AgentService {
  readonly worker: TaskWorker;
  readonly search: SearchService;
  /** Task reports shown in the conversation each task came from. */
  readonly reports: ChatReports;
  /** v1.4 (docs/skills.md): the space's skills. */
  readonly skills: Skills;
  /** v1.4 (docs/apps.md): connected apps (Slack, MCP servers); set by createApp. */
  apps?: AppsService;
  /** v1.6 聊天里发文件: the files sent in the chat (set by createApp; none in some tests). */
  attachments?: AttachmentStore;
  /** v1.6 生成图片: whether the model can draw, and the drawing (set by createApp). */
  images?: ImageGeneration;
  /** Fill_login_secret, import_site_cookies and record_sign_in. */
  readonly signIn: SignInTools;
  /** The account's persona and goal. */
  readonly accounts: AccountOperating;
  /** v1.5: each member's AGENTS.md, MEMORY.md and daily notes (docs/member-files.md). The core
   * keeps them on disk; createApp swaps in the hosted layer's store. */
  memberFiles: MemberFiles;
  /** Makes a project in the space when the 营销总群's
   * assistant is asked for work in one that does not exist (set by the app: ProjectService). */
  createProject?: (owner: string, name: string) => Promise<{ id: string; name: string }>;
  /** Routines and their mail poll. */
  readonly routines: Routines;
  private maintenance?: ReturnType<typeof setInterval>;
  private mailPoll?: ReturnType<typeof setInterval>;
  private refreshing = false;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly computer: ComputerService = new ComputerService(db, config),
    // Fork: isolation environments, shared with the chat agent and background tasks.
    readonly environments: EnvironmentService = new EnvironmentService(db, computer, config),
    // Each space's plan; the core's default lets all run.
    readonly plan: PlanGate & SpaceScopes = allowAllGate,
    // What a layer above the core adds (the store); the core's default is none.
    readonly extensions: AgentExtension[] = [],
  ) {
    this.search = new SearchService(db);
    this.reports = new ChatReports(db);
    this.skills = new Skills(db);
    this.signIn = new SignInTools(db, environments.store);
    this.accounts = new AccountOperating(this);
    // A config with no data directory (some tests) keeps the files in memory.
    const filesDir =
      config.memberFilesDir ?? (config.dataDir ? join(config.dataDir, "members") : "");
    this.memberFiles = new MemberFiles(
      filesDir ? new DiskMemberFileStore(filesDir) : new MemoryMemberFileStore(),
      db,
    );
    this.routines = new Routines(this);
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      // A read-only space's tasks wait until it may run again.
      mayRun: async (owner) => (await this.plan.refusal(owner)) === null,
      // A deploy puts `<dataDir>/drain` while it waits for the runs in
      // progress; no new run starts meanwhile.
      draining: () => existsSync(join(this.config.dataDir, drainFileName)),
      // Undeclined in its window, a review is sent.
      reviewDue: (owner, actionId) => settleDueReview(this.db, owner, actionId, Date.now()),
      // A repeating task created before its clock was known stays queued. Once the account
      // has a time zone, the first run waits for that clock instead of starting at once.
      clockWake: (owner, task) => this.nextWrittenRun(owner, task),
      // A standing task's failed run is retried with backoff
      // instead of failing it (standingRetry); one failed anyway is taken up again before its
      // outcome is published, so no 出问题 card goes out for it.
      failed: (owner, claimed, error, leaseId) =>
        this.standingRetry(owner, claimed, error, leaseId),
      // Each settle step runs whatever the one before did (a
      // owner's turn's check must not wait on the next maintenance pass because publishing threw).
      settled: async (owner, task) => {
        const step = (name: string, run: () => Promise<unknown>) =>
          run().catch((error) => backgroundFailure(name, error));
        if (task.status === "failed")
          await step("take up a failed standing task", () => this.reviveStanding(owner, task));
        await step("publish outcome", () => this.publishOutcome(owner, task));
        await step("note the run in the member's day note", () => this.noteRun(owner, task));
        await step("queue a pending instruction", () => this.queuePendingRedirect(owner, task));
      },
    });
  }
  /** The member the files belong to: Yuki (`yuki`), or one of the space's accounts. Null when
   * there is no such member in the space. */
  async memberRef(owner: string, id: string, cached = false): Promise<MemberRef | null> {
    const space = realOwnerOf(owner);
    // A run's start does not ask the database again for a name and time zone read a moment ago.
    const key = `${owner}\n${id}`;
    const hit = cached ? this.memberRefs.get(key) : undefined;
    if (hit && hit.until > Date.now()) return hit.ref;
    const ref = await this.memberRefNow(owner, space, id);
    if (ref) this.memberRefs.set(key, { ref, until: Date.now() + 30_000 });
    return ref;
  }
  private readonly memberRefs = new Map<string, { ref: MemberRef; until: number }>();
  private async memberRefNow(owner: string, space: string, id: string): Promise<MemberRef | null> {
    // The day a note belongs to is the day in the account's time zone (设置 → 通用 → 时区, the
    // one routines use); else her computer's; UTC without either.
    const accountZone = await readAccountZone(this.db, owner).catch(() => null);
    if (id === yukiMemberId) {
      const identity = await this.db.get<{ name?: string }>(owner, "agent-settings", "identity");
      return { space, owner, id, name: identityName(identity?.name), timezone: accountZone };
    }
    const record = (await this.environments.allRecords(owner)).find((found) => found.id === id);
    if (!record || record.deleting) return null;
    const timezone =
      accountZone ??
      (await this.computer.settings
        .view(envOwner(owner, id))
        .then((view) => view.timezone ?? null)
        .catch(() => null));
    return { space, owner, id, name: record.name, timezone };
  }
  /** What a run of this task reads first: the member's files. Empty when they cannot be read. */
  async memberFilesBlock(owner: string, accountId: string | null): Promise<string> {
    const ref = await this.memberRef(owner, accountId ?? yukiMemberId, true).catch(() => null);
    return ref ? this.memberFiles.promptBlock(ref) : "";
  }
  /** A run of a task has settled: the member's note for the day says so (the server's doing,
   * not the model's). */
  private async noteRun(owner: string, task: AgentTask) {
    const id = taskEnvironmentId(task);
    const ref = await this.memberRef(owner, id ?? yukiMemberId);
    if (ref) await this.memberFiles.noteSettledRun(ref, task);
  }
  start() {
    this.worker.start();
    void this.startup().catch((error) => backgroundFailure("start-up checks", error));
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
    // Routines with a mail trigger look at the inbox every two minutes.
    this.mailPoll = setInterval(() => {
      if (this.worker.draining) return;
      void this.routines.pollMail().catch((error) => backgroundFailure("routine mail poll", error));
    }, mailPollMs);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    if (this.mailPoll) clearInterval(this.mailPoll);
    this.mailPoll = undefined;
    await this.worker.stop();
    while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Incidents and their pictures older than 30 days go (at
      // start, then at most once an hour).
      await this.computer.incidents
        .prune()
        .catch((error) => backgroundFailure("incident retention", error));
      // Recover publications if the process exited after committing an outcome. One task whose
      // outcome cannot be published must not stop the others, or the loops below.
      // A standing task an error failed is taken up again first
      // (reviveStanding), so the founder's loop failed on 10-18 runs again after the deploy.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
        if (value.status === "failed")
          await this.reviveStanding(owner, value).catch((error) =>
            backgroundFailure("take up a failed standing task", error),
          );
        await this.publishOutcome(owner, value).catch((error) =>
          backgroundFailure("publish outcome", error),
        );
      }
      for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
        await this.activateMonitor(owner, value);
      // An owner's turn a loop left unconfirmed gets its own check.
      for (const { owner, value } of await this.db.scan<OwnerHandled>(ownerHandledKind))
        await this.confirmOwnerHandled(owner, value, ownerHandledStaleMs).catch((error) =>
          backgroundFailure("confirm a site the owner handled", error),
        );
      for (const { owner, value } of await this.db.scan<Idea>("ideas"))
        if (
          value.status === "accepted" &&
          value.taskId &&
          !(await this.db.get(owner, "tasks", value.taskId))
        )
          await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
            backgroundFailure("recover accepted idea", error);
            await this.notify(
              owner,
              "Accepted idea needs attention",
              "Open the idea again after making room for another task.",
              undefined,
              `idea-recovery:${value.id}`,
            );
          });
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async () => {
            await this.notify(
              owner,
              "Source refresh needs attention",
              "Reconnect the source or refresh Ideas to see the error.",
              undefined,
              `source-error:${Math.floor(Date.now() / 3600000)}`,
            );
          });
      }
    } finally {
      this.refreshing = false;
    }
  }
  /** At every start. */
  async startup() {
    await this.pauseRetiredLoops();
    await this.backfillOwnerHandled();
    await this.backfillDesktopConflicts();
  }
  /** v1.5 removed the accounts' standing operating loops and the v0.6 migration task. The tasks
   * older versions made for them stay in the database untouched, but nothing starts or ends them
   * any more, so once, at start, each one still going is paused (the owner sees it paused and can
   * cancel it). */
  async pauseRetiredLoops() {
    const marker = { id: "retired-loops-paused-v15", at: date() };
    if (await this.db.get("system", "migrations", marker.id)) return;
    for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
      if (value.input?.accountLoop !== true && value.input?.migrationV06 !== true) continue;
      if (terminal.has(value.status) || value.status === "paused") continue;
      await this.control(owner, value.id, "pause").catch((error) =>
        backgroundFailure("pause a retired account loop", error),
      );
    }
    await this.db.insertIfAbsent("system", "migrations", marker);
  }
  /** A sign-in fact a task recorded in a run during which a desktop tool of a run on
   * the same desktop failed with a conflict is not the site's doing. Once, at start, for every
   * such fact still standing (any status but signed_in or pending, recorded by a task): the fact
   * goes back to `pending`, its picture goes with the need card, and a sign-in task looks again
   * (startSignIn, which waits for the desktop by itself now). From this version on a run that hit
   * a conflict records nothing (model.ts `watchDesktop`), so nothing new ever qualifies. */
  async backfillDesktopConflicts() {
    const marker = { id: "desktop-conflict-backfill", at: date() };
    if (await this.db.get("system", "migrations", marker.id)) return;
    // Conflicts by the desktop they happened on: `[task owner, date]`.
    const conflicts = new Map<string, { owner: string; at: string }[]>();
    const desktops = new Map<string, string | null>();
    for (const { owner, value } of await this.db.scan<RunEvent>("run-events")) {
      if (value.kind !== "error" || !desktopConflict(value.detail ?? "")) continue;
      const key = `${owner}\n${value.taskId}`;
      if (!desktops.has(key)) {
        const task = await this.db.get<AgentTask>(owner, "tasks", value.taskId);
        const environmentId = task?.input?.environmentId;
        desktops.set(
          key,
          !task
            ? null
            : typeof environmentId === "string" && isEnvironmentId(environmentId)
              ? envOwner(owner, environmentId)
              : owner,
        );
      }
      const desktop = desktops.get(key);
      if (!desktop) continue;
      const list = conflicts.get(desktop) ?? [];
      list.push({ owner, at: value.date });
      conflicts.set(desktop, list);
    }
    for (const { owner: factOwner, value: fact } of await this.db.scan<
      SiteSignInFact & { id: string }
    >(signInKind)) {
      const taskId = "taskId" in fact.by ? fact.by.taskId : null;
      if (!taskId || fact.status === "signed_in" || fact.status === "pending") continue;
      const nearby = conflicts.get(factOwner);
      if (!nearby?.length) continue;
      const owner = parseEnvOwner(factOwner)?.real ?? factOwner;
      // The run that recorded it, from the worker's run records; a quarter hour before it when
      // none is found.
      const run = (
        await this.db.list<{ taskId: string; startedAt: string; finishedAt?: string }>(
          owner,
          "runs",
        )
      ).find(
        (row) =>
          row.taskId === taskId &&
          row.startedAt <= fact.at &&
          (!row.finishedAt || row.finishedAt >= fact.at),
      );
      const from = run?.startedAt ?? new Date(Date.parse(fact.at) - 15 * 60 * 1000).toISOString();
      if (!nearby.some((item) => item.owner === owner && item.at >= from && item.at <= fact.at))
        continue;
      const environmentId = parseEnvOwner(factOwner)?.environmentId ?? null;
      const usedBy: CredentialUsedBy = environmentId
        ? { type: "account", environmentId }
        : { type: "project" };
      if (fact.incident) await this.computer.incidents.remove(factOwner, fact.incident.id);
      await writeSignIn(this.db, factOwner, {
        site: fact.site,
        status: "pending",
        detail: null,
        at: date(),
        by: { taskId },
      });
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        kind: "status",
        date: date(),
        title: desktopHeldLabel,
        detail: `${fact.site}: ${fact.status} was recorded while another run had this desktop; not the site's doing. Looking again.`,
      } satisfies RunEvent);
      try {
        if (environmentId)
          await this.assertRoomForSignIns(owner, [{ environmentId, site: fact.site }]);
        else await this.assertRoomForTasks(owner, 1);
        await this.startSignIn(
          owner,
          usedBy,
          fact.site,
          `${fact.site}：上次登录时桌面被别的操作占用，结果不算数，请重新看一次并用 record_sign_in 记下所见。`,
        );
      } catch (error) {
        backgroundFailure("look again after a desktop conflict", error);
      }
    }
    await this.db.insertIfAbsent("system", "migrations", marker);
  }
  /** Owner's turns made before they were recorded (only the loop was
   * told, by a run event 「Owner took over」 whose detail starts with the site) are recorded once,
   * when the site's fact still asks the owner and nothing was recorded since; the maintenance
   * pass then confirms them. */
  async backfillOwnerHandled() {
    const marker = { id: "owner-handled-backfill", at: date() };
    if (await this.db.get("system", "migrations", marker.id)) return;
    const latest = new Map<string, OwnerHandled & { factOwner: string }>();
    for (const { owner, value } of await this.db.scan<RunEvent>("run-events")) {
      if (value.title !== ownerTookOverLabel) continue;
      const site = /^([^\s：:]+)：/.exec(value.detail ?? "")?.[1];
      if (!site) continue;
      const task = await this.db.get<AgentTask>(owner, "tasks", value.taskId);
      const environmentId = task?.input?.environmentId;
      if (typeof environmentId !== "string" || !isEnvironmentId(environmentId)) continue;
      const factOwner = envOwner(owner, environmentId);
      const key = `${factOwner}\n${site}`;
      if ((latest.get(key)?.at ?? "") >= value.date) continue;
      latest.set(key, {
        id: site,
        site,
        at: value.date,
        owner,
        environmentId,
        checkAt: null,
        factOwner,
      });
    }
    for (const { factOwner, ...row } of latest.values()) {
      const fact = (await readSignIns(this.db, factOwner)).find((item) => item.site === row.site);
      if (handledStands(fact, row)) await this.db.insertIfAbsent(factOwner, ownerHandledKind, row);
    }
    await this.db.insertIfAbsent("system", "migrations", marker);
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "Yuki",
      tone: "warm",
    });
  }
  /** v1.7 模型兜底: the primary and backup model strings and the backup in force now. */
  modelState(): {
    primary: string | null;
    fallback: string | null;
    backup: ReturnType<typeof backupState>;
  } {
    return {
      primary: this.config.model ?? null,
      fallback: this.config.fallbackModel ?? null,
      backup: backupState(this.config.fallbackModel),
    };
  }
  /** The tasks' routine fields only (status, repeat, the account they are bound to): what the
   * roster reads for the projects not open (v1.7 启动链瘦身). */
  async routineRows(owner: string): Promise<
    {
      status: AgentTask["status"];
      repeatMinutes: number | null;
      input: { environmentId?: string };
    }[]
  > {
    const tasks = await this.db.list<AgentTask>(owner, "tasks");
    return tasks.map((task) => {
      const environmentId = (task.input as { environmentId?: unknown } | undefined)?.environmentId;
      return {
        status: task.status,
        repeatMinutes: typeof task.repeatMinutes === "number" ? task.repeatMinutes : null,
        input: typeof environmentId === "string" && environmentId ? { environmentId } : {},
      };
    });
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [tasks, goals, monitors, ideas, memories, artifacts, notifications, identity] =
      await Promise.all([
        this.db.list<AgentTask>(owner, "tasks"),
        this.db.list<Goal>(owner, "goals"),
        this.db.list<Monitor>(owner, "monitors"),
        this.db.list<Idea>(owner, "ideas"),
        this.db.list<AgentMemory>(owner, "memories"),
        this.db.list<AgentArtifact>(owner, "agent-artifacts"),
        this.db.list<AgentNotification>(owner, "notifications"),
        this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      ]);
    const heartbeat = await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks");
    return {
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity: identity
        ? { ...identity, name: identityName(identity.name) }
        : { name: "Yuki", tone: "warm" },
      worker: workerField(
        this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      ),
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      task.artifactIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      [task.state.browserId, task.state.sessionId].includes(browser.id),
    );
    return {
      task,
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.list<RunEvent>(owner, "run-events"))
        .filter((e) => e.taskId === id)
        .sort((a, b) => a.date.localeCompare(b.date)),
      artifacts: (await this.db.list<AgentArtifact>(owner, "agent-artifacts")).filter(
        (a) => a.taskId === id,
      ),
    };
  }
  /** The chat's task_events tool. A task's latest run events (reports
   * included), oldest first, with a short task summary. Event text is the run's own output. */
  async taskEvents(owner: string, id: string, limit = 20) {
    const task = await this.getTask(owner, id);
    // The latest `limit` by date and the total, in SQL: a long-running task has many events.
    const [events, total] = await Promise.all([
      this.db.listPage<RunEvent>(owner, "run-events", {
        field: "taskId",
        value: id,
        order: "date",
        limit,
      }),
      this.db.countByField(owner, "run-events", "taskId", id),
    ]);
    return {
      taskId: task.id,
      task: {
        title: task.title,
        status: task.status,
        result: task.result ? clipText(task.result, 2000) : undefined,
        question: task.question || undefined,
        error: task.error || undefined,
        repeatMinutes: task.repeatMinutes ?? null,
        runs: task.runs ?? 0,
        nextRunAt: task.nextRunAt,
        updatedAt: task.updatedAt,
      },
      events: events.map((event) => {
        // An action told as not confirmed, and why, so the
        // chat never tells it as done.
        // A wait or a finish whose note carries the mark too.
        const why =
          event.kind === "report" || event.kind === "status" || event.kind === "result"
            ? unconfirmedOf(event.detail)
            : null;
        return {
          date: event.date,
          kind: event.kind,
          title: clipText(event.title, 300),
          detail: clipText(event.detail, 2000),
          ...(why ? { confirmed: false, unconfirmed: reportUnconfirmedWords[why] } : {}),
        };
      }),
      earlierEvents: Math.max(0, total - events.length),
    };
  }
  /** `originThreadId` is the conversation a chat delegated the task from;
   * its reports appear there (otherwise in the project's main conversation).
   * `typedByOwner` marks a prompt the person typed in the new-task form, so the task detail says
   * who wrote the rules. */
  async createTask(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    held = false,
    options: {
      originThreadId?: string | null;
      typedByOwner?: boolean;
      /** The room for this task was checked before the save it follows
       * (assertRoomForSignIns), so creating it never fails once that save is committed. */
      roomChecked?: boolean;
      /** The member who asked for it; else the member acting in this request. */
      createdBy?: string;
      /** The new-member form's first wake. A chat tool cannot set this. */
      firstRunAt?: string;
      /** The task is a routine (Routines.create); `wakeAt` is its first clock run
       * and `idle` a mail routine, which waits for mail with no next run. */
      routine?: { routine: Routine; wakeAt: string | null; idle: boolean };
    } = {},
  ) {
    const input = createTaskSchema.parse(raw);
    const createdBy = options.createdBy ?? currentActor()?.userId;
    const origin = threadIdSchema.safeParse(options.originThreadId);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    // Fork hook: a task bound to an environment needs that environment to exist now.
    const environmentId = input.input.environmentId;
    if (environmentId != null && typeof environmentId !== "string")
      throw new AppError("environmentId must be an environment id or null", 422);
    if (typeof environmentId === "string") await this.environments.get(owner, environmentId);
    // Fork hook: only open-ended (agent/plan) tasks repeat.
    if (input.repeatMinutes && !repeatableTaskKinds.has(input.kind))
      throw new AppError("Only general and plan tasks can repeat", 422);
    if (input.milestoneId && !input.goalId) throw new AppError("A milestone requires a goal", 422);
    const goal = input.goalId ? await this.db.get<Goal>(owner, "goals", input.goalId) : null;
    if (input.goalId && !goal) throw new AppError("Goal not found", 404);
    if (input.milestoneId && !goal?.milestones.some((m) => m.id === input.milestoneId))
      throw new AppError("Milestone not found in this goal", 404);
    if (!options.roomChecked) await this.assertRoomForTasks(owner, 1);
    const titles = planTitles(input.kind);
    const firstRun =
      input.repeatMinutes && !held && goal?.status !== "paused"
        ? firstRunPlan(options.firstRunAt)
        : null;
    const task: AgentTask = {
      id,
      title: input.title ?? taskTitle(input.prompt),
      prompt: input.prompt,
      kind: input.kind,
      goalId: input.goalId,
      milestoneId: input.milestoneId,
      status: held || goal?.status === "paused" ? "paused" : firstRun ? "scheduled" : "queued",
      ...(firstRun ? { nextRunAt: firstRun.nextRunAt } : {}),
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
      repeatMinutes: input.repeatMinutes ?? null,
      runs: 0,
      ...(origin.success ? { originThreadId: origin.data } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(options.typedByOwner && !origin.success ? { typedByOwner: true } : {}),
    };
    if (options.routine) {
      task.routine = options.routine.routine;
      if (task.status === "queued" && (options.routine.idle || options.routine.wakeAt))
        task.status = "scheduled";
      if (task.status === "scheduled" && options.routine.wakeAt)
        task.nextRunAt = options.routine.wakeAt;
    }
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async control(
    owner: string,
    id: string,
    action: "pause" | "resume" | "cancel" | "retry" | "run",
    /** The person's own words on resuming (the chat's resume_task). */
    options: { words?: string } = {},
  ) {
    const task = await this.getTask(owner, id);
    if (action === "run") return this.runNow(owner, task);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    if (action === "pause" && (terminal.has(task.status) || task.status === "paused")) return task;
    if (task.kind === "monitor" && action === "resume") {
      // Both UI entry points must activate the monitor before a worker can claim its task.
      await this.controlMonitor(owner, String(task.input.monitorId), "resume");
      const resumed = await this.getTask(owner, id);
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: id,
        kind: "status",
        date: date(),
        title: `Task ${resumed.status}`,
        detail: "Changed by you",
      });
      return resumed;
    }
    // A one-off task paused during its wait goes back to that wait; Run now
    // is the way to skip it. A repeating task resumes with a run now, as before.
    // An instruction the person gave while it was paused (`pendingAnswer`)
    // is read now, not when the rest of the wait (up to a day) is over; the wait record stays, so
    // the run is told it started early and posting still keeps the pacing.
    const wait = taskWait(task);
    const resumesWait =
      action === "resume" &&
      !task.repeatMinutes &&
      !task.actionId &&
      !task.pendingAnswer &&
      wait !== null &&
      Date.parse(wait.until) > Date.now();
    const readsInstructionNow = action === "resume" && !!task.pendingAnswer && wait !== null;
    // The instructions the runs read say where the person
    // resumed it, so one that said to pause for now (redirect_task, its run then paused it) is
    // done and is not followed again; their words on resuming come with it.
    const previousAnswer = typeof task.state.answer === "string" ? task.state.answer : "";
    const marksResume = action === "resume" && (!!previousAnswer || !!options.words?.trim());
    const linked =
      action === "retry" && task.actionId
        ? await this.db.get<ActionProposal>(owner, "actions", task.actionId)
        : null;
    // A general task whose review expired or was declined sent nothing,
    // so retrying it is safe: it is queued and its next run is told the email was not sent.
    const retryUnapproved =
      task.kind === "agent" && !!linked && notApprovedStatuses.has(linked.status);
    // A paused routine goes back to waiting for its trigger, it does not run now.
    const routineResume =
      action === "resume" && isRoutine(task) && !task.actionId && wait === null
        ? await this.routines.resumePatch(owner, task)
        : null;
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : routineResume
            ? "scheduled"
            : task.actionId && !retryUnapproved
              ? "waiting_approval"
              : resumesWait
                ? "scheduled"
                : "queued";
    if (action === "retry" && task.actionId && !retryUnapproved) {
      const a = linked;
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        // A report or question repeated after Retry or Resume shows again.
        ...(action === "retry" || action === "resume" ? { resumes: (task.resumes ?? 0) + 1 } : {}),
        ...(status === "queued" && readsInstructionNow ? { nextRunAt: date() } : {}),
        ...(routineResume ? { nextRunAt: routineResume.nextRunAt } : {}),
        // A cancelled task no longer waits for an answer, nor does a paused one (fork, pause
        // from chat): it waits for nothing but the person's resume, so it is never in 需要你 and
        // its run asks again after the resume if it still needs to.
        ...(action === "cancel" || action === "pause"
          ? { question: null as unknown as string }
          : {}),
        ...(marksResume
          ? { state: { ...task.state, answer: resumedAnswer(previousAnswer, options.words) } }
          : {}),
        updatedAt: date(),
        result: action === "cancel" ? "Stopped by you." : action === "pause" ? pausedResult : "",
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(owner, id);
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
          // Clearing the error fences out a failure reconcile that read the task before this.
          ...(action === "resume" || action === "retry" ? { error: null } : {}),
        },
      );
    if (action === "cancel" && task.actionId) {
      const proposal = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (proposal?.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
    }
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  /** The person's 「继续」 for a task (the chat's resume_task).
   * A paused task is resumed (Resume); one waiting for their answer takes it as the answer, with
   * the resume mark, so a run that stopped on a question instead of pausing goes on; a failed one is retried. One that is
   * already going is left as it is; one that ended takes nothing (409). */
  async ownerResume(owner: string, id: string, words?: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const task = await this.getTask(owner, id);
      if (task.status === "paused") return this.control(owner, id, "resume", { words });
      if (task.status === "failed") return this.control(owner, id, "retry");
      if (task.status === "succeeded" || task.status === "cancelled")
        throw new AppError("This task has ended; delegate a new one instead", 409);
      if (task.status !== "waiting_input") return task;
      const previous = typeof task.state.answer === "string" ? task.state.answer : "";
      const answered = await this.answer(owner, id, resumedAnswer(previous, words)).catch(
        (error) => {
          if (error instanceof AppError && error.status === 409) return null;
          throw error;
        },
      );
      if (!answered) continue;
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: id,
        kind: "status",
        date: date(),
        title: "Task queued",
        detail: "Changed by you",
      } satisfies RunEvent);
      return answered;
    }
    throw new AppError("Task changed; refresh and try again", 409);
  }
  /** Fork: "Run now" for a repeating task that is waiting for its next run, or for a task that
   * paused itself with wait_until (the wait is skipped; the note stays in its state), or for one
   * whose run the infrastructure stopped and that waits to be taken up again (report line). */
  private async runNow(owner: string, task: AgentTask) {
    if (task.kind === "monitor")
      throw new AppError("Only repeating or waiting tasks can be run on demand", 409);
    if (task.status !== "scheduled")
      throw new AppError("This task is not waiting for its next run", 409);
    if (!task.repeatMinutes && !taskWait(task) && !taskRunFailure(task.state))
      throw new AppError("Only repeating or waiting tasks can be run on demand", 409);
    // Run now on a routine is its test, recorded with the cause `test`.
    const updated = await this.queueNow(
      owner,
      task,
      "Run requested",
      "Changed by you",
      isRoutine(task) ? { input: { ...task.input, run: { cause: "test" } } } : {},
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    return updated;
  }
  /** An instruction that reached a running task after its wait re-read
   * the record (the run was already ending) would otherwise sit until the whole wait is over.
   * Once the run has settled, a scheduled task with an instruction pending runs again now. */
  private async queuePendingRedirect(owner: string, saved: AgentTask) {
    const task = await this.db.get<AgentTask>(owner, "tasks", saved.id);
    if (task?.status !== "scheduled" || !task.pendingAnswer?.trim()) return;
    // wait() already brought it forward when it saw the instruction (account tasks).
    if (task.nextRunAt && Date.parse(task.nextRunAt) <= Date.now() + 1000) return;
    await this.queueNow(
      owner,
      task,
      "Redirected",
      "A new instruction arrived while the run was ending; running again now.",
    );
  }
  /** Fork: a scheduled task (between repeating runs, or in a wait_until wait) is queued to run
   * now, with a status event; `extra` is written in the same swap. The wait record stays, so the
   * run that starts says the person ran it early. Null when the task is no longer scheduled. */
  async queueNow(
    owner: string,
    task: AgentTask,
    title: string,
    detail: string,
    extra: Partial<AgentTask> = {},
  ) {
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { status: "scheduled" },
      { ...extra, status: "queued", nextRunAt: date(), updatedAt: date() },
    );
    if (!updated) return null;
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: task.id,
      kind: "status",
      date: date(),
      title,
      detail,
    });
    return updated;
  }
  /** Fork: changes how often a task repeats. Null stops repeating: a task waiting for its next
   * run is then complete with its last result; a number makes a finished task repeat again.
   * A task in a wait_until wait (scheduled, or paused during it) keeps its resume time either
   * way: the waiting run still finishes (as a one-off run after null; the interval starts after
   * it otherwise, and its run stays open because wait() set `runOpen`, also when the number came
   * while the run that waited was still running). Null on a task that does not repeat changes
   * nothing. */
  async updateTask(owner: string, id: string, raw: unknown) {
    const input = z
      .object({ repeatMinutes: z.number().int().min(1).max(repeatMinutesMax).nullable() })
      .parse(raw);
    const task = await this.getTask(owner, id);
    if (!repeatableTaskKinds.has(task.kind))
      throw new AppError("Only general and plan tasks can repeat", 422);
    if (task.status === "cancelled") throw new AppError("This task was cancelled", 409);
    if (isRoutine(task)) throw new AppError("例行的时间在「修改」里改", 409);
    if (input.repeatMinutes === null && !task.repeatMinutes) return task;
    const patch: Partial<AgentTask> = { repeatMinutes: input.repeatMinutes, updatedAt: date() };
    const waiting = taskWait(task) !== null;
    if (input.repeatMinutes === null && task.status === "scheduled" && !waiting)
      patch.status = "succeeded";
    if (input.repeatMinutes !== null && task.status === "succeeded") {
      patch.status = "scheduled";
      patch.nextRunAt = new Date(Date.now() + input.repeatMinutes * 60000).toISOString();
    }
    if (input.repeatMinutes !== null && task.status === "scheduled" && !waiting)
      patch.nextRunAt = new Date(Date.now() + input.repeatMinutes * 60000).toISOString();
    // A one-off task that starts repeating during a run that waits (before or during its wait,
    // paused in it, or after the max-waits question) needs nothing here: wait() leaves the run
    // open (`runOpen`), so the run after the wait is its first run, with its state.
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status },
      patch,
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: input.repeatMinutes ? `Repeats every ${input.repeatMinutes} min` : "Repeating stopped",
      detail: "Changed by you",
    });
    return updated;
  }
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const next = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: "waiting_input" },
      {
        status: "queued",
        question: null,
        input: { ...task.input, ...(fields ? { fields } : {}) },
        // An answer starts a fresh budget of automatic continuations and a fresh count of waits.
        state: {
          ...task.state,
          answer,
          ...(task.state.autoContinued ? { autoContinued: 0 } : {}),
          ...(task.state.waits ? { waits: 0 } : {}),
        },
        // A report or question repeated after an answer shows again.
        resumes: (task.resumes ?? 0) + 1,
        updatedAt: date(),
      },
    );
    if (!next) throw new AppError("Task changed; refresh and try again", 409);
    return next;
  }
  /** A login of `site` was saved for an account
   * (or the project). The task that asked for it (record_sign_in no_login) is told, and is
   * counted on only when that queues its next run; else a queued or running sign-in task of that
   * account and site is told; else, for an
   * account, a task is started that signs it in: its prompt states only the goal, the AI does the
   * rest on the site's own login page with the sign-in tools. A login saved for the project wakes
   * only the task that asked for it. */
  async signInSaved(
    owner: string,
    usedBy: CredentialUsedBy,
    site: string,
    requests: CredentialRequestView[],
  ) {
    /** Tells the task; what it is now (null when it took nothing: ended, gone, or a task kind
     * that takes no instruction). */
    const tell = async (taskId: string, text: string) => {
      try {
        return await this.redirect(owner, taskId, { text });
      } catch (error) {
        if (error instanceof AppError && (error.status === 404 || error.status === 409))
          return null;
        throw error;
      }
    };
    // Woken: the task will run and read the instruction (queued now). A task that is running
    // reads it only if that run waits, a paused or failed one only if the owner resumes or
    // retries it: told, but not counted on.
    let woken = false;
    for (const request of requests)
      if (request.by.taskId) {
        const told = await tell(request.by.taskId, `${site} 的登录已保存。`);
        if (told?.status === "queued") woken = true;
      }
    if (woken || usedBy.type !== "account") return;
    await this.startSignIn(owner, usedBy, site, `${site} 的登录信息已更新。`);
  }
  /** What a task asked for was saved (a mailbox): it is told, which wakes it. A task
   * waiting on the person's answer is left alone (the notice would stand in for the answer); one
   * that ended or is gone is skipped. */
  async tellAsker(owner: string, taskId: string, text: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || task.status === "waiting_input" || terminal.has(task.status)) return;
    await this.redirect(owner, taskId, { text }).catch((error) => {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) return;
      throw error;
    });
  }
  /** The task that signs `usedBy` in to `site`: the open one for it is told
   * (`told`) and takes it (queued, or running: a sign-in run that is told during the run signs
   * in again when it finishes, see finish_task); otherwise one is created, on the account (or,
   * for the project's own login when the owner asks it to look again, on its default desktop).
   * The room for it was checked before the save (or the request) it follows. */
  private async startSignIn(owner: string, usedBy: CredentialUsedBy, site: string, told: string) {
    const environmentId = usedBy.type === "account" ? usedBy.environmentId : null;
    const signIn = (await this.db.list<AgentTask>(owner, "tasks")).find(
      (task) =>
        !terminal.has(task.status) &&
        task.status !== "paused" &&
        (task.input?.environmentId ?? null) === environmentId &&
        (task.input?.signIn as { site?: unknown } | undefined)?.site === site,
    );
    if (signIn) {
      const answer = await this.redirect(owner, signIn.id, { text: told }).catch((error) => {
        if (error instanceof AppError && (error.status === 404 || error.status === 409))
          return null;
        throw error;
      });
      if (answer?.status === "queued" || answer?.status === "running") return;
    }
    let name = "本项目";
    if (environmentId) {
      const environment = await this.environments.find(owner, environmentId);
      if (!environment || environment.deleting) return;
      name = environment.name;
    }
    await this.createTask(
      owner,
      {
        kind: "agent",
        title: `[${name}] 登录 ${site}`,
        prompt: environmentId
          ? `Check whether this account is signed in to ${site}, sign it in only if it is not, then record what you saw with record_sign_in.`
          : `Check whether this project's default desktop is signed in to ${site}, sign it in with the project's saved login only if it is not, then record what you saw with record_sign_in.`,
        input: { ...(environmentId ? { environmentId } : {}), signIn: { site } },
      },
      undefined,
      false,
      { roomChecked: true },
    );
  }
  /** The owner acted on a fact only they could act on for `site` (they
   * entered a code on the desktop): the AI looks again and records what it sees. Only for a
   * site whose fact is "needs a code"; anything else has nothing to look again at. */
  async recheckSignIn(owner: string, usedBy: CredentialUsedBy, site: string) {
    const factOwner =
      usedBy.type === "account" ? envOwner(owner, usedBy.environmentId) : scopeOfOwner(owner);
    const fact = (await readSignIns(this.db, factOwner)).find((item) => item.site === site);
    if (fact?.status !== "needs_code" && fact?.status !== "needs_owner") return false;
    // The page kept for the owner is his no more, and a desktop
    // he held is free for the check (the desktop owner is the fact owner, for an account and for
    // the project's default desktop alike).
    // The owner's turn is a fact until a newer fact for the site is
    // recorded: every run of the account's loop gets it (`ownerHandled` in its data), the owner
    // reads 「正在确认…」, and when the loop leaves it unconfirmed the dedicated check runs
    // (afterLoopRun, the maintenance pass). A new owner's turn is a new one: one check each.
    const handled: OwnerHandled = {
      id: site,
      site,
      at: date(),
      owner,
      environmentId: usedBy.type === "account" ? usedBy.environmentId : null,
      checkAt: null,
    };
    await this.db.put(factOwner, ownerHandledKind, handled);
    if (usedBy.type === "account")
      await this.assertRoomForSignIns(owner, [{ environmentId: usedBy.environmentId, site }]);
    else await this.assertRoomForTasks(owner, 1);
    await this.db.compareAndSwap(
      factOwner,
      ownerHandledKind,
      site,
      { at: handled.at, checkAt: null },
      { checkAt: date() },
    );
    await this.startSignIn(
      owner,
      usedBy,
      site,
      `${site}：主人在桌面里处理过了，请再看一次并记下所见。`,
    );
    return true;
  }
  /** Starts the dedicated sign-in check (startSignIn) for one
   * owner's turn still unconfirmed, at least `minAgeMs` old, once per owner's turn (`checkAt`, claimed by
   * a swap, so concurrent passes start one). The owner's turn record is never dropped here: only a
   * newer fact for the site ends it (writeSignIn; one that already arrived is applied). A check
   * that ends without recording leaves the record standing, and the owner reads 「还没确认上」
   * (`ownerHandledStale`) and presses 我弄好了 again for a new owner's turn with its own check. Not
   * started while a sign-in task for the site is queued or running (that one confirms it); the
   * account's loop being queued or running is no reason to wait (the desktop hold keeps them
   * apart). */
  async confirmOwnerHandled(factOwner: string, row: OwnerHandled, minAgeMs: number) {
    if (row.checkAt) return false;
    if (Date.now() - Date.parse(row.at) < minAgeMs) return false;
    const fact = (await readSignIns(this.db, factOwner)).find((item) => item.site === row.site);
    if (!handledStands(fact, row)) {
      // Answered: a newer fact for the site (or none left) stands in for this owner's turn.
      await this.db.removeMatching(factOwner, ownerHandledKind, row.site, { at: row.at });
      return false;
    }
    const environmentId = row.environmentId;
    const tasks = await this.db.list<AgentTask>(row.owner, "tasks");
    const busy = (task: AgentTask) => task.status === "queued" || task.status === "running";
    const claimed = await this.db.compareAndSwap(
      factOwner,
      ownerHandledKind,
      row.site,
      { at: row.at, checkAt: null },
      { checkAt: date() },
    );
    if (!claimed) return false;
    if (
      tasks.some(
        (task) =>
          busy(task) &&
          (task.input?.environmentId ?? null) === environmentId &&
          (task.input?.signIn as { site?: unknown } | undefined)?.site === row.site,
      )
    )
      return true;
    const usedBy: CredentialUsedBy = environmentId
      ? { type: "account", environmentId }
      : { type: "project" };
    try {
      if (environmentId)
        await this.assertRoomForSignIns(row.owner, [{ environmentId, site: row.site }]);
      else await this.assertRoomForTasks(row.owner, 1);
      await this.startSignIn(
        row.owner,
        usedBy,
        row.site,
        `${row.site}：主人在桌面里处理过了，请再看一次并用 record_sign_in 记下所见。`,
      );
    } catch (error) {
      // Not started (no room, the account went): the next pass tries again.
      await this.db.compareAndSwap(
        factOwner,
        ownerHandledKind,
        row.site,
        { at: row.at },
        { checkAt: null },
      );
      throw error;
    }
    return true;
  }
  /** Refuses, as createTask does, when `count` more open tasks would pass the limit. */
  async assertRoomForTasks(owner: string, count: number) {
    const open = (await this.db.list<AgentTask>(owner, "tasks")).filter(
      (task) => !terminal.has(task.status),
    ).length;
    if (open + count > 100)
      throw new AppError("Finish or cancel some tasks before adding more", 409);
  }
  /** Refuses, before a login is saved, when the sign-in tasks it would start (one per account
   * and site with no queued or running sign-in task to take it, see signInSaved) could not be
   * added now. */
  async assertRoomForSignIns(owner: string, logins: { environmentId: string; site: string }[]) {
    const open = (await this.db.list<AgentTask>(owner, "tasks")).filter(
      (task) => task.status === "queued" || task.status === "running",
    );
    const starts = logins.filter(
      ({ environmentId, site }) =>
        !open.some(
          (task) =>
            task.input?.environmentId === environmentId &&
            (task.input?.signIn as { site?: unknown } | undefined)?.site === site,
        ),
    ).length;
    if (starts) await this.assertRoomForTasks(owner, starts);
  }
  /** The owner moved an account from the project `from` to `to`. Its
   * sign-in tasks still open in `from` end (its logins are no longer there to use), and the AI
   * signs in again from `to` to each site in `sites`. */
  async accountMoved(
    from: string,
    to: string,
    environmentId: string,
    sites: string[],
    withdrawn: CredentialRequestView[] = [],
  ) {
    for (const task of await this.db.list<AgentTask>(from, "tasks"))
      if (
        !terminal.has(task.status) &&
        task.input?.environmentId === environmentId &&
        task.input?.signIn
      )
        await this.control(from, task.id, "cancel");
    // A task here that asked for a login of the account learns it will not come here.
    for (const request of withdrawn)
      if (request.by.taskId)
        await this.redirect(from, request.by.taskId, {
          text: `这个号已移出本项目，${request.site} 的登录请求已撤回。`,
        }).catch((error) => {
          if (!(error instanceof AppError && (error.status === 404 || error.status === 409)))
            throw error;
        });
    for (const site of sites)
      await this.signInSaved(to, { type: "account", environmentId }, site, []);
  }
  /** A new instruction from the person for a
   * task already started (other communities, no posts, a softer tone, stop). Nothing is asked of
   * anyone and nothing is interrupted:
   * - scheduled (waiting, or between repeating runs): stored and queued now (`queueNow`), so the
   *   run that reads it starts at once; its wait record stays.
   * - running, queued, paused, waiting for a review, failed: stored as `pendingAnswer` (appended
   *   to one not yet read), read by the next run; a running account task that then waits runs
   *   again at once (`wait`).
   * - waiting for input: it is the answer (added to the earlier answer).
   * The run that reads `pendingAnswer` adds it to `state.answer` (`takePendingAnswer`), so it
   * stays in every later run's message. A finished or cancelled task takes none (409), and
   * neither does a task no model run reads it for (a watch, a document or a finance task: 409). */
  /** `retryFailed`: the person gave the instruction (the chat, the task's own page), so a failed
   * task is retried with it; an instruction the system relays (a saved login, a moved account)
   * leaves a failed task to the person. */
  async redirect(owner: string, id: string, raw: unknown, options: { retryFailed?: boolean } = {}) {
    const { text } = redirectInputSchema.parse(raw);
    const event = (taskId: string) =>
      this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        kind: "status",
        date: date(),
        title: "Redirected",
        detail: clipText(text, 500),
      } satisfies RunEvent);
    // Retried when the task changes in between (a run's checkpoint, another instruction).
    for (let attempt = 0; attempt < 5; attempt++) {
      const task = await this.getTask(owner, id);
      // Only a model run reads an instruction (`takePendingAnswer`): a watch, a document or a
      // finance task would hold it unread and never act on it.
      if (!repeatableTaskKinds.has(task.kind))
        throw new AppError(
          "Only agent and plan tasks take new instructions; this task runs a fixed workflow. Change or cancel it instead.",
          409,
        );
      if (task.status === "succeeded" || task.status === "cancelled")
        throw new AppError("This task has ended; delegate a new one instead", 409);
      if (task.status === "waiting_input") {
        const previous = typeof task.state.answer === "string" ? task.state.answer : "";
        const answered = await this.answer(
          owner,
          id,
          previous ? `${previous}\n---\n${text}` : text,
        ).catch((error) => {
          if (error instanceof AppError && error.status === 409) return null;
          throw error;
        });
        if (!answered) continue;
        await event(id);
        return answered;
      }
      const pendingAnswer = task.pendingAnswer ? `${task.pendingAnswer}\n---\n${text}` : text;
      if (task.status === "scheduled") {
        const queued = await this.queueNow(owner, task, "Redirected", clipText(text, 500), {
          pendingAnswer,
        });
        if (queued) return queued;
        continue;
      }
      const updated = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        id,
        { status: task.status, updatedAt: task.updatedAt },
        { pendingAnswer, updatedAt: date() },
      );
      if (!updated) continue;
      await event(id);
      // The person's instruction to a failed task used to wait for a
      // retry nobody made, while the chat told them it was going again. It is retried now (the
      // same checks as 重试: a review whose outcome is uncertain still refuses, and the chat
      // hears it).
      if (task.status === "failed" && options.retryFailed) return this.control(owner, id, "retry");
      return updated;
    }
    throw new AppError("Task changed; refresh and try again", 409);
  }
  /** At the start of a model run, the instruction the person gave since
   * the last one (`pendingAnswer`) is added to `state.answer`, which the run's message carries,
   * and cleared, in one swap that also checks the run's lease and that no newer instruction came
   * in between (it is read again then). Like an answer (`answer`), it starts a fresh count of
   * wait_until waits and automatic continuations. Returns the run's task, changed or not. */
  async takePendingAnswer(owner: string, task: AgentTask, context: TaskContext) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await this.db.get<AgentTask>(owner, "tasks", task.id);
      const pending = latest?.pendingAnswer;
      if (!pending) return task;
      const previous = typeof task.state.answer === "string" ? task.state.answer : "";
      const next = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        task.id,
        { leaseId: task.leaseId ?? null, status: "running", pendingAnswer: pending },
        {
          pendingAnswer: null,
          state: {
            ...task.state,
            answer: previous ? `${previous}\n---\n${pending}` : pending,
            ...(task.state.autoContinued ? { autoContinued: 0 } : {}),
            ...(task.state.waits ? { waits: 0 } : {}),
          },
          updatedAt: date(),
        },
      );
      if (next) return next;
      // Not ours any more, or a newer instruction came in: the guard tells which.
      await context.guard();
    }
    return task;
  }
  /** The project's brief; empty text and no date when there is none. */
  async projectBrief(owner: string): Promise<ProjectBrief> {
    const brief = await this.db.get<ProjectBrief & { id: string }>(owner, "project-brief", "brief");
    return { text: brief?.text ?? "", updatedAt: brief?.updatedAt ?? null };
  }
  async setProjectBrief(owner: string, raw: unknown): Promise<ProjectBrief> {
    const { text } = projectBriefSchema.parse(raw);
    const brief = { id: "brief", text, updatedAt: date() };
    await this.db.put(owner, "project-brief", brief);
    return { text: brief.text, updatedAt: brief.updatedAt };
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const saved = await this.db.compareAndSwap<Goal>(owner, "goals", id, {}, patch);
    if (!saved) throw new AppError("Goal not found", 404);
    if (patch.status === "paused")
      for (const task of await this.db.listByGoalId<AgentTask>(owner, "tasks", id))
        if (!terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async setMilestoneDone(owner: string, goalId: string, milestoneId: string, done: boolean) {
    const saved = await this.db.setMilestoneDone<Goal>(owner, goalId, milestoneId, done);
    if (!saved) throw new AppError("Goal or milestone not found", 404);
    return saved;
  }
  /** `originThreadId` is the conversation a chat set the watch up from; its
   * notices are reported there (otherwise in the project's main conversation). */
  async createMonitor(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    options: { originThreadId?: string | null } = {},
  ) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
      options,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return null;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused") return null;
    if (task.state.resumingMonitor)
      return this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "paused", state: { resumingMonitor: true } },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, resumingMonitor: false, failures: 0, notice: null },
        },
      );
    if (!task.state.initializingMonitor) return null;
    return this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    if (action === "pause" || action === "stop") {
      const status = action === "pause" ? "paused" : "stopped";
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        {},
        { status, nextCheckAt: date() },
      );
      const task = await this.getTask(owner, monitor.taskId);
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
      return saved ?? monitor;
    }
    let monitorStatus = monitor.status;
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await this.getTask(owner, monitor.taskId);
      if (task.status === "cancelled") break;
      if (task.status === "paused") {
        // Mark the paused task before activating the monitor so no worker can claim it in between.
        const marked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", leaseId: task.leaseId ?? null },
          { state: { ...task.state, resumingMonitor: true } },
        );
        if (!marked) break;
        const activated = await this.db.compareAndSwap<Monitor>(
          owner,
          "monitors",
          id,
          { status: monitor.status },
          { status: "active", nextCheckAt: date(), error: null },
        );
        const saved = activated ?? (await this.db.get<Monitor>(owner, "monitors", id));
        if (saved?.status === "active" && (await this.activateMonitor(owner, saved))) return saved;
        const unmarked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", state: { resumingMonitor: true } },
          { state: { ...task.state, resumingMonitor: false } },
        );
        // Another request or maintenance may have finished this resume first.
        if (!unmarked && saved?.status === "active") {
          const latest = await this.getTask(owner, task.id);
          if (["queued", "running", "scheduled"].includes(latest.status)) return saved;
        }
        if (activated)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            id,
            { status: "active" },
            { status: monitor.status, error: monitor.error ?? null },
          );
        break;
      }
      // Only activate the monitor we read, so a concurrent stop is never undone.
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        { status: monitorStatus },
        { status: "active", nextCheckAt: date() },
      );
      if (!saved) break;
      monitorStatus = "active";
      this.worker.abort(owner, task.id);
      const queued = await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        // updatedAt fences out a whole run finishing in between, which would move the baseline.
        { status: task.status, leaseId: task.leaseId ?? null, updatedAt: task.updatedAt },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
      if (queued) return saved;
    }
    throw new AppError("The watch changed while updating. Try again.", 409);
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.listByStatus<AgentTask>(owner, "tasks", "succeeded"))
        .filter((task) => typeof task.input.messageId === "string")
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.listByStatus<Idea>(owner, "ideas", "new"))
      if (obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.listByStatus<Goal>(owner, "goals", "active"))
      if (!goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (idea.status === "new") {
      // A task already working on (or done with) the same email is opened instead of copied.
      const { kind, input } = idea;
      const handling =
        typeof input.messageId === "string"
          ? (await this.db.list<AgentTask>(owner, "tasks")).find(
              (task) =>
                task.kind === kind &&
                task.input.messageId === input.messageId &&
                task.status !== "failed" &&
                task.status !== "cancelled",
            )
          : undefined;
      if (handling)
        return (
          (await this.db.compareAndSwap<Idea>(
            owner,
            "ideas",
            id,
            { status: "new" },
            { status: "accepted", taskId: handling.id },
          )) ?? this.db.get<Idea>(owner, "ideas", id)
        );
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    if (idea.taskId && (await this.db.get(owner, "tasks", idea.taskId))) return idea;
    const goalId =
      typeof idea.input.goalId === "string"
        ? idea.input.goalId
        : (
            await this.createGoal(
              owner,
              { title: idea.title, description: idea.reason },
              hash(`idea-goal:${id}`),
            )
          ).id;
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.db.insertIfAbsent(owner, "notifications", value);
  }
  mailEvidence(mail: Mail): Evidence {
    return { id: mail.id, kind: "mail", title: mail.subject, excerpt: mail.body.slice(0, 400) };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  /** A declined, unapproved or expired message to people is
   * final. A new message to the same people in the same run is refused with the reason the run
   * reads (null: allowed). Other kinds of action are not held to it. */
  async finalSendRefusal(owner: string, task: AgentTask, input: ProposalInput) {
    if (!isMessageToPeople(input.kind)) return null;
    const since =
      typeof task.state.runStartedAt === "string" ? task.state.runStartedAt : task.createdAt;
    const final = await this.actions.finalRecipients(owner, task.id, since);
    const again = messageRecipients(input).filter((who) => final.has(who));
    if (!again.length) return null;
    return `A message to ${again.map((who) => who.replace(/^slack:/, "")).join(", ")} was declined or left unapproved, and that is final: it is not retried, reworded or sent another way. Do not prepare another message to them; tell the person it did not go out.`;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
    claimCheck?: ActionProposal["claimCheck"],
  ) {
    await context.guard();
    // An email goes through the project's mailbox when it has one; that channel is
    // the project's (not the Google connection the task started with), so it is not compared.
    // An app's action is prepared against that app's connection, which
    // the action service checks; the Google connection has nothing to do with it.
    const connection = isAppKind(input.kind)
      ? null
      : input.kind === "email.send"
        ? await this.workspace.mailConnection(owner)
        : await this.workspace.connection(owner);
    if (
      !isAppKind(input.kind) &&
      !isMailboxConnection(connection?.id) &&
      connection?.id !== task.state.connectionId
    )
      throw new AppError(
        "Google connection changed during this task. Start a new task using the current account.",
        409,
      );
    // Where the proposal waits. A chat-started task's has no
    // expiry; a background one (repeating, standing, a routine's) expires after 30 minutes; a
    // routine's draft never expires and its run does not wait on it.
    const routine = isRoutineTask(task);
    const chatStarted =
      !!task.originThreadId && !task.repeatMinutes && !routine && !isStandingTask(task);
    const routineDraft = routine && isMessageToPeople(input.kind);
    const fresh = !(await this.actions.existing(owner, `${task.id}:${key}`));
    const environmentId =
      typeof task.input?.environmentId === "string" ? task.input.environmentId : null;
    // The action review's call is made before the card, once (a resumed run finds the card).
    const rule = await reviewRuleFor(this.db, owner, environmentId, ruleKindOf(input));
    const settings = await readReviewSettings(this.db, owner);
    let verdict: ReturnType<typeof decideReview> | null = null;
    if (fresh && !routineDraft && rule?.mode !== "ask") {
      const alwaysAllow = rule?.mode === "always";
      let answer = null;
      let failed = false;
      if (needsModel(settings, input.kind, alwaysAllow)) {
        const model = modelSpec(this.config.model, this.config.fallbackModel);
        answer = model
          ? await askActionReview(model, input, settings, { signal: context.signal })
          : null;
        failed = !answer;
        context.signal.throwIfAborted();
      }
      verdict = decideReview({ settings, kind: input.kind, alwaysAllow, answer, failed });
    }
    const proposal = await this.actions.propose(
      owner,
      input,
      `${task.id}:${key}`,
      task.id,
      claimCheck,
      { noExpiry: chatStarted, fromRoutine: routine },
    );
    if (proposal.status === "succeeded") return proposal;
    // The owner's standing word on this kind of action,
    // for this account or the project: 「以后总是允许」 sends it now, 「以后都先问我」 waits for him.
    // Else the action review's verdict. A routine's draft is never let through.
    if (proposal.status === "awaiting_review" && !proposal.fromRoutine) {
      if (rule?.mode === "ask") {
        if (!proposal.askFirst)
          await this.db.compareAndSwap<ActionProposal>(
            owner,
            "actions",
            proposal.id,
            { status: "awaiting_review" },
            { askFirst: true },
          );
      } else if (verdict?.outcome === "run") {
        const sent = await this.actions.approveUnrefused(
          owner,
          proposal.id,
          verdict.by ?? "review",
          verdict.reason,
        );
        if (sent.status !== "awaiting_review") return sent;
      } else if (rule?.mode === "always" && !verdict) {
        const sent = await this.actions.approveUnrefused(owner, proposal.id, "rule");
        if (sent.status !== "awaiting_review") return sent;
      } else if (verdict?.reason && !proposal.reviewReason)
        await this.db.compareAndSwap<ActionProposal>(
          owner,
          "actions",
          proposal.id,
          { status: "awaiting_review" },
          { reviewReason: verdict.reason },
        );
    }
    // A routine's draft waits in the chat; the run does not wait on it.
    if (proposal.fromRoutine && proposal.status === "awaiting_review") {
      await context.event("approval", proposal.title, "Draft waiting in the chat; the run goes on");
      return proposal;
    }
    // On a general task this exact draft was not approved (it expired
    // unanswered or the person declined it); the run is told and goes on, the task does not fail.
    if (task.kind === "agent" && notApprovedStatuses.has(proposal.status)) return proposal;
    if (proposal.status !== "awaiting_review" && proposal.status !== "executing")
      throw new AppError(
        `Reviewed action ${proposal.status}: ${proposal.error ?? "No further action was taken"}`,
        409,
      );
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      const current = await this.db.get<AgentTask>(owner, "tasks", task.id);
      if (
        proposal.status === "awaiting_review" &&
        (current?.status === "paused" || current?.status === "cancelled")
      )
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    if (proposal.status === "awaiting_review")
      await context.event(
        "approval",
        proposal.title,
        `Review prepared for ${proposal.account ?? "the connected account"}`,
      );
    return proposal;
  }
  /** A proposal a chat turn makes itself (an app's tool that is not
   * read-only, a Slack draft). The same review as a task's (rule, action review, card), without a
   * task: it waits with no expiry for the person, and runs from the card. */
  async proposeFromChat(
    owner: string,
    input: ProposalInput,
    key: string,
    signal?: AbortSignal,
  ): Promise<ActionProposal> {
    const idempotency = `chat:${key}`;
    const fresh = !(await this.actions.existing(owner, idempotency));
    const rule = await reviewRuleFor(this.db, owner, null, ruleKindOf(input));
    const settings = await readReviewSettings(this.db, owner);
    let verdict: ReturnType<typeof decideReview> | null = null;
    if (fresh && rule?.mode !== "ask") {
      const alwaysAllow = rule?.mode === "always";
      let answer = null;
      let failed = false;
      if (needsModel(settings, input.kind, alwaysAllow)) {
        const model = modelSpec(this.config.model, this.config.fallbackModel);
        answer = model ? await askActionReview(model, input, settings, { signal }) : null;
        failed = !answer;
        signal?.throwIfAborted();
      }
      verdict = decideReview({ settings, kind: input.kind, alwaysAllow, answer, failed });
    }
    const proposal = await this.actions.propose(owner, input, idempotency, undefined, undefined, {
      noExpiry: true,
    });
    if (proposal.status !== "awaiting_review") return proposal;
    if (rule?.mode === "ask") {
      if (!proposal.askFirst)
        await this.db.compareAndSwap<ActionProposal>(
          owner,
          "actions",
          proposal.id,
          { status: "awaiting_review" },
          { askFirst: true },
        );
    } else if (verdict?.outcome === "run") {
      return this.actions.approveUnrefused(
        owner,
        proposal.id,
        verdict.by ?? "review",
        verdict.reason,
      );
    } else if (rule?.mode === "always" && !verdict) {
      return this.actions.approveUnrefused(owner, proposal.id, "rule");
    } else if (verdict?.reason && !proposal.reviewReason) {
      await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        proposal.id,
        { status: "awaiting_review" },
        { reviewReason: verdict.reason },
      );
    }
    return proposal;
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    if (task.repeatMinutes && repeatableTaskKinds.has(task.kind))
      return this.executeRepeating(owner, task, context);
    return this.continueUnfinished(
      owner,
      task,
      context,
      await this.executeOnce(owner, task, context),
    );
  }
  /** Fork: a one-off model run that ends without a completion call (the step cap, or a reply
   * with no tool call) is queued again with `state.autoContinued + 1`; the next run's message
   * says it continues unfinished work (model.ts). There is no limit and it
   * never asks the person (AGENT_AUTO_CONTINUE_RUNS is gone, like the waits limit): the person
   * can pause or cancel the task. The count is only for the next run's message. A completion, a
   * user answer or a wait_until wait resets it. A real question from the model always waits,
   * and a wait_until outcome (`scheduled`) is returned unchanged. A finished run also
   * closes a repeating run it ended as a one-off (Stop repeating during that run or its wait), so
   * Repeat this task later starts a fresh run instead of continuing the finished one. */
  private async continueUnfinished(
    owner: string,
    task: AgentTask,
    context: TaskContext,
    result: Partial<AgentTask>,
  ): Promise<Partial<AgentTask>> {
    if (result.status === "succeeded") {
      if (!Number(task.state.autoContinued) && !task.state.runOpen && !taskIncident(task.state))
        return result;
      const state = (await this.db.get<AgentTask>(owner, "tasks", task.id))?.state ?? task.state;
      return {
        ...result,
        state: {
          ...state,
          ...(state.autoContinued ? { autoContinued: 0 } : {}),
          ...(state.runOpen ? { runOpen: false } : {}),
          // A finished task has no incident left (fork, report line).
          ...(taskIncident(state) ? { incident: null } : {}),
        },
      };
    }
    if (result.status !== "waiting_input" || result.question !== runEndedWithoutCompletion)
      return result;
    const state = result.state ?? task.state;
    const done = Number(state.autoContinued ?? 0);
    // A run that ended by itself (the step cap, a reply without a tool call)
    // was not stopped by the infrastructure, as a wait without blocked: the incident is over (kept
    // as over only when the person was told, so the next run tells them once).
    const incident = incidentAfterRecovery(taskIncident(state), date());
    await context.event(
      "status",
      continuingLabel,
      "The run ended without a completion call; the next run picks up where it left off.",
    );
    return {
      ...result,
      status: "queued",
      question: null as unknown as string,
      state: { ...state, autoContinued: done + 1, incident },
    };
  }
  /** The next wake at the clock written on the task, in the account's time zone. Null when the
   * task has no clock or no time zone: the caller keeps now + the interval. */
  private async nextWrittenRun(owner: string, task: AgentTask): Promise<string | null> {
    const when = task.prompt
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("什么时候："))
      ?.slice("什么时候：".length)
      .trim();
    if (!when) return null;
    try {
      let zone = await readAccountZone(this.db, owner);
      const environmentId = taskEnvironmentId(task);
      if (!zone && environmentId)
        zone = (await this.computer.settings.view(envOwner(owner, environmentId))).timezone;
      return zone ? nextClockRun(when, zone, new Date(Date.now() + 60_000)) : null;
    } catch {
      return null;
    }
  }
  /** Fork: a repeating task. Each run starts from a clean plan and state (a run resumed after
   * a question or an approval continues instead); a finished run schedules the next one; a
   * failed run is retried at the next interval, and five failures in a row pause the task. */
  private async executeRepeating(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const interval = Number(task.repeatMinutes) * 60000;
    const runs = Number(task.runs ?? 0);
    if (!task.state.runOpen) {
      task = await context.checkpoint({
        plan: planTitles(task.kind).map((title, i) => ({
          id: String(i),
          title,
          status: "pending",
        })),
        evidence: [],
        error: null,
        actionId: null,
        question: null as unknown as string,
        state: {
          connectionId: task.state.connectionId ?? null,
          failures: task.state.failures ?? 0,
          failureStreak: task.state.failureStreak ?? 0,
          runOpen: true,
          ...this.routines.startState(task),
          // The incident is the task's, not one run's.
          ...(task.state.incident ? { incident: task.state.incident } : {}),
        },
      });
      await context.event("status", `Run ${runs + 1} started`, task.prompt);
    }
    let result: Partial<AgentTask>;
    try {
      result = await this.executeOnce(owner, task, context);
    } catch (error) {
      if (error instanceof LostLeaseError || context.signal.aborted) throw error;
      await context.guard();
      const failures = Number(task.state.failures ?? 0) + 1;
      const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
      const detail = error instanceof Error ? error.message : "Run failed";
      const nextRunAt = isRoutine(task)
        ? await this.routines.nextRun(owner, task)
        : new Date(Date.now() + interval).toISOString();
      // A model provider's balance, quota or billing answer is the owner's;
      // another run cannot change it, so the task fails into 需要你 (Retry runs it again).
      if (takeBackup(detail, this.config.fallbackModel)) {
        await this.backupNotice(owner, task.id, (title, text) =>
          context.event("status", title, text),
        );
        return {
          status: "scheduled",
          error: null,
          nextRunAt: new Date(Date.now() + 5_000).toISOString(),
          state: { ...task.state, failures, failureStreak, runOpen: false },
        };
      }
      if (providerQuotaPattern.test(detail)) {
        await context.event("error", "Task needs attention", detail);
        return {
          status: "failed",
          error: detail,
          ...this.routines.settle(task, "failed", detail),
          state: { ...task.state, failures, failureStreak, runOpen: false },
        };
      }
      // The same app refusing two runs in a row pauses a routine.
      const auth = this.routines.authStep(task, isRoutine(task) ? authBlockOf(detail) : null);
      if (auth.pause && auth.authBlock) {
        await context.event("error", "Paused: an app needs connecting", detail);
        return this.routines.pausedForAuth(task, auth.authBlock, detail);
      }
      await context.event(
        "error",
        failures >= 5 ? "Paused after repeated failures" : "Run failed; next run scheduled",
        detail,
      );
      return {
        status: failures >= 5 ? "paused" : "scheduled",
        error: detail,
        nextRunAt: nextRunAt ?? (null as unknown as string),
        ...this.routines.settle(task, "failed", detail, { authBlock: auth.authBlock }),
        state: {
          ...task.state,
          failures,
          failureStreak,
          runOpen: false,
          notice: {
            title: failures >= 5 ? `${task.title} paused` : `${task.title} failed`,
            body: detail,
            key: `task-run-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
          },
        },
      };
    }
    if (result.status === "waiting_input" && result.question === runEndedWithoutCompletion) {
      // Unattended runs must not stall on a missing completion call: the run counts as finished.
      // A real question from the model still waits for the user. The text
      // the model wrote during the run is its own running commentary, not a report: it stays in
      // state.lastUpdate and the run's 'Agent update' event, the run has no result, and no card
      // or notification goes out for it (docs/report-back.md).
      await context.event("status", "Run ended without a completion call; counted as finished");
      result = {
        ...result,
        status: "succeeded",
        question: null as unknown as string,
        result: null as unknown as string,
      };
    }
    if (result.status !== "succeeded") return result;
    // A written clock (每天 7:30) stays on that clock. An interval with no clock stays now + interval.
    // A routine's next run is its trigger's (none for a mail routine).
    const nextRunAt = isRoutine(task)
      ? await this.routines.nextRun(owner, task)
      : ((await this.nextWrittenRun(owner, task)) ?? new Date(Date.now() + interval).toISOString());
    await context.event(
      "status",
      `Run ${runs + 1} finished; ${nextRunAt ? `next run ${nextRunAt}` : "waiting for mail"}`,
    );
    // The 第 N 轮完成 card is the run's finish_task summary, written for the
    // person; a run without one sends none (and an old notice is never sent again).
    const summary = typeof result.result === "string" ? result.result.trim() : "";
    const {
      notice: _old,
      quietRun,
      authFailure,
      ...state
    } = { ...task.state, ...(result.state ?? {}) };
    // A routine run that ended after an app refused it counts as
    // failed for that app; the second in a row pauses the routine.
    const auth = this.routines.authStep(task, (authFailure as AuthBlock | undefined) ?? null);
    if (auth.pause && auth.authBlock) {
      await context.event("error", "Paused: an app needs connecting", summary);
      return {
        ...result,
        ...this.routines.pausedForAuth(task, auth.authBlock, summary || auth.authBlock.name, state),
        runs: runs + 1,
      };
    }
    // A run that finished is past any infrastructure incident.
    const incident = incidentAfterRecovery(taskIncident(state), date());
    return {
      ...result,
      status: "scheduled",
      nextRunAt: nextRunAt ?? (null as unknown as string),
      runs: runs + 1,
      error: null,
      ...this.routines.settle(task, authFailure ? "failed" : "succeeded", summary, {
        authBlock: auth.authBlock,
      }),
      state: {
        ...state,
        incident,
        failures: 0,
        runOpen: false,
        // A routine run that had nothing new sends no card and no notification; its
        // summary is in the routine's history.
        ...(summary && !quietRun
          ? {
              notice: {
                title: task.title,
                body: summary,
                key: `task-run:${task.id}:${runs + 1}`,
              },
            }
          : {}),
      },
    };
  }
  private async executeOnce(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed");
        // Sent by the owner's standing rule, so the report says so.
        if (action.autoApproved)
          await context.event(
            "status",
            action.autoApproved === "review"
              ? "Let through by the action review"
              : "Sent by your rule",
            action.reviewReason ?? action.title,
          );
        task = await context.checkpoint({
          state: {
            ...task.state,
            approvalResult:
              action.autoApproved === "review"
                ? `Run at once by the owner's action review (${action.reviewReason ?? "low risk"}): ${action.result ?? ""}`
                : action.autoApproved
                  ? `Sent at once by the owner's rule to always allow this kind: ${action.result ?? ""}`
                  : action.result,
          },
          actionId: null,
          // The run after a decided review is a resume.
          resumes: (task.resumes ?? 0) + 1,
        });
      } else if (task.kind === "agent" && notApprovedStatuses.has(action.status)) {
        // A review that expired unanswered or was declined ended the
        // whole task, so an outreach loop died on the first email nobody clicked. The run is
        // told it was not sent and decides what to do next.
        await context.event("status", "Review not approved", `${action.title} (${action.status})`);
        task = await context.checkpoint({
          state: {
            ...task.state,
            approvalResult: `Not approved (${action.status}): “${action.title}” was not sent.`,
          },
          actionId: null,
          resumes: (task.resumes ?? 0) + 1,
        });
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    if (task.kind === "monitor") {
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        // Each streak of failures (after a success or a resume) gets its own alerts.
        const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          { error: detail, nextCheckAt },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        return {
          status: failures >= 5 ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            resumingMonitor: false,
            failureStreak,
            notice: {
              title: "Watch needs attention",
              body: detail,
              key: `watch-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
            },
          },
        };
      }
    }
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary);
    }
    return executeModelTask(this, owner, task, context);
  }
  /** `text` (a wait note, a finish summary) with the
   * not-confirmed mark on a line of its own when an action this run recorded on the task's ledger
   * (at or after `since`) is still not confirmed, so the run's own words never stand for it as
   * done. Any such action, not only the latest: a later confirmed one does not confirm it. The
   * clients show the mark in their words; the next run and the chat read it as it is. */
  async markUnconfirmed(owner: string, task: AgentTask, since: string, text: string) {
    const ledger = actionLedgerOf(owner, task);
    if (!ledger || text.includes(unconfirmedMark)) return text;
    const rows = await this.db.list<AccountAction>(ledger, accountActionsKind);
    const open = rows.some((row) => row.taskId === task.id && row.at >= since && row.unconfirmed);
    return open ? `${text}\n${unconfirmedMark}` : text;
  }
  /** Fork: wait_until. The run ends and the task becomes `scheduled` with `nextRunAt` in
   * `minutes`, and `state.wait` holds the note for the next run (its priorState and message).
   * The worker claims it when due like a repeating task's next run, so a one-off task runs
   * again and ends normally on finish_task; the run stays open (`runOpen`, set for a one-off
   * task too, so Repeat this task during that run or its wait continues it) and a repeating
   * task's run resumes, its interval starting once that run finishes. A wait is a deliberate
   * outcome: automatic continuation does not apply and its counter resets; the rest of the
   * state stays.
   * A wait never asks the person anything and has
   * no limit: it is the task's state (the live panel shows when it runs again), not a report.
   * `state.waits` counts the waits since the last progress (the task's start, an answer, a
   * redirect, an action recorded on the account), shown on the task; it stops nothing.
   * The note is also the task's `lastUpdate`, so the latest progress record is never older than
   * the note when a later run (after an interruption, a failure, a question) reads both.
   * `account` is passed for a task bound to an account. Before the wait is scheduled the task is
   * read again: an instruction the person gave during the run (`pendingAnswer`) makes it run
   * again at once. */
  async wait(
    task: AgentTask,
    context: TaskContext,
    minutes: number,
    note: string,
    account?: { owner: string; taskId: string; runStartedAt: string },
    blocked?: IncidentKind,
    /** The task's owner, for the incident's picture (fork, incident screenshots). */
    owner?: string,
  ) {
    await context.guard();
    const since = new Date();
    let redirected = false;
    let woken = false;
    if (account) {
      const latest = await this.db.get<AgentTask>(account.owner, "tasks", account.taskId);
      redirected = !!latest?.pendingAnswer;
      woken = !!latest?.wakeAt && latest.wakeAt >= account.runStartedAt;
    }
    // The same part blocking again is not probed at the same pace: each
    // wait after the first is twice the one before (at most a day), and the owner sees it.
    const blockedWaits = blocked
      ? (incidentAfterFailure(taskIncident(task.state), blocked, since.toISOString()).waits ?? 1)
      : 1;
    if (blockedWaits > 1)
      minutes = Math.min(1440, Math.max(minutes, minutes * 2 ** (blockedWaits - 1)));
    const until = new Date(since.getTime() + minutes * 60000).toISOString();
    const wait: TaskWait = {
      minutes,
      note,
      since: since.toISOString(),
      until,
    };
    const waits = Number(task.state.waits ?? 0) + 1;
    // A wait because the infrastructure failed opens or keeps the task's
    // incident; any other wait means the run was not stopped by it, so the incident is over.
    const current = taskIncident(task.state);
    const failure = blocked;
    const incident = failure
      ? incidentAfterFailure(current, failure, since.toISOString())
      : incidentAfterRecovery(current, since.toISOString());
    // A new incident is kept with the desktop's picture of now.
    if (failure && isNewIncident(incident, current) && owner)
      await this.recordTaskIncident(owner, task, failure, note);
    const state = {
      ...task.state,
      wait,
      incident,
      lastUpdate: note,
      // A waiting run is open whatever the repeat setting is when it ends: Repeat this task during
      // this run or its wait makes the run after the wait run 1 of the repeating task, with this
      // note, answer and operations, instead of a fresh run that starts the job over
      // (executeRepeating). A one-off run that finishes closes it (continueUnfinished).
      runOpen: true,
      ...(task.state.autoContinued ? { autoContinued: 0 } : {}),
      // A notice left from an earlier run is not announced again by this wait.
      ...(task.state.notice ? { notice: null } : {}),
    };
    await context.event(
      "status",
      `Waiting ${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
      [
        note,
        `Resumes at ${until}`,
        // Why it waits, so the timeline says it after the incident is over.
        ...(blocked ? [`Blocked: ${blocked}`] : []),
        ...(redirected ? ["Runs again now: the person sent a new instruction"] : []),
        ...(woken && !redirected ? ["Runs again now: it was woken during the run"] : []),
      ].join("\n"),
    );
    return {
      status: "scheduled" as const,
      nextRunAt: redirected || woken ? new Date().toISOString() : until,
      question: null as unknown as string,
      error: null,
      state: { ...state, waits },
    };
  }
  /** The desktop this run drives is held by another run, or
   * another operation came between this run's (computer.ts `DesktopHeldError`,
   * `desktopBusyMessage`): the run ends here, blames nothing (no incident, no need, no fact), and
   * the task is scheduled again after `desktopHeldRetryMs` (at once when the person sent an
   * instruction meanwhile). The next run is told (`state.desktopHeld`, model.ts
   * `desktopHeldNote`) that nothing this one did on a site counts. */
  async desktopHeld(
    owner: string,
    task: AgentTask,
    context: TaskContext,
    detail: string,
  ): Promise<Partial<AgentTask>> {
    await context.guard();
    const at = date();
    const latest = await this.db.get<AgentTask>(owner, "tasks", task.id);
    const nextRunAt = latest?.pendingAnswer
      ? at
      : new Date(Date.parse(at) + desktopHeldRetryMs).toISOString();
    await context.event("status", desktopHeldLabel, `${detail}\nResumes at ${nextRunAt}`);
    return {
      status: "scheduled",
      nextRunAt,
      question: null as unknown as string,
      error: null,
      state: { ...task.state, runOpen: true, desktopHeld: { detail: sliceText(detail, 500), at } },
    };
  }
  /** A run of a task bound to an account that the
   * infrastructure stopped outside the model's tools: the model provider failed in a way that
   * goes away by itself, the network dropped, or the run's idle or hard deadline passed (a
   * desktop that hangs); model.ts `stoppedByInfrastructure` decides, and every other failure (a
   * refused key, a model that is not configured) fails the task as before. It is not a failure
   * and asks the person nothing: no card, no notification, nothing in 需要你. The task is taken up
   * again the way the worker takes up any run whose process died, when the run's lease runs out
   * (worker.ts; no time of its own), or at once when the person sent an instruction meanwhile, as
   * after a wait. That run is told what stopped this one (`state.runFailure`, model.ts
   * `runFailureNote`) and decides itself, under the infrastructure rule, whether to wait longer
   * with wait_until; no run reports it (the incident is the notice). The detail stays in the
   * timeline. `progress` is the text the model wrote before it was stopped (its progress record,
   * like `lastUpdate` after the step cap); `previous` is the run stopped before this one. */
  async runStopped(
    owner: string,
    task: AgentTask,
    context: TaskContext,
    detail: string,
    progress: string,
    previous: TaskRunFailure | null,
  ) {
    await context.guard();
    const latest = await this.db.get<AgentTask>(owner, "tasks", task.id);
    if (!latest?.leaseUntil) throw new Error(detail);
    return this.stoppedOutcome(
      owner,
      task,
      latest,
      detail,
      progress,
      previous,
      (kind, title, text) => context.event(kind, title, text),
    );
  }
  /** v1.2: the owner hears once that the runs moved to the backup model. */
  private async backupNotice(
    owner: string,
    taskId: string,
    event: (title: string, detail: string) => Promise<void>,
  ) {
    const model = this.config.fallbackModel ?? "";
    const state = backupState(model);
    const words = backupWords(state.reason ?? "quota", model, state.until);
    await this.notify(
      owner,
      words.title,
      `${words.text}这一轮停在这里，下一轮用备用模型。`,
      taskId,
      `model-fallback:${owner}`,
    );
    await event("Switched to the backup model", model);
  }
  /** What a run that was stopped (by the infrastructure, `runStopped`; or, on a standing task, by
   * any failure the owner need not fix, `standingRetry`) leaves: the task `scheduled` again after
   * its lease or the growing backoff (`stoppedRetryDelayMs`; at once when the person sent an
   * instruction), `state.runFailure` counting the runs stopped in a row, and the task's incident
   * (`stoppedIncidentKind`). The run that makes it `failedRunsBeforeOwner` in a row writes one
   * event more: from then on the owner sees the trouble (`runTrouble`, packages/domain/src/
   * standing.ts), while the task goes on retrying. `task` is the state to keep, `latest` the
   * record as saved now (its lease and any instruction waiting). */
  private async stoppedOutcome(
    owner: string,
    task: AgentTask,
    latest: AgentTask,
    detail: string,
    progress: string,
    previous: TaskRunFailure | null,
    event: (kind: RunEvent["kind"], title: string, detail: string) => Promise<void>,
  ) {
    const at = date();
    // A run that reached its own time limit was working, not stopped:
    // said as such, no incident and no count of stopped runs (a stopped run before it is over),
    // and the next run goes on when the lease frees, told where this one ended (`runCapped`).
    if (runCapped(detail)) {
      const nextRunAt = latest.pendingAnswer ? at : (latest.leaseUntil ?? at);
      await event("status", runCappedLabel, `${detail}\nResumes at ${nextRunAt}`);
      const { notice: _notice, runFailure: _over, ...state } = task.state;
      return {
        status: "scheduled" as const,
        nextRunAt,
        question: null as unknown as string,
        error: null,
        state: {
          ...state,
          ...(progress.trim() ? { lastUpdate: progress } : {}),
          runOpen: true,
          runCapped: { at, detail: sliceText(detail, 200) },
        },
      };
    }
    // v1.2: a key out of quota moves the runs to the backup instead of waiting for its reset. The
    // provider's 429 is an infrastructure stop, so this is the path it takes, not the failed one.
    if (takeBackup(detail, this.config.fallbackModel)) {
      await this.backupNotice(owner, task.id, (title, text) => event("status", title, text));
      const { notice: _notice, runFailure: _over, ...state } = task.state;
      return {
        status: "scheduled" as const,
        nextRunAt: latest.pendingAnswer ? at : (latest.leaseUntil ?? at),
        question: null as unknown as string,
        error: null,
        state: {
          ...state,
          ...(progress.trim() ? { lastUpdate: progress } : {}),
          runOpen: true,
        },
      };
    }
    // Stopped again and again (an outage): each retry waits longer (stoppedRetryDelayMs); an
    // instruction from the person still takes it up at once.
    const count = (previous?.count ?? 0) + 1;
    // v1.2: a provider that says when its limit comes back is waited for till then.
    const backoff =
      quotaResetAt(detail, Date.parse(at)) ??
      new Date(Date.parse(at) + stoppedRetryDelayMs(count)).toISOString();
    const leaseUntil = latest.leaseUntil ?? at;
    const nextRunAt = latest.pendingAnswer ? at : backoff > leaseUntil ? backoff : leaseUntil;
    // The stop is the task's incident (the desktop for a run with no
    // progress, else the model provider), a fact the account row shows while the task retries by
    // itself; the event names it, so the timeline says what stopped the run.
    const kind = stoppedIncidentKind(detail);
    await event(
      "error",
      runStoppedLabel,
      `${kind ? `Blocked: ${kind}\n` : ""}${detail}\nResumes at ${nextRunAt}`,
    );
    if (count === failedRunsBeforeOwner) await event("status", runTroubleLabel, detail);
    const { notice: _notice, ...state } = task.state;
    const runFailure: TaskRunFailure = {
      detail: sliceText(detail, 2000),
      at,
      since: previous?.since ?? at,
      count,
    };
    const current = taskIncident(task.state);
    const incident = kind ? incidentAfterFailure(current, kind, at) : current;
    // A new incident is kept with the desktop's picture of now.
    if (kind && isNewIncident(incident, current))
      await this.recordTaskIncident(owner, task, kind, detail);
    return {
      status: "scheduled" as const,
      nextRunAt,
      question: null as unknown as string,
      error: null,
      state: {
        ...state,
        ...(progress.trim() ? { lastUpdate: progress } : {}),
        // Open like a waiting run: Repeat this task meanwhile continues this run (see wait).
        runOpen: true,
        runFailure,
        incident,
      },
    };
  }
  /** Production 10-18: one error the
   * server did not take for the infrastructure (a relay's bare `empty_stream`) failed the
   * founder's loop for good. A standing task (an account's loop, or a task whose operating plan is
   * saved: `isStandingTask`) has no end of its own, so a failed run of it is never its end: it is
   * stopped (`stoppedOutcome`, backoff and incident) and the next run is told. Two failures still
   * fail it into 需要你 with 重试: what only the owner can fix (`ownerOnlyFailure`: the provider's
   * quota or billing, a refused key, permission or model, no model configured), and a refusal of
   * the server's own (an AppError below 500, such as an account that no longer exists). A
   * repeating task keeps its own rule (executeRepeating). Null: fail it as before. */
  private async standingRetry(
    owner: string,
    claimed: AgentTask,
    error: unknown,
    leaseId: string,
  ): Promise<Partial<AgentTask> | null> {
    const latest = await this.db.get<AgentTask>(owner, "tasks", claimed.id);
    if (latest?.status !== "running" || latest.leaseId !== leaseId) return null;
    if (latest.repeatMinutes || !(isStandingTask(latest) || isStandingTask(claimed))) return null;
    const detail = error instanceof Error ? error.message : String(error);
    // The server's own refusal: failed as before, marked so no check takes it up again for it.
    if (error instanceof AppError && error.status < 500) {
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: claimed.id,
        date: date(),
        kind: "error",
        title: "Task needs attention",
        detail,
      });
      return {
        status: "failed",
        error: detail,
        state: { ...latest.state, refused: { error: detail, at: date() } },
      };
    }
    if (ownerOnlyFailure(detail)) return null;
    return this.stoppedOutcome(
      owner,
      latest,
      latest,
      detail,
      "",
      taskRunFailure(claimed.state),
      async (kind, title, text) => {
        await this.db.put(owner, "run-events", {
          id: randomUUID(),
          taskId: claimed.id,
          date: date(),
          kind,
          title,
          detail: text,
        });
      },
    );
  }
  /** A failed standing task is taken up again when it may be: an account's
   * loop through its check (`AccountLoops.ensure`, which also ends one with nothing to work on);
   * a task with its operating plan saved (not a loop) on the project's default desktop when it
   * failed within `standingReviveWindowMs` (one failed longer ago the owner has left). */
  async reviveStanding(owner: string, task: AgentTask) {
    if (task.status !== "failed") return null;
    // A task with its plan saved that is bound to an account (one made before v0.6) is not taken
    // up again: the account's own loop acts on it now, and two standing workers on one account
    // would act twice. Only such a task on the project's default desktop is.
    const environmentId = task.input?.environmentId;
    if (typeof environmentId === "string" && isEnvironmentId(environmentId)) return null;
    if (Date.now() - Date.parse(task.updatedAt) > standingReviveWindowMs) return null;
    return this.reviveFailed(owner, task);
  }
  /** Takes up again a standing task an error failed (before standing tasks
   * retried by themselves, or by a way that retry did not cover): `scheduled`, its next run told
   * what stopped it (`state.runFailure`, `runFailureNote`), at once the first time and after the
   * growing backoff each time after (`state.revived`, so a task that keeps failing that way is
   * not run every minute), with the event `standingRevivedLabel`. `extra` is written in the same
   * swap (a loop's current title and prompt). Null when it is not one to take up: not standing,
   * repeating, failed by what only the owner can fix or by the server's own refusal
   * (`state.refused`, standingRetry), bound to an account that is gone, or changed meanwhile.
   * Idempotent: the swap holds on the failed record only. */
  async reviveFailed(owner: string, task: AgentTask, extra: Partial<AgentTask> = {}) {
    if (task.status !== "failed" || task.repeatMinutes || !isStandingTask(task)) return null;
    if (ownerOnlyFailure(task.error ?? "")) return null;
    const refused = task.state.refused as { error?: unknown } | undefined;
    if (refused?.error === task.error) return null;
    const environmentId = task.input?.environmentId;
    if (typeof environmentId === "string") {
      const record = await this.environments.find(owner, environmentId).catch(() => null);
      if (!record || record.deleting) return null;
    }
    const at = date();
    const failedAt = Number.isFinite(Date.parse(task.updatedAt)) ? task.updatedAt : at;
    const previous = taskRunFailure(task.state);
    const revivals =
      Number((task.state.revived as { count?: unknown } | undefined)?.count ?? 0) || 0;
    const nextRunAt = new Date(
      Math.max(Date.now(), Date.parse(failedAt) + stoppedRetryDelayMs(revivals + 1)),
    ).toISOString();
    const runFailure: TaskRunFailure = {
      detail: sliceText(task.error ?? "", 2000),
      at: failedAt,
      since: previous?.since ?? failedAt,
      count: (previous?.count ?? 0) + 1,
    };
    const revived = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { status: "failed", updatedAt: task.updatedAt },
      {
        ...extra,
        status: "scheduled",
        nextRunAt,
        error: null,
        question: null as unknown as string,
        leaseId: null,
        leaseUntil: null,
        updatedAt: at,
        state: {
          ...task.state,
          runFailure,
          runOpen: true,
          revived: { count: revivals + 1, at },
        },
      },
    );
    if (!revived) return null;
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: task.id,
      kind: "status",
      date: at,
      title: standingRevivedLabel,
      detail: task.error ?? "",
    });
    return revived;
  }
  /** Report_to_user. One `report` run event and one chat report in the
   * task's conversation; the run goes on. The same text and links are reported once per run of
   * a repeating task (`runs`) and per resume (`resumes`: an answer, Retry, Resume, a decided
   * review, the run after a wait_until wait), so a run that is interrupted or continued
   * automatically and says it again is not repeated, while the same notice after a resume is.
   * `posted`, the exact text of the action, is kept apart from the sentence
   * for the person, so the card quotes it under the sentence. */
  async report(
    owner: string,
    task: AgentTask,
    raw: unknown,
    context: TaskContext,
    /** `infrastructure`: the run is in infrastructure trouble on real signals
     * only (model.ts `systemTrouble`: an open incident on the system it runs on, a previous run the
     * infrastructure stopped, a desktop that did not start, a tool failed by the infrastructure). */
    run: { infrastructure?: boolean; steps?: readonly RunStep[] } = {},
  ): Promise<ReportReplyWithEvidence> {
    const input = reportInputWithSiteSchema.parse(raw);
    const text = input.text.trim();
    const posted = postedText(input.posted);
    const given = reportLinks(input.links);
    // A report that says the account put
    // something on a site carries the address of that item itself; without it the report is
    // recorded, shown as not confirmed, and the run is told how to find it. No site is known.
    // And the run looked at it after acting and says what it
    // saw (`verified`, `seen`), as its own steps show (`run.steps`); else 「没有亲眼确认」.
    const evidence = reportEvidence({ ...input, posted }, given.links, run.steps);
    const links = evidence.links;
    const ignored = evidence.invalid ? [...given.ignored, evidence.invalid] : given.ignored;
    // The task's incident is the server's (`state.incident`). Since
    // No report opens, repeats or ends it: the owner sees the incident itself. An action
    // recorded on the account still ends it (below); `incident` in the reply is the incident as
    // the server keeps it then, which the run writes into the task's state (model.ts).
    const at = date();
    const current = taskIncident(task.state);
    let incident: TaskIncident | null | undefined;
    const id = hash(
      `report:${task.id}:${task.runs ?? 0}:${task.resumes ?? 0}:${hash(JSON.stringify(posted ? [text, links, posted] : [text, links]))}${evidence.unconfirmed ? ":unconfirmed" : ""}`,
    );
    // A task bound to an account records each action it
    // reports on that account's ledger, and its cards are titled by what was done. Only marks:
    // an action past what is set for the account is recorded and flagged, never refused.
    // A standing task on the project's default desktop records its actions on
    // the project's own ledger (actionLedgerOf), so what it did can be compared with its plan.
    const ledgerOwner = actionLedgerOf(owner, task);
    // Infrastructure trouble is the server's to show (the task's
    // incident), never a report: production had dozens of 「桌面恢复了」「浏览器起不来」 cards. A
    // report from a run in that trouble that claims no action (`reportProof`: no action word, no
    // posted text outside a notice or summary), is no summary and carries no address at all (no
    // permalink, no target, no link that opens) can only be about the trouble: it is kept as a run
    // event, not a card. No word of it is read: what it says is the model's, and anything the
    // owner must give goes through the tools that ask for it (record_sign_in, ask_user, a card).
    if (
      run.infrastructure &&
      input.topic !== "summary" &&
      !reportProof({ ...input, posted }) &&
      !links.length &&
      !input.permalink?.trim() &&
      !input.target?.trim()
    ) {
      await context.guard();
      await this.db.insertIfAbsent(owner, "run-events", {
        id,
        taskId: task.id,
        date: at,
        kind: "status",
        title: infrastructureNoteLabel,
        detail: text,
      } satisfies RunEvent);
      return {
        reported: false,
        note: "Kept off the person's chat: this run is in infrastructure trouble, which the server shows them by itself; a report about the work itself gets through once a step works again or when it carries an address",
      };
    }
    let title = "Update";
    const marks: string[] = [];
    let entry: LedgerEntry | null = null;
    let recorded = false;
    let site: string | null = null;
    let action: string | null = null;
    let confirmsNote: string | null = null;
    let ref: string | null = null;
    let cardOf: string | null = null;
    let rowCard: string | null = null;
    if (ledgerOwner) {
      // The action is what the AI said it did, on the site it named;
      // nothing is inferred from links. A report without one (a summary, a notice, a link it
      // only found) is never an action; the AI's own `action` wins over a topic.
      action = input.action && input.action !== "none" ? input.action : null;
      if (action) {
        site = siteOf(input.site ?? "");
        if (!site)
          throw new AppError(
            "site must be the website the action was taken on: its domain or any address on it",
            422,
          );
        title = actionReportLabel;
        const ledger = await this.ledgerEntry(ledgerOwner, owner, task, site, action, {
          // What the action made, and the address that tells it apart (fork, report evidence).
          permalink: evidence.permalink,
          key: evidence.key,
          // What was posted is the action's own text; the sentence about it may be reworded.
          text: posted ?? text,
          unconfirmed: evidence.unconfirmed,
          // As the answer gave it, quotes aside.
          confirms: input.confirms?.replace(/^["'`]+|["'`]+$/g, "") || undefined,
          links,
          target: input.target?.trim()
            ? (normalizeLink(input.target) ?? input.target.trim())
            : null,
          steps: run.steps,
        });
        entry = ledger.entry;
        confirmsNote = ledger.confirmsNote ?? null;
        // A row written without its confirmation
        // keeps this report's card; a later report of the action while it waits rewrites that card.
        if (entry?.unconfirmed && !entry.replaces) entry = { ...entry, reportId: id };
        const prior = ledger.row;
        if (prior?.unconfirmed && prior.taskId === task.id && prior.reportId)
          cardOf = prior.reportId;
        rowCard = prior?.reportId ?? null;
        // The reference the report of this action with its address
        // names, while its row (this task's) waits for one.
        const waiting = entry?.unconfirmed ? entry : ledger.row?.unconfirmed ? ledger.row : null;
        if (evidence.unconfirmed && waiting?.taskId === task.id) ref = confirmsRef(waiting.id);
        if (entry) {
          // A row taken over keeps what its first report named when this one names nothing.
          const target = input.target?.trim()
            ? (normalizeLink(input.target) ?? input.target.trim())
            : (entry.target ?? null);
          const targetUser = input.targetUser?.trim() || entry.targetUser || null;
          entry = { ...entry, target, targetUser };
        }
        // Recorded first, before the lease is checked and before the card: the action was taken
        // whatever happens to this run now, and an action missing from the ledger lets the
        // account go past its pacing. A row taken over (fork, report evidence) is the same
        // action under the key its address gives: not a new one, and its pacing was told then.
        // When that key already holds the action, the row that waited for it was this action
        // told before its address, and goes.
        if (entry) {
          const { replaces, ...row } = entry;
          if (!replaces) {
            recorded = !!(await this.db.insertIfAbsent(ledgerOwner, accountActionsKind, row));
            if (recorded) await this.pruneLedger(ledgerOwner, row.at);
          } else if (replaces === row.id) await this.db.put(ledgerOwner, accountActionsKind, row);
          else {
            await this.db.insertIfAbsent(ledgerOwner, accountActionsKind, row);
            await this.db.remove(ledgerOwner, accountActionsKind, replaces);
          }
        }
      } else if (input.topic) title = topicReportLabels[input.topic];
    }
    await context.guard();
    // A confirmed action keeps the picture of the look the
    // run reports, as its evidence (an incident record marked `evidence`, never listed): the
    // picture the look step itself kept, dated when the look happened (`evidence.look`). Never
    // the desktop's picture at report time. A run whose steps are known is confirmed only with
    // such a look; a caller without a run keeps no picture.
    const seen = evidence.reply?.confirmed && input.seen?.trim() ? input.seen.trim() : null;
    const look = evidence.look;
    const shot =
      seen && look && look.kind !== "input" && look.shot?.length
        ? await this.computer.incidents.record({
            owner: this.ledgerOwnerOf(owner, task) ?? scopeOfOwner(owner),
            kind: "report",
            site,
            line: seen,
            system: false,
            evidence: true,
            picture: look.shot,
            ...(look.at ? { at: look.at } : {}),
          })
        : null;
    const seenAt = seen && look?.at ? look.at : null;
    // The founder's report stays in the hall (the founder lives in the
    // space's own conversation), marked with the project its job is for; that project's
    // conversation gets one line pointing there, once per action.
    const card = {
      id,
      kind: "report" as const,
      title,
      text,
      links,
      ...(posted ? { posted } : {}),
      ...(site && action ? { action: { site, action } } : {}),
      ...(evidence.unconfirmed
        ? { evidence: "missing" as const, evidenceWhy: evidence.why ?? "address" }
        : {}),
      ...(seen ? { seen } : {}),
      ...(shot?.shot ? { shot: shot.id } : {}),
      ...(seenAt ? { seenAt } : {}),
    };
    // The same report told again (its run event is keyed by it) shows nothing new: its card is
    // its own, or the action's it went into.
    const toldBefore = await this.db.get<RunEvent>(owner, "run-events", id);
    const shownBefore = toldBefore
      ? ((await this.reports.get(owner, id)) ??
        (rowCard ? await this.reports.get(owner, rowCard) : null))
      : null;
    const { report, created } = shownBefore
      ? { report: shownBefore, created: false }
      : cardOf && cardOf !== id
        ? await this.reports.rewrite(owner, task, { ...card, id: cardOf })
        : await this.reports.enqueue(owner, task, card);
    await this.db.insertIfAbsent(owner, "run-events", {
      id,
      taskId: task.id,
      date: report.createdAt,
      kind: "report",
      title: reportTitle(text),
      detail: [
        text,
        ...(posted ? [posted] : []),
        ...links,
        ...marks,
        ...(evidence.unconfirmed ? [unconfirmedMarks[evidence.why ?? "address"]] : []),
      ].join("\n"),
    } satisfies RunEvent);
    // An action recorded on the account means it can act again.
    if (incident === undefined && recorded && current && !current.resolvedAt)
      incident = incidentAfterRecovery(current, at);
    return {
      reported: true,
      ...(created ? {} : { alreadyReported: true }),
      ...(incident !== undefined ? { incident } : {}),
      ...(recorded ? { actedAt: at } : {}),
      links,
      ...(ignored.length ? { ignoredLinks: ignored, note: "Links must be http(s) URLs" } : {}),
      ...evidence.reply,
      ...(ref && evidence.reply
        ? { confirms: ref, evidenceNote: `${evidence.reply.evidenceNote} ${confirmsWords(ref)}` }
        : {}),
      ...(confirmsNote ? { confirmsNote } : {}),
      // `progress` (an action recorded, or a summary) resets the run's count of waits and
      // automatic continuations. A look reported as an action is not progress.
      ...(ledgerOwner
        ? { progress: (recorded && !lookOnly(input.action)) || input.topic === "summary" }
        : {}),
    };
  }
  /** A task's new infrastructure incident
   * as an incident of its desktop (the account's, or the project's default one), with its
   * picture when the desktop runs. The desktop, the model provider and the network are the
   * operator's to fix (system). */
  private async recordTaskIncident(
    owner: string,
    task: Pick<AgentTask, "input">,
    kind: IncidentKind,
    line: string,
  ) {
    const desktop = this.ledgerOwnerOf(owner, task) ?? scopeOfOwner(owner);
    const system = kind === "desktop" || kind === "model" || kind === "network";
    await this.computer.incidents.record({ owner: desktop, kind, line, system });
  }
  /** The owner's 「以后总是允许」 / 「以后都先问我」 on a
   * review card: kept for that action's account (the task's) or, without one, the project, for
   * its kind; 「以后总是允许」 also sends the card's own action now when it still waits. */
  async setReviewRule(owner: string, actionId: string, mode: ReviewRule["mode"]) {
    const action = await this.db.get<ActionProposal>(owner, "actions", actionId);
    if (!action) throw new AppError("Action not found", 404);
    const task = action.taskId ? await this.db.get<AgentTask>(owner, "tasks", action.taskId) : null;
    const environmentId =
      typeof task?.input?.environmentId === "string" ? task.input.environmentId : null;
    const rule: ReviewRule = {
      id: reviewRuleId(environmentId, ruleKindOf(action)),
      mode,
      at: new Date().toISOString(),
    };
    // A routine's draft is never let through by a rule.
    if (action.fromRoutine && mode === "always")
      throw new AppError("A routine's draft always waits for 发送", 409);
    await this.db.put(owner, reviewRulesKind, rule);
    let current = action;
    // Past its time (nothing runs): the rule is saved, the expired action is not run.
    if (action.status === "awaiting_review" && reviewExpired(action, Date.now()))
      current = (await settleDueReview(this.db, owner, actionId, Date.now())) ?? action;
    else if (action.status === "awaiting_review")
      current =
        mode === "always"
          ? await this.actions.approveUnrefused(owner, actionId, "rule")
          : ((await this.db.compareAndSwap<ActionProposal>(
              owner,
              "actions",
              actionId,
              { status: "awaiting_review" },
              { askFirst: true },
            )) ?? action);
    return { rule, action: current, scope: environmentId ? "account" : "project" };
  }
  private ledgerOwnerOf(owner: string, task: Pick<AgentTask, "input">) {
    const environmentId = task.input?.environmentId;
    return typeof environmentId === "string" && isEnvironmentId(environmentId)
      ? envOwner(owner, environmentId)
      : null;
  }
  /** The ledger row a reported action would add (`entry`), and the row that
   * already holds the action (`row`). The id is `ledgerKey`: the account, the site, the action,
   * and the address that tells the action apart (`reported.key`, else the text), never a run or
   * resume count, so an action repeated after a resume stays one row (no entry, its row).
   * A report without an address that confirms
   * its action writes its row `unconfirmed`, and its answer gives that row's reference
   * (`confirmsRef`). The report that names it in `confirms` is that action: this task's, on the
   * same site with the same action, its row still waiting. With its address it takes the row over
   * (the entry `replaces` it: one action, now under its address's key, so the same report again
   * finds it); still without one it adds nothing. Nothing else takes a row over: guessing which
   * earlier report a new one confirms (the same posted text, the latest action of its kind) took
   * a second action with the same template text for the first, uncounted. A report that does
   * not name the row is an action of its own. `confirmsNote` says when `confirms` names no such
   * row. */
  private async ledgerEntry(
    ledgerOwner: string,
    owner: string,
    task: AgentTask,
    site: string,
    action: string,
    reported: {
      permalink: string | undefined;
      key: ReportKey | undefined;
      text: string;
      unconfirmed: boolean;
      confirms: string | undefined;
      links: string[];
      /** What the action was done to, as the report names it (normalized). */
      target?: string | null;
      /** The run's own steps (model.ts); unknown for a caller without a run. */
      steps?: readonly RunStep[];
    },
  ): Promise<{ entry: LedgerEntry | null; row: AccountAction | null; confirmsNote?: string }> {
    const rowId = hash(
      ledgerKey(
        ledgerOwner,
        site,
        action,
        reported.key?.address,
        reported.text,
        reported.key?.withText,
      ),
    );
    const held = await this.db.get<AccountAction>(ledgerOwner, accountActionsKind, rowId);
    const waiting = reported.confirms
      ? (await this.db.list<AccountAction>(ledgerOwner, accountActionsKind)).find(
          (row) =>
            !!row.unconfirmed &&
            confirmsRef(row.id) === reported.confirms &&
            row.taskId === task.id &&
            row.site === site &&
            row.action === action,
        )
      : held || !reportsEarlierAction(reported.steps)
        ? undefined
        : waitingRowFor(
            await this.db.list<AccountAction>(ledgerOwner, accountActionsKind),
            { taskId: task.id, site, action, now: Date.now() },
            {
              address: reported.key?.address ?? reported.permalink ?? null,
              target: reported.target ?? null,
              links: reported.links,
            },
          );
    if (waiting && reported.unconfirmed) return { entry: null, row: waiting };
    if (waiting)
      return {
        entry: {
          ...waiting,
          id: rowId,
          permalink: reported.permalink ?? null,
          links: reported.links,
          unconfirmed: null,
          replaces: waiting.id,
        },
        row: held ?? waiting,
      };
    if (held) return { entry: null, row: held };
    const confirmsNote = reported.confirms
      ? "confirms names no report of this task on this site with this action that waits for its address; recorded as an action of its own"
      : undefined;
    const now = new Date();
    return {
      entry: {
        id: rowId,
        taskId: task.id,
        projectOwner: owner,
        site,
        action,
        permalink: reported.permalink ?? null,
        links: reported.links,
        at: now.toISOString(),
        ...(reported.unconfirmed ? { unconfirmed: true } : {}),
      },
      row: null,
      confirmsNote,
    };
  }
  /** Ledger rows are kept for 30 days, cleared when a new one is written. */
  private async pruneLedger(ledgerOwner: string, at: string) {
    const cutoff = Date.parse(at) - ledgerDays * 86400000;
    for (const row of await this.db.list<AccountAction>(ledgerOwner, accountActionsKind))
      if (Date.parse(row.at) < cutoff)
        await this.db.remove(ledgerOwner, accountActionsKind, row.id);
  }
  async finish(task: AgentTask, context: TaskContext, result: string) {
    await context.guard();
    await context.event("result", "Work completed", result);
    return {
      status: "succeeded" as const,
      result,
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })),
    };
  }
  private async publishOutcome(owner: string, saved: AgentTask) {
    const task = await this.getTask(owner, saved.id);
    // Each outcome also reaches the task's conversation as a chat report,
    // under the notification's key, so the maintenance replay never repeats either. An outcome
    // already notified before chat reports existed gets no late report.
    // The chat report never costs the notification or the maintenance loop: a report that
    // cannot be written is logged and the notification still goes out.
    const announce = async (
      label: string,
      title: string,
      body: string,
      key: string,
      report: string = body,
    ) => {
      if (!(await this.db.get(owner, "notifications", hash(key))))
        await this.reports
          .outcome(owner, task, label, report, key)
          .catch((error) => backgroundFailure("chat report", error));
      await this.notify(owner, title, body, task.id, key);
    };
    if (task.status === "succeeded") {
      await announce(
        "Finished",
        task.title,
        task.result ?? "Work completed",
        `task-done:${task.id}`,
      );
      if (task.goalId && !task.milestoneId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "failed") {
      await announce(
        "Needs attention",
        "Task needs attention",
        task.error ?? task.title,
        `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "waiting_input") {
      await announce(
        "Needs your input",
        "Your details are needed",
        task.question ?? task.title,
        // The same question asked again after the person resumed the task
        // is announced again; keys from before (no resumes) are unchanged.
        `input:${task.id}:${hash(task.question ?? "")}${task.resumes ? `:${task.resumes}` : ""}`,
      );
    } else if (task.status === "waiting_approval") {
      await announce(
        "Ready for your review",
        "Ready for your review",
        task.title,
        `review:${task.actionId}`,
        "A prepared action is waiting for your review. Open the task to approve or decline it.",
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if ((task.status === "scheduled" || (task.status === "paused" && task.error)) && notice.success)
      await announce(
        noticeLabel(notice.data),
        notice.data.title,
        notice.data.body,
        notice.data.key,
      );
    // A wait_until wait is not reported: it is the
    // task's state (the live panel shows when it runs again), and its note is the run's handoff
    // to the next run, never shown in the chat. Nothing is notified either.
    // A watch pauses after repeated failures only once that task outcome has committed.
    if (task.kind === "monitor" && task.status === "paused" && task.error)
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        { status: "active", error: task.error },
        { status: "paused" },
      );
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      let file: Artifact;
      try {
        file = await this.files.get(owner, ref);
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
        file = await this.workspace.importAttachment(owner, ref);
      }
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = await this.files.fill(owner, source.fileId, fields, `document:${task.id}`);
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
        ctx.signal,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash =
      typeof task.state.lastHash === "string" ? task.state.lastHash : monitor.lastHash;
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(monitor.value.toLowerCase())
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    // For change watches, keep the page lines and a relative-time-free fingerprint of the whole text.
    const change = monitor.condition === "change";
    const lines = change ? pageLines(observation.text) : [];
    const timelessHash = change ? hash(withoutRelativeTimes(text)) : undefined;
    const savedPage =
      matched && change
        ? await this.db.get<MonitorPage>(owner, "monitor-pages", monitor.id)
        : undefined;
    // Saved lines can run ahead of a lost task outcome; use them only for the committed baseline.
    const baseline = savedPage?.hash === previousHash ? savedPage : undefined;
    // Only relative times changed anywhere on the page ("3 minutes ago"): keep watching quietly.
    const quiet = Boolean(baseline?.timelessHash && baseline.timelessHash === timelessHash);
    const shouldNotify =
      matched && !quiet && (monitor.condition === "change" || !previouslyMatched);
    const diff = baseline && shouldNotify ? diffPage(baseline.lines, lines) : undefined;
    // Empty when the change is past the saved lines; the alert then quotes the page instead.
    const changes = diff ? describePageDiff(diff) : "";
    // A notification-worthy observation is a new event, even when the page text is
    // identical to an earlier one (a change back to a seen state, or a condition that
    // cleared and reappeared). Commit its sequence with the outcome so publication
    // retries still deduplicate on the same saved notice key.
    const alertSequence = Number(task.state.alertSequence ?? 0) + (shouldNotify ? 1 : 0);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active", checks: monitor.checks },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    if (change)
      await this.db.put(owner, "monitor-pages", {
        id: monitor.id,
        hash: currentHash,
        timelessHash,
        lines,
      });
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", changes || text.slice(0, 500));
    }
    const count = diff ? countPageDiff(diff) : "";
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? count
          ? `Change found: ${count}. A notification is ready.`
          : "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        lastHash: currentHash,
        resumingMonitor: false,
        matched,
        alertSequence,
        failures: 0,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: changes
                ? `Changed at ${observation.url}\n${changes}`
                : `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${alertSequence}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}
