/**
 * Phase C (docs/web.md): who a report card says speaks and the source line under it, from
 * components/ReportCardGroup.tsx, so the phone's report cards and the web app's report blocks
 * name them the same way. Pure.
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import type { AccountModel, TaskEntry } from "../model.ts";
import { reportSource } from "./core.ts";

export interface Speaker {
  name: string;
  /** The round avatar's letter: the name's first character, upper-cased. */
  initial: string;
}
export function speakerInitial(name: string): string {
  const first = Array.from(name.trim().replace(/^[@#[(（【「]+/, ""))[0] ?? "";
  return first.toUpperCase();
}
/** Who speaks a chat report: the account the task runs on; null for a task on the default desktop
 * (the card stays as it was). */
export function reportSpeaker(account: { name: string } | null): Speaker | null {
  const name = account?.name.trim();
  return name ? { name, initial: speakerInitial(name) } : null;
}
/** The speaker a report names itself. */
export function reportSpeakerOf(report: { speaker?: { name: string } }): Speaker | null {
  const name = report.speaker?.name?.trim();
  return name ? { name, initial: speakerInitial(name) } : null;
}

/** The speaker (the account that speaks) and the source line under it: 「每日巡检」 (the account
 * is not named twice; empty for the account's own loop), or 「每日巡检 · 跑在默认桌面」 for an
 * unbound task (`reportSource`). */
export function reportCardSource(
  report: ChatReport,
  entry: TaskEntry | null,
  account: AccountModel | null,
): { speaker: Speaker | null; source: string } {
  const speaker = reportSpeaker(account) ?? reportSpeakerOf(report);
  const title = entry?.task.title ?? report.taskTitle;
  const source = reportSource(
    title,
    account,
    !account && !!entry && !entry.environmentId,
    speaker?.name ?? null,
  );
  return { speaker, source };
}
