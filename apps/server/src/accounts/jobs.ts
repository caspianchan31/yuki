// The project's jobs (「活」). The chat makes one in the
// owner's words and gives it to the accounts it chooses (or the owner names, or everyone); each
// account's loop is woken at once and takes it inside its persona, or declines it with its reason
// (a fact the owner sees as a card: nothing waits for him). An account that finished it says so;
// a job every account it went to has finished, declined or left is done and archived. A job for
// everyone (「专号专用」) goes to accounts that join the project later too, and ends only when the
// owner ends it. Jobs live under the project's owner and go with the project.
import { createHash } from "node:crypto";
import type { AgentTask, ChatReportNotice } from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import {
  assignJobSchema,
  closeJobSchema,
  createJobSchema,
  type JobAction,
  type JobAssignee,
  type JobDropReason,
  type JobDue,
  type JobView,
  jobActiveStatuses,
  listJobsSchema,
  ownerJobAssignSchema,
  ownerJobCloseSchema,
  ownerJobPatchSchema,
  type ProjectJob,
  requestFounderSchema,
  requestProjectSchema,
  respondToJobSchema,
  updateJobSchema,
} from "../../../../packages/domain/src/jobs.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { mainThreadId } from "../chat/main-thread.ts";
import type { Store } from "../db.ts";
import { isAccountLoop } from "../engine/account-loop.ts";
import { type AccountAction, accountActionsKind } from "../engine/pacing.ts";
import type { AgentService } from "../engine/service.ts";
import type { TaskContext } from "../engine/worker.ts";
import { envOwner, isEnvironmentId } from "../environments.ts";
import { AppError } from "../errors.ts";
import { founderOf, projectNameOf, projectScopeByName, projectScopes } from "./founder.ts";
import { readGoal } from "./records.ts";

export const projectJobKind = "project-job";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const active = (assignee: JobAssignee) => jobActiveStatuses.includes(assignee.status);
/** Every account it went to finished, declined or left it, and at least one finished it. A job
 * for everyone never ends by itself: accounts that join later take it too. */
const finished = (job: ProjectJob) =>
  !job.everyone &&
  job.assignees.length > 0 &&
  job.assignees.every((item) => ["done", "declined", "dropped"].includes(item.status)) &&
  job.assignees.some((item) => item.status === "done");
/** A due the owner typed: his words, and the time when they are a plain date. */
export function ownerDue(text: string | null | undefined): JobDue | null {
  const value = text?.trim();
  if (!value) return null;
  const at = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : Number.NaN;
  return { text: value, at: Number.isNaN(at) ? null : new Date(at).toISOString() };
}
const dueOf = (due: { text: string; at?: string | null } | null | undefined): JobDue | null =>
  due ? { text: due.text, at: due.at ?? null } : null;

/** How many open jobs each account of `scope` is working on (given or taken): the chat's list of
 * accounts. */
export async function openJobCounts(db: Store, scope: string) {
  const counts: Record<string, number> = {};
  for (const job of await db.list<ProjectJob>(scope, projectJobKind))
    if (job.status === "open")
      for (const assignee of job.assignees)
        if (active(assignee)) counts[assignee.envId] = (counts[assignee.envId] ?? 0) + 1;
  return counts;
}

/** The task-like source of a job's card: the account's loop (or the system), in the conversation
 * the job was made in. */
type CardSource = Pick<AgentTask, "id" | "title" | "originThreadId">;

