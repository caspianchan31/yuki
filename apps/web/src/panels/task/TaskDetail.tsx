/**
 * Phase C (docs/web.md): one task, from shell/task/TaskDetail.tsx. Header title + ⋯ (改间隔 /
 * 停止重复 / 取消任务 with a confirm); pill + phase line; 账号 (light, name, 看桌面 — or
 * 「跑在默认桌面」 when the task is not bound to an account: a marker, never a block); 节奏; only
 * the phase's buttons; the middle by phase (等待 / 现在在做 / 排期 / 已暂停 / the need card for a
 * question, a review or a failure / 结果); 运营计划 v{n} when the task carries one; 本任务汇报;
 * folded 计划 n/m, 任务规则 (the prompt), 时间线 (GET /api/agent/tasks/:id events).
 *
 * It only presents what the task already is: no step here asks for an approval, and the buttons
 * are the existing control / PATCH endpoints (useTaskActions).
 */

import { ApiError } from "@m/api-response";
import { type ControlAction, useTaskActions } from "@m/shell/actions";
import { pollMs, useShellData } from "@m/shell/data";
import { operatingPlanOf, type TaskOp } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { useThrottled } from "@m/shell/poll";
import { humanizeKey } from "@m/shell/results/artifact-core";
import { phaseWords, t } from "@m/shell/strings";
import {
  accountLine,
  detailActions,
  detailEntry,
  type MenuOp,
  mergeReports,
  middleBlocks,
  needsForTask,
  normalizeTaskDetail,
  operatingPlanBlock,
  planBlock,
  receiptLine,
  reportLines,
  rhythmLine,
  rulesHint,
  type TaskDetailPayload,
  taskMenu,
  timelineLines,
} from "@m/shell/task/detail-core";
import { readInterval } from "@m/shell/task/new-task-core";
import { useWorkspace } from "@m/workspace";
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ChatReport } from "../../../../../packages/domain/src/agent";
import { firstLine, rhythmLabel } from "../../../../../packages/domain/src/task-phase";
import { Btn, cx, ErrorLine, Field, IconBtn, Section, Sheet, Skeleton } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { errorText, Fold, KV, ReceiptLine, StatusPill } from "./parts";
import { TaskNeed } from "./TaskNeed";

