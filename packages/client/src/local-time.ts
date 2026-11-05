// The dates and times the person reads, in the time zone of the device
// reading them (the server writes UTC). One set of formats for every page (apps/web's
// pages/common.tsx exports them): a sign-up made at 01:30 Beijing time reads that day everywhere,
// never the UTC day before. Free of react-native so node:test covers them.

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** In the local time zone; "" when it is not a date. A date without a time (a day the
 * server already chose) is that day, not the UTC midnight it would parse as. */
export function localDay(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const date = dateOf(iso);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : "";
}

/** 09:30 in the local time zone; "" when it is not a date. */
export function localWhen(iso: string): string {
  const date = dateOf(iso);
  return date ? `${localDay(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}` : "";
}

/** 10-18 09:30 in the local time zone (records, alerts, the time of a check); "" when it is not
 * a date. */
export function shortWhen(iso: string): string {
  const date = dateOf(iso);
  return date
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : "";
}
