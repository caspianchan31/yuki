/**
 * The 创始人 panel's pure logic. The space's founder (one
 * account in no project, given jobs by every project, served in the owner's order of the
 * projects) read defensively from GET /api/founder; moving a project up or down in that order;
 * the words of a founder job's and a stuck task's state; one card per project with the
 * /api/projects/overview counts merged in; the loop line; and the speaker line of a chat report
 * (the account that speaks, the founder tagged). No react-native imports.
 *
 * What the founder is really doing (`founderState`: her loop through the
 * shared phase function, running / waiting / stopped and why, or 没在经营 with nothing to work
 * on), each project's 「没人在做」 (`activity` from the server's facts, never 一切正常), and the
 * order the owner never set read as 「未设置（按名称）」 (`priorityNote`).
 */
import type { AgentTask } from "../../../../../packages/domain/src/agent.ts";
import {
  clockLabel,
  durationLabel,
  type TaskPhase,
  taskPhase,
} from "../../../../../packages/domain/src/task-phase.ts";
import { type ProjectOverview, stalledPhase } from "../model";
import { incidentWord, phaseWords, t } from "../strings";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface FounderLoop {
  taskId: string;
  status: string;
  nextRunAt: string | null;
  /** What the shared phase function reads of the loop, when the server sends
   * it: its title, last change, failure, question, runs and its wait and open incident. */
  title?: string;
  updatedAt?: string;
  error?: string;
  question?: string;
  attempts?: number;
  state?: Record<string, unknown>;
}
export interface FounderAccount {
  environmentId: string;
  name: string;
  goal: string | null;
  plan: number | null;
  loop: FounderLoop | null;
  /** She has something to work on (a long-term goal or an open job:
   * AccountLoops.wanted); absent when the server does not say. */
  hasWork?: boolean;
}
export interface FounderPriority {
  projectId: string;
  name: string;
  rank: number;
  /** The owner placed it (the others follow, by name). */
  set: boolean;
}
export interface FounderJob {
  jobId: string;
  title: string;
  status: string;
  due: string | null;
}
export interface FounderStuck {
  taskId: string;
  title: string;
  status: string;
}
/** Whether anything acts in a project (founder-routes.ts projectActivity):
 * acting, nobody (nothing goes on by itself), silent (work goes on, nothing done on a site for
 * days). */
export type ProjectActivity = "acting" | "nobody" | "silent";
export interface FounderProject {
  projectId: string;
  name: string;
  founderJobs: FounderJob[];
  /** Actions done on a site in 7 days (notices and summaries are not actions). */
  actions7d: number;
  stuck: FounderStuck[];
  /** When the server sends them: what goes on by itself, its last action on
   * a site, the accounts that are not operating, and the activity from those facts. */
  working?: number;
  lastActionAt?: string | null;
  idle?: string[];
  activity?: ProjectActivity;
}
export interface FounderData {
  founder: FounderAccount | null;
  priorities: FounderPriority[];
  projects: FounderProject[];
}

/** Reads `{ founder, priorities, projects }`; null when the payload is not that shape at all.
 * Rows without an id are dropped; a founder without an environment id reads as none. */
