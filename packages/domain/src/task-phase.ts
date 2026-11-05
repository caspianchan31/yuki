/**
 * One status vocabulary for a background task, shared by every
 * surface of the client (task cards, rail rows, account rows, the status strip) and by the
 * server's read-only overview (N1). It only reads what the task record already says; nothing
 * here changes what the system does, and nothing here asks for a new approval.
 *
 * `taskPhase(task, { now, words })` answers:
 *   key / label / tone  which of the eleven states the task is in, and how it reads
 *   needsYou            whether it belongs in 需要你 (decision 4: an ask_user question, an upstream
 *                       email/calendar review, a failure within 7 days; an account's standing
 *                       loop that failed, or a default-desktop standing task failed for what
 *                       only the owner can fix, for as long as it is so; a loop the owner
 *                       paused is his decision, not a need).
 *                       Site checks and sign-in walls never are, nor are waits, nor an
 *                       infrastructure incident.
 *   sub / detail        the one line under the label, and the question / error first line (never
 *                       a wait note: that is the run's handoff to its next run)
 *   incident            the task's open infrastructure incident (fork, report line), so the
 *                       account row can show the fact while the task retries by itself
 *   rank                此刻 priority (design §4.5): the lowest rank of an account's tasks wins
 *
 * The words are a table so the language can be switched in one place: the client passes the
 * table from packages/client/src/shell/strings.ts; the default below is the same Chinese table
 * (design §9.3 puts the Chinese status words here, next to the function).
 * Pure: no I/O, no globals except Date; `now` is injectable for tests.
 */
import {
  type AgentTask,
  currentWait,
  type IncidentKind,
  openIncident,
  type TaskWait,
  taskWait,
} from "./agent.ts";
import {
  isStandingTask,
  ownerOnlyFailure,
  type StandingBehind,
  taskStandingBehind,
} from "./standing.ts";

export type TaskPhaseKey =
  | "input"
  | "approval"
  | "fail"
  | "run"
  | "queue"
  | "wait"
  | "sched"
  | "pause"
  | "done"
  | "cancelled";
/** Colour family; "Soft" variants are the lighter fills of the same hue (design §5.1). */
export type TaskPhaseTone =
  | "amber"
  | "red"
  | "blue"
  | "blueSoft"
  | "teal"
  | "tealSoft"
  | "grey"
  | "green";
/** What a waiting_input task is stopped on: a question, or (only a task stopped before the
 * report line) a run that ended without a completion call. */
export type TaskInputReason = "question" | "unfinished";

/** The question a run ends on when it stopped without a completion call. Same text as
 * engine/model.ts `runEndedWithoutCompletion` (a test pins the two together). Since the report
 * line such a run simply continues (there is no limit on it any more), so only a task stopped on
 * it before has it as its question. */
export const runEndedWithoutCompletionQuestion =
  "The agent reached the end of this run without confirming completion. Give it a follow-up instruction to continue.";

/** A failure counts in 需要你 for 7 days; after that it is only history. Not an account's
 * standing loop (`isStandingLoop`): a stopped loop is a state, not an event, and stays. */
export const failedNeedsYouMs = 7 * 24 * 60 * 60 * 1000;

/** An account's standing operating loop (engine/account-loop.ts, the task
 * the system keeps while the account has a long-term goal or an open job). Stopped (failed or
 * paused), the account does nothing at all until the owner acts, however long ago it stopped: it
 * stays in 需要你 (`TaskPhase.stopped`) with no 7-day expiry. */
export function isStandingLoop(task: Pick<AgentTask, "input">): boolean {
  return task.input?.accountLoop === true;
}
/** A failed task that stays in 需要你 however long ago it failed: an
 * account's standing loop (the account does nothing at all until the owner acts), and a standing
 * task on the project's default desktop (its plan saved) that failed for what only the owner can
 * fix (`ownerOnlyFailure`: nothing takes it up again by itself). */
