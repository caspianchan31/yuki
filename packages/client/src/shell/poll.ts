/**
 * The one polling hook of the app (the shell's data, the task list, a
 * conversation's reports). The rules are in poll-core.ts: load at once on mount whatever the
 * page's visibility, then poll at the normal pace while the page is in use and slowly while it
 * is hidden and untouched; an overdue poll runs as soon as the page is back in use. Never two
 * runs of one poller at once.
 */
import { useEffect, useRef, useState } from "react";
import { appInBackground, isWeb, onAppActive, onAppStateChange } from "../platform-env";
import { type PageUse, pageInUse, pollDue, startRetrying, throttleWait } from "./poll-core";

const web = isWeb && typeof window !== "undefined" && typeof document !== "undefined";

let lastInputAt: number | null = null;
let inputWatched = false;
const inputEvents = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

/** Records the last click / key / focus on the page (once per app). */
function watchInput() {
  if (inputWatched || !web) return;
  inputWatched = true;
  const mark = () => {
    lastInputAt = Date.now();
  };
  for (const type of inputEvents)
    window.addEventListener(type, mark, { capture: true, passive: true });
}

function pageUse(now: number): PageUse {
  if (!web)
    return {
      visible: !appInBackground(),
      sinceInputMs: null,
      focused: false,
    };
  let focused = false;
  try {
    focused = document.hasFocus();
  } catch {
    focused = false;
  }
  return {
    visible: !document.hidden,
    sinceInputMs: lastInputAt === null ? null : now - lastInputAt,
    focused,
  };
}

/** Someone is using the page now (visible, focused, or touched within a minute). */
export function pageActive(now: number = Date.now()): boolean {
  watchInput();
  return pageInUse(pageUse(now));
}

/** The page is on screen now: visible, or focused (a webview that never reports "visible");
 * the native app is in the foreground. Unlike `pageActive`, a recent click does not count: a tab
 * left in the background a moment ago is not looked at. */
export function pageOnScreen(): boolean {
  if (!web) return !appInBackground();
  try {
    return !document.hidden || document.hasFocus();
  } catch {
    return !document.hidden;
  }
}

/** `pageOnScreen()`, re-rendering when it changes (the tab shown or hidden, the window focused or
 * not; the app coming back). What only counts once the person looks at it (a report recorded as
 * seen) waits for it. */
export function useOnScreen(): boolean {
  const [onScreen, setOnScreen] = useState(pageOnScreen);
  useEffect(() => {
    const update = () => setOnScreen(pageOnScreen());
    update();
    // The app going to the background as well as coming back (the browser tab hidden or shown).
    const unsubscribe = onAppStateChange(update);
    if (!web)
      return () => {
        unsubscribe();
      };
    const windowEvents = ["focus", "blur", "pageshow", "pagehide"] as const;
    for (const type of windowEvents) window.addEventListener(type, update);
    return () => {
      unsubscribe();
      for (const type of windowEvents) window.removeEventListener(type, update);
    };
  }, []);
  return onScreen;
}

/** Runs `task` at once and then every `everyMs` while the page is in use (slower while it is
 * hidden and untouched), and again as soon as the page comes back; never two at once. A change
 * of `resetOn` starts over (runs at once). */
export function usePoll(
  task: () => Promise<unknown>,
  everyMs: number,
  enabled = true,
  resetOn?: unknown,
) {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (!enabled) return;
    watchInput();
    let running = false;
    let lastStart = Number.NEGATIVE_INFINITY;
    let stopped = false;
    const run = () => {
      if (running || stopped) return;
      running = true;
      lastStart = Date.now();
      void latest
        .current()
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    };
    const tick = () => {
      const now = Date.now();
      if (pollDue({ inUse: pageActive(now), sinceLastMs: now - lastStart, everyMs })) run();
    };
    // Back in use: run now if a poll is overdue at the normal pace.
    const wake = () => {
      const now = Date.now();
      if (pageActive(now) && pollDue({ inUse: true, sinceLastMs: now - lastStart, everyMs })) run();
    };
    run();
    const timer = setInterval(tick, everyMs);
    const unsubscribe = onAppActive(wake);
    const wakeEvents = ["focus", "pointerdown", "keydown"] as const;
    if (web) {
      document.addEventListener("visibilitychange", wake);
      for (const type of wakeEvents) window.addEventListener(type, wake, { passive: true });
    }
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      if (web) {
        document.removeEventListener("visibilitychange", wake);
        for (const type of wakeEvents) window.removeEventListener(type, wake);
      }
    };
    // `resetOn` only restarts the poller; the task itself is read through `latest`.
  }, [everyMs, enabled, resetOn]);
}

/**
 * `value`, taking a change at most once per `everyMs`: a change after a quiet period at once, a
 * change within the period at its end (the latest value then); the value at mount counts as the
 * first. For reads that follow a polled value (the task detail re-reads its events when the task
 * changes) without one read per poll.
 */
export function useThrottled<T>(value: T, everyMs: number): T {
  const [taken, setTaken] = useState(value);
  // The value at mount counts as taken: the reads it drives just ran.
  const lastTakenAt = useRef<number | null>(Date.now());
  useEffect(() => {
    if (Object.is(value, taken)) return;
    const take = () => {
      lastTakenAt.current = Date.now();
      setTaken(value);
    };
    const wait = throttleWait(lastTakenAt.current, Date.now(), everyMs);
    if (wait === 0) {
      take();
      return;
    }
    const timer = setTimeout(take, wait);
    return () => clearTimeout(timer);
  }, [value, taken, everyMs]);
  return taken;
}

/**
 * While `failing`, retries `attempt` with backoff (poll-core startRetrying: 5 s, doubling to once
 * a minute); stops when an attempt answers true or `failing` turns false (a read elsewhere
 * succeeded), and starts over from 5 s at the next failure.
 */
export function useRetryWhile(failing: boolean, attempt: () => Promise<boolean>) {
  const latest = useRef(attempt);
  latest.current = attempt;
  useEffect(() => {
    if (!failing) return;
    return startRetrying(() => latest.current());
  }, [failing]);
}
