// What the owner, the chat and the tasks do with an account's
// own records: its persona (two layers), the owner's long-term goal (which keeps the account's
// loop running), the plan, the facts about the project's other accounts, and the v0.6 migration's
// hand-over of an earlier task to the account's loop. Nothing here asks anyone or waits.
import { createHash } from "node:crypto";
import {
  type AccountRecordBy,
  chatAccountGoalSchema,
  chatAccountPersonaSchema,
  checkLinkSchema,
  migrateGoalSchema,
  migratePersonaSchema,
  ownerGoalSchema,
  ownerPersonaSchema,
  type PersonaFieldName,
  type PersonaFieldsInput,
  personaFact,
  retireTaskSchema,
  setAccountPersonaSchema,
} from "../../../../packages/domain/src/accounts.ts";
import {
  type AgentTask,
  personaReportLabel,
  personaSetLabel,
  taskWait,
} from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import { siteOf } from "../credentials/site.ts";
import {
  type AccountAction,
  accountActionsKind,
  normalizeLink,
  readProfiles,
  recentWindowMs,
  siteOfRow,
} from "../engine/pacing.ts";
import type { AgentService } from "../engine/service.ts";
import type { TaskContext } from "../engine/worker.ts";
import { envOwner, isEnvironmentId } from "../environments.ts";
import { AppError } from "../errors.ts";
import { currentActor } from "../request-actor.ts";
import {
  goalVersions,
  personaVersions,
  planVersions,
  readGoal,
  readPersona,
  readPlan,
  restorePersona,
  writeGoal,
  writePersona,
} from "./records.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled"]);
/** The persona's parts as the owner reads them on a card. */
const fieldWords: Record<PersonaFieldName, string> = {
  who: "是谁",
  voice: "说话方式",
  background: "背景",
  boundaries: "不碰什么",
};
/** The member acting in this request, for a record the owner wrote. */
export const ownerBy = (userId?: string | null): AccountRecordBy => ({
  userId: userId ?? currentActor()?.userId ?? null,
});

/** One of the project's other accounts that a link or a user name belongs to. */
export interface SiblingMatch {
  name: string;
  kind: "interaction" | "same_target";
  link: string | null;
}

export class AccountOperating {
  constructor(private readonly service: AgentService) {}
  private get db() {
    return this.service.db;
  }
  /** A live account of `owner`'s project by id; 404 otherwise (another project's included). */
  private async byId(owner: string, environmentId: string) {
    return this.service.environments.get(owner, environmentId);
  }
  /** A live account of `owner`'s project as the chat names it (name, id, label, user name). */
  async byName(owner: string, account: string): Promise<Environment> {
    const found = await this.service.environments.findByNameOrId(owner, account);
    if (!found || found.deleting) {
      const names = (await this.service.environments.records(owner))
        .filter((record) => !record.deleting)
        .map((record) => record.name);
      throw new AppError(
        `No account named "${account}" in this project. Accounts: ${names.length ? names.join(", ") : "none"}`,
        404,
      );
    }
    return found;
  }
  /** Persona, goal and plan of an account of the project, with their histories. */
  async view(owner: string, environmentId: string) {
    const record = await this.byId(owner, environmentId);
    const derived = envOwner(owner, record.id);
    const [persona, personaHistory, goal, goalHistory, plan, planHistory] = await Promise.all([
      readPersona(this.db, derived),
      personaVersions(this.db, derived),
      readGoal(this.db, derived),
      goalVersions(this.db, derived),
      readPlan(this.db, derived),
      planVersions(this.db, derived),
    ]);
    return {
      persona,
      personaVersions: personaHistory,
      goal: goal?.text ? goal : null,
      goalVersions: goalHistory,
      plan,
      planVersions: planHistory,
    };
  }
  /** The persona fields sent, written in the owner's name (the account detail, or the chat
   * writing his words; the v0.6 migration writing what his own task prompt said). */
  async ownerPersona(
    owner: string,
    record: Environment,
    fields: PersonaFieldsInput,
    by: AccountRecordBy,
    reason: string | null,
    from?: { taskId: string; text: string },
  ) {
    return writePersona(this.db, envOwner(owner, record.id), {
      fields,
      source: "owner",
      by,
      reason,
      ...(from ? { from } : {}),
    });
  }
  /** PUT …/persona: the owner's own words; saved at once. */
  async putPersona(owner: string, environmentId: string, raw: unknown) {
    const { fields } = ownerPersonaSchema.parse(raw);
    const record = await this.byId(owner, environmentId);
    await this.ownerPersona(owner, record, fields, ownerBy(), null);
    return this.view(owner, environmentId);
  }
  /** POST …/persona/versions/:n/use: an earlier version, used again as the owner's. */
  async usePersonaVersion(owner: string, environmentId: string, version: number) {
    const record = await this.byId(owner, environmentId);
    const result = await restorePersona(this.db, envOwner(owner, record.id), version, ownerBy());
    if (!result) throw new AppError("Persona version not found", 404);
    return this.view(owner, environmentId);
  }
  /** Sets or clears the owner's long-term goal (null or empty clears it), then makes the
   * account's loop match. */
  async setGoal(
    owner: string,
    record: Environment,
    text: string | null,
    by: AccountRecordBy,
    from?: { taskId: string; text: string },
  ) {
    const { goal, changed } = await writeGoal(this.db, envOwner(owner, record.id), text, by, from);
    const loop = await this.service.loops.ensure(owner, record.id);
    return { goal: goal?.text ? goal : null, changed, loop };
  }
  /** PUT …/goal: the owner's own words; empty clears it. */
  async putGoal(owner: string, environmentId: string, raw: unknown) {
    const { text } = ownerGoalSchema.parse(raw);
    const record = await this.byId(owner, environmentId);
    await this.setGoal(owner, record, text, ownerBy());
    return this.view(owner, environmentId);
  }
  /** 停止经营 (Cancel on the loop): the goal is cleared and the jobs given to the account here
   * are no longer its; the loop then has nothing to work on. */
  async stopOperating(owner: string, environmentId: string) {
    const record = await this.service.environments.find(owner, environmentId);
    if (!record) return;
    await writeGoal(this.db, envOwner(owner, record.id), null, ownerBy());
    await this.service.loops.dropJobs?.(owner, record.id, "stopped");
  }