export function normalizeFounder(payload: unknown): FounderData | null {
  const value = record(payload);
  if (!Array.isArray(value.priorities) && !Array.isArray(value.projects) && !("founder" in value))
    return null;
  const raw = record(value.founder);
  const environmentId = str(raw.environmentId);
  const loop = record(raw.loop);
  const loopTask = str(loop.taskId);
  const founder: FounderAccount | null = environmentId
    ? {
        environmentId,
        name: str(raw.name) ?? environmentId,
        goal: str(raw.goal),
        plan: num(raw.plan),
        loop: loopTask ? normalizeLoop(loopTask, loop) : null,
        ...(typeof raw.hasWork === "boolean" ? { hasWork: raw.hasWork } : {}),
      }
    : null;
  const priorities = list(value.priorities).flatMap((item, index) => {
    const row = record(item);
    const projectId = str(row.projectId);
    return projectId
      ? [
          {
            projectId,
            name: str(row.name) ?? "",
            rank: num(row.rank) ?? index + 1,
            set: row.set === true,
          },
        ]
      : [];
  });
  priorities.sort((a, b) => a.rank - b.rank);
  const projects = list(value.projects).flatMap((item) => {
    const row = record(item);
    const projectId = str(row.projectId);
    if (!projectId) return [];
    const activity = activities.find((item) => item === row.activity);
    return [
      {
        projectId,
        name: str(row.name) ?? "",
        actions7d: num(row.actions7d) ?? 0,
        ...(num(row.working) !== null ? { working: num(row.working) as number } : {}),
        ...("lastActionAt" in row ? { lastActionAt: str(row.lastActionAt) } : {}),
        ...(Array.isArray(row.idle)
          ? { idle: row.idle.filter((name): name is string => typeof name === "string" && !!name) }
          : {}),
        ...(activity ? { activity } : {}),
        founderJobs: list(row.founderJobs).flatMap((job) => {
          const entry = record(job);
          const jobId = str(entry.jobId);
          return jobId
            ? [
                {
                  jobId,
                  title: str(entry.title) ?? "",
                  status: str(entry.status) ?? "",
                  due: str(record(entry.due).text) ?? str(entry.due),
                },
              ]
            : [];
        }),
        stuck: list(row.stuck).flatMap((task) => {
          const entry = record(task);
          const taskId = str(entry.taskId);
          return taskId
            ? [{ taskId, title: str(entry.title) ?? "", status: str(entry.status) ?? "" }]
            : [];
        }),
      },
    ];
  });
  return { founder, priorities, projects };
}

const activities: readonly ProjectActivity[] = ["acting", "nobody", "silent"];

/** The loop's fields the server sent; the optional ones only when present. */
function normalizeLoop(taskId: string, loop: Record<string, unknown>): FounderLoop {
  const state = loop.state && typeof loop.state === "object" ? record(loop.state) : null;
  return {
    taskId,
    status: str(loop.status) ?? "",
    nextRunAt: str(loop.nextRunAt),
    ...(str(loop.title) ? { title: str(loop.title) as string } : {}),
    ...(str(loop.updatedAt) ? { updatedAt: str(loop.updatedAt) as string } : {}),
    ...(str(loop.error) ? { error: str(loop.error) as string } : {}),
    ...(str(loop.question) ? { question: str(loop.question) as string } : {}),
    ...(num(loop.attempts) !== null ? { attempts: num(loop.attempts) as number } : {}),
    ...(state ? { state } : {}),
  };
}