function stopsForGood(task: AgentTask): boolean {
  if (isStandingLoop(task)) return true;
  return !task.input?.environmentId && isStandingTask(task) && ownerOnlyFailure(task.error ?? "");
}
/** The rail's "最近 24 小时结束" fold. */
export const recentlyEndedMs = 24 * 60 * 60 * 1000;

export interface TaskPhase {
  key: TaskPhaseKey;
  label: string;
  tone: TaskPhaseTone;
  /** Belongs in 需要你 (decision 4). */
  needsYou: boolean;
  /** The line under the label (副文案), already in the client's language. */
  sub: string;
  /** The question / error, first line only; "" when there is none. Never a wait note (fork,
   * report line): that is the run's handoff to its next run, not something the person reads. */
  detail: string;
  /** 此刻 priority: lower wins. input 0 · approval 1 · fail (7 days) 2 · run 3 · queue 4 ·
   * wait 5 · sched 6 · pause 7 · ended 9. */
  rank: number;
  /** Set for key "input". */
  reason?: TaskInputReason;
  /** The task's open infrastructure incident (fork, report line): what keeps failing and since
   * when; the task retries by itself. */
  incident?: { kind: IncidentKind; since: string };
  /** ISO time that matters for this phase: the resume time (wait, a pause inside a wait), the
   * next run (sched), the failure (fail), the end (done, cancelled). */
  at?: string;
  /** A wait the server marked as a pacing wait (state.wait.pacing). */
  pacing?: boolean;
  /** Succeeded, cancelled, or failed more than 7 days ago (never a stopped standing loop). */
  ended: boolean;
  /** A standing task that failed and stays failed (`stopsForGood`: an
   * account's loop, or a default-desktop standing task failed for what only the owner can fix):
   * in 需要你 for as long as it is so, 「经营停了：<why>」 (`loopStopped`) with 重试. A loop the
   * owner paused is not one (its line reads `loopPaused`, never a need). */
  stopped?: boolean;
  /** A live standing task that runs without acting (`taskStandingBehind`):
   * its plan states a pace and it did nothing on a site for `noActionCapDays` or more. Its line
   * leads with it (`words.behind`); not in 需要你: the task itself decides what to change, and
   * the owner sees it on its line, its member's face and the founder's card. */
  behind?: StandingBehind;
}

/** Every word taskPhase writes. Functions take already-formatted pieces. */
export interface TaskPhaseWords {
  labels: Record<TaskPhaseKey, string>;
  /** "第 3/5 步 · 正在 r/LocalLLM 发这条回复" (not for an operating task: `showsSteps`) */
  step: (current: number, total: number, what: string) => string;
  running: string;
  queued: string;
  /** "15:00 继续（还剩 13 分）" (+ pacing suffix). No count of waits here or
   * anywhere: waits have no limit, so the count is nothing the person acts on. */
  waiting: (clock: string, left: string, pacing: boolean) => string;
  /** "每天 · 已跑 1 轮 · 下次 明天 10:05" */
  scheduled: (rhythm: string, runs: number, next: string) => string;
  /** A scheduled one-off run that is not a wait. */
  scheduledOnce: (next: string) => string;
  /** "原定 15:00 恢复" */
  pausedInWait: (clock: string) => string;
  paused: string;
  /** A task stopped before the report line on a run without a completion call: "上一轮没确认做完
   * · 卡在：第 4 步 打开评论区". */
  unfinished: (step: string) => string;
  /** The line of a task with an open infrastructure incident (fork, report line): "网络连不上
   * （13:02 起）· 14:00 再试". Optional: without it the line is the wait's or the schedule's. */
  incident?: (kind: IncidentKind, since: string, next: string) => string;
  /** "第 4 步 打开评论区" */
  stuckAt: (index: number, title: string) => string;
  approval: string;
  question: string;
  /** "<error first line> · 第 2 次" */
  failed: (error: string, attempts: number) => string;
  /** A standing loop that failed: 「经营停了：<why>」 (no attempt count: the
   * owner acts on why it stopped, not on how often it ran). */
  loopStopped: (error: string) => string;
  /** A standing task that runs without acting (`TaskPhase.behind`): 「计划定了
   * 节奏，3 天没在网站上做事」. Optional: without it the line is the phase's own. */
  behind?: (days: number) => string;
  /** A standing loop that is paused: 「经营暂停了，点恢复继续」. */
  loopPaused: string;
  /** A loop paused while the owner was away. */
  loopPausedAway: string;
  failedUnknown: string;
  done: string;
  /** A finished task's result as its line starts from it (a
   * client's own reading of the server's marks); as it is when absent. */
  result?: (text: string) => string;
  cancelled: string;
  /** Rhythm words. */
  once: string;
  daily: string;
  hourly: string;
  everyDays: (days: number) => string;
  everyHours: (hours: number) => string;
  everyMinutes: (minutes: number) => string;
  /** Duration pieces: "13 分" / "1 小时 20 分" / "2 天 3 小时". */
  minutes: (n: number) => string;
  hours: (n: number) => string;
  days: (n: number) => string;
  join: string;
  /** Day words for clock labels. */
  today: string;
  tomorrow: string;
  yesterday: string;
}