  // The chat's tools: on accounts of the chat's own project only.
  async chatSetPersona(owner: string, raw: unknown, userId?: string) {
    const input = chatAccountPersonaSchema.parse(raw);
    const record = await this.byName(owner, input.account);
    const result = await this.ownerPersona(
      owner,
      record,
      input.fields,
      ownerBy(userId),
      input.reason ?? null,
    );
    return {
      account: record.name,
      saved: result.version !== null,
      version: result.persona?.version ?? null,
      changed: result.changed,
      persona: personaFact(result.persona),
    };
  }
  async chatSetGoal(owner: string, raw: unknown, userId?: string) {
    const input = chatAccountGoalSchema.parse(raw);
    const record = await this.byName(owner, input.account);
    const { goal, changed, loop } = await this.setGoal(owner, record, input.text, ownerBy(userId));
    return {
      account: record.name,
      changed,
      goal: goal?.text ?? null,
      operating: loop ? { task: loop.title, running: !terminal.has(loop.status) } : null,
    };
  }
  /** The chat's pause_task / resume_task on an account: its operating
   * loop, under the owner the loop is kept by. */
  async chatLoop(owner: string, account: string) {
    const record = await this.byName(owner, account);
    const loop = await this.service.loops.of(owner, record.id);
    if (!loop) throw new AppError("This account has no operating loop", 404);
    return loop;
  }
  /** read_account: what the chat needs to know about one account of the project. */
  async chatRead(owner: string, account: string) {
    const record = await this.byName(owner, account);
    const derived = envOwner(owner, record.id);
    const [persona, goal, plan, rows, jobs] = await Promise.all([
      readPersona(this.db, derived),
      readGoal(this.db, derived),
      readPlan(this.db, derived),
      this.db.list<AccountAction>(derived, accountActionsKind),
      this.service.jobs.ofAccount(owner, record.id),
    ]);
    const since = Date.now() - recentWindowMs;
    return {
      account: record.name,
      accountLabel: record.accountLabel,
      persona: personaFact(persona),
      goal: goal?.text ?? null,
      plan,
      jobs,
      recentActions: rows
        .filter((row) => Date.parse(row.at) >= since)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((row) => ({
          site: row.site ?? null,
          action: row.action,
          permalink: row.permalink ?? null,
          target: row.target ?? null,
          at: row.at,
          ...(row.stranger ? { stranger: row.stranger } : {}),
        })),
    };
  }