const taskStatuses = new Set<AgentTask["status"]>([
  "queued",
  "running",
  "scheduled",
  "waiting_input",
  "waiting_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
/** The founder's loop as a task the shared phase function reads (taskPhase): an account's
 * standing loop, so a stopped one stays stopped however long ago; null without a loop or with a
 * state no task has. */
export function founderLoopTask(founder: FounderAccount): AgentTask | null {
  const loop = founder.loop;
  if (!loop || !taskStatuses.has(loop.status as AgentTask["status"])) return null;
  const at = loop.updatedAt ?? "";
  return {
    id: loop.taskId,
    title: loop.title ?? t.taskTitle.loop(founder.name),
    prompt: "",
    kind: "agent",
    status: loop.status as AgentTask["status"],
    plan: [],
    evidence: [],
    input: { environmentId: founder.environmentId, accountLoop: true },
    state: loop.state ?? {},
    createdAt: at,
    updatedAt: at,
    attempts: loop.attempts ?? 0,
    artifactIds: [],
    ...(loop.nextRunAt ? { nextRunAt: loop.nextRunAt } : {}),
    ...(loop.error ? { error: loop.error } : {}),
    ...(loop.question ? { question: loop.question } : {}),
  };
}

/** What the founder is doing, as the members bar and her section say it. */
export interface FounderState {
  /** The ring (members-core MemberState). */
  state: "needs" | "blocked" | "running" | "waiting" | "idle";
  /** One short line: 正在做, 排队中, 明天 10:05 继续, 经营停了, 经营暂停了, 没在经营, 停着. */
  line: string;
  /** The longer reason when there is one: 「经营停了：模型服务没返回内容」, 「没在经营：给它一个长期目标或
   * 派活」, the incident's line; null otherwise. */
  detail: string | null;
  /** Her loop's phase; null without a live loop. */
  phase: TaskPhase | null;
}
/** The founder's real state from her loop (never a fixed 「创始人」): running,
 * queued, waiting for its next run (or retrying an incident by itself), stopped (failed or paused,
 * with why) or, with no live loop, 没在经营 when she has nothing to work on, else 停着. `stalled`:
 * the worker has no heartbeat, so a run reads 后台停着. */
export function founderState(founder: FounderAccount, now: number, stalled: boolean): FounderState {
  const task = founderLoopTask(founder);
  const phase = task ? stalledPhase(taskPhase(task, { now, words: phaseWords }), stalled) : null;
  if (!phase || phase.ended)
    return founder.hasWork === false
      ? { state: "needs", line: t.flags.idle, detail: t.needs.idle, phase: null }
      : { state: "idle", line: t.members.idle, detail: null, phase: null };
  if (phase.needsYou) {
    const line = phase.stopped
      ? phase.key === "pause"
        ? t.members.loopPaused
        : t.members.loopStopped
      : phase.label;
    return { state: "needs", line, detail: phase.sub, phase };
  }
  if ((phase.key === "wait" || phase.key === "sched") && phase.incident) {
    const since = Date.parse(phase.incident.since);
    return {
      state: "blocked",
      line: t.members.blocked(
        incidentWord(phase.incident.kind),
        durationLabel(Math.max(0, now - (Number.isNaN(since) ? now : since))),
      ),
      detail: phase.sub,
      phase,
    };
  }
  if (phase.key === "run")
    return phase.stalled
      ? { state: "waiting", line: t.members.stalled, detail: null, phase }
      : { state: "running", line: t.members.running, detail: null, phase };
  if (phase.key === "queue") return { state: "waiting", line: phase.label, detail: null, phase };
  if (phase.key === "wait" || phase.key === "sched") {
    const clock = phase.at ? clockLabel(phase.at, now, phaseWords) : "";
    const line = clock
      ? phase.key === "wait"
        ? t.accountsRail.nextWait(clock)
        : t.founder.next(clock)
      : t.members.waiting;
    return { state: "waiting", line, detail: null, phase };
  }
  return { state: "idle", line: phase.label, detail: null, phase };
}

/** The order with `projectId` moved one place up (-1) or down (1); unchanged at either end or
 * for an id that is not in it. */
export function moveInOrder(order: readonly string[], projectId: string, step: -1 | 1): string[] {
  const next = [...order];
  const from = next.indexOf(projectId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to] as string, next[from] as string];
  return next;
}

/** A founder job's state in the job words (已派 / 在做 / 没接 / 做完了). */
export function founderJobWord(status: string): string {
  const words = t.jobs.status as Readonly<Record<string, string>>;
  return words[status] ?? status;
}
/** A task's state in the task words (等你回答 / 失败 …). */
export function taskStatusWord(status: string): string {
  return t.server.statusWords[status] ?? status;
}

export interface FounderCardCounts {
  needsYou: number;
  running: number;
  waiting: number;
}
export interface FounderCard {
  projectId: string;
  name: string;
  rank: number;
  /** From /api/projects/overview; null when it has not answered (or has no such project). */
  counts: FounderCardCounts | null;
  actions7d: number;
  /** Whether anything acts there, and why not (the line under the chip);
   * undefined from a server that does not say. */
  activity?: ProjectActivity;
  why?: string | null;
  jobs: { jobId: string; title: string; line: string }[];
  stuck: { taskId: string; title: string; line: string }[];
}

/** One card per project in the owner's order (projects the order does not list come last, as
 * the server sent them), with the overview's counts. */
export function founderCards(
  data: FounderData,
  overview: readonly ProjectOverview[] | null,
  now: number = Date.now(),
): FounderCard[] {
  const rank = new Map(data.priorities.map((item, index) => [item.projectId, index]));
  const projects = [...data.projects].sort(
    (a, b) =>
      (rank.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.projectId) ?? Number.MAX_SAFE_INTEGER),
  );
  return projects.map((project, index) => {
    const row = overview?.find((item) => item.id === project.projectId);
    return {
      projectId: project.projectId,
      name:
        project.name ||
        data.priorities.find((item) => item.projectId === project.projectId)?.name ||
        row?.name ||
        "",
      rank: index + 1,
      counts: row
        ? {
            needsYou: row.counts.needsYou,
            running: row.counts.running,
            waiting: row.counts.waiting,
          }
        : null,
      actions7d: project.actions7d,
      ...(project.activity ? { activity: project.activity, why: activityWhy(project, now) } : {}),
      jobs: project.founderJobs.map((job) => ({
        jobId: job.jobId,
        title: job.title,
        line: [job.title, job.due ?? "", founderJobWord(job.status)]
          .filter(Boolean)
          .join(t.common.sep),
      })),
      stuck: project.stuck.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        line: `${task.title}${t.common.sep}${taskStatusWord(task.status)}`,
      })),
    };
  });
}