export const taskPhaseWordsZh: TaskPhaseWords = {
  labels: {
    input: "等你回答",
    approval: "等你审阅",
    fail: "失败",
    run: "运行中",
    queue: "排队中",
    wait: "等待中",
    sched: "排期中",
    pause: "已暂停",
    done: "已完成",
    cancelled: "已取消",
  },
  step: (current, total, what) => `第 ${current}/${total} 步${what ? ` · ${what}` : ""}`,
  running: "正在运行",
  queued: "排队中，等后台接手",
  waiting: (clock, left, pacing) => `${clock} 继续（还剩 ${left}）${pacing ? "· 节奏" : ""}`,
  scheduled: (rhythm, runs, next) => `${rhythm} · 已跑 ${runs} 轮 · 下次 ${next}`,
  scheduledOnce: (next) => `下次 ${next}`,
  pausedInWait: (clock) => `原定 ${clock} 恢复`,
  paused: "已暂停，点恢复继续",
  unfinished: (step) => `上一轮没确认做完${step ? ` · 卡在：${step}` : ""}`,
  stuckAt: (index, title) => `第 ${index} 步 ${title}`,
  approval: "邮件或日程草稿等你审阅",
  question: "任务在等你回答",
  failed: (error, attempts) => `${error}${attempts > 1 ? ` · 第 ${attempts} 次` : ""}`,
  loopStopped: (error) => `经营停了：${error}`,
  loopPaused: "经营暂停了，点恢复继续",
  loopPausedAway: "等你回来：在营销总群说「继续」就恢复",
  behind: (days) => `计划定了节奏，${days} 天没在网站上做事`,
  failedUnknown: "任务失败",
  done: "已完成",
  cancelled: "已取消",
  once: "一次性",
  daily: "每天",
  hourly: "每小时",
  everyDays: (days) => `每 ${days} 天`,
  everyHours: (hours) => `每 ${hours} 小时`,
  everyMinutes: (minutes) => `每 ${minutes} 分钟`,
  minutes: (n) => `${n} 分`,
  hours: (n) => `${n} 小时`,
  days: (n) => `${n} 天`,
  join: " ",
  today: "",
  tomorrow: "明天",
  yesterday: "昨天",
};

const rankOf: Record<TaskPhaseKey, number> = {
  input: 0,
  approval: 1,
  fail: 2,
  run: 3,
  queue: 4,
  wait: 5,
  sched: 6,
  pause: 7,
  done: 9,
  cancelled: 9,
};

