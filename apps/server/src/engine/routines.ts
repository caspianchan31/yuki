// v1.4 routines (docs/routines.md): the triggers, the limit, the edit, the run history and the
// mail poll of a repeating agent task that carries a `routine`. The run itself is the repeating
// task's run (service.ts executeRepeating); nothing here asks a model to decide a flow.
import { randomUUID } from "node:crypto";
import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import { clipText } from "../../../../packages/domain/src/agent.ts";
import { spaceKeyOf } from "../../../../packages/domain/src/projects.ts";
import {
  type AuthBlock,
  advanceMailCursor,
  authBlockLine,
  authBlockOf,
  createRoutineSchema,
  isRoutine,
  mailIsNew,
  mailMatches,
  nextRoutineRun,
  pickRoutineZone,
  pushRoutineRun,
  type Routine,
  type RoutineMail,
  type RoutineTrigger,
  routineLimitSentence,
  routineRepeatMinutes,
  routinesPerMemberMax,
  updateRoutineSchema,
} from "../../../../packages/domain/src/routines.ts";
import { taskEnvironmentId } from "../../../../packages/domain/src/task-phase.ts";
import { readAccountZone } from "../account-settings.ts";
import { envOwner } from "../environments.ts";
import { AppError } from "../errors.ts";
import { backgroundFailure } from "../log.ts";
import type { AgentService } from "./service.ts";

const date = () => new Date().toISOString();
/** Statuses in which a routine is between runs; only then can it be edited. */
const editable = new Set(["scheduled", "paused", "failed", "succeeded"]);

export class Routines {
  private polling = false;
  constructor(private readonly service: AgentService) {}
  private get db() {
    return this.service.db;
  }

  /** The routines a member has that are not cancelled (an account's, or the main member's:
   * those without an environment in the scope). */
  async ofMember(owner: string, environmentId: string | null) {
    return (await this.db.list<AgentTask>(owner, "tasks")).filter(
      (task) =>
        isRoutine(task) &&
        task.status !== "cancelled" &&
        (taskEnvironmentId(task) ?? null) === environmentId,
    );
  }

  /** The time zone clock times use: the account's own setting, else the account's desktop
   * settings, else the project's default desktop, else `defaultRoutineZone`. */
  async zoneFor(owner: string, environmentId: string | null): Promise<string> {
    const account = await readAccountZone(this.db, owner).catch(() => null);
    if (account) return pickRoutineZone(account);
    const computers: Array<string | null> = [];
    for (const target of [environmentId, null]) {
      try {
        computers.push(
          (await this.service.computer.settings.view(target ? envOwner(owner, target) : owner))
            .timezone,
        );
      } catch {
        // An unreadable setting falls through to the next.
      }
    }
    return pickRoutineZone(...computers);
  }

  /** The next run of a routine, or null when it waits for mail (no clock). */
  async nextRun(owner: string, task: AgentTask, from = new Date()): Promise<string | null> {
    if (!isRoutine(task) || task.routine.trigger.type === "mail") return null;
    const trigger = task.routine.trigger;
    if (trigger.type === "every") return nextRoutineRun(trigger, "UTC", from);
    // A run that finishes at its clock minute must not fire again at once.
    const zone = await this.zoneFor(owner, taskEnvironmentId(task));
    return nextRoutineRun(trigger, zone, new Date(from.getTime() + 1000));
  }

  async create(
    owner: string,
    raw: unknown,
    options: { originThreadId?: string | null; createdBy?: string; idempotencyKey?: string } = {},
  ) {
    const input = createRoutineSchema.parse(raw);
    const environmentId = taskEnvironmentId(input);
    if ((await this.ofMember(owner, environmentId)).length >= routinesPerMemberMax)
      throw new AppError(routineLimitSentence, 409);
    const routine: Routine = {
      trigger: input.trigger,
      history: [],
      ...(input.trigger.type === "mail" ? { mail: { at: date(), ids: [] } } : {}),
    };
    const wakeAt =
      input.trigger.type === "daily" || input.trigger.type === "weekly"
        ? await this.nextRun(owner, { routine, input: input.input } as AgentTask)
        : null;
    return this.service.createTask(
      owner,
      {
        title: input.name,
        prompt: input.instruction,
        kind: "agent",
        input: input.input,
        repeatMinutes: routineRepeatMinutes(input.trigger),
      },
      options.idempotencyKey,
      false,
      {
        originThreadId: options.originThreadId,
        createdBy: options.createdBy,
        routine: { routine, wakeAt, idle: input.trigger.type === "mail" },
      },
    );
  }

