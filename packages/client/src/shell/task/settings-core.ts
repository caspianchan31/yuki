/**
 * The settings sheet's pure parts — the change-password checks with
 * Chinese errors (the server's rules: current password required, new one at least 8 characters),
 * the server's refusal in Chinese, the 后台 heartbeat line, and the identity body that flips only
 * 汇报卡显示在聊天里 (POST /api/agent/identity replaces the whole record, so name, tone and avatar
 * go back as they are).
 *
 * Pure: no react-native.
 */
import type { AgentIdentity } from "../../../../../packages/domain/src/agent.ts";
import { durationLabel } from "../../../../../packages/domain/src/task-phase.ts";
import { passwordMin, validPassword } from "../../session-core.ts";
import type { WorkerHealth } from "../model.ts";
import { stoppedForWords, t } from "../strings.ts";

export interface PasswordDraft {
  current: string;
  next: string;
  repeat: string;
}

export function checkPassword(
  draft: PasswordDraft,
): { ok: true; current: string; next: string } | { ok: false; error: string } {
  if (!draft.current) return { ok: false, error: t.settings.passwordMissing };
  const next = validPassword(draft.next);
  if (typeof next !== "string")
    return { ok: false, error: t.settings.passwordTooShort(passwordMin) };
  if (draft.repeat !== draft.next) return { ok: false, error: t.settings.passwordsDiffer };
  return { ok: true, current: draft.current, next };
}

/** The server's refusal of a password change, in Chinese: 403 wrong current password, 429 too
 * many tries, anything else with the server's own words. */
export function passwordErrorText(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : Number.NaN;
  if (status === 403) return t.settings.passwordWrong;
  if (status === 429) return t.settings.passwordTooMany;
  const detail = error instanceof Error ? error.message : String(error);
  return t.settings.passwordFailed(detail);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "14:46:58" in the device's time zone; "" for an unreadable time. */
export function clockSeconds(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 后台 ● 正常 · 最后心跳 14:46:58 / ● 已停 3 分钟 · 最后心跳 14:44:02 / 还没有心跳. */
export function workerLine(health: WorkerHealth): {
  state: "ok" | "down" | "unknown";
  text: string;
} {
  const clock = clockSeconds(health.lastTickAt);
  if (health.sinceMs === null || !clock)
    return { state: health.down ? "down" : "unknown", text: t.settings.workerUnknown };
  if (health.down)
    return {
      state: "down",
      text: t.settings.workerDown(durationLabel(health.sinceMs, stoppedForWords), clock),
    };
  return { state: "ok", text: t.settings.workerOk(clock) };
}

/** Whether reports show in the chat (the server's default is yes). */
export function showsChatUpdates(identity: AgentIdentity | undefined): boolean {
  return identity?.showChatUpdates !== false;
}

/** POST /api/agent/identity body that changes only showChatUpdates. */
export function identityPayload(
  identity: AgentIdentity | undefined,
  showChatUpdates: boolean,
): AgentIdentity {
  return {
    name: identity?.name?.trim() || t.app.name,
    tone: identity?.tone ?? "warm",
    ...(identity?.avatar ? { avatar: identity.avatar } : {}),
    showChatUpdates,
  };
}

/** 外观: follow the system, or force light or dark. */
export type Appearance = "system" | "light" | "dark";
export const appearanceChoices: readonly Appearance[] = ["system", "light", "dark"];
export const appearanceKey = "yuki.appearance";

/** Anything but "light" or "dark" follows the system. */
export function parseAppearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

/** The saved choice; an unreadable store (private window, blocked data) follows the system. */
export function readAppearance(storage: Pick<Storage, "getItem"> | null | undefined): Appearance {
  try {
    return parseAppearance(storage?.getItem(appearanceKey));
  } catch {
    return "system";
  }
}

/** Saves the choice ("system" clears it). False when the store refused. */
export function writeAppearance(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  value: Appearance,
): boolean {
  try {
    if (!storage) return false;
    if (value === "system") storage.removeItem(appearanceKey);
    else storage.setItem(appearanceKey, value);
    return true;
  } catch {
    return false;
  }
}

/** The `data-theme` value for the root element; null leaves the system's choice in force. */
export function themeAttribute(value: Appearance): "light" | "dark" | null {
  return value === "system" ? null : value;
}

/** The browser's own time zone, or null when it cannot say. */
export function browserZone(
  read: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  try {
    return read()?.trim() || null;
  } catch {
    return null;
  }
}