  /** A task's set_account_persona on its own account: written as the AI's; a part the owner
   * wrote stays (`ownerLocked`). A change reaches the owner as a card, and nothing waits. */
  async taskSetPersona(owner: string, task: AgentTask, raw: unknown, context: TaskContext) {
    const input = setAccountPersonaSchema.parse(raw);
    const environmentId = task.input?.environmentId;
    if (typeof environmentId !== "string" || !isEnvironmentId(environmentId))
      throw new AppError("Only a task bound to an account sets its persona", 409);
    const record = await this.byId(owner, environmentId);
    await context.guard();
    const result = await writePersona(this.db, envOwner(owner, record.id), {
      fields: input.fields,
      source: "ai",
      by: { taskId: task.id, title: task.title },
      reason: input.reason,
    });
    const changed = result.changed.map((name) => fieldWords[name]).join("、");
    await context.event(
      "status",
      personaSetLabel,
      [
        result.version ? `v${result.version}: ${result.changed.join(", ")}` : "nothing written",
        `reason: ${input.reason}`,
        ...(result.ownerLocked.length
          ? [`set by the owner, left as they are: ${result.ownerLocked.join(", ")}`]
          : []),
      ].join("\n"),
    );
    if (result.version)
      await this.service.reports.enqueue(owner, task, {
        id: hash(`persona:${record.id}:${result.version}`),
        kind: "report",
        title: personaReportLabel(result.version),
        text: `${record.name} 的人设更新到第 ${result.version} 版：${changed}。${input.reason}`,
        links: [],
        // The client shows it as its own card, with 看看 on the account.
        notice: {
          kind: "persona",
          environmentId: record.id,
          account: record.name,
          changed: result.changed,
          reason: input.reason,
          version: result.version,
        },
      });
    return {
      saved: result.version !== null,
      version: result.persona?.version ?? null,
      changed: result.changed,
      ownerLocked: result.ownerLocked,
      persona: personaFact(result.persona),
    };
  }

  /** The other accounts of the task's project whose ledger holds `link`: as what they made (the
   * permalink) or what they acted on (the target). Every row the ledger keeps, not only recent. */
  async checkLink(owner: string, task: AgentTask, raw: unknown) {
    const { link } = checkLinkSchema.parse(raw);
    const environmentId = task.input?.environmentId;
    if (typeof environmentId !== "string" || !isEnvironmentId(environmentId))
      throw new AppError("Only a task bound to an account checks links against its siblings", 409);
    const wanted = normalizeLink(link);
    if (!wanted) throw new AppError("link must be a web address", 422);
    const found: { account: string; as: "made" | "acted_on"; action: string; at: string }[] = [];
    for (const sibling of await this.service.environments.siblings(envOwner(owner, environmentId)))
      for (const row of await this.db.list<AccountAction>(
        sibling.ledgerOwner,
        accountActionsKind,
      )) {
        if (row.permalink && normalizeLink(row.permalink) === wanted)
          found.push({ account: sibling.name, as: "made", action: row.action, at: row.at });
        else if (row.target && normalizeLink(row.target) === wanted)
          found.push({ account: sibling.name, as: "acted_on", action: row.action, at: row.at });
      }
    return { link: wanted, siblings: found };
  }
  /** What a reported action did to the project's other accounts (report_to_user): its target is
   * something a sibling made (`interaction`, with that link), else its target user is a sibling's
   * user name on that site (`interaction`); else its target is a place a sibling acted in too
   * (`same_target`). A saved login's user name counts on its own site; an account's name or
   * label (no site of its own) counts only on a site the sibling is known on (it acted there, or a
   * profile of it there is recorded), so a stranger who happens to share the name is not taken for
   * it. Links compare whole after `normalizeLink`, user names case-insensitively; nothing is
   * parsed. */
  async siblingRelation(
    ledgerOwner: string,
    site: string,
    target: string | null,
    targetUser: string | null,
  ): Promise<SiblingMatch | null> {
    if (!target && !targetUser) return null;
    const user = targetUser?.trim().toLowerCase() || null;
    const siblings = await Promise.all(
      (await this.service.environments.siblings(ledgerOwner)).map(async (sibling) => ({
        sibling,
        rows: await this.db.list<AccountAction>(sibling.ledgerOwner, accountActionsKind),
      })),
    );
    if (target)
      for (const { sibling, rows } of siblings)
        for (const row of rows)
          if (row.permalink && normalizeLink(row.permalink) === target)
            return { name: sibling.name, kind: "interaction", link: row.permalink };
    if (user)
      for (const { sibling, rows } of siblings) {
        const named = sibling.identities.filter(
          (identity) => identity.username.trim().toLowerCase() === user,
        );
        if (named.some((identity) => identity.site !== null && siteOf(identity.site) === site))
          return { name: sibling.name, kind: "interaction", link: null };
        if (
          named.some((identity) => identity.site === null) &&
          (rows.some((row) => siteOfRow(row) === site) ||
            !!(await readProfiles(this.db, sibling.ledgerOwner))[site])
        )
          return { name: sibling.name, kind: "interaction", link: null };
      }
    if (target)
      for (const { sibling, rows } of siblings)
        for (const row of rows)
          if (row.target && normalizeLink(row.target) === target)
            return { name: sibling.name, kind: "same_target", link: row.target };
    return null;
  }

