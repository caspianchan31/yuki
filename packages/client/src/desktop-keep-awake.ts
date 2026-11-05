/** v1.5 (cost): how long the live desktop view keeps a computer awake (desktop-stream-state.ts).
 * Free of React so tests read it. */
// Each URL request keeps the computer awake for 15 minutes (the provider's idle window); a
// visible stream repeats it every 2 minutes while the person has done something in the app in
// the last 15 minutes (v1.5: a view left open on a screen nobody uses no longer keeps the
// computer running; before, it held it for up to an hour and a half). Once it lapses the
// computer pauses by itself and starts again when it is next needed.
export const keepAwakeMs = 120000,
  keepAwakeIdleMs = 15 * 60000;

/** Whether a visible stream still asks to keep the computer awake: the person did something in
 * the app (or opened the view) less than `keepAwakeIdleMs` ago. */
export function keepViewAwake(now: number, lastActive: number): boolean {
  return now - lastActive < keepAwakeIdleMs;
}
