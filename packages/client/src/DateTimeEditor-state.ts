/**
 * The state of the date and time editor (DateTimeEditor.tsx), free of React Native so the web app
 * (apps/web, phase C) shares it: the date and time shown for `value` in `timeZone`, and the
 * change that turns them back into an instant (or a date, all day).
 */
import { useEffect, useState } from "react";
import { isCompleteInstant, localDateTime, zonedInstant } from "./date-time";
import { t } from "./shell/strings";

export function useDateTimeEditor({
  value,
  timeZone,
  allDay,
  onChange,
}: {
  value: string;
  timeZone: string;
  allDay: boolean;
  onChange: (value: string) => void;
}) {
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState("");
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
  return { date, time, error, change };
}
