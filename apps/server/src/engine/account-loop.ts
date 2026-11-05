// Each account that has a long-term goal, or a job given to
// it that is not over, has exactly one standing operating loop in its project: an agent task the
// system keeps, titled 「<name> 的日常运营」, whose prompt is the owner's goal in his words. The loop
// has no cadence of ours: each run decides from the facts what to do and ends with wait_until at
// a time it chooses itself; finish_task does not end it. The system ends it when the goal is
// cleared and no job is left, or when the account leaves the project or is deleted.
import { createHash, randomUUID } from "node:crypto";
import { type AgentTask, clipText } from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import { projectOwner, realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { readGoal } from "../accounts/records.ts";
import { envOwner, isEnvironmentId } from "../environments.ts";
import { backgroundFailure } from "../log.ts";
import { migrationTaskKey } from "./migration-v06.ts";
import type { AgentService } from "./service.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const date = () => new Date().toISOString();

/** The idempotency key of an account's loop in a project (the task id is its hash, as for every
 * keyed task), so concurrent or repeated calls never make a second one. */
export const loopKey = (scope: string, environmentId: string) => `loop:${scope}:${environmentId}`;
export const loopTaskId = (scope: string, environmentId: string) =>
  hash(`task:${loopKey(scope, environmentId)}`);
export const isAccountLoop = (task: Pick<AgentTask, "input">) => task.input?.accountLoop === true;
export const loopTitle = (name: string) => `${name} 的日常运营`;
/** The loop's prompt: the goal in the owner's words, or, without one, the jobs given to it. */
export const loopPrompt = (name: string, goal: string | null) => goal ?? `做派给 ${name} 的活`;
/** Results of a loop the system ended (the owner reads them on the task). */
export const loopEnded = {
  cleared: "目标已清空，经营停止",
  /** It ran only for jobs given to it, and none is left. */
  idle: "派给它的活都结束了，经营停止",
  moved: "号已移出这个项目，这里的经营停止",
  removed: "号已删除，经营停止",
} as const;

/** Where the loop of a new owner starts: right away, or (taking over an earlier task) at the time
 * that task was waiting for, with its wait and progress record. */
export interface LoopStart {
  nextRunAt: string;
  state: Record<string, unknown>;
}

export class AccountLoops {
  /** Jobs (docs/accounts.md §3): how many jobs given to the account in this project are not
   * over. Set by the jobs part; none until then. */
  openJobs: (scope: string, environmentId: string) => Promise<number> = async () => 0;
  /** Jobs: the account no longer does the jobs given to it here (`stopped` by the owner, `moved`
   * out of the project, `removed`). Set by the jobs part. */
  dropJobs?: (
    scope: string,
    environmentId: string,
    why: "stopped" | "moved" | "removed",
  ) => Promise<void>;
  /** Jobs: the account takes the open jobs given to everyone in its project that it does not
   * have yet (it joined later, or came back). Set by the jobs part. */
  adoptJobs?: (scope: string, environmentId: string) => Promise<void>;
  constructor(private readonly service: AgentService) {}
  private get db() {
    return this.service.db;
  }
  /** The account's record and the task owner of its project; null when it is gone or going. */
  private async account(real: string, environmentId: string) {
    if (!isEnvironmentId(environmentId)) return null;
    const record = await this.db.get<Environment>(real, "environments", environmentId);
    if (!record || record.deleting) return null;
    const projectId = record.projectId ?? null;
    return { record, scope: projectId ? projectOwner(real, projectId) : real };
  }
  /** Makes the account's loop match what it has to work on: started (or started again) when it
   * has a goal or an open job, ended when it has neither. A goal changed meanwhile becomes the
   * loop's prompt, and a loop waiting for its next run runs now with it. `startup` (the check at
   * every start) only starts what is missing, takes up again a loop an error failed and ends what
   * should not run; it changes nothing else. Returns the loop, or null when the account has none. */
  async ensure(
    owner: string,
    environmentId: string,
    options: { startup?: boolean; start?: LoopStart; handover?: boolean } = {},
  ): Promise<AgentTask | null> {
    const real = realOwnerOf(owner);
    const found = await this.account(real, environmentId);
    if (!found) return null;
    const { record, scope } = found;
    await this.adoptJobs?.(scope, environmentId);
    const goal = (await readGoal(this.db, envOwner(real, environmentId)))?.text ?? null;
    const wanted = !!goal || (await this.openJobs(scope, environmentId)) > 0;
    const id = loopTaskId(scope, environmentId);
    const existing = await this.db.get<AgentTask>(scope, "tasks", id);
    const prompt = loopPrompt(record.name, goal);
    const title = loopTitle(record.name);
    // Whether it runs for the owner's goal (else only for jobs): what its end is told by.
    const forGoal = !!goal;
    if (!wanted) {
      // A loop an error failed ends too once the account has nothing to work
      // on: the owner stopped it on purpose (cleared the goal, the jobs ended), so it is not a
      // stop that waits for 重试 in 需要你 but 没在经营 like any account with nothing to do.
      if (existing && (!terminal.has(existing.status) || existing.status === "failed"))
        await this.end(
          scope,
          existing,
          existing.input?.forGoal ? loopEnded.cleared : loopEnded.idle,
          undefined,
          true,
        );
      return null;
    }
    if (!existing) {
      if (!options.handover && (await this.handoverPending(scope, environmentId))) return null;
      const created = await this.service.createTask(
        scope,
        { kind: "agent", title, prompt, input: { environmentId, accountLoop: true, forGoal } },
        loopKey(scope, environmentId),
        false,
        { roomChecked: true },
      );
      return options.start ? this.startAt(scope, created, options.start) : created;
    }
    // Ended by the owner (停止经营) or by the system: a goal or a job starts it again.
    if (existing.status === "succeeded" || existing.status === "cancelled") {
      const revived = await this.db.compareAndSwap<AgentTask>(
        scope,
        "tasks",
        id,
        { status: existing.status },
        {
          status: options.start ? "scheduled" : "queued",
          title,
          prompt,
          input: { ...existing.input, forGoal },
          result: "",
          error: null,
          question: null,
          pendingAnswer: null,
          leaseId: null,
          leaseUntil: null,
          state: options.start?.state ?? {},
          nextRunAt: options.start?.nextRunAt ?? date(),
          updatedAt: date(),
        },
      );
      if (revived) await this.event(scope, id, "Operating started again", prompt);
      return revived ?? this.db.get<AgentTask>(scope, "tasks", id);
    }
    // A loop an error failed is taken up again at every check (the
    // start check, so the founder's loop failed on 10-18 by a relay's empty answer runs again on
    // deploy; a goal; a job; the maintenance pass), with its current title and prompt. A failure
    // only the owner can fix stays as it is, for 重试 (AgentService.reviveFailed).
    if (existing.status === "failed")
      return (
        (await this.service.reviveFailed(scope, existing, {
          title,
          prompt,
          input: { ...existing.input, forGoal },
        })) ?? existing
      );
    if (options.startup) return existing;
    if (existing.prompt === prompt && existing.input?.forGoal === forGoal) {
      if (existing.title === title) return existing;
      // Only the title's wording changed (an older loop's 「经营 · <name>」, or a renamed
      // account): renamed in place, nothing runs because of it.
      return (
        (await this.db.compareAndSwap<AgentTask>(
          scope,
          "tasks",
          id,
          { status: existing.status, title: existing.title },
          { title, updatedAt: date() },
        )) ?? this.db.get<AgentTask>(scope, "tasks", id)
      );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      scope,
      "tasks",
      id,
      { status: existing.status, prompt: existing.prompt },
      { prompt, title, input: { ...existing.input, forGoal }, updatedAt: date() },
    );
    if (!updated) return this.db.get<AgentTask>(scope, "tasks", id);
    if (updated.status === "scheduled")
      return (
        (await this.service.queueNow(scope, updated, "Goal changed", prompt)) ??
        this.db.get<AgentTask>(scope, "tasks", id)
      );
    await this.event(scope, id, "Goal changed", prompt);
    return updated;
  }
  /** The account's loop and the owner its tasks are kept under (its
   * project's); null when the account is gone or has never had a loop. */
  async of(owner: string, environmentId: string) {
    const found = await this.account(realOwnerOf(owner), environmentId);
    if (!found) return null;
    const task = await this.db.get<AgentTask>(
      found.scope,
      "tasks",
      loopTaskId(found.scope, environmentId),
    );
    return task ? { scope: found.scope, task } : null;
  }
  /** Whether the account has something to work on in its project: a long-term goal, or a job
   * given to it that is not over. */
  async wanted(owner: string, environmentId: string) {
    const real = realOwnerOf(owner);
    const found = await this.account(real, environmentId);
    if (!found) return false;
    const goal = (await readGoal(this.db, envOwner(real, environmentId)))?.text;
    return !!goal || (await this.openJobs(found.scope, environmentId)) > 0;
  }
  /** Jobs: the account was given a job (or one of its jobs changed). Its loop (made if it has
   * none) runs now: one waiting runs at once with its wait record kept; one running sees it when
   * this run ends with a wait (`wakeAt`, see AgentService.wait). */
  async wake(owner: string, environmentId: string, title: string, detail: string) {
    const loop = await this.ensure(owner, environmentId);
    if (!loop) return null;
    const found = await this.account(realOwnerOf(owner), environmentId);
    if (!found) return loop;
    const { scope } = found;
    if (loop.status === "scheduled")
      return (await this.service.queueNow(scope, loop, title, detail)) ?? loop;
    if (loop.status === "running") {
      await this.db.compareAndSwap<AgentTask>(
        scope,
        "tasks",
        loop.id,
        { status: "running" },
        { wakeAt: date() },
      );
      await this.event(scope, loop.id, title, detail);
    }
    return loop;
  }
  /** v0.6 migration: an earlier task on the account, listed in the project's migration data,
   * that is still open. Until it ends (retire_task hands it over, or it ends by itself or by the
   * owner) that task operates the account and no loop starts beside it, whatever became of the
   * migration task: one that failed after setting the goal leaves the earlier task working as it
   * did. */
  private async handoverPending(scope: string, environmentId: string) {
    for (const task of await this.earlierTasks(scope))
      if (!terminal.has(task.status) && task.input?.environmentId === environmentId) return true;
    return false;
  }
  /** The earlier tasks listed in the project's migration data (none without a migration). */
  private async earlierTasks(scope: string) {
    const migration = await this.db.get<AgentTask>(
      scope,
      "tasks",
      hash(`task:${migrationTaskKey(scope)}`),
    );
    const listed =
      (migration?.state.migration as { tasks?: { id: string }[] } | undefined)?.tasks ?? [];
    const tasks: AgentTask[] = [];
    for (const item of listed) {
      const task = await this.db.get<AgentTask>(scope, "tasks", item.id);
      if (task) tasks.push(task);
    }
    return tasks;
  }
  /** A task has ended (its run settled, or the owner stopped it): when it is an earlier task the
   * migration listed, its account's loop starts now if the account has something to work on, so
   * the goal moved off it is not left waiting for the next start. */
  async earlierEnded(scope: string, task: AgentTask) {
    const environmentId = task.input?.environmentId;
    if (!terminal.has(task.status) || isAccountLoop(task) || typeof environmentId !== "string")
      return;
    if (!(await this.earlierTasks(scope)).some((item) => item.id === task.id)) return;
    await this.ensure(scope, environmentId);
  }
  /** v0.6 migration: an instruction the owner gave an earlier task that no run of it read yet
   * goes to the loop that takes its work over, as his instruction to it (added to one it has
   * not read yet), and its next run reads it as the earlier task's would have. */
  async passInstruction(scope: string, loopId: string, text: string) {
    // Until the swap holds: each miss means the loop changed meanwhile, and is read again.
    for (;;) {
      const loop = await this.db.get<AgentTask>(scope, "tasks", loopId);
      if (!loop || terminal.has(loop.status)) return false;
      const updated = await this.db.compareAndSwap<AgentTask>(
        scope,
        "tasks",
        loopId,
        { status: loop.status, updatedAt: loop.updatedAt },
        {
          pendingAnswer: loop.pendingAnswer ? `${loop.pendingAnswer}\n---\n${text}` : text,
          updatedAt: date(),
        },
      );
      if (!updated) continue;
      await this.event(scope, loopId, "Redirected", clipText(text, 500));
      return true;
    }
  }
  /** A new loop that takes over an earlier task starts when that task was due, with its wait. */
  private async startAt(scope: string, task: AgentTask, start: LoopStart) {
    return (
      (await this.db.compareAndSwap<AgentTask>(
        scope,
        "tasks",
        task.id,
        { status: "queued" },
        { status: "scheduled", nextRunAt: start.nextRunAt, state: start.state, updatedAt: date() },
      )) ?? task
    );
  }
  /** Ends a task that is not over (a loop, or an earlier task a loop takes over): `succeeded`
   * with `result`, whatever it was doing. */
  async end(
    scope: string,
    task: AgentTask,
    result: string,
    title = "Operating stopped",
    /** Ends a failed loop as well (ensure: the account has nothing left to work on). */
    failedToo = false,
  ) {
    // Until the swap holds: each miss means the task changed meanwhile, and is read again.
    for (let current: AgentTask | null = task; ; ) {
      if (!current) return;
      if (terminal.has(current.status) && !(failedToo && current.status === "failed")) return;
      const ended = await this.db.compareAndSwap<AgentTask>(
        scope,
        "tasks",
        task.id,
        { status: current.status, leaseId: current.leaseId ?? null },
        {
          status: "succeeded",
          result,
          leaseId: null,
          leaseUntil: null,
          question: null,
          ...(current.status === "failed" ? { error: null } : {}),
          updatedAt: date(),
        },
      );
      if (!ended) {
        current = await this.db.get<AgentTask>(scope, "tasks", task.id);
        continue;
      }
      this.service.worker.abort(scope, task.id);
      await this.event(scope, task.id, title, result);
      return;
    }
  }
  /** The account left the project `from` for `to`: its loop in `from` ends and its jobs there
   * are no longer its; in `to` it starts if the account has something to work on. */
  async moved(real: string, environmentId: string, from: string) {
    const left = await this.db.get<AgentTask>(from, "tasks", loopTaskId(from, environmentId));
    if (left && !terminal.has(left.status)) await this.end(from, left, loopEnded.moved);
    await this.dropJobs?.(from, environmentId, "moved");
    await this.ensure(real, environmentId);
  }
  /** The account is being deleted: its loop ends, and its jobs are no longer its. */
  async removed(scope: string, environmentId: string) {
    const loop = await this.db.get<AgentTask>(scope, "tasks", loopTaskId(scope, environmentId));
    if (loop && !terminal.has(loop.status)) await this.end(scope, loop, loopEnded.removed);
    await this.dropJobs?.(scope, environmentId, "removed");
  }
  /** At every start: each live account gets the loop it should have and nothing else; a loop
   * whose account is gone, or is now in another project, ends. Running loops are left as they
   * are. One account's failure does not stop the others. */
  async reconcile() {
    for (const { owner, value } of await this.db.scan<Environment>("environments"))
      if (!value.deleting)
        await this.ensure(owner, value.id, { startup: true }).catch((error) =>
          backgroundFailure("account loop check", error),
        );
    for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
      if (!isAccountLoop(value) || terminal.has(value.status)) continue;
      const environmentId = String(value.input.environmentId ?? "");
      const found = await this.account(realOwnerOf(owner), environmentId);
      if (!found) await this.end(owner, value, loopEnded.removed);
      else if (found.scope !== owner) await this.end(owner, value, loopEnded.moved);
    }
  }
  private async event(scope: string, taskId: string, title: string, detail: string) {
    await this.db.put(scope, "run-events", {
      id: randomUUID(),
      taskId,
      kind: "status",
      date: date(),
      title,
      detail,
    });
  }
}
