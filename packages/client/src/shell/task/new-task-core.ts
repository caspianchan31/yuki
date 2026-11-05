/**
 * The fallback new-task form's checks and payload. The chat is the
 * normal way; this form exists to pin the account and the repeat interval exactly. It asks for
 * nothing else: pacing, voice and reporting are the task's own, decided from the account's
 * facts (owner's principle).
 *
 * POST /api/agent/tasks { prompt, kind: "agent", input: { environmentId }, repeatMinutes?,
 * typed: true } with a requestId that stays the same while the input does (a double tap or a
 * retry after a network error creates one task). `typed` tells the server the person wrote the
 * prompt, so the task detail says 「你写的」 (fork, report line).
 *
 * Pure: no react-native.
 */
import { parseRepeatMinutes } from "../../task-schedule-core.ts";
import { t } from "../strings.ts";

/** createTaskSchema caps the prompt at 12000 characters. */
export const promptMax = 12000;

/** The 每 [n] 分钟 field: whole minutes 1..10080, with Chinese errors for every case
 * parseRepeatMinutes refuses. */
export function readInterval(value: string): { minutes: number } | { error: string } {
  const trimmed = value.trim();
  const parsed = parseRepeatMinutes(trimmed, { allowEmpty: false });
  if (typeof parsed === "number") return { minutes: parsed };
  if (!trimmed) return { error: t.interval.required };
  if (!/^\d+$/.test(trimmed)) return { error: t.interval.whole };
  return { error: Number(trimmed) < 1 ? t.interval.tooSmall : t.interval.tooLarge };
}

export interface NewTaskDraft {
  what: string;
  environmentId: string | null;
  repeat: "once" | "every";
  minutes: string;
}

export interface NewTaskPayload {
  prompt: string;
  kind: "agent";
  input: { environmentId: string };
  repeatMinutes?: number;
  /** The person typed this prompt (not the chat). */
  typed: true;
}

export type NewTaskCheck =
  | { ok: true; payload: NewTaskPayload }
  | { ok: false; field: "what" | "account" | "minutes"; error: string };

/** The account preselected in the form: the one it was opened with when it is in this project,
 * else the first. */
export function initialAccount(
  accountIds: readonly string[],
  preferred: string | null | undefined,
): string | null {
  if (preferred && accountIds.includes(preferred)) return preferred;
  return accountIds[0] ?? null;
}

export function checkNewTask(draft: NewTaskDraft, accountIds: readonly string[]): NewTaskCheck {
  const prompt = draft.what.trim();
  if (!prompt) return { ok: false, field: "what", error: t.newTask.whatRequired };
  if (prompt.length > promptMax)
    return { ok: false, field: "what", error: t.newTask.tooLong(promptMax) };
  if (!accountIds.length) return { ok: false, field: "account", error: t.newTask.noAccounts };
  if (!draft.environmentId || !accountIds.includes(draft.environmentId))
    return { ok: false, field: "account", error: t.newTask.accountRequired };
  const payload: NewTaskPayload = {
    prompt,
    kind: "agent",
    input: { environmentId: draft.environmentId },
    typed: true,
  };
  if (draft.repeat === "every") {
    const interval = readInterval(draft.minutes);
    if ("error" in interval) return { ok: false, field: "minutes", error: interval.error };
    payload.repeatMinutes = interval.minutes;
  }
  return { ok: true, payload };
}

export interface Submission {
  input: string;
  id: string;
}
/** The request id for `payload`: the previous one while the input is the same, a new one once it
 * changed. */
export function submissionFor(
  previous: Submission | null,
  payload: NewTaskPayload,
  makeId: () => string = newRequestId,
): Submission {
  const input = JSON.stringify(payload);
  return previous?.input === input ? previous : { input, id: makeId() };
}

export function newRequestId(): string {
  return `newtask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
