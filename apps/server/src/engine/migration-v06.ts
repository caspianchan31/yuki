// The move of production data to v0.6, run once at start
// (marker `system/migrations/v06`; every step is idempotent, so running it again changes nothing).
// 1. Deterministic: an account task that saved its own operating plan gives it to its account as
//    the account's plan v1 (an account that already has a plan keeps it). With several such tasks
//    on one account, the open one's plan, else the one set last. The tasks are left as they are.
// 2. AI: for each project with an open agent task on a live account (with a saved plan or not,
//    mid-run or waiting), one task moves what those tasks' own
//    prompts say (the persona, the long-term goal) onto their accounts in the owner's name and
//    hands each task to its account's loop (retire_task). It also sees how often the person had
//    each task repeat and an instruction of his no run read yet (retire_task passes that on).
//    Until an earlier task is handed over or ends, it keeps running as it did and no loop starts
//    beside it (AccountLoops.handoverPending): nothing is lost if the migration task fails or
//    never finishes.
import {
  type AgentTask,
  type OperatingPlan,
  operatingPlanOf,
} from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import { parseOwner, realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { writePlan } from "../accounts/records.ts";
import { envOwner, isEnvironmentId } from "../environments.ts";
import type { AgentService } from "./service.ts";

const markerOwner = "system";
const markerKind = "migrations";
const markerId = "v06";
const terminal = new Set(["succeeded", "failed", "cancelled"]);
export const migrationTaskTitle = "把号的人设和目标搬到号上";
/** The migration task of a project (its id is the hash of this key, as for every keyed task). */
export const migrationTaskKey = (scope: string) => `migration-v06:${scope}`;

interface Marker {
  id: string;
  status: "done";
  plans: number;
  projects: number;
  at: string;
}

export const readV06Marker = (service: Pick<AgentService, "db">) =>
  service.db.get<Marker>(markerOwner, markerKind, markerId);

/** Whether the task is bound to an account of its own project that is not being deleted. */
async function onLiveAccount(service: AgentService, owner: string, task: AgentTask) {
  const environmentId = task.input?.environmentId;
  if (typeof environmentId !== "string") return false;
  const record = await service.environments.find(owner, environmentId);
  return !!record && !record.deleting;
}

/** The account task's own plan, as the account's v1. Returns whether it wrote one. */
async function copyPlan(service: AgentService, owner: string, task: AgentTask) {
  const plan = operatingPlanOf(task.state);
  const environmentId = task.input?.environmentId;
  if (!plan || typeof environmentId !== "string" || !isEnvironmentId(environmentId)) return false;
  const record = await service.db.get<Environment>(
    realOwnerOf(owner),
    "environments",
    environmentId,
  );
  if (!record || record.deleting) return false;
  const { version: _version, setAt, ...input } = plan as OperatingPlan;
  const { written } = await writePlan(service.db, envOwner(owner, environmentId), input, task.id, {
    migratedFrom: task.id,
    setAt,
  });
  return written;
}

/** Whether `a`'s plan is the one its account keeps rather than `b`'s: an open task's over an
 * ended one's, else the one set last. */
function preferPlan(a: AgentTask, b: AgentTask) {
  const openA = !terminal.has(a.status);
  if (openA !== !terminal.has(b.status)) return openA;
  const at = (task: AgentTask) => operatingPlanOf(task.state)?.setAt ?? "";
  return at(a) > at(b);
}

/** Step 1 for every task, and step 2's task for each project with an open one. Skipped once the
 * marker is set. */
export async function runV06Migration(service: AgentService, options: { force?: boolean } = {}) {
  if (!options.force && (await readV06Marker(service))) return null;
  let plans = 0;
  const open = new Map<string, AgentTask[]>();
  // Per account, the task whose plan becomes its v1.
  const planned = new Map<string, { owner: string; task: AgentTask }>();
  for (const { owner, value } of await service.db.scan<AgentTask>("tasks")) {
    if (owner.includes("#") || value.input?.accountLoop || value.input?.migrationV06) continue;
    const environmentId = value.input?.environmentId;
    if (operatingPlanOf(value.state) && typeof environmentId === "string") {
      const key = `${realOwnerOf(owner)}:${environmentId}`;
      const chosen = planned.get(key);
      if (!chosen || preferPlan(value, chosen.task)) planned.set(key, { owner, task: value });
    }
    // Every open agent task on a live account, whatever its state holds: a repeating task's
    // state is reset at each run's start, and a task may never have saved a plan while its
    // prompt still says who the account is. The migration task reads them all and decides.
    if (
      value.kind === "agent" &&
      !terminal.has(value.status) &&
      (await onLiveAccount(service, owner, value))
    )
      open.set(owner, [...(open.get(owner) ?? []), value]);
  }
  for (const { owner, task } of planned.values()) if (await copyPlan(service, owner, task)) plans++;
  let projects = 0;
  for (const [owner, tasks] of open) {
    const records = (await service.environments.records(owner)).filter(
      (record) => !record.deleting,
    );
    const accounts = records.map((record) => ({
      name: record.name,
      accountLabel: record.accountLabel,
    }));
    const migration = await service.createTask(
      owner,
      {
        kind: "agent",
        title: migrationTaskTitle,
        prompt: "把这些号的人设和长期目标从原来的任务里搬到号上，然后让号自己的长期经营接手。",
        input: { migrationV06: true },
      },
      migrationTaskKey(owner),
      false,
      { roomChecked: true },
    );
    // The data the task works from, in its state: priorState shows it to every run.
    if (!migration.state.migration)
      await service.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        migration.id,
        { status: migration.status },
        {
          state: {
            ...migration.state,
            migration: {
              project: parseOwner(owner).projectId,
              accounts,
              tasks: tasks.map((task) => ({
                id: task.id,
                title: task.title,
                account:
                  records.find((record) => record.id === task.input?.environmentId)?.name ?? null,
                prompt: task.prompt,
                answers: typeof task.state.answer === "string" ? task.state.answer : null,
                // What the person set and has not been read yet: the interval he chose for a
                // repeating task, and an instruction no run read (retire_task passes it on).
                repeatMinutes: task.repeatMinutes ?? null,
                unreadInstruction: task.pendingAnswer?.trim() || null,
                plan: operatingPlanOf(task.state),
                status: task.status,
              })),
            },
          },
        },
      );
    projects++;
  }
  const marker: Marker = {
    id: markerId,
    status: "done",
    plans,
    projects,
    at: new Date().toISOString(),
  };
  await service.db.put(markerOwner, markerKind, marker);
  return marker;
}
