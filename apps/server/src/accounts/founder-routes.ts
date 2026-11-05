// /api/founder, the space's founder and the owner's view over
// every project. Always the space's (the project header is ignored). The per-project numbers of
// /api/projects/overview are not repeated here; this adds what only the founder view needs.
//
//   GET  /api/founder             { founder, priorities, projects }
//   PUT  /api/founder             { environmentId | null }  -> the same
//   PUT  /api/founder/priorities  { order: projectId[] }    -> the same
//
// It tells the truth about who is doing anything. The founder carries her
// loop as the shared phase function reads it (running / waiting / stopped and why, an open
// incident) and whether she has anything to work on (`hasWork`); each project carries the facts
// behind 「没人在做」: how many of its tasks go on by themselves (`working`), how many of those
// run without acting (`silent`: a standing task with nothing done on a site for the system's cap,
// packages/domain/src/standing.ts), its last action on a site (`lastActionAt`; notices and
// summaries are not actions), its accounts that are not operating (`idle`), and `activity` from
// those facts (`projectActivity`). A project is never "all fine" only because nothing in it
// complains.
import { Hono } from "hono";
import { z } from "zod";
import {
  type AgentTask,
  operatingPlanOf,
  reportInputSchema,
} from "../../../../packages/domain/src/agent.ts";
import type { ProjectJob } from "../../../../packages/domain/src/jobs.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import {
  noActionCapDays,
  type StandingActivity,
  standingBehind,
} from "../../../../packages/domain/src/standing.ts";
import { taskPhase } from "../../../../packages/domain/src/task-phase.ts";
import { loopTaskId } from "../engine/account-loop.ts";
import { type AccountAction, accountActionsKind } from "../engine/pacing.ts";
import type { AgentService } from "../engine/service.ts";
import { standingActivity } from "../engine/standing.ts";
import { envOwner } from "../environments.ts";
import { idleAccount } from "../project-overview.ts";
import {
  founderFact,
  founderOf,
  founderPriorities,
  projectScopes,
  setFounder,
  setFounderPriorities,
} from "./founder.ts";
import { projectJobKind } from "./jobs.ts";

const dayMs = 86400000;
const weekMs = 7 * dayMs;

/** The report topics that are not an action (report_to_user's `topic`), and "none": a ledger row
 * the AI wrote with one of these as its action word (an older notice) is nothing done on a site. */
