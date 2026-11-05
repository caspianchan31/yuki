import type { Store } from "../db.ts";

// v1.2: one model turn's token counts; a count the provider did not report reads as 0.
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const modelUsageKind = "model-usage";
/** One account's tokens on one UTC day: `account-usage/<accountId>:<day>`. */
export const accountUsageKind = "account-usage";

// v1.2: one owner's usage on one UTC day on one model: `model-usage/<day>:<model>`.
export interface ModelUsageRecord extends ModelUsage {
  id: string;
  day: string;
  model: string;
  turns: number;
  updatedAt: string;
}

// v1.2: adds one model turn's counts to its owner's record for the UTC day of `at`.
export async function recordModelUsage(
  db: Store,
  owner: string,
  model: string,
  usage: ModelUsage,
  at = new Date(),
): Promise<ModelUsageRecord> {
  const day = at.toISOString().slice(0, 10);
  const id = `${day}:${model}`;
  const current = await db.get<ModelUsageRecord>(owner, modelUsageKind, id);
  const record: ModelUsageRecord = {
    id,
    day,
    model,
    turns: (current?.turns ?? 0) + 1,
    input: (current?.input ?? 0) + usage.input,
    output: (current?.output ?? 0) + usage.output,
    cacheRead: (current?.cacheRead ?? 0) + usage.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + usage.cacheWrite,
    updatedAt: at.toISOString(),
  };
  await db.put(owner, modelUsageKind, record);
  return record;
}

export interface AccountUsageRecord {
  id: string;
  day: string;
  accountId: string;
  input: number;
  output: number;
  turns: number;
  updatedAt: string;
}

/** Adds one model turn to that account's total for the UTC day of `at`. */
export async function recordAccountUsage(
  db: Store,
  owner: string,
  accountId: string,
  usage: ModelUsage,
  at = new Date(),
): Promise<AccountUsageRecord> {
  const day = at.toISOString().slice(0, 10);
  const id = `${accountId}:${day}`;
  const current = await db.get<AccountUsageRecord>(owner, accountUsageKind, id);
  const record: AccountUsageRecord = {
    id,
    day,
    accountId,
    input: (current?.input ?? 0) + usage.input,
    output: (current?.output ?? 0) + usage.output,
    turns: (current?.turns ?? 0) + 1,
    updatedAt: at.toISOString(),
  };
  await db.put(owner, accountUsageKind, record);
  return record;
}

/** USD per million tokens from an env value; null when unset or not a non-negative number. */
export function pricePerMillion(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Today's spend from token counts and the configured per-million prices. Null until both prices are set. */
export function usageCostUsd(
  input: number,
  output: number,
  usdPerMillionInput: number | null,
  usdPerMillionOutput: number | null,
): number | null {
  if (usdPerMillionInput == null || usdPerMillionOutput == null) return null;
  if (
    ![input, output, usdPerMillionInput, usdPerMillionOutput].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    return null;
  return (input * usdPerMillionInput + output * usdPerMillionOutput) / 1_000_000;
}

/** That account's total on one UTC day, or null when it has not called a model. */
export async function accountUsageOn(
  db: Store,
  owner: string,
  accountId: string,
  day: string,
): Promise<AccountUsageRecord | null> {
  return (await db.get<AccountUsageRecord>(owner, accountUsageKind, `${accountId}:${day}`)) ?? null;
}

// v1.2: the records of `owner` whose UTC day is within `fromDay`…`toDay` (inclusive),
// sorted by day then model.
export async function modelUsageOf(
  db: Store,
  owner: string,
  fromDay: string,
  toDay: string,
): Promise<ModelUsageRecord[]> {
  const rows = await db.list<ModelUsageRecord>(owner, modelUsageKind);
  return rows
    .filter((row) => row.day >= fromDay && row.day <= toDay)
    .sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}
