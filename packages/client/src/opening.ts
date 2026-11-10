// v1.7.2 对话快: while a page opens, the reads its first screen does not need (the roster's
// previews, the @ list, banners, settings) wait a moment, so the conversation's own reads are
// not queued behind some twenty others in the browser and on the server.

let open = false;
let over: () => void = () => {};
let ended: Promise<void> = Promise.resolve();

/** The longest those reads wait when no conversation reports its first messages. */
export const openingCapMs = 1200;

/** Reads that the first screen draws without. Matched against the path as requested. */
const later = [
  /^\/api\/topology(\?|$)/,
  /^\/api\/agent\/routines(\?|$)/,
  /^\/api\/agent\/brief(\?|$)/,
  /^\/api\/agent\/model(\?|$)/,
  /^\/api\/chat-reports\?limit=50$/,
  /^\/api\/environments\/everyone(\?|$)/,
  /^\/api\/skills(\?|$)/,
  /^\/api\/apps(\?|$)/,
  /^\/api\/credentials\/(sign-ins|guides)(\?|$)/,
  /^\/api\/billing(\/|\?|$)/,
  /^\/api\/account-settings(\?|$)/,
  /^\/api\/projects\/overview(\?|$)/,
];

/** The page starts to open (the web app, before its first draw). */
export function beginOpening(
  capMs = openingCapMs,
  timer: (run: () => void, ms: number) => unknown = setTimeout,
) {
  if (open) return;
  open = true;
  ended = new Promise((resolve) => {
    over = resolve;
  });
  timer(openingOver, capMs);
}

/** The open conversation has its first messages (or could not load): everything may read. */
export function openingOver() {
  if (!open) return;
  open = false;
  over();
}

/** Resolves at once unless the page is opening and this read can wait. */
export function afterOpening(method: string, path: string): Promise<void> | undefined {
  if (!open || method !== "GET" || !later.some((pattern) => pattern.test(path))) return undefined;
  return ended;
}
