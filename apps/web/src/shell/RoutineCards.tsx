/**
 * v1.4 routines (docs/routines.md「Member card」): one card per routine, with when it runs, 开着/停着,
 * 最近运行 (three, 展开 to twenty), its latest reports and 暂停/恢复 · 测试 · 修改 · 删除. A member's
 * card and Yuki's own (YukiDetail, the hall's routines) show the same cards.
 */

import { combineThreadReports, isHandoffNotice } from "@m/chat-reports-core";
import { useTaskActions } from "@m/shell/actions";
import { useShellData } from "@m/shell/data";
import {
  capReportTasks,
  clockNeedsZone,
  type DetailRoutine,
  loadedTaskReports,
  newestReportSentence,
  queuedClockWake,
  recentReportsFor,
  routineRunRows,
  routineSwitch,
  taskReportPollMs,
} from "@m/shell/members/member-detail";
import type { TaskEntry } from "@m/shell/model";
import { usePoll } from "@m/shell/poll";
import { phaseWords, reportLabel } from "@m/shell/strings";
import { useRef, useState } from "react";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { RoutineEditor } from "./RoutineEditor";

export function RoutineCards({
  routines,
  entries,
  projectId,
  timezone,
}: {
  routines: DetailRoutine[];
  /** The tasks behind them, for the status line. */
  entries: readonly TaskEntry[];
  /** The scope the routines are in (null = the space's own, the hall). */
  projectId: string | null;
  /** A member's time zone; undefined for Yuki's own (no account, no zone line). */
  timezone?: string | null;
}) {
  const data = useShellData();
  const actions = useTaskActions();
  const apiFor = data.apiFor;
  const routineKey = routines.map((routine) => routine.id).join("\n");
  const [hers, setHers] = useState<ChatReport[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  const reportTicket = useRef(0);
  const loadTaskReports = data.taskReports;
  usePoll(
    async () => {
      const ids = capReportTasks(routineKey.split("\n").filter(Boolean));
      const mine = ++reportTicket.current;
      if (!ids.length) {
        if (mine === reportTicket.current) setHers([]);
        return;
      }
      const pages = await Promise.all(ids.map((id) => loadTaskReports(id).catch(() => null)));
      const loaded = loadedTaskReports(pages);
      if (loaded && mine === reportTicket.current) setHers(loaded);
    },
    taskReportPollMs(capReportTasks(routineKey.split("\n").filter(Boolean)).length, 15000),
    routineKey.length > 0,
    routineKey,
  );
  const routineReports = combineThreadReports(data.reports.value, hers);
  const statusOf = new Map(
    entries.map((entry) => {
      const wake = queuedClockWake(entry.task, timezone, new Date(data.now));
      const label = wake ? `下次 ${clockLabel(wake, data.now, phaseWords)}` : entry.phase.label;
      return [entry.task.id, label];
    }),
  );
  return (
    <>
      {routines.map((routine) => (
        <div key={routine.id} className="member-card">
          <div className="lbl">{routine.title}</div>
          <div className="roster-line">
            {[routine.when, routine.on ? "开着" : "停着"].filter(Boolean).join(" · ")}
          </div>
          {timezone !== undefined && clockNeedsZone(routine.when, timezone) ? (
            <div className="roster-line">
              {routine.routine ? "没填时区，先按北京时间" : "填了时区才按这个钟点"}
            </div>
          ) : null}
          {routine.routine && editId === routine.id ? (
            <RoutineEditor
              task={{
                id: routine.id,
                title: routine.title,
                prompt: routine.prompt,
                routine: routine.routine,
              }}
              request={(path, body, method) => apiFor(projectId).request(path, body, method)}
              onDone={() => setEditId(null)}
            />
          ) : null}
          {statusOf.get(routine.id) ? (
            <div className="roster-line">{statusOf.get(routine.id)}</div>
          ) : null}
          {routine.routine
            ? (() => {
                const expanded = openRuns.has(routine.id);
                const { rows, more } = routineRunRows(routine.routine.history, expanded);
                if (rows.length === 0) return <div className="roster-line">还没有运行过</div>;
                return (
                  <>
                    <div className="roster-line">最近运行</div>
                    {rows.map((row) => (
                      <div key={row.key} className="roster-line">
                        {clockLabel(row.startedAt, data.now, phaseWords)}
                        {" · "}
                        {row.label}
                        {row.summary ? ` · ${row.summary}` : ""}
                      </div>
                    ))}
                    {more > 0 || expanded ? (
                      <button
                        type="button"
                        className="member-run quiet"
                        onClick={() =>
                          setOpenRuns((current) => {
                            const next = new Set(current);
                            if (!next.delete(routine.id)) next.add(routine.id);
                            return next;
                          })
                        }
                      >
                        {expanded ? "收起" : `展开（还有 ${more} 条）`}
                      </button>
                    ) : null}
                  </>
                );
              })()
            : null}
          {recentReportsFor(
            routineReports.filter((report) => !isHandoffNotice(report)),
            routine.id,
          ).map((report) => {
            const sentence = newestReportSentence([report], report.taskId);
            return (
              <div key={report.id} className="roster-line">
                {clockLabel(report.createdAt, data.now, phaseWords)}
                {" · "}
                {sentence || reportLabel(report.title)}
              </div>
            );
          })}
          <div className="member-actions">
            <button
              type="button"
              className="member-run quiet"
              disabled={actions.busy?.taskId === routine.id}
              onClick={() => void actions.control(routine.id, routineSwitch(routine.on))}
            >
              {routine.on ? "暂停" : "恢复"}
            </button>
            {routine.ready ? (
              <button
                type="button"
                className="member-run"
                disabled={actions.busy?.taskId === routine.id}
                onClick={() => void actions.control(routine.id, "run")}
              >
                测试
              </button>
            ) : null}
            {routine.routine && routine.editable ? (
              <button
                type="button"
                className="member-run quiet"
                onClick={() => setEditId(editId === routine.id ? null : routine.id)}
              >
                修改
              </button>
            ) : null}
            {confirmId === routine.id ? (
              <>
                <button
                  type="button"
                  className="member-run"
                  disabled={actions.busy?.taskId === routine.id}
                  onClick={() => {
                    setConfirmId(null);
                    void actions.control(routine.id, "cancel");
                  }}
                >
                  确定删除
                </button>
                <button
                  type="button"
                  className="member-run quiet"
                  onClick={() => setConfirmId(null)}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="member-run quiet"
                onClick={() => setConfirmId(routine.id)}
              >
                删除
              </button>
            )}
          </div>
        </div>
      ))}
      {actions.error ? <p className="err">{actions.error.message}</p> : null}
    </>
  );
}
