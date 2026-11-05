/**
 * Phase C (docs/web.md): the repeat and date editors of the older screens, from
 * task-schedule.tsx, DateTimeEditor.tsx and DateFields.web.tsx — for the legacy task detail and
 * delegate form, and the calendar event editor (the legacy area draws those screens):
 *   TaskSchedulePicker  "every N minutes" and the account to run on (default desktop or one of
 *                       the project's accounts)
 *   TaskScheduleDetail  the schedule of a task with Run now, a new interval and Stop repeating;
 *                       a task that paused itself with wait_until shows when it resumes
 *   DateTimeEditor      a date and a time in a time zone (native <input type="date/time">)
 *   DateFields          the two native inputs
 */

import { useAgentWorkspace } from "@m/agent-workspace";
import { useDateTimeEditor } from "@m/DateTimeEditor-state";
import { DEFAULT_DESKTOP_LABEL } from "@m/environments";
import { t } from "@m/shell/strings";
import {
  currentWait,
  parseRepeatMinutes,
  runNoteView,
  scheduleLabel,
  waitLabel,
} from "@m/task-schedule-core";
import { useScheduleAccounts } from "@m/task-schedule-state";
import { useWorkspace } from "@m/workspace";
import { Play, Repeat, Square } from "lucide-react";
import { useState } from "react";
import type { AgentTask } from "../../../../../packages/domain/src/agent";
import { Btn, cx, ErrorLine, Field } from "../../ui/primitives";
import { errorText } from "./parts";

const w = t.taskSchedule;

export function TaskSchedulePicker({
  repeat,
  onRepeat,
  environmentId,
  onEnvironment,
}: {
  repeat: string;
  onRepeat: (value: string) => void;
  environmentId: string | null;
  onEnvironment: (value: string | null) => void;
}) {
  const { accounts, available, loaded } = useScheduleAccounts(true);
  const parsed = parseRepeatMinutes(repeat);
  return (
    <div className="tp" style={{ gap: 12 }}>
      <Field
        label={t.newTask.intervalLabel}
        value={repeat}
        onChange={(e) => onRepeat(e.target.value)}
        inputMode="numeric"
        placeholder={w.runOnce}
      />
      {typeof parsed === "object" && parsed ? <ErrorLine error={parsed.error} /> : null}
      {available ? (
        <div className="tp-lines" style={{ gap: 8 }}>
          <span className="tp-strong">{w.runOn}</span>
          <div className="row">
            <Btn
              className="sm"
              variant={environmentId === null ? "pri" : undefined}
              aria-pressed={environmentId === null}
              onClick={() => onEnvironment(null)}
            >
              {DEFAULT_DESKTOP_LABEL}
            </Btn>
            {accounts.map((account) => (
              <Btn
                key={account.id}
                className="sm"
                variant={environmentId === account.id ? "pri" : undefined}
                aria-pressed={environmentId === account.id}
                onClick={() => onEnvironment(account.id)}
              >
                {account.name}
              </Btn>
            ))}
          </div>
          <span className="tp-small">
            {!loaded ? w.loadingAccounts : accounts.length ? w.usesAccount : w.noAccounts}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function TaskScheduleDetail({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  const { refresh, mutate } = useAgentWorkspace();
  const { accounts, available, loaded } = useScheduleAccounts(
    typeof task.input.environmentId === "string",
  );
  const [editing, setEditing] = useState(false);
  const [interval, setIntervalText] = useState(String(task.repeatMinutes ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const environmentId =
    typeof task.input.environmentId === "string" ? task.input.environmentId : null;
  const account = accounts.find((item) => item.id === environmentId);
  const label = scheduleLabel(task);
  const wait = currentWait(task);
  const note = wait ? runNoteView(wait.note) : null;
  const repeatable = task.kind === "agent" || task.kind === "plan";
  if (!label && !environmentId && !repeatable) return null;
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh().catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const patch = (repeatMinutes: number | null) =>
    run(async () => {
      await api.request(`/api/agent/tasks/${task.id}`, { repeatMinutes }, "PATCH");
      setEditing(false);
    });
  const save = () => {
    const parsed = parseRepeatMinutes(interval, { allowEmpty: false });
    if (parsed === null || typeof parsed === "object")
      return setError(parsed?.error ?? t.interval.required);
    void patch(parsed);
  };
  return (
    <div className="tp" style={{ gap: 8 }}>
      {environmentId ? (
        <p className="tp-small">
          {w.runsOn}
          {account
            ? `${account.name}${account.accountLabel ? ` (${account.accountLabel})` : ""}`
            : available && loaded
              ? w.accountGone
              : w.boundAccount}
        </p>
      ) : null}
      {label ? <p className="tp-small">{label}</p> : null}
      {wait ? <p className="tp-small">{waitLabel(task)}</p> : null}
      {/* an action of that run not confirmed, before its words. */}
      {note?.unconfirmed ? (
        <p className="tp-small" style={{ color: "var(--amber)", fontWeight: 600 }}>
          {note.unconfirmed}
        </p>
      ) : null}
      {note ? <p className="muted tp-pre">{note.text}</p> : null}
      <ErrorLine error={error} />
      {repeatable && task.status !== "cancelled" && !editing ? (
        <div className="row">
          {task.status === "scheduled" && (task.repeatMinutes || wait) ? (
            <Btn
              className="sm"
              icon={Play}
              busy={busy}
              onClick={() => void run(() => mutate(`/tasks/${task.id}/control`, { action: "run" }))}
            >
              {t.tasksRail.runNow}
            </Btn>
          ) : null}
          <Btn
            className="sm"
            icon={Repeat}
            disabled={busy}
            onClick={() => {
              setIntervalText(String(task.repeatMinutes ?? ""));
              setError("");
              setEditing(true);
            }}
          >
            {task.repeatMinutes ? t.tasksRail.changeInterval : w.repeatThis}
          </Btn>
          {task.repeatMinutes ? (
            <Btn className="sm" icon={Square} busy={busy} onClick={() => void patch(null)}>
              {t.tasksRail.stopRepeating}
            </Btn>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <form
          className="tp-box"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field
            label={t.newTask.intervalLabel}
            value={interval}
            onChange={(e) => setIntervalText(e.target.value)}
            inputMode="numeric"
            autoFocus
            placeholder={w.example}
          />
          <div className="row">
            <Btn type="submit" variant="pri" className="sm" busy={busy}>
              {w.saveInterval}
            </Btn>
            <Btn
              className="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              {t.common.cancel}
            </Btn>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function DateTimeEditor({
  label,
  value,
  timeZone,
  allDay,
  onChange,
}: {
  label: string;
  value: string;
  timeZone: string;
  allDay: boolean;
  onChange: (value: string) => void;
}) {
  const { date, time, error, change } = useDateTimeEditor({ value, timeZone, allDay, onChange });
  return (
    <div className="tp" style={{ gap: 6 }}>
      <DateFields label={label} date={date} time={time} allDay={allDay} onChange={change} />
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}

export function DateFields({
  label,
  date,
  time,
  allDay,
  onChange,
}: {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  onChange: (date: string, time: string) => void;
}) {
  return (
    <div className={cx("tp-dates", allDay && "one")}>
      <label className="field">
        <span>{t.dateFields.date(label)}</span>
        <input
          className="input"
          type="date"
          value={date}
          onChange={(e) => onChange(e.target.value, time)}
        />
      </label>
      {!allDay ? (
        <label className="field">
          <span>{t.dateFields.time(label)}</span>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => onChange(date, e.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}
