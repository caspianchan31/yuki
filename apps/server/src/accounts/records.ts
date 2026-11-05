// The account's own records, kept under its derived owner
// (`envOwner`), so they follow the account across tasks and projects and go only with it: its
// persona (two layers: what the owner wrote stays; what a task wrote the owner may change), the
// owner's long-term goal. Every change is a new version, kept for good.
// Writes are a compare-and-swap on the version, again until no other write came in between.
import type {
  AccountGoal,
  AccountGoalVersion,
  AccountPersona,
  AccountPersonaVersion,
  AccountRecordBy,
  PersonaFieldName,
  PersonaFields,
  PersonaFieldsInput,
} from "../../../../packages/domain/src/accounts.ts";
import { personaFieldNames } from "../../../../packages/domain/src/accounts.ts";
import type { Store } from "../db.ts";

export const accountPersonaKind = "account-persona";
export const accountPersonaVersionsKind = "account-persona-versions";
export const accountGoalKind = "account-goal";
export const accountGoalVersionsKind = "account-goal-versions";
/** Records written before v1.5 (the operating plan): nothing writes them any more, and they are
 * still removed with the account. */
export const accountPlanKind = "account-plan";
export const accountPlanVersionsKind = "account-plan-versions";
/** Every kind above: removed with the account. */
export const accountRecordKinds = [
  accountPersonaKind,
  accountPersonaVersionsKind,
  accountGoalKind,
  accountGoalVersionsKind,
  accountPlanKind,
  accountPlanVersionsKind,
] as const;

const versionId = (version: number) => `v${version}`;
const emptyFields = (): PersonaFields => ({
  who: null,
  voice: null,
  background: null,
  boundaries: null,
});

export function readPersona(db: Store, ledgerOwner: string) {
  return db.get<AccountPersona>(ledgerOwner, accountPersonaKind, "persona");
}
/** Newest first. */
export async function personaVersions(db: Store, ledgerOwner: string) {
  return (await db.list<AccountPersonaVersion>(ledgerOwner, accountPersonaVersionsKind)).sort(
    (a, b) => b.version - a.version,
  );
}

/** Replaces the record with `next` when its version is still `current`'s (or inserts the first);
 * false when another write came in between. */
async function swap<T extends { id: string; version: number }>(
  db: Store,
  ledgerOwner: string,
  kind: string,
  current: T | null,
  next: T,
) {
  if (!current) return !!(await db.insertIfAbsent(ledgerOwner, kind, next));
  return !!(await db.compareAndSwap(
    ledgerOwner,
    kind,
    next.id,
    { version: current.version },
    next as unknown as Record<string, unknown>,
  ));
}

export interface PersonaWrite {
  fields: PersonaFieldsInput;
  source: "owner" | "ai";
  by: AccountRecordBy;
  reason: string | null;
  from?: { taskId: string; text: string };
  restoredFrom?: number;
}
/** Writes the persona fields sent (null or empty unsets one). The owner writes any field; a task
 * never overwrites a field the owner wrote (`ownerLocked`). Only a field whose value changes makes
 * a new version; with none, nothing is written. */
export async function writePersona(db: Store, ledgerOwner: string, write: PersonaWrite) {
  for (;;) {
    const current = await readPersona(db, ledgerOwner);
    const fields: PersonaFields = { ...emptyFields(), ...(current?.fields ?? {}) };
    const changed: PersonaFieldName[] = [];
    const ownerLocked: PersonaFieldName[] = [];
    const setAt = new Date().toISOString();
    for (const name of personaFieldNames) {
      const sent = write.fields[name];
      if (sent === undefined) continue;
      const before = fields[name];
      if (write.source === "ai" && before?.source === "owner") {
        ownerLocked.push(name);
        continue;
      }
      const value = sent?.trim() ? sent.trim() : null;
      if ((before?.value ?? null) === value && (value === null || before?.source === write.source))
        continue;
      fields[name] = value
        ? { value, source: write.source, by: write.by, reason: write.reason, setAt }
        : null;
      changed.push(name);
    }
    if (!changed.length) return { persona: current, version: null, changed, ownerLocked };
    const version = (current?.version ?? 0) + 1;
    const next: AccountPersona = { id: "persona", fields, version, updatedAt: setAt };
    if (!(await swap(db, ledgerOwner, accountPersonaKind, current, next))) continue;
    await db.put<AccountPersonaVersion>(ledgerOwner, accountPersonaVersionsKind, {
      id: versionId(version),
      version,
      fields,
      changed,
      source: write.source,
      by: write.by,
      reason: write.reason,
      ...(write.from ? { from: write.from } : {}),
      ...(write.restoredFrom ? { restoredFrom: write.restoredFrom } : {}),
      at: setAt,
    });
    return { persona: next, version, changed, ownerLocked };
  }
}
/** The owner uses an earlier version again: its four parts become a new version, his own. */
export async function restorePersona(
  db: Store,
  ledgerOwner: string,
  version: number,
  by: AccountRecordBy,
) {
  const earlier = await db.get<AccountPersonaVersion>(
    ledgerOwner,
    accountPersonaVersionsKind,
    versionId(version),
  );
  if (!earlier) return null;
  const fields = Object.fromEntries(
    personaFieldNames.map((name) => [name, earlier.fields[name]?.value ?? null]),
  ) as PersonaFieldsInput;
  return writePersona(db, ledgerOwner, {
    fields,
    source: "owner",
    by,
    reason: null,
    restoredFrom: version,
  });
}

export function readGoal(db: Store, ledgerOwner: string) {
  return db.get<AccountGoal>(ledgerOwner, accountGoalKind, "goal");
}
export async function goalVersions(db: Store, ledgerOwner: string) {
  return (await db.list<AccountGoalVersion>(ledgerOwner, accountGoalVersionsKind)).sort(
    (a, b) => b.version - a.version,
  );
}
/** Sets (or, with null or empty text, clears) the owner's long-term goal for the account. The
 * same text again writes nothing. */
export async function writeGoal(
  db: Store,
  ledgerOwner: string,
  text: string | null,
  by: AccountRecordBy,
  from?: { taskId: string; text: string },
) {
  const value = text?.trim() ? text.trim() : null;
  for (;;) {
    const current = await readGoal(db, ledgerOwner);
    if ((current?.text ?? null) === value) return { goal: current, changed: false };
    const version = (current?.version ?? 0) + 1;
    const next: AccountGoal = {
      id: "goal",
      text: value,
      source: "owner",
      by,
      setAt: new Date().toISOString(),
      version,
      ...(from ? { from } : {}),
    };
    if (!(await swap(db, ledgerOwner, accountGoalKind, current, next))) continue;
    const { id: _, ...rest } = next;
    await db.put<AccountGoalVersion>(ledgerOwner, accountGoalVersionsKind, {
      ...rest,
      id: versionId(version),
    });
    return { goal: next, changed: true };
  }
}

/** Whether the account has a persona and a long-term goal: the chat's list of accounts. */
export async function accountFacts(db: Store, ledgerOwner: string) {
  const [persona, goal] = await Promise.all([
    readPersona(db, ledgerOwner),
    readGoal(db, ledgerOwner),
  ]);
  return {
    persona: !!persona && personaFieldNames.some((name) => !!persona.fields[name]),
    goal: !!goal?.text,
  };
}

/** Removed with the account (EnvironmentService.remove). */
export async function removeAccountRecords(db: Store, ledgerOwner: string) {
  for (const kind of accountRecordKinds)
    for (const row of await db.list<{ id: string }>(ledgerOwner, kind))
      await db.remove(ledgerOwner, kind, row.id);
}