/** 「需要你 1 · 运行 2 · 等待 0」; while the worker has no heartbeat (`stalled`, ShellData.stalled)
 * nothing runs, so its runs read 「后台停着」 (「需要你 1 · 后台停着 · 等待 0」). */
export function countsLine(counts: FounderCardCounts, stalled: boolean): string {
  const f = t.founder;
  const running =
    stalled && counts.running > 0 ? t.members.stalled : f.running(stalled ? 0 : counts.running);
  return [f.needsYou(counts.needsYou), running, f.waiting(counts.waiting)].join(t.common.sep);
}

/** The founder's loop: 此刻 (its state) and 下次 (when it runs next, as a clock); null without a
 * loop. `clock` turns an ISO time into the shell's clock label. A running loop while the worker
 * has no heartbeat (`stalled`) reads 「后台停着」. */
export function loopLine(
  loop: FounderLoop | null,
  clock: (iso: string) => string,
  stalled: boolean,
): { now: string; next: string } | null {
  if (!loop) return null;
  return {
    now:
      stalled && loop.status === "running"
        ? t.members.stalled
        : loop.status
          ? taskStatusWord(loop.status)
          : t.founder.loopUnknown,
    next: loop.nextRunAt ? clock(loop.nextRunAt) || t.founder.noNext : t.founder.noNext,
  };
}

export interface Speaker {
  name: string;
  /** The round avatar's letter: the name's first character, upper-cased. */
  initial: string;
  founder: boolean;
}
/** Who speaks a chat report: the account the task runs on (its name, its initial, 创始人 for the
 * founder); null for a task on the default desktop (the card stays as it was). */
