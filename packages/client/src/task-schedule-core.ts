/**
 * Fork: repeating tasks and wait_until waits. Pure helpers (no react-native) for the schedule
 * field in the delegate form and the schedule and wait lines in task cards and details.
 */
import {
  type AgentTask,
  currentWait,
  repeatMinutesMax,
} from "../../../packages/domain/src/agent.ts";
import { runNoteView } from "./shell/strings.ts";

// A wait note's not-confirmed line, for the schedule lines.
export { currentWait, repeatMinutesMax, runNoteView };

/** Parses the "every N minutes" field: empty means run once (when allowed); otherwise 1..10080. */
export function parseRepeatMinutes(
  text: string,
  options: { allowEmpty?: boolean } = {},
): number | null | { error: string } {
  const allowEmpty = options.allowEmpty ?? true;
  const trimmed = text.trim();
  if (!trimmed)
    return allowEmpty
      ? null
      : { error: `Enter the minutes between runs, 1 to ${repeatMinutesMax} (7 days).` };
  const value = Number(trimmed);
  const tail = allowEmpty ? ", or leave it empty to run once" : "";
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(value))
    return { error: `Enter a whole number of minutes${tail}.` };
  if (value < 1) return { error: `Repeat at least every 1 minute${tail}.` };
  if (value > repeatMinutesMax)
    return { error: `Repeat at most every ${repeatMinutesMax} minutes (7 days)${tail}.` };
  return value;
}

/** "every 15 min", "every 2 h", "every 1 d 2 h". */
export function intervalLabel(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [
    days ? `${days} d` : "",
    hours ? `${hours} h` : "",
    rest || (!days && !hours) ? `${rest} min` : "",
  ].filter(Boolean);
  return `every ${parts.join(" ")}`;
}

/** The schedule summary for a task: null when it runs once. */
export function scheduleLabel(task: {
  repeatMinutes?: number | null;
  runs?: number;
  status: string;
  nextRunAt?: string;
}): string | null {
  if (!task.repeatMinutes || task.status === "cancelled") return null;
  const runs = task.runs ?? 0;
  const base = `Repeats ${intervalLabel(task.repeatMinutes)} · ${runs} ${runs === 1 ? "run" : "runs"} so far`;
  if (task.status === "scheduled" && task.nextRunAt)
    return `${base} · next ${new Date(task.nextRunAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  return base;
}

/** "Waiting · resumes 2:40 PM" for a task that paused itself, with the date
 * when it does not resume today; null when the task is not in a wait. */
export function waitLabel(
  task: Pick<AgentTask, "status" | "nextRunAt" | "state">,
  now = new Date(),
): string | null {
  const wait = currentWait(task);
  if (!wait) return null;
  const at = new Date(wait.until);
  const time = at.toLocaleString(
    undefined,
    at.toDateString() === now.toDateString()
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
  return `Waiting · resumes ${time}`;
}