const toneOf: Record<TaskPhaseKey, TaskPhaseTone> = {
  input: "amber",
  approval: "amber",
  fail: "red",
  run: "blue",
  queue: "blueSoft",
  wait: "teal",
  sched: "tealSoft",
  pause: "grey",
  done: "green",
  cancelled: "grey",
};

const toMs = (now: Date | number | undefined) =>
  now === undefined ? Date.now() : typeof now === "number" ? now : now.getTime();

/** The first non-empty line of a text, trimmed; "" for anything else. A line that is only a
 * heading (「选区：」, its items below it) reads with the line after it (「选区：a film forum — …」),
 * so a list never shows a bare heading. */
export function firstLine(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const lines = value
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
  const [head = "", next] = lines;
  const line = next && /[:：]$/.test(head) ? `${head}${next.replace(/^[-*•]\s*/, "")}` : head;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** A local clock label relative to `now`: "14:30", "明天 10:05", "昨天 09:12" or
 * "10-12 10:05". The device's time zone; "" for an unreadable time. */
export function clockLabel(
  iso: string | undefined | null,
  now: Date | number = Date.now(),
  words: Pick<TaskPhaseWords, "tomorrow" | "yesterday"> = taskPhaseWordsZh,
): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(toMs(now));
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(at) === dayKey(today)) return time;
  if (dayKey(at) === dayKey(tomorrow)) return `${words.tomorrow} ${time}`;
  if (dayKey(at) === dayKey(yesterday)) return `${words.yesterday} ${time}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** "13 分", "1 小时 20 分", "2 天 3 小时"; at least one minute. */
export function durationLabel(
  ms: number,
  words: Pick<TaskPhaseWords, "minutes" | "hours" | "days" | "join"> = taskPhaseWordsZh,
): string {
  const total = Math.max(1, Math.ceil(ms / 60000));
  if (total < 60) return words.minutes(total);
  if (total < 1440) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes
      ? `${words.hours(hours)}${words.join}${words.minutes(minutes)}`
      : words.hours(hours);
  }
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  return hours ? `${words.days(days)}${words.join}${words.hours(hours)}` : words.days(days);
}

/** "一次性", "每天", "每小时", "每 2 天", "每 3 小时", "每 45 分钟". */
export function rhythmLabel(
  repeatMinutes: number | null | undefined,
  words: TaskPhaseWords = taskPhaseWordsZh,
): string {
  const minutes = Number(repeatMinutes);
  if (!repeatMinutes || !Number.isFinite(minutes) || minutes <= 0) return words.once;
  if (minutes === 1440) return words.daily;
  if (minutes === 60) return words.hourly;
  if (minutes % 1440 === 0) return words.everyDays(minutes / 1440);
  if (minutes % 60 === 0) return words.everyHours(minutes / 60);
  return words.everyMinutes(minutes);
}

/** The account a task is bound to (`input.environmentId`); null = the project's default desktop. */
export function taskEnvironmentId(task: {
  input?: { environmentId?: unknown } | null;
}): string | null {
  const id = task.input?.environmentId;
  return typeof id === "string" && id ? id : null;
}

/** Whether the task's plan steps say where it is. Not on an operating task (a
 * task bound to an account): it goes through its plan again on every run, all day, and nothing
 * moves a step forward while it works (only finish_task marks the steps done), so 「第 1/5 步」
 * would stay as it is the whole day. Its line is the phase (正在运行, the next run, an
 * incident), on the rail row, the chat's task card and the task detail alike. */
export function showsSteps(task: Pick<AgentTask, "input">): boolean {
  return taskEnvironmentId(task) === null;
}

/** Plan progress: steps done, the step in progress (1-based) and its title. */
export function planProgress(task: Pick<AgentTask, "plan">): {
  done: number;
  total: number;
  current: number;
  title: string;
} {
  const plan = Array.isArray(task.plan) ? task.plan : [];
  const done = plan.filter((step) => step.status === "succeeded").length;
  const index = plan.findIndex((step) => step.status === "running" || step.status === "waiting");
  const pending = plan.findIndex((step) => step.status === "pending" || step.status === "failed");
  const at = index >= 0 ? index : pending;
  return {
    done,
    total: plan.length,
    current: plan.length ? Math.min(plan.length, at >= 0 ? at + 1 : done + 1) : 0,
    title: at >= 0 ? (plan[at]?.title ?? "") : "",
  };
}

function waitRecord(task: Pick<AgentTask, "state">): Partial<TaskWait> & { pacing?: unknown } {
  const wait = task.state?.wait;
  return wait && typeof wait === "object" ? (wait as Partial<TaskWait> & { pacing?: unknown }) : {};
}

/** Why a waiting_input task stopped. Waits never stop a task (there is no limit on them,
 * docs/wait-until.md), and neither does a run without a completion call any more. */
export function inputReason(task: Pick<AgentTask, "status" | "question">): TaskInputReason {
  if (task.question === runEndedWithoutCompletionQuestion) return "unfinished";
  return "question";
}

/** The phase of one task. `now` defaults to the clock. */
export function taskPhase(
  task: AgentTask,
  options: { now?: Date | number; words?: TaskPhaseWords } = {},
): TaskPhase {
  const now = toMs(options.now);
  const words = options.words ?? taskPhaseWordsZh;
  const clock = (iso: string | undefined) => clockLabel(iso, now, words);
  const base = (key: TaskPhaseKey, sub: string, extra: Partial<TaskPhase> = {}): TaskPhase => ({
    key,
    label: words.labels[key],
    tone: toneOf[key],
    needsYou: false,
    sub,
    detail: "",
    rank: rankOf[key],
    ended: false,
    ...extra,
  });
  const open = openIncident(task.state);
  const lag = taskStandingBehind(task, now);
  const incident: Partial<TaskPhase> = {
    ...(open ? { incident: { kind: open.kind, since: open.since } } : {}),
    ...(lag ? { behind: lag } : {}),
  };
  // A standing task running without acting says so first (an open incident explains itself).
  const behindLine = (sub: string) =>
    lag && words.behind && !open ? `${words.behind(lag.days)} · ${sub}` : sub;
  switch (task.status) {
    case "waiting_input": {
      const reason = inputReason(task);
      const question = firstLine(task.question);
      if (reason === "unfinished") {
        const progress = planProgress(task);
        const step =
          progress.title && showsSteps(task) ? words.stuckAt(progress.current, progress.title) : "";
        return base("input", words.unfinished(step), { needsYou: true, reason, detail: question });
      }
      return base("input", question || words.question, {
        needsYou: true,
        reason,
        detail: question,
      });
    }
    case "waiting_approval":
      return base("approval", firstLine(task.question) || words.approval, {
        needsYou: true,
        detail: firstLine(task.question),
      });
    case "failed": {
      const error = firstLine(task.error);
      const failedAt = task.updatedAt;
      if (stopsForGood(task))
        return base("fail", words.loopStopped(error || words.failedUnknown), {
          needsYou: true,
          detail: error,
          at: failedAt,
          stopped: true,
        });
      const age = now - Date.parse(failedAt);
      const recent = !(age > failedNeedsYouMs);
      return base("fail", words.failed(error || words.failedUnknown, task.attempts ?? 0), {
        needsYou: recent,
        detail: error,
        at: failedAt,
        rank: recent ? rankOf.fail : 9,
        ended: !recent,
      });
    }
    case "running": {
      // Never state.lastUpdate here. It is the progress record a run leaves
      // for the next one (a wait_until note, the text of a run that hit the step cap), written
      // when a run ends, so during a run it is the previous run's handoff, which no surface
      // shows (docs/report-back.md); it stays for the AI.
      // An operating task's steps never say where it is (`showsSteps`).
      const progress = planProgress(task);
      const sub =
        progress.total && showsSteps(task)
          ? words.step(progress.current, progress.total, progress.title)
          : words.running;
      return base("run", behindLine(sub), incident);
    }
    case "queued":
      return base("queue", behindLine(words.queued), incident);
    case "scheduled": {
      // While an incident is open the line says what keeps failing and when
      // it tries again, so a task the infrastructure stops again and again is not a silent loop.
      const wait = currentWait(task);
      const next = wait?.until ?? task.nextRunAt;
      const failing =
        incident.incident && words.incident
          ? words.incident(incident.incident.kind, clock(incident.incident.since), clock(next))
          : "";
      if (wait) {
        const pacing = waitRecord(task).pacing === true;
        const left = Date.parse(wait.until) - now;
        return base(
          "wait",
          failing ||
            behindLine(words.waiting(clock(wait.until), durationLabel(left, words), pacing)),
          { at: wait.until, pacing, ...incident },
        );
      }
      if (failing) return base("sched", failing, { at: task.nextRunAt, ...incident });
      if (task.repeatMinutes)
        return base(
          "sched",
          behindLine(
            words.scheduled(
              rhythmLabel(task.repeatMinutes, words),
              task.runs ?? 0,
              clock(task.nextRunAt),
            ),
          ),
          { at: task.nextRunAt, ...incident },
        );
      return base("sched", behindLine(words.scheduledOnce(clock(task.nextRunAt))), {
        at: task.nextRunAt,
        ...incident,
      });
    }
    case "paused": {
      // A paused standing loop: only the owner pauses one, so it is his decision, not a need:
      // its line says it does nothing until he resumes it (never in 需要你).
      if (isStandingLoop(task))
        return base(
          "pause",
          task.state?.pausedFor === "owner_away" ? words.loopPausedAway : words.loopPaused,
          { at: task.updatedAt },
        );
      const wait = taskWait(task);
      return wait
        ? base("pause", words.pausedInWait(clock(wait.until)), { at: wait.until })
        : base("pause", words.paused);
    }
    case "succeeded":
      return base(
        "done",
        firstLine(words.result?.(task.result ?? "") ?? task.result, 120) || words.done,
        {
          ended: true,
          at: task.updatedAt,
        },
      );
    default:
      return base("cancelled", words.cancelled, { ended: true, at: task.updatedAt });
  }
}

/** Ended within the last 24 hours (the rail's "最近 24 小时结束" fold). */
export function endedRecently(
  phase: Pick<TaskPhase, "ended" | "at">,
  now: Date | number = Date.now(),
): boolean {
  if (!phase.ended || !phase.at) return false;
  const age = toMs(now) - Date.parse(phase.at);
  return age >= 0 && age <= recentlyEndedMs;
}

/** Task-only counts of one project (design §8.2 N1). The caller adds reviews that no
 * waiting_approval task stands for, and account-level flags, to `needsYou`. */
export interface TaskPhaseCounts {
  /** Tasks in 需要你: questions, reviews, failures within 7 days and stopped standing loops. */
  needsYou: number;
  running: number;
  queued: number;
  waiting: number;
  scheduled: number;
  failed7d: number;
}
export function taskPhaseCounts(
  tasks: readonly AgentTask[],
  now: Date | number = Date.now(),
): TaskPhaseCounts {
  const counts: TaskPhaseCounts = {
    needsYou: 0,
    running: 0,
    queued: 0,
    waiting: 0,
    scheduled: 0,
    failed7d: 0,
  };
  for (const task of tasks) {
    const phase = taskPhase(task, { now });
    if (phase.needsYou) counts.needsYou += 1;
    if (phase.key === "fail" && phase.needsYou) counts.failed7d += 1;
    else if (phase.key === "run") counts.running += 1;
    else if (phase.key === "queue") counts.queued += 1;
    else if (phase.key === "wait") counts.waiting += 1;
    else if (phase.key === "sched") counts.scheduled += 1;
  }
  return counts;
}