const notActions = new Set<string>(["none", ...reportInputSchema.shape.topic.unwrap().options]);
/** Whether a ledger row is an action done on a site (not a notice or a summary). */
export function isSiteAction(row: Pick<AccountAction, "action">): boolean {
  return !notActions.has(
    String(row.action ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** Whether a task that goes on by itself runs without acting: a standing task (its `activity`;
 * null for a one-off task, which is doing what it was given) that the shared rule finds behind
 * (`standingBehind`: its plan states a pace and nothing was done for `noActionCapDays`) or,
 * before its plan states a pace, that did nothing on a site for as long since its last action
 * or since it began. */
export function runsWithoutActing(
  task: Pick<AgentTask, "createdAt">,
  activity: StandingActivity | null,
  now: number,
): boolean {
  if (!activity) return false;
  if (activity.planPace) return standingBehind(activity, now) !== null;
  const since = Date.parse(activity.lastActionAt ?? task.createdAt);
  return Number.isFinite(since) && now - since >= noActionCapDays * dayMs;
}

/** A project's activity from its facts: "nobody" (nothing in it goes on by itself: no loop, no
 * task, no job the founder works on), "silent" (work goes on, but every one of them runs without
 * acting: `runsWithoutActing`), else "acting". */
export function projectActivity(facts: {
  working: number;
  silent: number;
}): "acting" | "nobody" | "silent" {
  if (!facts.working) return "nobody";
  return facts.silent >= facts.working ? "silent" : "acting";
}

/** The founder's loop as every client reads it with the shared phase function (taskPhase): its
 * state and why it stopped, never its prompt, plan or evidence. */
function loopView(loop: AgentTask) {
  return {
    taskId: loop.id,
    title: loop.title,
    status: loop.status,
    nextRunAt: loop.nextRunAt ?? null,
    updatedAt: loop.updatedAt,
    error: loop.error ?? null,
    question: loop.question ?? null,
    attempts: loop.attempts ?? 0,
    // What taskPhase reads of the state: the wait and the open incident.
    state: {
      ...(loop.state?.wait ? { wait: loop.state.wait } : {}),
      ...(loop.state?.incident ? { incident: loop.state.incident } : {}),
    },
  };
}

/** The phases a task goes on by itself in. */
const goesOn = new Set(["run", "queue", "wait", "sched"]);

/** The founder view of the space `owner` belongs to. */
export async function founderView(service: AgentService, owner: string) {
  const db = service.db;
  const real = realOwnerOf(owner);
  const now = Date.now();
  const founder = await founderOf(db, real);
  const fact = founder ? await founderFact(db, real) : null;
  const loop = founder
    ? await db.get<AgentTask>(real, "tasks", loopTaskId(real, founder.id))
    : null;
  const founderGoesOn = !!loop && goesOn.has(taskPhase(loop, { now }).key);
  const founderHasWork = founder
    ? await service.loops.wanted(real, founder.id).catch(() => undefined)
    : undefined;
  const priorities = await founderPriorities(db, real);
  const since = now - weekMs;
  const accounts = (await service.environments.allRecords(real)).filter(
    (record) => !record.deleting,
  );
  const projects = [];
  for (const { project, scope } of await projectScopes(db, real)) {
    const jobs = await db.list<ProjectJob>(scope, projectJobKind);
    const founderJobs = founder
      ? jobs.flatMap((job) => {
          const own = job.assignees.find((item) => item.envId === founder.id);
          return own && job.status === "open"
            ? [{ jobId: job.id, title: job.title, status: own.status, due: job.due }]
            : [];
        })
      : [];
    const own = accounts.filter((record) => record.projectId === project.id);
    // Every action done for this project: its accounts', the founder's for it, and the project's
    // own ledger (a task on its default desktop, when one is kept).
    const ledgers = [
      ...own.map((record) => envOwner(real, record.id)),
      ...(founder ? [envOwner(real, founder.id)] : []),
      scope,
    ];
    let actions7d = 0;
    let lastActionAt: string | null = null;
    let lastMs = Number.NEGATIVE_INFINITY;
    for (const ledger of ledgers)
      for (const row of await db.list<AccountAction>(ledger, accountActionsKind)) {
        if (row.projectOwner !== scope || !isSiteAction(row)) continue;
        const at = Date.parse(row.at);
        if (!Number.isFinite(at)) continue;
        if (at >= since) actions7d += 1;
        if (at > lastMs) {
          lastMs = at;
          lastActionAt = row.at;
        }
      }
    const tasks = await db.list<AgentTask>(scope, "tasks");
    const phases = tasks.map((task) => ({ task, phase: taskPhase(task, { now }) }));
    // What waits on the owner: a question, a review, a failure in 需要你, a stopped loop.
    const stuck = phases
      .filter(({ phase }) => phase.needsYou)
      .map(({ task }) => ({ taskId: task.id, title: task.title, status: task.status }));
    const working = phases.filter(({ phase }) => goesOn.has(phase.key));
    // The founder works for this project while she has one of its jobs and her loop goes on.
    const founderHere = founderGoesOn && founderJobs.length > 0;
    let silent = 0;
    for (const { task } of working)
      if (runsWithoutActing(task, await standingActivity(db, scope, task, new Date(now)), now))
        silent += 1;
    const idle: string[] = [];
    for (const record of own) {
      const hasWork = await service.loops.wanted(real, record.id).catch(() => undefined);
      if (idleAccount(record, hasWork, tasks, now)) idle.push(record.name);
    }
    const count = working.length + (founderHere ? 1 : 0);
    projects.push({
      projectId: project.id,
      name: project.name,
      founderJobs,
      actions7d,
      stuck,
      working: count,
      silent,
      lastActionAt,
      idle,
      activity: projectActivity({ working: count, silent }),
    });
  }
  return {
    founder:
      founder && fact
        ? {
            environmentId: founder.id,
            name: founder.name,
            persona: fact.persona,
            goal: fact.goal,
            plan: loop ? (operatingPlanOf(loop.state)?.version ?? null) : null,
            ...(founderHasWork === undefined ? {} : { hasWork: founderHasWork }),
            loop: loop ? loopView(loop) : null,
          }
        : null,
    priorities,
    projects,
  };
}

const setFounderSchema = z.object({ environmentId: z.string().min(1).max(100).nullable() });
const prioritiesSchema = z.object({ order: z.array(z.string().min(1).max(100)).max(200) });

export function founderRoutes(service: AgentService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await founderView(service, c.get("owner"))));
  app.put("/", async (c) => {
    const owner = c.get("owner");
    const { environmentId } = setFounderSchema.parse(await c.req.json());
    const before = await founderOf(service.db, owner);
    const after = await setFounder(service.db, owner, environmentId);
    // The founder's loop follows: a new founder's loop takes its jobs; one no longer the founder
    // keeps only what its own goal asks.
    for (const id of new Set([before?.id, after?.id].filter(Boolean) as string[]))
      await service.loops.ensure(realOwnerOf(owner), id);
    return c.json(await founderView(service, owner));
  });
  app.put("/priorities", async (c) => {
    const owner = c.get("owner");
    const { order } = prioritiesSchema.parse(await c.req.json());
    await setFounderPriorities(service.db, owner, order);
    return c.json(await founderView(service, owner));
  });
  return app;
}
