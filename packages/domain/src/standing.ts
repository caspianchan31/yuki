// A standing task has no end of its own: an account's operating
// loop (the founder's included), or a task working toward an operating goal with its plan saved
// (finish_task does not end it; the person stops it). An error is never a reason for such a task
// to end for good, and a task that runs without acting must be visible as such. These are
// the facts and rules the server and the clients share about such tasks. Nothing here knows a
// site, an account, a trade or a number of posts: the plan's pace is the task's own words, and the
// only numbers are the system's backstops (how many failed runs before the owner hears of it once,
// how long a paced plan may go without one action before the owner sees it).
import {
  type AgentTask,
  gatewayUpstreamPattern,
  openIncident,
  operatingPlanOf,
  providerQuotaPattern,
  taskRunFailure,
} from "./agent.ts";

/** A task with no end of its own: an account's loop, or a task whose operating plan is saved. */
export function isStandingTask(task: Pick<AgentTask, "input" | "state">): boolean {
  return task.input?.accountLoop === true || !!operatingPlanOf(task.state);
}

/** The model provider's own words that it refuses the key, its permission or the model asked
 * for, and the server's own words that no model or key is configured. */
const refusalPatterns = [
  /\b(?:authentication_error|permission_error|not_found_error|UNAUTHENTICATED|PERMISSION_DENIED)\b/,
  /^Unknown provider\b/i,
  /^Invalid model string\b/i,
  /\b[A-Z][A-Z0-9_]*_API_KEY is not set\b/,
];
/**
 * Whether a run's failure is one only the owner (or the operator) can fix, so a standing task
 * fails on it into 需要你 (重试 runs it again) instead of retrying: the provider's balance, quota
 * or billing (`providerQuotaPattern`), the provider refusing the key, its permission or the model
 * (401, 403, 404 or their error types), a model or key the server is not configured with. A relay
 * that says its upstream failed is never one, whatever status it relays. Everything else that
 * stops a standing task's run (a relay that sent nothing, a request the provider could not take
 * this time, a bug of ours fixed by the next deploy) may pass, so the task retries with backoff
 * and the owner hears of it once it keeps failing (`runTrouble`).
 */
export function ownerOnlyFailure(detail: string): boolean {
  const message = detail.trim();
  if (providerQuotaPattern.test(message)) return true;
  if (gatewayUpstreamPattern.test(message)) return false;
  const status = Number(
    /^(\d{3})\b/.exec(message)?.[1] ?? /"code":\s*(\d{3})\b/.exec(message)?.[1] ?? "",
  );
  if (status === 401 || status === 403 || status === 404) return true;
  return refusalPatterns.some((pattern) => pattern.test(message));
}

/** How many runs in a row a task may fail and retry by itself before the owner hears of it once
 * (the server's backstop; the task keeps retrying with backoff after that too). */
export const failedRunsBeforeOwner = 5;
/** The
 * waits in a row the same part may block a task before the owner sees it as a need. The first
 * shows on the task's line at once; the second is his. */
export const incidentWaitsBeforeOwner = 2;
/** Runs of a task that keep failing while it retries by itself. */
export interface RunTrouble {
  /** When the first of the failed runs in a row failed. */
  since: string;
  /** When the latest failed. */
  at: string;
  /** How many failed in a row. */
  count: number;
  /** What stopped the latest, as the server saw it (data: the client words it, `failureText`). */
  detail: string;
}
/** The owner-facing need of a task whose runs keep failing (`failedRunsBeforeOwner` or more in a
 * row, `state.runFailure`): one need while it lasts, gone by itself once a run ends without being
 * stopped. Null while it is not waiting for its next try (running now, paused, ended). */
export function runTrouble(task: Pick<AgentTask, "status" | "state">): RunTrouble | null {
  if (task.status !== "scheduled" && task.status !== "queued") return null;
  // The same part blocking the task's waits again is the owner's too.
  const incident = openIncident(task.state);
  if (incident && (incident.waits ?? 1) >= incidentWaitsBeforeOwner)
    return {
      since: incident.since,
      at: incident.since,
      count: incident.waits ?? incidentWaitsBeforeOwner,
      detail: `Blocked: ${incident.kind}`,
    };
  const failure = taskRunFailure(task.state);
  if (!failure || failure.count < failedRunsBeforeOwner) return null;
  return { since: failure.since, at: failure.at, count: failure.count, detail: failure.detail };
}

/** How long a standing task whose plan states a pace may go without one action before the owner
 * sees it (the system's cap; whether it is behind its own pace sooner is the task's judgement,
 * which it reports in its own words). */
export const noActionCapDays = 3;
/** What a standing task's own plan says about its pace and what it actually did: the facts every
 * run of it gets in its data (`planAndActions`) and the server computes from its ledger. */
