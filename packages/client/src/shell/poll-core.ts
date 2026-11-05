/**
 * When a poller runs, when a failed read is retried, and which of several
 * overlapping reads may apply its answer. Pure: no react-native, so node:test can import it;
 * poll.ts adds the hooks.
 *
 * Every poller loads once as soon as it mounts, whatever the page's visibility: a page opened in
 * a background tab, or a window the browser counts as hidden (covered, on another screen, a
 * webview that never reports "visible"), must still show its data when someone looks at it.
 * After that it runs every `everyMs` while the page is in use, and only every `hiddenEveryMs`
 * while the page is hidden and nobody has touched it for a minute. Coming back (visible again,
 * a click, a key, focus) runs an overdue poll at once.
 */

/** The pollers' normal paces (the request budget is in data.tsx). */
export const pollMs = {
  reports: 15_000,
  environments: 20_000,
  overview: 30_000,
  workspace: 60_000,
  /** Re-render relative times ("还剩 13 分"). Not a request. */
  clock: 30_000,
} as const;

/** A hidden page polls this much less often, and at least once a minute or less often. */
export const hiddenFactor = 4;
export const hiddenFloorMs = 60_000;
/** A click, a key or focus within this long counts as "in use", even if the browser says hidden. */
export const recentInputMs = 60_000;

export function hiddenEveryMs(everyMs: number): number {
  return Math.max(everyMs * hiddenFactor, hiddenFloorMs);
}

export interface PageUse {
  /** The platform says the page is on screen (web: document not hidden; native: app active). */
  visible: boolean;
  /** Milliseconds since the last click / key / focus on the page; null without one. */
  sinceInputMs: number | null;
  /** web: document.hasFocus(). */
  focused: boolean;
}

/** Someone is using the page: it is visible, focused, or was touched within a minute. */
export function pageInUse(use: PageUse): boolean {
  return (
    use.visible ||
    use.focused ||
    (use.sinceInputMs !== null && use.sinceInputMs >= 0 && use.sinceInputMs < recentInputMs)
  );
}

/**
 * Whether a poll that last started `sinceLastMs` ago is due now. Timers fire a little early or
 * late; a tick within a tenth of the period (at most a second) of being due counts as due, so a
 * 3-second poll does not slip to every 6 seconds.
 */
export function pollDue(input: { inUse: boolean; sinceLastMs: number; everyMs: number }): boolean {
  const period = input.inUse ? input.everyMs : hiddenEveryMs(input.everyMs);
  const slack = Math.min(1000, Math.round(input.everyMs / 10));
  return input.sinceLastMs + slack >= period;
}

/** How long a throttled value waits before taking a change: none when the last change it took
 * is at least `everyMs` old, else the rest of that period. */
export function throttleWait(lastTakenAt: number | null, now: number, everyMs: number): number {
  if (lastTakenAt === null) return 0;
  return Math.max(0, lastTakenAt + everyMs - now);
}

// ───────────────────────────── retry after a failed read ─────────────────────────────

/**
 * A read that failed and is not polled (GET /api/workspace) is tried again after 5 s, then 10,
 * 20, 40 and from then on every 60 s, until it answers: the red bar's 「正在重试」 is true. That is
 * at most 4 reads in the first minute and 1 a minute after, well inside the server's 120 requests
 * per minute per IP (rate-limit.ts) next to the regular polls.
 */
export const retryBackoff = { firstMs: 5_000, maxMs: 60_000 } as const;

/** The wait before retry number `attempt` (0 = the first retry). */
export function retryDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(retryBackoff.maxMs, retryBackoff.firstMs * 2 ** Math.min(n, 16));
}

/**
 * Calls `attempt` after retryDelayMs(0), then again after each next delay while it answers false
 * (or throws); stops for good once it answers true, or when the returned function is called.
 * Never two attempts at once: the next wait starts when an attempt has finished.
 */
export function startRetrying(attempt: () => Promise<boolean>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tries = 0;
  const schedule = () => {
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      void attempt()
        .catch(() => false)
        .then((recovered) => {
          tries += 1;
          if (!recovered && !stopped) schedule();
        });
    }, retryDelayMs(tries));
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

// ───────────────────────────── request versioning ─────────────────────────────

/**
 * Request versioning for a value several reads write (a poll and a refresh after an action):
 * each read takes a ticket when it starts, and only a read that no later read has overtaken may
 * apply its answer. A poll that started before an account move and answers after the refresh
 * that followed the move is dropped, so it cannot put the stale list back until the next poll.
 */
export function requestVersions() {
  let newest = 0;
  return {
    /** A new read; the check stays true until another read begins (or `invalidate`). */
    begin(): () => boolean {
      newest += 1;
      const mine = newest;
      return () => mine === newest;
    },
    /** Drops every read in flight (the owner unmounted). */
    invalidate(): void {
      newest += 1;
    },
  };
}
export type RequestVersions = ReturnType<typeof requestVersions>;