  /** Changes a routine's name, instruction or trigger. It must be between runs. */
  async update(owner: string, id: string, raw: unknown) {
    const input = updateRoutineSchema.parse(raw);
    const task = await this.service.getTask(owner, id);
    if (!isRoutine(task)) throw new AppError("这不是一个例行", 422);
    if (task.status === "cancelled") throw new AppError("这个例行已经删除了", 409);
    if (!editable.has(task.status)) throw new AppError("这个例行正在跑，等这一轮结束再改", 409);
    const patch: Partial<AgentTask> = { updatedAt: date() };
    if (input.name) patch.title = input.name;
    if (input.instruction) patch.prompt = input.instruction;
    if (input.trigger) {
      const trigger = input.trigger;
      const kept = task.routine.mail;
      patch.routine = {
        ...task.routine,
        trigger,
        // A new mail trigger starts now; a changed filter keeps its place in the inbox.
        ...(trigger.type === "mail"
          ? { mail: task.routine.trigger.type === "mail" && kept ? kept : { at: date(), ids: [] } }
          : { mail: undefined }),
        sourceError: null,
      };
      patch.repeatMinutes = routineRepeatMinutes(trigger);
      if (task.status === "scheduled" || task.status === "succeeded") {
        patch.status = "scheduled";
        patch.nextRunAt =
          (await this.nextRun(owner, { ...task, routine: patch.routine })) ??
          (null as unknown as string);
      }
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status },
      patch,
    );
    if (!updated) throw new AppError("这个例行刚被改过，刷新后再试", 409);
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: "Routine edited",
      detail: "Changed by you",
    } satisfies RunEvent);
    return updated;
  }

  /** What resuming a paused routine writes: it waits for its next trigger instead of running
   * now (a routine made for 9:00 does not run at 14:00 because it was paused over lunch). */
  async resumePatch(owner: string, task: AgentTask): Promise<Partial<AgentTask>> {
    return {
      status: "scheduled",
      nextRunAt: (await this.nextRun(owner, task)) ?? (null as unknown as string),
    };
  }

  /** The record of a run that ended, written with the run's last write. */
  settle(
    task: AgentTask,
    status: "succeeded" | "failed",
    summary: string,
    extra: Pick<Routine, "authBlock"> | Record<string, never> = {},
  ): Partial<AgentTask> {
    if (!isRoutine(task)) return {};
    const { run: _run, ...input } = task.input;
    const startedAt =
      typeof task.state.runStartedAt === "string" ? task.state.runStartedAt : date();
    return {
      input,
      routine: {
        ...task.routine,
        ...extra,
        history: pushRoutineRun(task.routine.history, {
          startedAt,
          endedAt: date(),
          status,
          summary: clipText(summary.trim() || (status === "succeeded" ? "完成" : "失败"), 300),
          cause: typeof task.state.runCause === "string" ? task.state.runCause : "schedule",
        }),
      },
    };
  }

  /** What a run that met an app it cannot use does (docs/routines.md): the first time it is
   * recorded (the run's own failure report stands); the same app on the next run pauses the
   * routine. A run that met none clears the record. */
  authStep(task: AgentTask, block: AuthBlock | null) {
    if (!isRoutine(task)) return { authBlock: null, pause: false };
    if (!block) return { authBlock: null, pause: false };
    const pause = task.routine.authBlock?.app === block.app;
    return { authBlock: { ...block, at: date(), paused: pause }, pause };
  }

  /** The paused routine's patch: it stays off until the app is connected again, and the owner is
   * told once which app (the notice reaches the chat like any failure's). */
  pausedForAuth(
    task: AgentTask,
    block: AuthBlock,
    detail: string,
    state: Record<string, unknown> = task.state,
  ): Partial<AgentTask> {
    return {
      status: "paused",
      error: detail,
      nextRunAt: null as unknown as string,
      ...this.settle(task, "failed", detail, {
        authBlock: { ...block, at: date(), paused: true },
      }),
      state: {
        ...state,
        runOpen: false,
        notice: {
          title: `${task.title} 暂停了`,
          body: authBlockLine(task.title, block),
          key: `routine-auth:${task.id}:${block.app}:${task.runs ?? 0}`,
        },
      },
    };
  }

  /** An app was connected (docs/apps.md): the conversation that started it hears so, and each
   * routine paused for that app goes back to waiting for its trigger. */
  async appConnected(event: {
    space: string;
    owner: string;
    app: { id: string; name: string };
    originThreadId?: string | null;
  }) {
    const said = new Set<string>();
    const tell = async (
      owner: string,
      title: string,
      thread: string | null | undefined,
      text: string,
    ) => {
      const where = await this.service.reports.threadOf(owner, { originThreadId: thread });
      if (said.has(`${owner}:${where}`)) return;
      said.add(`${owner}:${where}`);
      await this.service.reports.enqueue(
        owner,
        { id: `app-connected:${event.app.id}`, title, originThreadId: thread },
        {
          id: `app-connected:${event.app.id}:${randomUUID()}`,
          kind: "outcome",
          title: "Connected",
          text,
          links: [],
        },
      );
    };
    if (event.originThreadId)
      await tell(event.owner, event.app.name, event.originThreadId, `${event.app.name} 连好了`);
    for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
      if (
        !isRoutine(value) ||
        value.status !== "paused" ||
        value.routine.authBlock?.app !== event.app.id ||
        spaceKeyOf(owner) !== event.space
      )
        continue;
      const resumed = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        value.id,
        { status: "paused" },
        {
          ...(await this.resumePatch(owner, value)),
          error: null,
          routine: { ...value.routine, authBlock: null, sourceError: null },
          state: { ...value.state, failures: 0, failureStreak: 0, notice: null },
          resumes: (value.resumes ?? 0) + 1,
          updatedAt: date(),
        },
      );
      if (resumed)
        await tell(
          owner,
          event.app.name,
          value.originThreadId,
          `${event.app.name} 连好了，「${value.title}」接着跑`,
        );
    }
  }

  /** The run's cause and the state a fresh run keeps for `settle`. */
  startState(task: AgentTask): Record<string, unknown> {
    // Any repeating task marks when its run began (a decline is final within it).
    if (!isRoutine(task)) return { runStartedAt: date() };
    const run = task.input.run as { cause?: unknown } | undefined;
    return {
      runStartedAt: date(),
      runCause: typeof run?.cause === "string" ? run.cause : "schedule",
    };
  }

  /** The run's mail, for the message the run reads. */
  mailOf(task: AgentTask): RoutineMail | null {
    const run = task.input?.run as { mail?: RoutineMail } | undefined;
    return run?.mail ?? null;
  }

  /** Looks at the inbox for each idle routine with a mail trigger and queues one run per new
   * matching message (oldest first; the next one waits for the next look). A source that cannot
   * be read records a failed run with the reason, once per reason, and fires nothing. */
  async pollMail() {
    if (this.polling) return;
    this.polling = true;
    try {
      const mine = (await this.db.scan<AgentTask>("tasks")).filter(
        ({ value }) =>
          value.status === "scheduled" && isRoutine(value) && value.routine.trigger.type === "mail",
      );
      const inbox = new Map<string, Promise<Awaited<ReturnType<typeof this.read>>>>();
      for (const { owner, value } of mine) {
        if ((await this.service.plan.refusal(owner)) !== null) continue;
        if (!inbox.has(owner)) inbox.set(owner, this.read(owner, value));
        await this.look(owner, value, (await inbox.get(owner)) as never).catch((error) =>
          backgroundFailure("look at a routine's inbox", error),
        );
      }
    } finally {
      this.polling = false;
    }
  }
  private async read(owner: string, task: AgentTask) {
    try {
      return {
        mail: await this.service.workspace.searchMail(owner, "", {
          type: "task",
          taskId: task.id,
          title: task.title,
          run: null,
        }),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "邮箱读不到" };
    }
  }
  private async look(owner: string, task: AgentTask, read: Awaited<ReturnType<Routines["read"]>>) {
    if (!isRoutine(task) || task.routine.trigger.type !== "mail") return;
    const trigger: Extract<RoutineTrigger, { type: "mail" }> = task.routine.trigger;
    const cursor = task.routine.mail ?? { at: task.createdAt, ids: [] };
    if ("error" in read) {
      const step = this.authStep(task, authBlockOf(read.error ?? ""));
      // The same refusal at the next look: stop looking, and say which app to connect.
      if (task.routine.sourceError === read.error) {
        const block = step.authBlock;
        if (step.pause && block)
          await this.db.compareAndSwap(
            owner,
            "tasks",
            task.id,
            { status: "scheduled" },
            this.pausedForAuth(task, block, read.error ?? ""),
          );
        return;
      }
      const failed = this.settle(
        { ...task, state: { ...task.state, runStartedAt: date(), runCause: "schedule" } },
        "failed",
        read.error ?? "邮箱读不到",
        { authBlock: step.authBlock },
      );
      await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "scheduled" },
        {
          routine: { ...(failed.routine as Routine), sourceError: read.error },
          error: read.error,
          updatedAt: date(),
        },
      );
      return;
    }
    const next = read.mail
      .filter((mail) => mailIsNew(cursor, mail) && mailMatches(trigger, mail))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
    const cleared = task.routine.sourceError ? { sourceError: null } : {};
    if (!next) {
      if (task.routine.sourceError)
        await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "scheduled" },
          { routine: { ...task.routine, ...cleared }, error: null, updatedAt: date() },
        );
      return;
    }
    const facts: RoutineMail = {
      id: next.id,
      from: next.sender ? `${next.sender} <${next.from}>` : next.from,
      subject: next.subject,
      date: next.date,
      snippet: next.body.slice(0, 240),
    };
    const queued = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { status: "scheduled" },
      {
        status: "queued",
        nextRunAt: date(),
        error: null,
        updatedAt: date(),
        routine: { ...task.routine, ...cleared, mail: advanceMailCursor(cursor, next) },
        input: { ...task.input, run: { cause: `mail:${next.id}`, mail: facts } },
      },
    );
    if (queued)
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: task.id,
        kind: "status",
        date: date(),
        title: "New mail",
        detail: `${facts.from}: ${facts.subject}`,
      } satisfies RunEvent);
  }
}