export function TaskDetailPanel({ panel, onClose }: PanelProps<"task">) {
  const { taskId } = panel;
  const nav = useShellNav();
  const { api, notify } = useWorkspace();
  const shell = useShellData();
  const { now, accountById, accounts, needs, taskReports } = shell;
  const actions = useTaskActions();
  const live = shell.entryById.get(taskId);

  // GET /api/agent/tasks/:id: the events and artifacts, and the task itself when it is not in
  // the polled list; read again whenever the polled task changes.
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notFound, setNotFound] = useState(false);
  // At most one re-read per 15 s however often the task checkpoints (the rail's report pace).
  const liveUpdatedAt = useThrottled(live?.task.updatedAt, pollMs.reports);
  useEffect(() => {
    void liveUpdatedAt;
    let active = true;
    api
      .request<unknown>(`/api/agent/tasks/${encodeURIComponent(taskId)}`)
      .then((payload) => {
        if (!active) return;
        const next = normalizeTaskDetail(payload);
        setDetail(next);
        setNotFound(!next);
        setLoadError("");
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setLoadError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, liveUpdatedAt]);

  // 本任务汇报: N2 with taskId, merged with the rail's project-wide copy (an older server that
  // refuses a missing threadId leaves only that copy).
  const projectReports = useMemo(
    () => shell.reports.value.filter((report) => report.taskId === taskId),
    [shell.reports.value, taskId],
  );
  const newestProjectReport = projectReports[0]?.id ?? "";
  const [ownReports, setOwnReports] = useState<ChatReport[]>([]);
  const [reportsPartial, setReportsPartial] = useState(false);
  useEffect(() => {
    void liveUpdatedAt;
    void newestProjectReport;
    let active = true;
    taskReports(taskId)
      .then((list) => {
        if (!active) return;
        setOwnReports(list.filter((report) => report.taskId === taskId));
        setReportsPartial(false);
      })
      .catch(() => {
        if (active) setReportsPartial(true);
      });
    return () => {
      active = false;
    };
  }, [taskReports, taskId, liveUpdatedAt, newestProjectReport]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [interval, setIntervalText] = useState("");
  const [intervalError, setIntervalError] = useState("");

  const entry = detailEntry(live, detail?.task, now, shell.stalled);
  const task = entry?.task;
  const busy = actions.busy?.taskId === taskId ? actions.busy.action : null;
  const actionError = actions.error?.taskId === taskId ? actions.error.message : "";

  const openEditor = useCallback(() => {
    setIntervalText(String(task?.repeatMinutes ?? 60));
    setIntervalError("");
    setConfirmCancel(false);
    setEditing(true);
  }, [task?.repeatMinutes]);

  const control = async (action: ControlAction, inWait = false) => {
    const ok = await actions.control(taskId, action, { inWait });
    if (!ok) return;
    const words = t.tasksRail;
    notify(
      action === "pause"
        ? words.paused_toast
        : action === "resume"
          ? words.resumed_toast
          : action === "run"
            ? inWait
              ? words.continued
              : words.ranNow
            : action === "retry"
              ? t.needs.receiptRetried
              : t.taskDetail.cancelled,
    );
  };

  const stopRepeating = async () => {
    if (await actions.setRepeat(taskId, null)) notify(t.taskDetail.repeatStopped);
  };

  const pressAction = (op: TaskOp) => {
    if (op === "interval") return openEditor();
    if (op === "stopRepeat") return void stopRepeating();
    if (op === "run") return void control("run", entry?.phase.key === "wait");
    return void control(op);
  };

  const pressMenu = (op: MenuOp) => {
    setMenuOpen(false);
    if (op === "interval") return openEditor();
    if (op === "cancel") {
      setEditing(false);
      return setConfirmCancel(true);
    }
    void stopRepeating();
  };

  const saveInterval = async () => {
    const parsed = readInterval(interval);
    if ("error" in parsed) return setIntervalError(parsed.error);
    setIntervalError("");
    if (await actions.setRepeat(taskId, parsed.minutes)) {
      setEditing(false);
      notify(t.taskDetail.intervalSaved(rhythmLabel(parsed.minutes, phaseWords)));
    }
  };

  if (!entry || !task) {
    return (
      <Sheet title={notFound ? t.taskDetail.gone : t.taskDetail.loading} onClose={onClose} wide>
        {notFound ? (
          <p className="muted">{t.taskDetail.gone}</p>
        ) : loadError ? (
          <ErrorLine error={loadError} />
        ) : (
          <Skeleton lines={6} />
        )}
      </Sheet>
    );
  }

  const phase = entry.phase;
  const menu = taskMenu(task);
  const taskNeeds = needsForTask(needs, taskId);
  const middle = middleBlocks(task, phase, taskNeeds.length > 0, now);
  const buttons = detailActions(phase, middle.need, !!task.repeatMinutes);
  const where = accountLine(entry.environmentId, accountById, {
    loading: accounts.loading,
    count: accounts.value.length,
  });
  const plan = operatingPlanBlock(operatingPlanOf(task), now);
  const reports = reportLines(mergeReports(ownReports, projectReports), now);
  const steps = planBlock(task, phase.ended);
  const timeline = timelineLines(detail?.events ?? [], now);
  const receipt = phase.needsYou ? "" : receiptLine(nav.receipts[taskId], now);
  const artifacts = phase.key === "done" ? (detail?.artifacts ?? []) : [];
  const operating = task.input?.accountLoop === true;

  const openDesktop = () =>
    nav.openPanel({
      kind: "legacy",
      detail:
        where.kind === "account"
          ? {
              type: "computer",
              environment: {
                id: where.account.id,
                name: where.account.name,
                accountLabel: where.account.view.accountLabel,
              },
            }
          : { type: "computer" },
    });

  return (
    <Sheet
      title={task.title}
      onClose={onClose}
      wide
      actions={
        menu.length ? (
          <IconBtn
            icon={MoreHorizontal}
            label={t.taskDetail.menu}
            aria-expanded={menuOpen}
            on={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          />
        ) : undefined
      }
    >
      <div className="tp">
        {menuOpen ? (
          <div className="tp-menu" role="menu">
            {menu.map((item) => (
              <Btn
                key={item.op}
                role="menuitem"
                className={cx("sm", item.op === "cancel" && "ghost")}
                variant={item.op === "cancel" ? "danger" : undefined}
                busy={item.op === "stopRepeat" && busy === "repeat"}
                onClick={() => pressMenu(item.op)}
              >
                {item.label}
              </Btn>
            ))}
          </div>
        ) : null}

        <div className="row">
          <StatusPill phase={phase} />
          {phase.sub && phase.sub !== phase.label ? (
            <span className="muted" style={{ minWidth: 0 }}>
              {phase.sub}
            </span>
          ) : null}
        </div>

        <div>
          <KV k={t.taskDetail.rhythm}>{rhythmLine(task)}</KV>
        </div>

        {buttons.length ? (
          <div className="row">
            {buttons.map((button) => {
              // setRepeat reports itself busy as "repeat".
              const mine = busy === (button.op === "stopRepeat" ? "repeat" : button.op);
              return (
                <Btn
                  key={button.op}
                  className="sm"
                  busy={mine}
                  disabled={!!busy && !mine}
                  onClick={() => pressAction(button.op)}
                >
                  {button.label}
                </Btn>
              );
            })}
          </div>
        ) : null}
        {receipt ? <ReceiptLine text={receipt} /> : null}
        <ErrorLine error={actionError} />

        {confirmCancel ? (
          <div className="tp-box warn" role="alertdialog" aria-label={t.taskDetail.cancelYes}>
            <p>{operating ? t.taskDetail.stopOperatingConfirm : t.taskDetail.cancelConfirm}</p>
            <div className="row">
              <Btn
                variant="danger"
                className="sm solid"
                busy={busy === "cancel"}
                onClick={() => {
                  void control("cancel").then(() => setConfirmCancel(false));
                }}
              >
                {operating ? t.taskDetail.stopOperating : t.taskDetail.cancelYes}
              </Btn>
              <Btn className="sm ghost" onClick={() => setConfirmCancel(false)}>
                {t.taskDetail.cancelNo}
              </Btn>
            </div>
          </div>
        ) : null}

        {editing ? (
          <form
            className="tp-box"
            onSubmit={(e) => {
              e.preventDefault();
              void saveInterval();
            }}
          >
            <Field
              label={t.taskDetail.intervalLabel}
              value={interval}
              onChange={(e) => setIntervalText(e.target.value)}
              inputMode="numeric"
              autoFocus
              hint={intervalError ? <span className="tp-red">{intervalError}</span> : undefined}
            />
            <div className="row">
              <Btn type="submit" variant="pri" className="sm" busy={busy === "repeat"}>
                {t.taskDetail.intervalSave}
              </Btn>
              <Btn
                className="sm ghost"
                onClick={() => {
                  setEditing(false);
                  setIntervalError("");
                }}
              >
                {t.common.cancel}
              </Btn>
            </div>
          </form>
        ) : null}

        {middle.need ? taskNeeds.map((item) => <TaskNeed key={item.key} item={item} />) : null}
        {middle.blocks.map((block) => (
          <Section key={block.title} title={block.title}>
            <p className={cx("tp-pre", block.tone === "error" && "tp-red")}>{block.body}</p>
          </Section>
        ))}
        {artifacts.length ? (
          <MaybeSection title={middle.blocks.length ? "" : t.taskDetail.result}>
            <div className="tp-lines">
              {artifacts.map((artifact) => (
                <div key={artifact.id}>
                  <div className="tp-strong">{humanizeKey(artifact.title)}</div>
                  {firstLine(artifact.summary) ? (
                    <div className="muted">{firstLine(artifact.summary)}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </MaybeSection>
        ) : null}

        {plan ? (
          <Section title={plan.title}>
            <div className="tp-lines">
              {plan.rows.map((row) => (
                <div key={row.label} className="tp-plan-row">
                  <span className="tp-faint">{row.label}</span>
                  <span className="tp-pre">{row.lines.join("\n")}</span>
                </div>
              ))}
              {plan.setAt ? <span className="tp-faint">{plan.setAt}</span> : null}
            </div>
          </Section>
        ) : null}

        <Section title={t.taskDetail.reports(reports.length)}>
          <div className="tp-lines">
            {reports.map((line) => (
              <div key={line.id} className="tp-line">
                <span className="tp-faint tp-mono">{line.time}</span>
                <span className={cx("lbl", line.tone !== "neutral" && line.tone)}>
                  {line.label}
                </span>
                {line.text ? <span>{line.text}</span> : null}
                {line.links.map((link) => (
                  <a
                    key={link.url}
                    className="linkbtn"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t.reportCard.openLink(link.short)}
                  >
                    {`${t.common.link} ${link.short}`}
                  </a>
                ))}
                {line.unconfirmed ? (
                  <span className="tp-unconfirmed">{line.unconfirmed}</span>
                ) : null}
              </div>
            ))}
            {!reports.length ? <span className="tp-small">{t.taskDetail.noReports}</span> : null}
            {reportsPartial ? (
              <span className="tp-faint">{t.taskDetail.reportsPartial}</span>
            ) : null}
          </div>
        </Section>

        {steps ? (
          <Fold label={steps.label}>
            <ol className="tp-lines" style={{ margin: 0, paddingLeft: 20 }}>
              {steps.lines.map((line) => (
                <li
                  key={line.key}
                  className={cx(
                    line.state === "done" && "tp-green",
                    line.state === "current" && "tp-strong",
                  )}
                >
                  {line.text}
                </li>
              ))}
            </ol>
          </Fold>
        ) : null}
        <Fold label={t.taskDetail.rules}>
          <p className="tp-pre">{task.prompt}</p>
          {rulesHint(task) ? <p className="tp-small">{rulesHint(task)}</p> : null}
        </Fold>
        <Fold label={t.taskDetail.timeline}>
          <div className="tp-lines">
            {timeline.lines.map((line) => (
              <div key={line.id}>
                <div>
                  <span className="tp-faint tp-mono">{`${line.time}  `}</span>
                  {line.title}
                </div>
                {line.detail ? <div className="tp-small tp-pre">{line.detail}</div> : null}
              </div>
            ))}
            {!timeline.lines.length ? (
              <span className="tp-small">{t.taskDetail.noTimeline}</span>
            ) : null}
            {timeline.older > 0 ? (
              <span className="tp-faint">{t.taskDetail.olderEvents(timeline.older)}</span>
            ) : null}
          </div>
        </Fold>
      </div>
    </Sheet>
  );
}

/** A section with a heading, or the bare content when there is none. */
function MaybeSection({ title, children }: { title: string; children: ReactNode }) {
  return title ? <Section title={title}>{children}</Section> : <div>{children}</div>;
}
