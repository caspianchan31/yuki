// v1.2: when the primary key's quota is gone, runs use MODEL_FALLBACK and the owner is told once.
// The primary comes back by itself: at the reset the provider stated, or after an hour when it
// stated none (a balance or billing answer). The backup model's own key is the one that provider
// already reads from the environment.
import { providerQuotaPattern, quotaResetAt } from "../../../../packages/domain/src/agent.ts";

const retryPrimaryAfterMs = 60 * 60_000;

let backupUntil: number | null = null;

function onBackup(now: number): boolean {
  if (backupUntil !== null && now >= backupUntil) backupUntil = null;
  return backupUntil !== null;
}

export function isKeyExhausted(detail: string, now = Date.now()): boolean {
  return (
    providerQuotaPattern.test(detail) ||
    /usage quota/i.test(detail) ||
    quotaResetAt(detail, now) !== null
  );
}

export function resetKeyExhausted(): void {
  backupUntil = null;
}

/** True when this failure moves the runs to the backup. A backup already in force does not move
 * again, so its own quota failure takes the ordinary wait. */
export function takeBackup(
  message: string,
  fallback: string | undefined,
  now = Date.now(),
): boolean {
  if (!fallback?.trim() || !isKeyExhausted(message, now) || onBackup(now)) return false;
  const reset = quotaResetAt(message, now);
  backupUntil = reset ? Date.parse(reset) : now + retryPrimaryAfterMs;
  return true;
}

/** The model string in force: the backup until the primary is due back, when one is set. */
export function modelSpec(
  primary: string | undefined,
  fallback: string | undefined,
  now = Date.now(),
): string | undefined {
  const backup = fallback?.trim();
  if (backup && onBackup(now)) return backup;
  return primary;
}