export interface StandingActivity {
  /** The pace its plan states, in the plan's words; null without a plan. */
  planPace: string | null;
  /** When the plan was saved; null without one. */
  planSetAt: string | null;
  /** Its actions in the last 7 days by kind (`<site>/<action>`, as the pacing counts them). */
  actionsLast7Days: Record<string, number>;
  /** Of those, the ones reported without the item's own address (not confirmed). */
  unconfirmedLast7Days: number;
  /** Its latest action on the ledger (kept 30 days); null when none. */
  lastActionAt: string | null;
  /** The actions of the last 7 days, newest first
   * and at most `recentActionsShown`, each the site, the action, the item acted on (`target`) and
   * the action's own address (`permalink`), never the words. */
  recentActions: RecentAction[];
}
/** One of `recentActions`: addresses and a time, as the ledger holds them. */
export interface RecentAction {
  site: string | null;
  action: string;
  target: string | null;
  permalink: string | null;
  at: string;
  /** What a visitor who is not signed in saw there, the
   * last time the account looked (view_as_stranger); absent when it never looked. */
  stranger?: StrangerSeen | null;
  /** An action reported without its own address confirmed yet, with the reference
   * a report of it gives as `confirms` and the addresses it was reported with. */
  unconfirmed?: { confirms: string; links: string[] };
}
/** A stranger's view as the ledger keeps it. */
export interface StrangerSeen {
  status: "shown" | "not_shown" | "gone" | "unreadable";
  at: string;
  httpStatus: number | null;
}
export const recentActionsShown = 40;
export interface StandingBehind {
  /** Since when nothing was done: the latest action, or the plan's save if later. */
  since: string;
  /** Whole days since then. */
  days: number;
}
/** A standing task that is running without acting: its plan states a pace, and nothing was done
 * for `noActionCapDays` since its latest action or the plan's save, whichever is later (a plan
 * the task changed starts its own count). Null otherwise. For a live task only: the caller leaves
 * out paused, ended and failed ones. */
export function standingBehind(
  activity: PlanActivity | null,
  now: number = Date.now(),
): StandingBehind | null {
  if (!activity?.planPace?.trim()) return null;
  const marks = [activity.lastActionAt, activity.planSetAt]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const since = marks[0];
  if (!since) return null;
  const elapsed = now - Date.parse(since);
  const day = 86_400_000;
  if (elapsed < noActionCapDays * day) return null;
  return { since, days: Math.floor(elapsed / day) };
}

/** The part of `StandingActivity` a standing task keeps on itself (`state.planActivity`, written
 * at each run's start and when a report records an action), so the owner's screens can tell, on
 * the task's own record, that it runs without acting (`taskStandingBehind`). */
export type PlanActivity = Pick<StandingActivity, "planPace" | "planSetAt" | "lastActionAt">;
export function planActivityOf(activity: PlanActivity): PlanActivity {
  return {
    planPace: activity.planPace,
    planSetAt: activity.planSetAt,
    lastActionAt: activity.lastActionAt,
  };
}
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
/** A task's kept `state.planActivity`; null when it has none. */
export function taskPlanActivity(state: AgentTask["state"] | undefined): PlanActivity | null {
  const value = state?.planActivity as Partial<Record<keyof PlanActivity, unknown>> | undefined;
  if (!value || typeof value !== "object") return null;
  return {
    planPace: text(value.planPace),
    planSetAt: text(value.planSetAt),
    lastActionAt: text(value.lastActionAt),
  };
}
const liveStatuses: ReadonlySet<string> = new Set(["running", "queued", "scheduled"]);
/** A live standing task that runs without acting (`standingBehind` on its kept `planActivity`):
 * one fact for every screen of the owner (the task's line, the member's face, the founder's
 * project card). Null for a task that is paused, ended, failed or not standing. */
export function taskStandingBehind(
  task: Pick<AgentTask, "status" | "input" | "state">,
  now: number = Date.now(),
): StandingBehind | null {
  if (!liveStatuses.has(task.status) || !isStandingTask(task)) return null;
  return standingBehind(taskPlanActivity(task.state), now);
}

/** The run event of a task whose runs reached `failedRunsBeforeOwner` failures in a row (once per
 * streak; the task keeps retrying). */
export const runTroubleLabel = "Keeps failing; still retrying by itself, the owner is told";
/** The run event of a standing task the server took up again after an error had failed it. */
export const standingRevivedLabel = "Taken up again by itself after a failure";
/** The run event of a report kept out of the chat: infrastructure trouble, which the server shows
 * by itself (its detail: the report's text). */
export const infrastructureNoteLabel = "Kept out of the chat: infrastructure trouble";