export function reportSpeaker(
  account: { name: string; view?: { founder?: boolean } } | null,
): Speaker | null {
  if (!account) return null;
  const name = account.name.trim();
  if (!name) return null;
  return { name, initial: speakerInitial(name), founder: account.view?.founder === true };
}
/** The speaker a report names itself (the founder's copy in the project that gave the job). */
export function reportSpeakerOf(report: {
  speaker?: { name: string; founder: boolean };
}): Speaker | null {
  const name = report.speaker?.name?.trim();
  if (!name) return null;
  return { name, initial: speakerInitial(name), founder: report.speaker?.founder === true };
}
export function speakerInitial(name: string): string {
  const first = Array.from(name.trim().replace(/^[@#[(（【「]+/, ""))[0] ?? "";
  return first.toUpperCase();
}

/** How many projects the priority list shows before 「其余 n 个项目 ▸」. */
export const topPriorities = 5;
/** The priority rows shown (the top ones, or all when opened) and how many are folded. */
export function priorityRows<T>(
  priorities: readonly T[],
  expanded: boolean,
  top = topPriorities,
): { shown: T[]; hidden: number } {
  // Folding a single row saves nothing: show it.
  if (expanded || priorities.length <= top + 1) return { shown: [...priorities], hidden: 0 };
  return { shown: priorities.slice(0, top), hidden: priorities.length - top };
}

/** Why nothing acts in a project, in words: the accounts that are not
 * operating (「Pop 没在经营」), work that goes on without doing anything on a site for days
 * (「在跑，但 4 天没在网站上做事」, or 「在跑，还没在网站上做过事」), or nothing that goes on by itself
 * (「没有号在经营，也没有在跑的任务」); null while something acts. */
export function activityWhy(project: FounderProject, now: number): string | null {
  const f = t.founder;
  if (project.activity === "nobody")
    return project.idle?.length ? f.idleWhy(project.idle.join("、")) : f.nobodyWhy;
  if (project.activity === "silent") {
    const last = project.lastActionAt ? Date.parse(project.lastActionAt) : Number.NaN;
    return Number.isFinite(last)
      ? f.silentWhy(Math.max(1, Math.floor((now - last) / 86400000)))
      : f.neverActed;
  }
  return null;
}

/** A project card's state line: 卡住 n (red), 需要你 n (amber), 没人在做 (grey); with none of
 * them, 在做 when something acts there (never 一切正常: a project where nothing complains is not
 * fine for that alone). */
export type CardChip = { tone: "red" | "amber" | "grey"; label: string };
export function cardState(card: FounderCard): { chips: CardChip[]; fine: boolean } {
  const f = t.founder;
  const chips: CardChip[] = [];
  if (card.stuck.length) chips.push({ tone: "red", label: f.stuckChip(card.stuck.length) });
  const needsYou = card.counts?.needsYou ?? 0;
  if (needsYou) chips.push({ tone: "amber", label: f.needsYou(needsYou) });
  if (card.activity === "nobody" || card.activity === "silent")
    chips.push({ tone: "grey", label: f.nobody });
  return { chips, fine: !chips.length && card.activity === "acting" };
}
/** Whether nothing at all happens in a project: no founder job, no action in 7 days, nothing
 * stuck, nothing waiting on the owner, and nothing that goes on by itself (work that goes on
 * without acting, 「silent」, stays shown: the owner has to see it). */
export function quietCard(card: FounderCard): boolean {
  return (
    !card.jobs.length &&
    !card.actions7d &&
    !card.stuck.length &&
    !(card.counts?.needsYou ?? 0) &&
    card.activity !== "acting" &&
    card.activity !== "silent"
  );
}

/** The owner never set the order: 「未设置（按名称）」 under 项目优先级 (the
 * founder then takes the projects by name); null once he placed any. */
export function priorityNote(priorities: readonly Pick<FounderPriority, "set">[]): string | null {
  return priorities.length && !priorities.some((item) => item.set)
    ? t.founder.prioritiesUnset
    : null;
}
/** The cards shown in full (in the owner's order), and the quiet ones folded into one line. */
export function splitQuiet(cards: readonly FounderCard[]): {
  active: FounderCard[];
  quiet: FounderCard[];
} {
  return {
    active: cards.filter((card) => !quietCard(card)),
    quiet: cards.filter(quietCard),
  };
}
/** The founder as the job cards name it (null without one). */
export function founderRefOf(
  data: FounderData | null | undefined,
): { environmentId: string; name: string } | null {
  const founder = data?.founder;
  return founder ? { environmentId: founder.environmentId, name: founder.name } : null;
}

/** Where 创始人 leads (the members bar, the project
 * switcher's row, an old link): the founder's own card, its account detail, which holds what
 * the 创始人 panel used to show; null without a founder (the panel then says how to set one). */
export function founderCard(
  founder: { environmentId: string } | null | undefined,
): { kind: "account"; environmentId: string } | null {
  return founder ? { kind: "account", environmentId: founder.environmentId } : null;
}

/** Whether an account's card shows the founder's section (项目优先级, 各项目): only the
 * founder's, by the account's own flag or the space's founder. */
export function showsFounderSection(
  account: { id: string; view?: { founder?: boolean } },
  founder: { environmentId: string | null } | null | undefined,
): boolean {
  return account.view?.founder === true || founder?.environmentId === account.id;
}
