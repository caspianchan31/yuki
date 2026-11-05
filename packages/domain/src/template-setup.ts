// v1.2: picking a member template writes its persona, its goal (role, apps, and any routine
// the server cannot schedule), and one repeating task per routine that has an interval.

import { repeatMinutesMax } from "./agent.ts";
import type { MemberTemplate } from "./member-templates.ts";

export function repeatMinutesOfWhen(when: string): number | null {
  const text = when.trim();
  const hours = /^每\s*(\d+)\s*小时/.exec(text);
  if (hours) return within(Number(hours[1]) * 60);
  const minutes = /^每\s*(\d+)\s*分钟/.exec(text);
  if (minutes) return within(Number(minutes[1]));
  if (text.startsWith("每天")) return 24 * 60;
  if (text.startsWith("每周")) return 7 * 24 * 60;
  return null;
}

/** One routine as the new-member form shows it. One with no interval is kept in the goal. */
export function templateRoutineLine(
  routine: { title: string; when: string },
  timeZone = "",
): string {
  const title = routine.title.trim();
  const when = routine.when.trim();
  if (repeatMinutesOfWhen(when) === null) return `${title}（${when}，记在目标里）`;
  const clock =
    /^每天\s*\d{1,2}:\d{2}/.test(when) || /^每周[一二三四五六日]\s*\d{1,2}:\d{2}/.test(when);
  if (clock && !timeZone.trim()) return `${title}（${when}，填了时区才按这个钟点）`;
  return `${title}（${when}）`;
}

function within(minutes: number): number | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= repeatMinutesMax ? minutes : null;
}

export interface TemplateTaskBody {
  title: string;
  prompt: string;
  kind: "agent";
  input: { environmentId: string };
  repeatMinutes: number;
  /** The first wake, when the written clock and a time zone say so. */
  nextRunAt?: string;
}

export interface TemplateSetup {
  persona: { who: string; background: string };
  goal: string;
  tasks: TemplateTaskBody[];
}

const weekdayOf = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedClock(
  at: Date,
  timeZone: string,
): { hour: number; minute: number; day: number } | null {
  try {
    const bag = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    );
    const hour = Number(bag.hour);
    const minute = Number(bag.minute);
    const day = weekdayOf[bag.weekday as keyof typeof weekdayOf];
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || day === undefined) return null;
    return { hour: hour % 24, minute, day };
  } catch {
    return null;
  }
}

/** The next time `when` says, in `timeZone`. An interval with no clock ("每 4 小时") has none. */
export function nextClockRun(when: string, timeZone: string, now = new Date()): string | null {
  const zone = timeZone.trim();
  if (!zone) return null;
  const text = when.trim();
  const daily = /^每天\s*(\d{1,2}):(\d{2})/.exec(text);
  const weekly = /^每周([一二三四五六日])\s*(\d{1,2}):(\d{2})/.exec(text);
  const hour = Number(daily?.[1] ?? weekly?.[2]);
  const minute = Number(daily?.[2] ?? weekly?.[3]);
  if ((!daily && !weekly) || hour > 23 || minute > 59) return null;
  const wantDay = weekly ? "日一二三四五六".indexOf(weekly[1] ?? "") : null;
  if (wantDay === -1) return null;
  for (let step = 0; step <= 8 * 24 * 60; step++) {
    const at = new Date(now.getTime() + step * 60_000);
    const clock = zonedClock(at, zone);
    if (!clock) return null;
    if (
      clock.hour === hour &&
      clock.minute === minute &&
      (wantDay === null || clock.day === wantDay)
    )
      return at.toISOString();
  }
  return null;
}

/** A future first wake the HTTP task route may set. The chat tool has no such field. */
export function firstRunPlan(
  nextRunAt: string | undefined,
  now = Date.now(),
): { status: "scheduled"; nextRunAt: string } | null {
  const at = nextRunAt ? Date.parse(nextRunAt) : Number.NaN;
  if (!Number.isFinite(at) || at <= now + 60_000 || at > now + 8 * 24 * 60 * 60 * 1000) return null;
  return { status: "scheduled", nextRunAt: new Date(at).toISOString() };
}

/** What to save on the new member. Routines with no interval (来信才做、每月) stay in the goal. */
export function templateSetup(
  template: MemberTemplate,
  environmentId: string,
  timeZone = "",
): TemplateSetup {
  const tasks: TemplateTaskBody[] = [];
  const later: string[] = [];
  for (const routine of template.routines) {
    const repeatMinutes = repeatMinutesOfWhen(routine.when);
    if (repeatMinutes === null) {
      later.push(`${routine.title}（${routine.when}）：${routine.instruction}`);
      continue;
    }
    const nextRunAt = nextClockRun(routine.when, timeZone);
    tasks.push({
      title: routine.title,
      prompt: `${routine.instruction}\n什么时候：${routine.when}`,
      kind: "agent",
      input: { environmentId },
      repeatMinutes,
      ...(nextRunAt ? { nextRunAt } : {}),
    });
  }
  const goal = [
    template.role,
    template.apps.length ? `要连接：${template.apps.join("、")}` : "",
    ...later,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  return {
    persona: { who: template.role, background: template.persona },
    goal,
    tasks,
  };
}
