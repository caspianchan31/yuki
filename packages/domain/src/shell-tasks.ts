/**
 * v1.7.2 快照只带活的: the tasks the shell's snapshot (`GET /api/agent`) carries. A project that
 * has run for weeks has hundreds of finished tasks (642 on the test site on 2026-11-09: 713 KB
 * of 800, two seconds to make, read at every opening and every poll); the shell shows the live
 * ones and the recent past. So: every task still going (a routine that is not cancelled counts,
 * whatever its last run's status: it rests there between runs and stays in the routine list),
 * plus the finished ones of the last `days` days, newest first, at most `max`, plus every finished
 * one that still asks something of the person (`taskPhase().needsYou`, what the shell's 需要你
 * list is made of), however old and however many. Each finished one comes without its plan and
 * evidence (a finished task's detail is read by itself: `GET /api/agent/tasks/:id`).
 * `GET /api/agent?all=1` still gives everything.
 */
import type { AgentTask, TaskStatus } from "./agent.ts";
import { isRoutine } from "./routines.ts";
import { taskPhase } from "./task-phase.ts";

export const finalTaskStatuses: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export interface ShellTasksOptions {
  now?: number;
  /** Finished tasks this many days back are kept (default 7). */
  days?: number;
  /** At most this many finished tasks (default 100). */
  max?: number;
}

/** A task in the past, not worked on: a final status, unless it is a routine (a routine rests at
 * its last run's status between runs, with or without a next run: one started by mail has none).
 * A cancelled routine is finished. */
export function finishedTask(task: AgentTask): boolean {
  if (!finalTaskStatuses.has(task.status)) return false;
  if (task.status === "cancelled") return true;
  return !isRoutine(task);
}

/** A finished task without the parts the list never shows. */
export function trimFinishedTask(task: AgentTask): AgentTask {
  return { ...task, plan: [], evidence: [] };
}

export function shellTasks(tasks: AgentTask[], options: ShellTasksOptions = {}): AgentTask[] {
  const now = options.now ?? Date.now();
  const days = options.days ?? 7;
  const max = options.max ?? 100;
  const since = now - days * 86_400_000;
  const finished = tasks.filter(finishedTask);
  // What still asks something of the person never leaves, and takes no place among the recent:
  // the 需要你 list, its count and an account's stopped state are all made from these tasks.
  const asking = new Set(
    finished.filter((task) => taskPhase(task, { now }).needsYou).map((task) => task.id),
  );
  const recent = finished
    .filter((task) => !asking.has(task.id) && Date.parse(task.updatedAt) >= since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, max);
  const kept = new Set([...asking, ...recent.map((task) => task.id)]);
  return tasks.flatMap((task) => {
    if (!finishedTask(task)) return [task];
    return kept.has(task.id) ? [trimFinishedTask(task)] : [];
  });
}