export class ProjectJobs {
  constructor(private readonly service: AgentService) {}
  private get db() {
    return this.service.db;
  }
  async list(scope: string) {
    return (await this.db.list<ProjectJob>(scope, projectJobKind)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
  async get(scope: string, id: string) {
    const job = await this.db.get<ProjectJob>(scope, projectJobKind, id);
    if (!job) throw new AppError("Job not found", 404);
    return job;
  }
  /** Applies `change` to the job and writes it when no other write came in between (again
   * until none did). `change` returns null to write nothing. */
  private async write(
    scope: string,
    id: string,
    change: (job: ProjectJob) => ProjectJob | null,
  ): Promise<{ job: ProjectJob; changed: boolean }> {
    for (;;) {
      const current = await this.get(scope, id);
      const next = change(structuredClone(current));
      if (!next) return { job: current, changed: false };
      const written = { ...next, version: current.version + 1, updatedAt: date() };
      const saved = await this.db.compareAndSwap<ProjectJob>(
        scope,
        projectJobKind,
        id,
        { version: current.version },
        written as unknown as Record<string, unknown>,
      );
      if (saved) return { job: saved, changed: true };
    }
  }
  /** The live accounts of `scope`'s project. */
  private async accounts(scope: string) {
    return (await this.service.environments.records(scope)).filter((record) => !record.deleting);
  }
  /** The project's accounts and, for naming, the space's founder (v0.8: any project may give it
   * jobs). */
  private async namedAccounts(scope: string) {
    const records = await this.accounts(scope);
    const founder = await founderOf(this.db, scope);
    return founder && !records.some((record) => record.id === founder.id)
      ? [...records, founder]
      : records;
  }
  /** v0.8: the project scope that keeps `jobId` for the founder's loop (its jobs are in every
   * project); `scope` itself for any other account. */
  async jobScope(scope: string, environmentId: string, jobId: string) {
    const founder = await founderOf(this.db, scope);
    if (founder?.id !== environmentId) return scope;
    for (const { scope: project } of await projectScopes(this.db, scope))
      if (await this.db.get<ProjectJob>(project, projectJobKind, jobId)) return project;
    return scope;
  }
  /** v0.8: the founder's open jobs in every project (what keeps its loop running). */
  async founderOpenCount(owner: string, environmentId: string) {
    let count = 0;
    for (const { scope } of await projectScopes(this.db, owner))
      count += (await openJobCounts(this.db, scope))[environmentId] ?? 0;
    return count;
  }
  /** v0.8: what the founder's loop reads: its open jobs in every project, each with its project
   * and the owner's rank for it. */
  async founderFacts(owner: string, environmentId: string, ranks: Map<string, number>) {
    const out: Record<string, unknown>[] = [];
    for (const { project, scope } of await projectScopes(this.db, owner))
      for (const fact of await this.factsFor(scope, environmentId))
        out.push({ ...fact, project: project.name, projectRank: ranks.get(project.id) ?? null });
    return out.sort(
      (a, b) =>
        Number(a.projectRank ?? Number.MAX_SAFE_INTEGER) -
        Number(b.projectRank ?? Number.MAX_SAFE_INTEGER),
    );
  }
  /** Jobs as the owner's screens read them: each account by its current name. */
  async views(scope: string, options: { briefOfArchived?: boolean } = {}): Promise<JobView[]> {
    const jobs = await this.list(scope);
    // Read with every /api/agent poll: the accounts only when there is a job to name them in.
    if (!jobs.length) return [];
    const records = await this.namedAccounts(scope);
    const names = new Map(records.map((record) => [record.id, record.name]));
    return jobs.map((job) => {
      const view = this.viewOf(job, names);
      return job.archivedAt && !options.briefOfArchived ? { ...view, brief: "" } : view;
    });
  }
  private viewOf(job: ProjectJob, names: Map<string, string>): JobView {
    return {
      ...job,
      assignees: job.assignees.map((item) => ({
        ...item,
        name: names.get(item.envId) ?? item.name,
        live: names.has(item.envId),
      })),
    };
  }
  async view(scope: string, job: ProjectJob) {
    const records = await this.namedAccounts(scope);
    return this.viewOf(job, new Map(records.map((record) => [record.id, record.name])));
  }
  /** One job with what its accounts reported doing for it (their ledger rows with its id). */
  async detail(scope: string, id: string) {
    const job = await this.get(scope, id);
    const real = realOwnerOf(scope);
    const actions: JobAction[] = [];
    for (const assignee of job.assignees)
      for (const row of await this.db.list<AccountAction>(
        envOwner(real, assignee.envId),
        accountActionsKind,
      ))
        if (row.jobId === job.id && row.projectOwner === scope)
          actions.push({
            account: assignee.name,
            environmentId: assignee.envId,
            site: row.site ?? null,
            action: row.action,
            permalink: row.permalink ?? null,
            target: row.target ?? null,
            at: row.at,
          });
    actions.sort((a, b) => b.at.localeCompare(a.at));
    return { job: await this.view(scope, job), actions };
  }

  /** How many open jobs the account works on in `scope` (keeps its loop running). */
  async openCount(scope: string, environmentId: string) {
    return (await openJobCounts(this.db, scope))[environmentId] ?? 0;
  }
  /** What the account's loop reads: the open jobs given to it or taken by it. */
  async factsFor(scope: string, environmentId: string) {
    const jobs = await this.list(scope);
    return jobs.flatMap((job) => {
      const own = job.assignees.find((item) => item.envId === environmentId);
      if (job.status !== "open" || !own || !active(own)) return [];
      return [
        {
          jobId: job.id,
          title: job.title,
          brief: job.brief,
          due: job.due,
          everyone: job.everyone,
          status: own.status,
          ...(own.ownerInsisted ? { ownerInsisted: true, yourEarlierReason: own.reason } : {}),
          otherAccounts: job.assignees
            .filter((item) => item.envId !== environmentId)
            .map((item) => ({ name: item.name, status: item.status })),
        },
      ];
    });
  }
  /** The account's jobs in `scope` for read_account: open ones and the ones it declined. */
  async ofAccount(scope: string, environmentId: string) {
    return (await this.list(scope)).flatMap((job) => {
      const own = job.assignees.find((item) => item.envId === environmentId);
      if (!own || job.archivedAt) return [];
      return [
        {
          jobId: job.id,
          title: job.title,
          due: job.due,
          status: own.status,
          ...(own.reason ? { reason: own.reason } : {}),
        },
      ];
    });
  }

  /** Wakes the account's loop (made if it has none) so it sees a job now. */
  private async wake(scope: string, environmentId: string, title: string, detail: string) {
    await this.service.loops.wake(scope, environmentId, title, detail);
  }
  /** Ends the account's loop when it has nothing left to work on. */
  private async follow(scope: string, environmentIds: string[]) {
    for (const id of new Set(environmentIds)) await this.service.loops.ensure(scope, id);
  }

  /** A new job, given to `to` (accounts of `scope`'s project) or to everyone. The same `id`
   * again (a retried chat turn) is the same job. `later`: accounts whose loop starts later (the
   * v0.6 migration hands each its earlier task's wait), so they are not woken now. */
  async create(
    scope: string,
    input: {
      title: string;
      brief: string;
      due: JobDue | null;
      to: Environment[] | "everyone";
      origin: ProjectJob["origin"];
      requestedBy?: string;
    },
    id: string,
    later: ReadonlySet<string> = new Set(),
  ) {
    const everyone = input.to === "everyone";
    let records = everyone ? await this.accounts(scope) : (input.to as Environment[]);
    // A job for everyone in a project with no account goes to the
    // space's founder, who takes it or declines it by its persona (before, it waited for a first
    // account that might never come, and the founder never heard of it).
    if (everyone && !records.length) records = await this.founderFor(scope);
    const at = date();
    const seen = new Set<string>();
    const assignees: JobAssignee[] = [];
    for (const record of records)
      if (!seen.has(record.id)) {
        seen.add(record.id);
        assignees.push({
          envId: record.id,
          name: record.name,
          status: "assigned",
          reason: null,
          note: null,
          ownerInsisted: false,
          at,
        });
      }
    const job: ProjectJob = {
      id,
      title: input.title,
      brief: input.brief,
      due: input.due,
      everyone,
      assignees,
      status: "open",
      origin: input.origin,
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      createdAt: at,
      updatedAt: at,
      doneAt: null,
      archivedAt: null,
      closedReason: null,
      version: 1,
    };
    const inserted = await this.db.insertIfAbsent(scope, projectJobKind, job);
    if (!inserted) return { job: await this.get(scope, id), created: false };
    for (const assignee of assignees)
      if (!later.has(assignee.envId)) await this.wake(scope, assignee.envId, "New job", job.title);
    await this.askInHall(
      scope,
      job,
      assignees.map((item) => item.envId),
    );
    return { job, created: true };
  }
  /** A project's job given to the founder is asked for in the hall, by that
   * project's 运营专员, so every request to the founder is seen in one place. Not for a job made
   * in the hall itself (its card there already asks), nor for one given by the space's own scope. */
  private async askInHall(scope: string, job: ProjectJob, given: string[]) {
    const project = await projectNameOf(this.db, scope);
    if (!project) return;
    const founder = await founderOf(this.db, scope);
    if (!founder || !given.includes(founder.id)) return;
    const hall = realOwnerOf(scope);
    const hallThread = await mainThreadId(this.db, hall);
    if (job.origin?.threadId === hallThread) return;
    await this.service.reports.enqueue(
      hall,
      { id: `job:${job.id}`, title: job.title, originThreadId: hallThread },
      {
        id: hash(`founder-request:${scope}:${job.id}:${job.version}:${founder.id}`),
        kind: "report",
        title: "Update",
        text: job.brief || job.title,
        links: [],
        notice: {
          kind: "founder_request",
          jobId: job.id,
          jobTitle: job.title,
          project,
          account: founder.name,
          environmentId: founder.id,
        },
      },
    );
  }
  /** The founder as the only taker of a project's job for everyone: in a project's own scope
   * (not the 营销总群), when the space has one; else nobody. */
  private async founderFor(scope: string): Promise<Environment[]> {
    if (!(await projectNameOf(this.db, scope))) return [];
    const founder = await founderOf(this.db, scope);
    return founder ? [founder] : [];
  }
  /** The founder takes the open jobs for everyone of the projects that have no
   * account (made before it was the founder, or before this rule), once each: its loop is checked
   * (`AccountLoops.adoptJobs`) and the 营销总群 shows the request. One it declined or left is not
   * taken again. */
  async adoptForFounder(owner: string, environmentId: string) {
    const founder = await founderOf(this.db, owner);
    if (!founder || founder.id !== environmentId) return;
    const at = date();
    for (const { scope } of await projectScopes(this.db, owner)) {
      if ((await this.accounts(scope)).length) continue;
      for (const listed of await this.list(scope)) {
        if (listed.status !== "open" || !listed.everyone) continue;
        if (listed.assignees.some((item) => item.envId === founder.id)) continue;
        const { job, changed } = await this.write(scope, listed.id, (job) => {
          if (job.status !== "open" || job.assignees.some((item) => item.envId === founder.id))
            return null;
          job.assignees.push({
            envId: founder.id,
            name: founder.name,
            status: "assigned",
            reason: null,
            note: null,
            ownerInsisted: false,
            at,
          });
          return job;
        });
        if (changed) await this.askInHall(scope, job, [founder.id]);
      }
    }
  }
  /** Request_founder, in a project's account loop or a task on its
   * default desktop. Production: no project had ever given the founder a job, because only the
   * owner naming it in the chat could. The project's work becomes a job given to the founder,
   * kept in this project (its cards in the task's conversation), asked for in the 营销总群 by
   * `create` (askInHall); the founder's loop is woken and takes it or declines it by its persona.
   * The same title from the same task is the same job, and so is any request of this task the
   * founder has not answered or finished yet (open, hers still assigned or taken): it is returned
   * as it stands, so a run that asks again in other words adds no job and no card in the hall. */
  async requestFounder(scope: string, task: AgentTask, raw: unknown) {
    const input = requestFounderSchema.parse(raw);
    if (!(await projectNameOf(this.db, scope)))
      throw new AppError("Only a project asks the founder for work", 409);
    const founder = await founderOf(this.db, scope);
    if (!founder) throw new AppError("This space has no founder", 409);
    if (task.input?.environmentId === founder.id)
      throw new AppError("The founder does not ask itself", 409);
    const pending = (await this.list(scope)).find(
      (job) =>
        job.status === "open" &&
        job.requestedBy === task.id &&
        job.assignees.some(
          (item) => item.envId === founder.id && jobActiveStatuses.includes(item.status),
        ),
    );
    const { job, created } = pending
      ? { job: pending, created: false }
      : await this.create(
          scope,
          {
            title: input.title,
            brief: input.brief,
            due: dueOf(input.due),
            to: [founder],
            origin: { threadId: task.originThreadId ?? null, userId: null },
            requestedBy: task.id,
          },
          hash(`job:${scope}:founder-request:${task.id}:${input.title}`),
        );
    const own = job.assignees.find((item) => item.envId === founder.id);
    return {
      jobId: job.id,
      title: job.title,
      founder: founder.name,
      created,
      // This task's request the founder has not answered or finished yet, as it stands.
      ...(pending ? { alreadyAsked: true } : {}),
      status: own?.status ?? null,
      ...(own?.reason ? { reason: own.reason } : {}),
    };
  }
  /** The founder's loop hands a piece of its
   * work to a project, the reverse of `requestFounder`. With accounts, it is a job for everyone in
   * that project (never the founder), taken or declined by each account's persona; a project with
   * no account carries it on its default desktop (its 运营专员 does it). The 营销总群 shows it,
   * said by the founder to the project's 运营专员. The same task's request to that project that is
   * still open is returned as it stands. */
  async requestProject(scope: string, task: AgentTask, raw: unknown) {
    const input = requestProjectSchema.parse(raw);
    const founder = await founderOf(this.db, scope);
    if (!founder || task.input?.environmentId !== founder.id)
      throw new AppError("Only the founder hands its work to a project", 409);
    const target = await projectScopeByName(this.db, scope, input.project);
    const project = (await projectNameOf(this.db, target)) ?? input.project;
    const hall = realOwnerOf(scope);
    const hallThread = await mainThreadId(this.db, hall);
    const accounts = (await this.accounts(target)).filter((record) => record.id !== founder.id);
    let jobId: string | null = null;
    let taskId: string | null = null;
    let created = true;
    let title = input.title;
    if (accounts.length) {
      const pending = (await this.list(target)).find(
        (job) => job.status === "open" && job.requestedBy === task.id,
      );
      const made = pending
        ? { job: pending, created: false }
        : await this.create(
            target,
            {
              title: input.title,
              brief: input.brief,
              due: dueOf(input.due),
              // Everyone: each account takes it or declines it by its persona, later ones too.
              to: "everyone",
              origin: { threadId: hallThread, userId: null },
              requestedBy: task.id,
            },
            hash(`job:${target}:project-request:${task.id}:${input.title}`),
          );
      jobId = made.job.id;
      created = made.created;
      title = made.job.title;
    } else {
      const made = await this.service.createTask(
        target,
        { kind: "agent", title: input.title, prompt: input.brief, input: { environmentId: null } },
        hash(`task:${target}:project-request:${task.id}:${input.title}`),
        false,
        {},
      );
      taskId = made.id;
      created = made.createdAt === made.updatedAt;
      title = made.title;
    }
    await this.service.reports.enqueue(
      hall,
      { id: `project-request:${jobId ?? taskId}`, title, originThreadId: hallThread },
      {
        id: hash(`project-request:${target}:${jobId ?? taskId}:${founder.id}`),
        kind: "report",
        title: "Update",
        text: input.brief,
        links: [],
        notice: {
          kind: "project_request",
          ...(jobId ? { jobId } : {}),
          jobTitle: title,
          project,
          account: founder.name,
          environmentId: founder.id,
        },
        speaker: { name: founder.name, founder: true },
      },
    );
    return {
      project,
      title,
      created,
      to: jobId ? ("accounts" as const) : ("default desktop" as const),
      ...(jobId ? { jobId, accounts: accounts.map((record) => record.name) } : { taskId }),
    };
  }
  /** Gives the job to `add` (one that declined it gets it again: the owner insists) and takes it
   * off `remove`. A finished job is opened first (`update` with reopen). */
  async assign(scope: string, id: string, add: Environment[], remove: string[]) {
    const at = date();
    const insisted: string[] = [];
    const { job } = await this.write(scope, id, (job) => {
      if (job.status !== "open")
        throw new AppError("This job is finished; open it again before giving it out", 409);
      for (const record of add) {
        const existing = job.assignees.find((item) => item.envId === record.id);
        if (!existing)
          job.assignees.push({
            envId: record.id,
            name: record.name,
            status: "assigned",
            reason: null,
            note: null,
            ownerInsisted: false,
            at,
          });
        else if (existing.status === "declined") {
          Object.assign(existing, { status: "assigned", ownerInsisted: true, at });
          insisted.push(record.name);
        } else if (existing.status === "done" || existing.status === "dropped") {
          Object.assign(existing, { status: "assigned", ownerInsisted: false, at });
          delete existing.dropped;
        }
      }
      for (const envId of remove) {
        const existing = job.assignees.find((item) => item.envId === envId);
        if (existing && existing.status !== "done" && existing.status !== "dropped")
          Object.assign(existing, { status: "dropped", dropped: "owner", at });
      }
      if (finished(job)) Object.assign(job, { status: "done", doneAt: at, archivedAt: at });
      return job;
    });
    for (const record of add) await this.wake(scope, record.id, "New job", job.title);
    await this.askInHall(
      scope,
      job,
      add.map((record) => record.id),
    );
    await this.follow(scope, remove);
    return { job, insisted };
  }
  /** Changes the job's words or due, or opens a finished one again (an everyone job then goes to
   * the project's accounts as they are now). Accounts working on it see the change at once. */
  async update(
    scope: string,
    id: string,
    patch: { title?: string; brief?: string; due?: JobDue | null; reopen?: boolean },
  ) {
    const records = patch.reopen ? await this.accounts(scope) : [];
    const at = date();
    const { job, changed } = await this.write(scope, id, (job) => {
      let changed = false;
      if (patch.title !== undefined && patch.title !== job.title) {
        job.title = patch.title;
        changed = true;
      }
      if (patch.brief !== undefined && patch.brief !== job.brief) {
        job.brief = patch.brief;
        changed = true;
      }
      if (patch.due !== undefined && JSON.stringify(patch.due) !== JSON.stringify(job.due)) {
        job.due = patch.due;
        changed = true;
      }
      if (patch.reopen && job.status === "done") {
        Object.assign(job, { status: "open", doneAt: null, archivedAt: null, closedReason: null });
        if (job.everyone)
          for (const record of records)
            if (!job.assignees.some((item) => item.envId === record.id))
              job.assignees.push({
                envId: record.id,
                name: record.name,
                status: "assigned",
                reason: null,
                note: null,
                ownerInsisted: false,
                at,
              });
        changed = true;
      }
      return changed ? job : null;
    });
    if (changed && job.status === "open")
      for (const assignee of job.assignees.filter(active))
        await this.wake(scope, assignee.envId, "Job changed", job.title);
    return job;
  }
  /** The owner ends the job: done and archived, whatever its accounts were doing. */
  async close(scope: string, id: string, reason: string | null) {
    const at = date();
    const { job } = await this.write(scope, id, (job) =>
      job.status === "done" && job.archivedAt
        ? null
        : Object.assign(job, {
            status: "done" as const,
            doneAt: job.doneAt ?? at,
            archivedAt: at,
            closedReason: reason,
          }),
    );
    await this.follow(
      scope,
      job.assignees.map((item) => item.envId),
    );
    return job;
  }
  /** The account no longer has the jobs it was given in `scope` (`hook` of the account loop):
   * the owner stopped its operating, it left the project, or it is deleted. */
  async drop(scope: string, environmentId: string, why: JobDropReason) {
    const at = date();
    for (const listed of await this.list(scope)) {
      if (listed.status !== "open") continue;
      const own = listed.assignees.find((item) => item.envId === environmentId);
      if (!own || own.status === "done" || own.status === "dropped") continue;
      const { job } = await this.write(scope, listed.id, (job) => {
        const entry = job.assignees.find((item) => item.envId === environmentId);
        if (
          job.status !== "open" ||
          !entry ||
          entry.status === "done" ||
          entry.status === "dropped"
        )
          return null;
        Object.assign(entry, { status: "dropped", dropped: why, at });
        if (finished(job)) Object.assign(job, { status: "done", doneAt: at, archivedAt: at });
        return job;
      });
      if (job.status === "done" && job.doneAt === at) await this.doneCard(scope, job, null);
    }
  }
  /** An account in `scope`'s project takes the open jobs given to everyone that it does not have
   * yet (a new account, or one back after it left): called whenever its loop is checked. */
  async adopt(scope: string, environmentId: string) {
    const record = (await this.accounts(scope)).find((item) => item.id === environmentId);
    if (!record) return;
    const at = date();
    for (const listed of await this.list(scope)) {
      if (listed.status !== "open" || !listed.everyone) continue;
      const own = listed.assignees.find((item) => item.envId === environmentId);
      const back =
        own?.status === "dropped" && (own.dropped === "moved" || own.dropped === "removed");
      if (own && !back) continue;
      await this.write(scope, listed.id, (job) => {
        if (job.status !== "open") return null;
        const entry = job.assignees.find((item) => item.envId === environmentId);
        if (!entry)
          job.assignees.push({
            envId: record.id,
            name: record.name,
            status: "assigned",
            reason: null,
            note: null,
            ownerInsisted: false,
            at,
          });
        else if (
          entry.status === "dropped" &&
          entry.dropped !== "owner" &&
          entry.dropped !== "stopped"
        ) {
          Object.assign(entry, { status: "assigned", name: record.name, at });
          delete entry.dropped;
        } else return null;
        return job;
      });
    }
  }

  /** respond_to_job in the account's own loop: take, decline (its reason reaches the owner as a
   * card, and nothing waits), done, or a note on progress. */
  async respond(scope: string, task: AgentTask, raw: unknown, context: TaskContext) {
    const input = respondToJobSchema.parse(raw);
    const environmentId = task.input?.environmentId;
    if (
      !isAccountLoop(task) ||
      typeof environmentId !== "string" ||
      !isEnvironmentId(environmentId)
    )
      throw new AppError("Only an account's own loop answers its jobs", 409);
    await context.guard();
    scope = await this.jobScope(scope, environmentId, input.jobId);
    const note = input.note?.trim() || null;
    const at = date();
    let name = "";
    // Taking a job the owner gave again after its reason: he reads that it took it.
    let tookInsisted = false;
    const { job } = await this.write(scope, input.jobId, (job) => {
      const own = job.assignees.find((item) => item.envId === environmentId);
      if (!own) throw new AppError("This job was not given to this account", 409);
      if (job.status !== "open") throw new AppError("This job is over", 409);
      if (own.status === "dropped") throw new AppError("This job is no longer this account's", 409);
      name = own.name;
      tookInsisted =
        (input.decision === "take" || input.decision === "progress") &&
        own.status === "assigned" &&
        own.ownerInsisted === true;
      switch (input.decision) {
        case "take":
          Object.assign(own, { status: "taken", note: note ?? own.note, at });
          break;
        case "decline":
          Object.assign(own, { status: "declined", reason: note, at });
          break;
        case "done":
          Object.assign(own, { status: "done", note: note ?? own.note, at });
          break;
        case "progress":
          Object.assign(own, {
            status: own.status === "assigned" ? "taken" : own.status,
            note: note ?? own.note,
            at,
          });
          break;
      }
      if (finished(job)) Object.assign(job, { status: "done", doneAt: at, archivedAt: at });
      return job;
    });
    const label = {
      take: "Job taken",
      decline: "Job declined",
      done: "Job done",
      progress: "Job progress",
    }[input.decision];
    await context.event("status", label, [job.title, ...(note ? [note] : [])].join("\n"));
    const source: CardSource = {
      id: task.id,
      title: task.title,
      originThreadId: job.origin?.threadId ?? null,
    };
    if (input.decision === "decline")
      await this.card(scope, source, `job-declined:${job.id}:${environmentId}:${job.version}`, {
        title: "Job declined",
        text: `${name} 没接「${job.title}」：${note}`,
        notice: {
          kind: "job_declined",
          jobId: job.id,
          jobTitle: job.title,
          environmentId,
          account: name,
          reason: note ?? "",
        },
      });
    if (tookInsisted)
      await this.card(scope, source, `job-taken:${job.id}:${environmentId}:${job.version}`, {
        title: "Job taken",
        text: `${name} 接了「${job.title}」`,
        notice: {
          kind: "job_taken",
          jobId: job.id,
          jobTitle: job.title,
          environmentId,
          account: name,
        },
      });
    if (job.status === "done" && job.doneAt === at) await this.doneCard(scope, job, source);
    const goal = (await readGoal(this.db, envOwner(realOwnerOf(scope), environmentId)))?.text;
    const left = await this.openCount(scope, environmentId);
    return {
      jobId: job.id,
      title: job.title,
      yourStatus: job.assignees.find((item) => item.envId === environmentId)?.status ?? null,
      jobStatus: job.status,
      ...(!goal && !left
        ? {
            nothingLeft: true,
            note: "This account has no long-term goal and no other job here: finish_task now ends its loop",
          }
        : {}),
    };
  }
  private async doneCard(scope: string, job: ProjectJob, source: CardSource | null) {
    await this.card(
      scope,
      source ?? {
        id: `job:${job.id}`,
        title: job.title,
        originThreadId: job.origin?.threadId ?? null,
      },
      `job-done:${job.id}:${job.doneAt}`,
      {
        title: "Job done",
        text: `「${job.title}」做完了，已归档。`,
        notice: { kind: "job_done", jobId: job.id, jobTitle: job.title },
      },
    );
  }
  private async card(
    scope: string,
    source: CardSource,
    key: string,
    value: { title: string; text: string; notice: ChatReportNotice },
  ) {
    await this.service.reports.enqueue(scope, source, {
      id: hash(key),
      kind: "report",
      title: value.title,
      text: value.text,
      links: [],
      notice: value.notice,
    });
  }

  // The chat's tools: on jobs and accounts of the chat's own project only.
  /** ["everyone"] (a model's spelling of the literal inside the list) means everyone, unless an
   * account of the project is called that. Seen with a real model. */
  private async meansEveryone(scope: string, names: string[] | "everyone") {
    if (names === "everyone" || names.length !== 1) return false;
    if (names[0].trim().toLowerCase() !== "everyone") return false;
    try {
      await this.service.accounts.byName(scope, names[0]);
      return false;
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return true;
      throw error;
    }
  }
  private async named(scope: string, names: string[]) {
    const records: Environment[] = [];
    const founder = await founderOf(this.db, scope);
    for (const name of names) {
      const wanted = name.trim().toLowerCase();
      if (
        founder &&
        (founder.name.toLowerCase() === wanted || wanted === "创始人" || wanted === "founder")
      ) {
        records.push(founder);
        continue;
      }
      records.push(await this.service.accounts.byName(scope, name));
    }
    return records;
  }
  private async chatView(scope: string, job: ProjectJob) {
    const view = await this.view(scope, job);
    return {
      jobId: view.id,
      title: view.title,
      brief: view.brief,
      due: view.due,
      everyone: view.everyone,
      status: view.status,
      archived: !!view.archivedAt,
      accounts: view.assignees.map((item) => ({
        name: item.name,
        status: item.status,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.ownerInsisted ? { ownerInsisted: true } : {}),
        ...(item.dropped ? { dropped: item.dropped } : {}),
      })),
    };
  }
  async chatCreate(
    scope: string,
    raw: unknown,
    origin: { threadId: string | null; userId: string | null } | null,
    key: string,
    later?: ReadonlySet<string>,
  ) {
    const input = createJobSchema.parse(raw);
    const to =
      input.assignees === "everyone" || (await this.meansEveryone(scope, input.assignees))
        ? "everyone"
        : await this.named(scope, input.assignees);
    if (to !== "everyone" && !to.length) throw new AppError("Name at least one account", 422);
    const { job, created } = await this.create(
      scope,
      { title: input.title, brief: input.brief, due: dueOf(input.due), to, origin },
      hash(`job:${scope}:${key}:${input.title}`),
      later,
    );
    return {
      ...(await this.chatView(scope, job)),
      created,
      // A job for everyone in a project with no account yet: the first account added takes it.
      ...(job.everyone && !job.assignees.length ? { waitsForFirstAccount: true } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }
  async chatAssign(scope: string, raw: unknown) {
    const input = assignJobSchema.parse(raw);
    const current = await this.get(scope, input.jobId);
    const add = await this.named(scope, input.add ?? []);
    const remove: string[] = [];
    for (const name of input.remove ?? []) {
      const wanted = name.trim().toLowerCase();
      const listed = current.assignees.find((item) => item.name.toLowerCase() === wanted);
      remove.push(listed ? listed.envId : (await this.service.accounts.byName(scope, name)).id);
    }
    const { job, insisted } = await this.assign(scope, input.jobId, add, remove);
    return { ...(await this.chatView(scope, job)), ...(insisted.length ? { insisted } : {}) };
  }
  async chatUpdate(scope: string, raw: unknown) {
    const input = updateJobSchema.parse(raw);
    const job = await this.update(scope, input.jobId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.due !== undefined ? { due: dueOf(input.due) } : {}),
      ...(input.reopen ? { reopen: true } : {}),
    });
    return this.chatView(scope, job);
  }
  async chatClose(scope: string, raw: unknown) {
    const input = closeJobSchema.parse(raw);
    return this.chatView(scope, await this.close(scope, input.jobId, input.reason));
  }
  async chatList(scope: string, raw: unknown) {
    const input = listJobsSchema.parse(raw ?? {});
    const jobs = (await this.list(scope)).filter((job) => input.archived || !job.archivedAt);
    return { jobs: await Promise.all(jobs.map((job) => this.chatView(scope, job))) };
  }

  // The owner's job panel (HTTP): accounts by id, of this project only.
  async ownerPatch(scope: string, id: string, raw: unknown) {
    const input = ownerJobPatchSchema.parse(raw);
    await this.update(scope, id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.due !== undefined ? { due: ownerDue(input.due) } : {}),
      ...(input.reopen ? { reopen: true } : {}),
    });
    return this.detail(scope, id);
  }
  async ownerAssign(scope: string, id: string, raw: unknown) {
    const input = ownerJobAssignSchema.parse(raw);
    const add: Environment[] = [];
    for (const envId of input.add ?? [])
      add.push(await this.service.environments.get(scope, envId));
    await this.assign(scope, id, add, input.remove ?? []);
    return this.detail(scope, id);
  }
  async ownerClose(scope: string, id: string, raw: unknown) {
    const input = ownerJobCloseSchema.parse(raw ?? {});
    await this.close(scope, id, input.reason?.trim() || null);
    return this.detail(scope, id);
  }
}
