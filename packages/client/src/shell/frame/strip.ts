/**
 * The pure model of the red worker-down bar (prototype downbar()). No
 * react-native, so node:test can pin it. (v0.8 ADHD pass: the status strip that lived here is
 * replaced by the 下一步 bar, focus-core.ts.)
 * Down bar: the worker's heartbeat is older than 45 s (「后台已停 3 分钟 · 最后心跳 14:44:02」), or the
 * API cannot be reached (「连不上服务器 · 正在重试」: both reads behind it are retried, App.tsx). It
 * is never a 需要你 number.
 * Infra notice: the project's runs the infrastructure keeps stopping, as ONE
 * system notice (「模型服务连不上（13:02 起）· 2 个任务受影响，会自己重试」) instead of a card per
 * run; a task whose runs failed `failedRunsBeforeOwner` times in a row (packages/domain/src/
 * standing.ts runTrouble) leads it with what keeps failing in the owner's words (「「X 的日常运营」
 * 连续 6 次没跑成：模型服务没返回内容 · 会自己重试」). It goes by itself once runs work again (the
 * incident is over, the failures in a row are reset). Never in 需要你: nobody but the operator
 * can act on it.
 */

import { systemIncidentKinds } from "../../../../../packages/domain/src/agent.ts";
import { runTrouble } from "../../../../../packages/domain/src/standing.ts";
import { clockLabel, durationLabel } from "../../../../../packages/domain/src/task-phase.ts";
import type { TaskEntry, WorkerHealth } from "../model.ts";
import { failureText, incidentWord, phaseWords, stoppedForWords, t } from "../strings.ts";

/** "14:44:02" (local time); "" for a missing or unreadable time. */
export function clockWithSeconds(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * The red bar's text, or null when there is nothing to say. The API being unreachable wins
 * (GET /api/agent, or GET /api/workspace); the worker counts as down only once /api/agent has
 * answered (`ready`), so a page that is still loading shows no bar.
 */
export function downBarText(input: {
  agentError: string;
  workspaceError?: string;
  ready: boolean;
  worker: WorkerHealth;
}): string | null {
  if (input.agentError || input.workspaceError) return t.downBar.apiDown;
  if (!input.ready || !input.worker.down) return null;
  if (input.worker.sinceMs === null) return t.downBar.neverSeen;
  return t.downBar.stopped(
    durationLabel(input.worker.sinceMs, stoppedForWords),
    clockWithSeconds(input.worker.lastTickAt),
  );
}

/** How long a system incident (`systemIncidentKinds`) stays on its task's line and account flag
 * only, before the project's notice shows it too: a short outage goes by itself unseen there. */
export const infraNoticeAfterMs = 30 * 60 * 1000;

/** The project's one infrastructure notice, or null. A task whose runs keep
 * failing (`runTrouble`) leads it: the one failing longest, its title, how many runs in a row and
 * why in the owner's words, and how many other tasks are held. Else every live task with an open
 * incident of the system it runs on (`systemIncidentKinds`: not a site's check, sign-in or rate
 * limit, which the task works around and its line shows) open for `infraNoticeAfterMs` counts
 * once; the parts that keep failing are named once each, oldest first, with when the oldest
 * began. */
export function infraNoticeText(entries: readonly TaskEntry[], now: Date | number): string | null {
  const at = typeof now === "number" ? now : now.getTime();
  const lasting = (incident: TaskEntry["phase"]["incident"]) =>
    !!incident &&
    systemIncidentKinds.has(incident.kind) &&
    at - Date.parse(incident.since) >= infraNoticeAfterMs;
  const live = entries.filter((entry) => !entry.phase.ended);
  const held = live.filter((entry) => lasting(entry.phase.incident) || runTrouble(entry.task));
  const troubled = live
    .map((entry) => ({ entry, trouble: runTrouble(entry.task) }))
    .filter(
      (item): item is { entry: TaskEntry; trouble: NonNullable<typeof item.trouble> } =>
        item.trouble !== null,
    )
    .sort((a, b) => a.trouble.since.localeCompare(b.trouble.since));
  const [first] = troubled;
  if (first)
    return t.infra.trouble(
      first.entry.task.title,
      first.trouble.count,
      failureText(first.trouble.detail.split("\n")[0] ?? ""),
      held.length - 1,
    );
  const open = live
    .flatMap((entry) =>
      entry.phase.incident && lasting(entry.phase.incident) ? [entry.phase.incident] : [],
    )
    .sort((a, b) => a.since.localeCompare(b.since));
  if (!open.length) return null;
  const parts = [...new Set(open.map((incident) => incidentWord(incident.kind)))];
  return t.infra.notice(parts.join("、"), clockLabel(open[0]?.since, now, phaseWords), open.length);
}
