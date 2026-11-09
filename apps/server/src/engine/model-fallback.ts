// v1.2: when the primary key's quota is gone, runs use MODEL_FALLBACK and the owner is told once.
// The primary comes back by itself: at the reset the provider stated, or after an hour when it
// stated none (a balance or billing answer). The backup model's own key is the one that provider
// already reads from the environment.
// v1.7 模型兜底: the backup also takes over when the primary refuses the key (an hour) or does not
// answer at all (ten minutes): a 5xx, a relay's upstream failure, a connection that fails, a rate
// limit. The desktop, the browser or a proxy failing is never the model's doing and moves nothing.
import {
  modelFailureKind,
  providerQuotaPattern,
  quotaResetAt,
} from "../../../../packages/domain/src/agent.ts";

const retryPrimaryAfterMs = 60 * 60_000;
const retryPrimaryAfterOutageMs = 10 * 60_000;

export type BackupReason = "quota" | "auth" | "outage";
export interface BackupState {
  /** Whether runs use the backup now. */
  active: boolean;
  reason: BackupReason | null;
  /** When the primary is tried again (ISO), while active. */
  until: string | null;
  /** When the backup took over (ISO), while active. */
  since: string | null;
}

let backup: { until: number; since: number; reason: BackupReason } | null = null;

function onBackup(now: number): boolean {
  if (backup !== null && now >= backup.until) backup = null;
  return backup !== null;
}

/** The primary refused its key: not a quota, the key itself (wrong, revoked, expired). */
export function isKeyRefused(detail: string): boolean {
  return modelFailureKind(detail) === "auth";
}
/** The primary gave no usable answer: down, overloaded, unreachable, or rate limited (not a quota). */
export function isModelOutage(detail: string): boolean {
  return modelFailureKind(detail) === "outage";
}

export function isKeyExhausted(detail: string, now = Date.now()): boolean {
  return (
    providerQuotaPattern.test(detail) ||
    /usage quota/i.test(detail) ||
    quotaResetAt(detail, now) !== null
  );
}

export function resetKeyExhausted(): void {
  backup = null;
}

/** Why this failure would move the runs to the backup, or null when it would not. */
export function backupReason(message: string, now = Date.now()): BackupReason | null {
  if (isKeyExhausted(message, now)) return "quota";
  if (isKeyRefused(message)) return "auth";
  if (isModelOutage(message)) return "outage";
  return null;
}

/** True when this failure moves the runs to the backup. A backup already in force does not move
 * again, so its own failure takes the ordinary wait. */
export function takeBackup(
  message: string,
  fallback: string | undefined,
  now = Date.now(),
): boolean {
  if (!fallback?.trim() || onBackup(now)) return false;
  const reason = backupReason(message, now);
  if (!reason) return false;
  const reset = reason === "quota" ? quotaResetAt(message, now) : null;
  const until = reset
    ? Date.parse(reset)
    : now + (reason === "outage" ? retryPrimaryAfterOutageMs : retryPrimaryAfterMs);
  backup = { until, since: now, reason };
  return true;
}

/** The backup in force, for the page (v1.7 出错时页面直说). */
export function backupState(fallback: string | undefined, now = Date.now()): BackupState {
  if (!fallback?.trim() || !onBackup(now) || !backup)
    return { active: false, reason: null, until: null, since: null };
  return {
    active: true,
    reason: backup.reason,
    until: new Date(backup.until).toISOString(),
    since: new Date(backup.since).toISOString(),
  };
}

/** What the owner is told, by reason (the title) and the model it moved to. */
export function backupWords(
  reason: BackupReason,
  model: string,
  until: string | null,
): { title: string; text: string } {
  const back = until
    ? `，${new Date(until).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} 再试主模型`
    : "";
  const title =
    reason === "quota" ? "主钥匙额度用完" : reason === "auth" ? "主钥匙被拒绝" : "主模型不通";
  return { title, text: `已改用备用模型 ${model}${back}。` };
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
