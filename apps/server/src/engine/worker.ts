import { randomUUID } from "node:crypto";
import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

/** A run is one owner's task; two spaces may hold the same task id. */
const runKey = (owner: string, taskId: string) => `${owner}\n${taskId}`;

export class LostLeaseError extends Error {
  constructor() {
    super("Task was paused, cancelled or taken over by another worker");
    this.name = "LostLeaseError";
  }
}
export interface TaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<AgentTask>): Promise<AgentTask>;
  event(kind: RunEvent["kind"], title: string, detail?: string): Promise<void>;
}
export type TaskHandler = (
  owner: string,
  task: AgentTask,
  context: TaskContext,
) => Promise<Partial<AgentTask>>;
/** The file in the data directory a deploy puts
 * while it waits for the runs in progress to end (and removes once the new server is up). */
export const drainFileName = "drain";
export class TaskWorker {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  // Both keyed by owner and task id (runKey): task ids are unique per owner only.
  private active = new Map<string, AbortController>();
  // Tasks this worker has started and not yet settled, including ones still being claimed.
  private inFlight = new Set<string>();
  lastTickAt?: string;
  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      settled?: (owner: string, task: AgentTask) => Promise<void>;
      /** Whether the owner's space may run now; a task of one that may not
       * stays as it is (queued, scheduled) and runs once the space may run again. */
      mayRun?: (owner: string) => Promise<boolean>;
      /** True while a deploy waits for the runs
       * in progress to end: no new run starts (nothing queued, scheduled or left behind by a
       * dead process); the runs in progress go on and settle; the heartbeat goes on. */
      draining?: () => boolean;
      /** A task's review whose window has ended with no
       * decision: the service sends it (or expires it, asked first). */
      reviewDue?: (owner: string, actionId: string) => Promise<unknown>;
      /** A repeating task queued with no wake time, that has never run: the next written
       * clock, or null to run it now. A time still ahead is stored and the run waits. */
      clockWake?: (owner: string, task: AgentTask) => Promise<string | null>;
      /** A run that failed (not a lost lease, not an
       * interruption) may be taken up again instead of failing its task: the service answers with
       * what to write (a standing task's retry with backoff, service.ts `standingRetry`), or null
       * to fail it as before. `claimed` is the task as this run claimed it, before any checkpoint. */
      failed?: (
        owner: string,
        claimed: AgentTask,
        error: unknown,
        leaseId: string,
      ) => Promise<Partial<AgentTask> | null>;
    } = {},
  ) {}
  /** Whether a deploy is draining the worker now (draining option). */
  get draining() {
    return this.options.draining?.() ?? false;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get running() {
    return Boolean(this.timer);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // Timer callbacks cannot await runs; each run owns its durable error state.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    while (this.inFlight.size || this.ticking) await new Promise((r) => setTimeout(r, 10));
  }
  abort(owner: string, taskId: string) {
    this.active.get(runKey(owner, taskId))?.abort();
  }
  async tick() {
    if (this.stopping) return;
    if (this.running)
      await this.db.put("system", "worker-status", {
        id: "tasks",
        lastTickAt: new Date(this.now()).toISOString(),
      });
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    const started: Promise<void>[] = [];
    try {
      // Draining for a deploy: start nothing; the runs in progress settle by themselves.
      if (this.draining) return;
      const records = await this.db.scan<AgentTask>("tasks");
      const due = records.filter(
        ({ owner, value: t }) =>
          !this.inFlight.has(runKey(owner, t.id)) &&
          (t.status === "queued" ||
            (t.status === "scheduled" && Date.parse(t.nextRunAt ?? "") <= this.now()) ||
            (t.status === "running" && Date.parse(t.leaseUntil ?? "") <= this.now()) ||
            t.status === "waiting_approval"),
      );
      const eligible = [];
      const mayRun = new Map<string, boolean>();
      for (const record of due) {
        if (this.inFlight.size + eligible.length >= 3) break;
        if (this.options.mayRun) {
          let may = mayRun.get(record.owner);
          if (may === undefined) {
            may = await this.options.mayRun(record.owner);
            mayRun.set(record.owner, may);
          }
          if (!may) continue;
        }
        if (
          record.value.status === "queued" &&
          record.value.repeatMinutes &&
          !record.value.nextRunAt &&
          Number(record.value.runs ?? 0) === 0 &&
          Number(record.value.resumes ?? 0) === 0 &&
          this.options.clockWake
        ) {
          const at = await this.options.clockWake(record.owner, record.value).catch(() => null);
          if (at && Date.parse(at) > this.now()) {
            const held = await this.db.compareAndSwap<AgentTask>(
              record.owner,
              "tasks",
              record.value.id,
              { status: "queued", leaseId: record.value.leaseId ?? null },
              {
                status: "scheduled",
                nextRunAt: at,
                updatedAt: new Date(this.now()).toISOString(),
              },
            );
            if (held) continue;
          }
        }
        if (record.value.status === "waiting_approval") {
          const action = record.value.actionId
            ? await this.db.get<{ status: string; expiresAt?: string }>(
                record.owner,
                "actions",
                record.value.actionId,
              )
            : null;
          if (
            record.value.actionId &&
            action?.status === "awaiting_review" &&
            Date.parse(action.expiresAt ?? "") <= this.now()
          ) {
            // Undeclined, it is sent (asked first: it
            // expires unsent); the run then goes on with the result.
            if (this.options.reviewDue)
              await this.options.reviewDue(record.owner, record.value.actionId).catch(() => {});
            else
              await this.db.compareAndSwap(
                record.owner,
                "actions",
                record.value.actionId,
                { status: "awaiting_review", expiresAt: action.expiresAt },
                { status: "expired" },
              );
            const settled = await this.db.get<{ status: string }>(
              record.owner,
              "actions",
              record.value.actionId,
            );
            if (settled && ["awaiting_review", "executing"].includes(settled.status)) continue;
          } else if (action && ["awaiting_review", "executing"].includes(action.status)) continue;
        }
        eligible.push(record);
      }
      // Runs outlive the tick, so a long task does not stop later ticks from starting queued work.
      for (const { owner, value } of eligible) {
        const key = runKey(owner, value.id);
        this.inFlight.add(key);
        started.push(this.run(owner, value).finally(() => this.inFlight.delete(key)));
      }
    } finally {
      this.ticking = false;
    }
    await Promise.all(started);
  }
  private async run(owner: string, previous: AgentTask) {
    if (this.stopping) return;
    const leaseId = randomUUID(),
      leaseMs = this.options.leaseMs ?? 60000;
    const expected: Record<string, unknown> = {
      status: previous.status,
      leaseId: previous.leaseId ?? null,
    };
    if (previous.status === "running") expected.leaseUntil = previous.leaseUntil;
    let task = await this.db.compareAndSwap<AgentTask>(owner, "tasks", previous.id, expected, {
      status: "running",
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempts: previous.attempts + 1,
    });
    if (!task) return;
    const claimed = task;
    const controller = new AbortController();
    this.active.set(runKey(owner, task.id), controller);
    const taskId = task.id;
    const guard = async () => {
      const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== "running")
        throw new LostLeaseError();
    };
    const checkpoint = async (patch: Partial<AgentTask>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const next = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        taskId,
        { leaseId, status: "running" },
        { ...patch, updatedAt: new Date(this.now()).toISOString() },
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "") => {
      await guard();
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        date: new Date(this.now()).toISOString(),
        kind,
        title,
        detail,
      });
    };
    const startedAt = new Date(this.now()).toISOString();
    const heartbeat = setInterval(
      () => {
        void this.db
          .compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
          )
          .then((value) => {
            if (!value) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        status: "running",
      });
      const result = await this.execute(owner, task, {
        signal: controller.signal,
        guard,
        checkpoint,
        event,
      });
      await checkpoint({ ...result, leaseId: null, leaseUntil: null });
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          { status: "queued", leaseId: null, leaseUntil: null },
        );
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        const retry = this.options.failed
          ? await this.options.failed(owner, claimed, error, leaseId).catch((failure) => {
              backgroundFailure("retry a failed run", failure);
              return null;
            })
          : null;
        if (retry)
          await this.db.compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            {
              ...retry,
              leaseId: null,
              leaseUntil: null,
              updatedAt: new Date(this.now()).toISOString(),
            },
          );
        else await this.fail(owner, taskId, leaseId, detail, event);
      }
      await this.db.compareAndSwap(
        owner,
        "runs",
        leaseId,
        { status: "running" },
        {
          status: controller.signal.aborted ? "interrupted" : "failed",
          finishedAt: new Date(this.now()).toISOString(),
        },
      );
    } finally {
      clearInterval(heartbeat);
      this.active.delete(runKey(owner, taskId));
    }
    const settled = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
  }
  /** The run failed for good: its task is `failed` with the error, and the timeline says so. */
  private async fail(
    owner: string,
    taskId: string,
    leaseId: string,
    detail: string,
    event: (kind: RunEvent["kind"], title: string, detail?: string) => Promise<void>,
  ) {
    await event("error", "Task needs attention", detail).catch((error) =>
      backgroundFailure("record task error", error),
    );
    await this.db.compareAndSwap(
      owner,
      "tasks",
      taskId,
      { leaseId, status: "running" },
      {
        status: "failed",
        error: detail,
        leaseId: null,
        leaseUntil: null,
        updatedAt: new Date(this.now()).toISOString(),
      },
    );
  }
}
