// The account's own settings (one record per space, under the space's real owner): the time
// zone routines' clock times use. Not per member, not per project.

import { spaceKeyOf } from "../../../packages/domain/src/projects.ts";
import { canonicalZone } from "../../../packages/domain/src/routines.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export const accountSettingsKind = "account-settings";

export interface AccountSettings {
  timezone: string | null;
}

/** The account's time zone, or null while it has none (or the stored one no longer parses). */
export async function readAccountZone(db: Store, scope: string): Promise<string | null> {
  const row = await db.get<{ id: string; timezone?: unknown }>(
    spaceKeyOf(scope),
    accountSettingsKind,
    "default",
  );
  return canonicalZone(row?.timezone);
}

/** Validates a PUT body: `{ timezone }` as an IANA zone name (400 otherwise). */
export function parseAccountSettings(body: unknown): { timezone: string } {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const timezone = canonicalZone(value.timezone);
  if (!timezone)
    throw new AppError(
      "timezone must be an IANA zone name, such as Asia/Shanghai or America/Los_Angeles",
      400,
    );
  return { timezone };
}

export async function saveAccountZone(
  db: Store,
  scope: string,
  timezone: string,
): Promise<AccountSettings> {
  await db.put(spaceKeyOf(scope), accountSettingsKind, { id: "default", timezone });
  return { timezone };
}
