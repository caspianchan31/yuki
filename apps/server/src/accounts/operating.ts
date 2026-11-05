// What the owner, the chat and the tasks do with an account's
// own records: its persona (two layers) and the owner's long-term goal. Nothing here asks anyone
// or waits.
import { createHash } from "node:crypto";
import {
  type AccountRecordBy,
  chatAccountGoalSchema,
  chatAccountPersonaSchema,
  ownerGoalSchema,
  ownerPersonaSchema,
  type PersonaFieldName,
  type PersonaFieldsInput,
  personaFact,
  setAccountPersonaSchema,
} from "../../../../packages/domain/src/accounts.ts";
import {
  type AgentTask,
  personaReportLabel,
  personaSetLabel,
} from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import { dutyBody } from "../../../../packages/domain/src/member-files.ts";
import type { AgentService } from "../engine/service.ts";
import type { TaskContext } from "../engine/worker.ts";
import { envOwner, isEnvironmentId } from "../environments.ts";
import { AppError } from "../errors.ts";
import { backgroundFailure } from "../log.ts";
import { currentActor } from "../request-actor.ts";
import {
  goalVersions,
  personaVersions,
  readGoal,
  readPersona,
  restorePersona,
  writeGoal,
  writePersona,
} from "./records.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
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

export class AccountOperating {
  constructor(private readonly service: AgentService) {}
  /** Her AGENTS.md keeps the words the persona and the goal were given in (the section named),
   * so what she reads first matches what the owner or her tasks wrote. A file that cannot be
   * written never fails the record. */
  private async keepInAgents(
    owner: string,
    record: Environment,
    heading: string,
    body: string,
    by: string,
  ) {
    try {
      const ref = await this.service.memberRef(owner, record.id);
      if (ref) await this.service.memberFiles.setSection(ref, heading, body, by);
    } catch (error) {
      backgroundFailure("keep the persona in AGENTS.md", error);
    }
  }
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
  /** Persona and goal of an account of the project, with their histories. */
  async view(owner: string, environmentId: string) {
    const record = await this.byId(owner, environmentId);
    const derived = envOwner(owner, record.id);
    const [persona, personaHistory, goal, goalHistory] = await Promise.all([
      readPersona(this.db, derived),
      personaVersions(this.db, derived),
      readGoal(this.db, derived),
      goalVersions(this.db, derived),
    ]);
    return {
      persona,
      personaVersions: personaHistory,
      goal: goal?.text ? goal : null,
      goalVersions: goalHistory,
    };
  }
  /** The persona fields sent, written in the owner's name (the account detail, or the chat
   * writing his words). */
  async ownerPersona(
    owner: string,
    record: Environment,
    fields: PersonaFieldsInput,
    by: AccountRecordBy,
    reason: string | null,
  ) {
    const result = await writePersona(this.db, envOwner(owner, record.id), {
      fields,
      source: "owner",
      by,
      reason,
    });
    if (result.version)
      await this.keepInAgents(owner, record, "职责", dutyBody(result.persona?.fields), "owner");
    return result;
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
  /** Sets or clears the owner's long-term goal (null or empty clears it). */
  async setGoal(owner: string, record: Environment, text: string | null, by: AccountRecordBy) {
    const { goal, changed } = await writeGoal(this.db, envOwner(owner, record.id), text, by);
    if (changed) await this.keepInAgents(owner, record, "长期目标", goal?.text ?? "", "owner");
    return { goal: goal?.text ? goal : null, changed };
  }
  /** PUT …/goal: the owner's own words; empty clears it. */
  async putGoal(owner: string, environmentId: string, raw: unknown) {
    const { text } = ownerGoalSchema.parse(raw);
    const record = await this.byId(owner, environmentId);
    await this.setGoal(owner, record, text, ownerBy());
    return this.view(owner, environmentId);
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
    const { goal, changed } = await this.setGoal(owner, record, input.text, ownerBy(userId));
    return {
      account: record.name,
      changed,
      goal: goal?.text ?? null,
    };
  }
  /** read_account: what the chat needs to know about one account of the project. */
  async chatRead(owner: string, account: string) {
    const record = await this.byName(owner, account);
    const derived = envOwner(owner, record.id);
    const [persona, goal] = await Promise.all([
      readPersona(this.db, derived),
      readGoal(this.db, derived),
    ]);
    return {
      account: record.name,
      accountLabel: record.accountLabel,
      persona: personaFact(persona),
      goal: goal?.text ?? null,
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
    if (result.version)
      await this.keepInAgents(owner, record, "职责", dutyBody(result.persona?.fields), record.name);
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
}