  // The v0.6 migration task (docs/accounts.md §8): it moves what an earlier task's own
  // prompt says onto its account, in the owner's name, and hands the task to the account's loop.
  /** The earlier task the migration may take from: one of those listed in its data. */
  private async earlier(owner: string, migration: AgentTask, taskId: string) {
    const listed = (migration.state.migration as { tasks?: { id: string }[] } | undefined)?.tasks;
    if (!listed?.some((item) => item.id === taskId))
      throw new AppError("taskId must be one of the tasks listed in this migration's data", 422);
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async migratePersona(owner: string, migration: AgentTask, raw: unknown) {
    const input = migratePersonaSchema.parse(raw);
    const from = await this.earlier(owner, migration, input.fromTaskId);
    const record = await this.byName(owner, input.account);
    const result = await this.ownerPersona(
      owner,
      record,
      input.fields,
      { taskId: migration.id, title: migration.title },
      input.reason ?? null,
      { taskId: from.id, text: from.prompt },
    );
    return {
      account: record.name,
      saved: result.version !== null,
      changed: result.changed,
      persona: personaFact(result.persona),
    };
  }
  async migrateGoal(owner: string, migration: AgentTask, raw: unknown) {
    const input = migrateGoalSchema.parse(raw);
    const from = await this.earlier(owner, migration, input.fromTaskId);
    const record = await this.byName(owner, input.account);
    const { goal } = await writeGoal(
      this.db,
      envOwner(owner, record.id),
      input.text,
      { taskId: migration.id, title: migration.title },
      { taskId: from.id, text: from.prompt },
    );
    return { account: record.name, goal: goal?.text ?? null };
  }
  /** create_job in the migration task: an account whose earlier task is still open starts its
   * loop when retire_task hands that task over (at the time it was due), not now. */
  async migrateJob(owner: string, migration: AgentTask, raw: unknown) {
    const listed =
      (migration.state.migration as { tasks?: { id: string }[] } | undefined)?.tasks ?? [];
    const later = new Set<string>();
    for (const item of listed) {
      const task = await this.db.get<AgentTask>(owner, "tasks", item.id);
      const environmentId = task?.input?.environmentId;
      if (task && !terminal.has(task.status) && typeof environmentId === "string")
        later.add(environmentId);
    }
    return this.service.jobs.chatCreate(owner, raw, null, `migration:${migration.id}`, later);
  }
  /** retire_task: the earlier task ends (`已并入 <name> 的长期经营`) and its account's loop takes
   * over, starting when the earlier task was due (with its wait and progress record). Refused
   * while the account has neither a goal nor a job: the earlier task would end with nothing to
   * take its work over. */
  async retire(owner: string, migration: AgentTask, raw: unknown) {
    const { taskId } = retireTaskSchema.parse(raw);
    const task = await this.earlier(owner, migration, taskId);
    if (terminal.has(task.status)) return { retired: false, reason: "That task has already ended" };
    const environmentId = task.input?.environmentId;
    if (typeof environmentId !== "string" || !isEnvironmentId(environmentId))
      throw new AppError("That task is not on an account", 422);
    const record = await this.byId(owner, environmentId);
    const goal = await readGoal(this.db, envOwner(owner, record.id));
    if (!goal?.text && !(await this.service.loops.openJobs(owner, record.id)))
      throw new AppError(
        "Set the account's long-term goal or give it a job first; otherwise nothing takes this task's work over",
        409,
      );
    const wait = taskWait(task);
    const waiting = task.status === "scheduled" && task.nextRunAt;
    const start = waiting
      ? {
          nextRunAt: task.nextRunAt as string,
          state: {
            ...(wait ? { wait, runOpen: true } : {}),
            ...(typeof task.state.lastUpdate === "string"
              ? { lastUpdate: task.state.lastUpdate }
              : {}),
          },
        }
      : undefined;
    const loop = await this.service.loops.ensure(owner, record.id, {
      handover: true,
      ...(start ? { start } : {}),
    });
    if (!loop) throw new AppError("The account's loop could not be started", 409);
    const result = `已并入 ${record.name} 的长期经营`;
    await this.service.loops.end(owner, task, result, "Taken over by the account's loop");
    // Ended, it takes no more instructions: one it had not read yet goes to the loop.
    const pending = (await this.db.get<AgentTask>(owner, "tasks", task.id))?.pendingAnswer?.trim();
    const passed = pending
      ? await this.service.loops.passInstruction(owner, loop.id, pending)
      : false;
    return {
      retired: true,
      task: task.title,
      loop: loop.title,
      startsAt: loop.nextRunAt ?? null,
      ...(passed ? { instructionPassedOn: true } : {}),
    };
  }
}
