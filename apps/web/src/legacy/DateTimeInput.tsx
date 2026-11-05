/**
 * Phase C (docs/web.md): the event form's date and time inputs, from DateTimeEditor.tsx and
 * DateFields.web.tsx. DateTimeEditor belongs to another area; this is the minimal local copy the
 * event sheet needs (same rules: a wall-clock time in the event's zone, an all-day date alone).
 */
import { isCompleteInstant, localDateTime, zonedInstant } from "@m/date-time";
import { t } from "@m/shell/strings";
import { useEffect, useId, useState } from "react";

export function DateTimeInput({
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
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState("");
  const dateId = useId();
  const timeId = useId();
  useEffect(() => {
    try {
      if (allDay) {
        setDate(value.slice(0, 10));
      } else if (isCompleteInstant(value)) {
        const local = localDateTime(value, timeZone);
        setDate(local.date);
        setTime(local.time);
      }
    } catch {
      setError(t.dateFields.badTimeZone);
    }
  }, [value, timeZone, allDay]);
  function change(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    setError("");
    if (allDay) {
      onChange(nextDate);
      return;
    }
    try {
      onChange(zonedInstant(nextDate, nextTime, timeZone));
    } catch (e) {
      onChange(`${nextDate} ${nextTime}`);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="lg-stack tight">
      <div className="lg-pair">
        <label className="field" htmlFor={dateId}>
          <span>{t.dateFields.date(label)}</span>
          <input
            id={dateId}
            className="input"
            type="date"
            value={date}
            onChange={(e) => change(e.target.value, time)}
          />
        </label>
        {!allDay && (
          <label className="field" htmlFor={timeId}>
            <span>{t.dateFields.time(label)}</span>
            <input
              id={timeId}
              className="input"
              type="time"
              value={time}
              onChange={(e) => change(date, e.target.value)}
            />
          </label>
        )}
      </div>
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}
