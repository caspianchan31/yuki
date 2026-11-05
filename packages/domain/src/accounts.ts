// What belongs to the account itself, whatever task or
// project it works in: its persona (who it is, how it speaks, its background, what it never
// touches), the owner's long-term goal for it and its operating plan. Each is kept under the
// account's derived owner with every version, so it follows the account across tasks and
// projects and goes only when the account is deleted. Only types and size bounds live here: the
// server judges no content.
import { z } from "zod";
import type { OperatingPlan } from "./agent.ts";

/** The persona's parts: who the account is, how it speaks, its background (only what holds up)
 * and what it never says or touches. */
export const personaFieldNames = ["who", "voice", "background", "boundaries"] as const;
export type PersonaFieldName = (typeof personaFieldNames)[number];
/** The same order of size as the plan's 口径. */
export const personaTextMax = 1500;
export const accountGoalMax = 4000;
export const personaReasonMax = 600;

/** Who wrote a persona field or a goal: a member of the space (null for one the server could not
 * name), or a task. */
export type AccountRecordBy = { userId: string | null } | { taskId: string; title: string };
export interface PersonaField {
  value: string;
  /** `owner`: written by the owner (the account detail, or the chat writing his words); the AI
   * never overwrites it. `ai`: written by a task; the owner may change it at any time. */
  source: "owner" | "ai";
  by: AccountRecordBy;
  reason: string | null;
  setAt: string;
}
export type PersonaFields = Record<PersonaFieldName, PersonaField | null>;
/** `account-persona/persona` under the derived owner. A field never written is null: unset. */
export interface AccountPersona {
  id: "persona";
  fields: PersonaFields;
  version: number;
  updatedAt: string;
}
/** `account-persona-versions/v<n>`: the whole persona after each change. */
export interface AccountPersonaVersion {
  id: string;
  version: number;
  fields: PersonaFields;
  changed: PersonaFieldName[];
  source: "owner" | "ai";
  by: AccountRecordBy;
  reason: string | null;
  /** A version written from a task's own prompt (the v0.6 migration): that prompt as it was. */
  from?: { taskId: string; text: string };
  /** The version the owner chose to use again. */
  restoredFrom?: number;
  at: string;
}
/** `account-goal/goal`: the owner's long-term goal for the account, in his words. Only the owner
 * sets or clears it; null text is a cleared goal. */
export interface AccountGoal {
  id: "goal";
  text: string | null;
  source: "owner";
  by: AccountRecordBy;
  setAt: string;
  version: number;
  from?: { taskId: string; text: string };
}
export interface AccountGoalVersion extends Omit<AccountGoal, "id"> {
  id: string;
}
/** `account-plan/plan`: the account's operating plan, one version line per account (it does not
 * start again with a new task). */
export interface AccountPlan extends OperatingPlan {
  id: "plan";
  /** The task that saved it. */
  taskId: string;
  /** Copied from that task's own plan by the v0.6 migration. */
  migratedFrom?: string;
}
export interface AccountPlanVersion extends Omit<AccountPlan, "id"> {
  id: string;
}

const personaText = (what: string) =>
  z.string().trim().max(personaTextMax).nullable().optional().describe(what);
/** A change of persona fields: an omitted field stays as it is; null or empty unsets it. */
export const personaFieldsSchema = z
  .object({
    who: personaText("Who the account is"),
    voice: personaText("How it speaks"),
    background: personaText("Its background and history: only what holds up"),
    boundaries: personaText("What it never says, claims or touches"),
  })
  .refine(
    (fields) => personaFieldNames.some((name) => fields[name] !== undefined),
    "fields needs at least one part of the persona",
  );
export type PersonaFieldsInput = z.output<typeof personaFieldsSchema>;
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(personaReasonMax)
  .describe("Why, for the owner: what this comes from");
/** A task's set_account_persona: the account is the task's own. */
export const setAccountPersonaSchema = z.object({
  fields: personaFieldsSchema,
  reason: reasonSchema,
});
/** Which account the chat means: a name, label or saved user name of this project (several
 * tools share it, so the tools' own descriptions say what it is). */
export const accountRefSchema = z.string().trim().min(1).max(200);
/** The chat's set_account_persona: the owner's words about an account of this project. */
export const chatAccountPersonaSchema = z.object({
  account: accountRefSchema,
  fields: personaFieldsSchema,
  reason: reasonSchema.optional(),
});
/** The chat's set_account_goal: the owner's long-term goal for an account, in his words. */
export const chatAccountGoalSchema = z.object({
  account: accountRefSchema,
  text: z
    .string()
    .trim()
    .max(accountGoalMax)
    .describe("The owner's long-term goal for the account, in his words; empty clears it"),
});
export const readAccountSchema = z.object({ account: accountRefSchema });
/** check_link: whether a link is something another account of the project made or acted on. */
export const checkLinkSchema = z.object({
  link: z.string().trim().min(1).max(2048).describe("The address to look up"),
});
/** The v0.6 migration task's tools: what an earlier task's own prompt says, moved onto its
 * account in the owner's name (the prompt is the owner's text, kept with the version). */
export const migratePersonaSchema = chatAccountPersonaSchema.extend({
  fromTaskId: z.string().trim().min(1).max(200).describe("The earlier task this comes from"),
});
export const migrateGoalSchema = chatAccountGoalSchema.extend({
  fromTaskId: z.string().trim().min(1).max(200).describe("The earlier task this comes from"),
});
export const retireTaskSchema = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The earlier task the account's loop takes over"),
});
/** PUT …/persona from the account detail (the owner's own words). */
export const ownerPersonaSchema = z.object({ fields: personaFieldsSchema });
/** PUT …/goal from the account detail; empty clears it. */
export const ownerGoalSchema = z.object({ text: z.string().trim().max(accountGoalMax) });

/** The persona as a run reads it: each part's value and who set it; null when nothing is set. */
export type PersonaFact = { version: number } & Record<
  PersonaFieldName,
  { value: string; source: "owner" | "ai" } | null
>;
export function personaFact(persona: AccountPersona | null): PersonaFact | null {
  if (!persona || personaFieldNames.every((name) => !persona.fields[name])) return null;
  const parts = Object.fromEntries(
    personaFieldNames.map((name) => {
      const field = persona.fields[name];
      return [name, field ? { value: field.value, source: field.source } : null];
    }),
  ) as Record<PersonaFieldName, { value: string; source: "owner" | "ai" } | null>;
  return { version: persona.version, ...parts };
}
