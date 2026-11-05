/**
 * What the account detail shows of the account's own records
 * (GET /api/agent/accounts/:id): its persona (four parts, who set each and why, every version),
 * the owner's long-term goal and the operating plan. Pure functions: the server's answer read
 * defensively, and the lines in strings.ts words.
 */
import type {
  AccountRecordBy,
  PersonaFieldName,
} from "../../../../../packages/domain/src/accounts";
import { personaFieldNames } from "../../../../../packages/domain/src/accounts";
import type { OperatingPlan } from "../../../../../packages/domain/src/agent";
import { t } from "../strings";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

export interface PersonaPart {
  value: string;
  source: "owner" | "ai";
  reason: string | null;
}
export type PersonaParts = Record<PersonaFieldName, PersonaPart | null>;
export interface PersonaVersionView {
  version: number;
  parts: PersonaParts;
  source: "owner" | "ai";
  by: AccountRecordBy | null;
  reason: string | null;
  restoredFrom: number | null;
  at: string;
}
export interface AccountOperatingView {
  persona: { version: number; parts: PersonaParts } | null;
  personaVersions: PersonaVersionView[];
  goal: { text: string; setAt: string } | null;
  plan: OperatingPlan | null;
}

function partsOf(value: unknown): PersonaParts {
  const fields = record(value);
  return Object.fromEntries(
    personaFieldNames.map((name) => {
      const field = record(fields[name]);
      const text = str(field.value);
      return [
        name,
        text
          ? {
              value: text,
              source: field.source === "owner" ? "owner" : "ai",
              reason: str(field.reason),
            }
          : null,
      ];
    }),
  ) as PersonaParts;
}
function byOf(value: unknown): AccountRecordBy | null {
  const by = record(value);
  if (typeof by.taskId === "string") return { taskId: by.taskId, title: str(by.title) ?? "" };
  if ("userId" in by) return { userId: str(by.userId) };
  return null;
}
export function normalizeAccountOperating(payload: unknown): AccountOperatingView {
  const value = record(payload);
  const persona = record(value.persona);
  const parts = partsOf(persona.fields);
  const any = personaFieldNames.some((name) => parts[name]);
  const goal = record(value.goal);
  const plan = record(value.plan);
  return {
    persona: any ? { version: num(persona.version) ?? 0, parts } : null,
    personaVersions: (Array.isArray(value.personaVersions) ? value.personaVersions : [])
      .map((item) => {
        const entry = record(item);
        return {
          version: num(entry.version) ?? 0,
          parts: partsOf(entry.fields),
          source: entry.source === "owner" ? ("owner" as const) : ("ai" as const),
          by: byOf(entry.by),
          reason: str(entry.reason),
          restoredFrom: num(entry.restoredFrom),
          at: str(entry.at) ?? "",
        };
      })
      .sort((a, b) => b.version - a.version),
    goal: str(goal.text) ? { text: str(goal.text) as string, setAt: str(goal.setAt) ?? "" } : null,
    plan:
      Array.isArray(plan.communities) && num(plan.version) ? (value.plan as OperatingPlan) : null,
  };
}

/** 「你定的」 or 「AI 定的 · 理由」 beside a persona part. */
export function partSource(part: PersonaPart): string {
  return part.source === "owner" ? t.persona.byOwner : t.persona.byAi(part.reason);
}
/** Who wrote a version: 你改的 / 任务「…」写的 / 用回第 n 版. */
export function versionWho(version: PersonaVersionView): string {
  if (version.restoredFrom) return t.persona.restored(version.restoredFrom);
  if (version.by && "taskId" in version.by) return t.persona.byTask(version.by.title);
  return version.source === "owner" ? t.persona.byYou : t.persona.byAi(null);
}
/** The persona parts the owner changed in the editor: only those are sent (an unchanged part a
 * task wrote stays the task's), an emptied one as null (unset). */
export function personaChanges(
  current: PersonaParts | null,
  draft: Record<PersonaFieldName, string>,
): Partial<Record<PersonaFieldName, string | null>> {
  const changes: Partial<Record<PersonaFieldName, string | null>> = {};
  for (const name of personaFieldNames) {
    const before = current?.[name]?.value ?? "";
    const after = draft[name].trim();
    if (after !== before.trim()) changes[name] = after || null;
  }
  return changes;
}
