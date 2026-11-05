// When the shell's pollers run (poll-core.ts). A page the browser counts as
// hidden (a background tab, a covered window, an embedded view) must still load the rail, and
// keep it alive slowly, instead of showing 「正在加载…」 until a visibilitychange that never comes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  hiddenEveryMs,
  pageInUse,
  pollDue,
  recentInputMs,
  requestVersions,
  retryBackoff,
  retryDelayMs,
  startRetrying,
  throttleWait,
} from "../../../packages/client/src/shell/poll-core.ts";

test("the first poll is always due, visible or not", () => {
  for (const inUse of [true, false])
    assert.equal(pollDue({ inUse, sinceLastMs: Number.POSITIVE_INFINITY, everyMs: 3000 }), true);
});

test("in use: every period, with a little slack for early timers", () => {
  assert.equal(pollDue({ inUse: true, sinceLastMs: 3000, everyMs: 3000 }), true);
  assert.equal(pollDue({ inUse: true, sinceLastMs: 2800, everyMs: 3000 }), true);
  assert.equal(pollDue({ inUse: true, sinceLastMs: 1500, everyMs: 3000 }), false);
  assert.equal(pollDue({ inUse: true, sinceLastMs: 19_500, everyMs: 20_000 }), true);
});

test("hidden and untouched: a quarter of the pace, at most once a minute, never stopped", () => {
  assert.equal(hiddenEveryMs(3000), 60_000);
  assert.equal(hiddenEveryMs(20_000), 80_000);
  assert.equal(hiddenEveryMs(30_000), 120_000);
  assert.equal(pollDue({ inUse: false, sinceLastMs: 3000, everyMs: 3000 }), false);
  assert.equal(pollDue({ inUse: false, sinceLastMs: 45_000, everyMs: 3000 }), false);
  assert.equal(pollDue({ inUse: false, sinceLastMs: 60_000, everyMs: 3000 }), true);
});

test("visible, focused or touched within a minute counts as in use", () => {
  assert.equal(pageInUse({ visible: true, focused: false, sinceInputMs: null }), true);
  assert.equal(pageInUse({ visible: false, focused: true, sinceInputMs: null }), true);
  assert.equal(pageInUse({ visible: false, focused: false, sinceInputMs: 5_000 }), true);
  assert.equal(pageInUse({ visible: false, focused: false, sinceInputMs: recentInputMs }), false);
  assert.equal(pageInUse({ visible: false, focused: false, sinceInputMs: null }), false);
});

test("a throttled value takes a change after a quiet period at once, else at the period's end", () => {
  assert.equal(throttleWait(null, 1000, 15_000), 0);
  assert.equal(throttleWait(0, 20_000, 15_000), 0);
  assert.equal(throttleWait(10_000, 13_000, 15_000), 12_000);
});

test("a failed read is retried after 5 s, doubling to once a minute", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 50].map(retryDelayMs),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000],
  );
  assert.equal(retryDelayMs(-1), retryBackoff.firstMs);
  assert.equal(retryDelayMs(Number.NaN), retryBackoff.firstMs);
});

/** Lets every pending promise callback run (the attempt and the scheduling after it). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("retrying runs until a read answers, one at a time, inside the request budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const startedAt: number[] = [];
  let clock = 0;
  let answers = false;
  const stop = startRetrying(async () => {
    startedAt.push(clock);
    return answers;
  });
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1000) {
      clock += 1000;
      t.mock.timers.tick(1000);
      await settle();
    }
  };
  await advance(4_000);
  assert.deepEqual(startedAt, [], "nothing before the first 5 s");
  await advance(1_000);
  assert.deepEqual(startedAt, [5_000]);
  await advance(10 * 60_000);
  // 5, +10, +20, +40, then every 60 s.
  assert.deepEqual(startedAt.slice(0, 6), [5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
  // Never more than 4 retries in any minute: far inside 120 requests per minute.
  for (const start of startedAt)
    assert.ok(startedAt.filter((at) => at >= start && at < start + 60_000).length <= 4);
  // The read answers: no more retries.
  answers = true;
  const count = startedAt.length;
  await advance(60_000);
  assert.equal(startedAt.length, count + 1, "the answering attempt is the last");
  await advance(10 * 60_000);
  assert.equal(startedAt.length, count + 1);
  stop();
});

test("retrying stops when told to, and a throwing attempt counts as a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = startRetrying(async () => {
    calls += 1;
    throw new Error("fetch failed");
  });
  t.mock.timers.tick(5_000);
  await settle();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls, 2, "a throw schedules the next retry like a false answer");
  stop();
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(calls, 2, "nothing after stop()");
});

/** A promise resolved from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("only the newest read applies its answer: a poll from before a move cannot undo it", async () => {
  const versions = requestVersions();
  let shown = ["Oak_Example_2", "Pine_Example_3"];
  // As ShellDataProvider.refreshAccounts: take a ticket, read, apply only while still newest.
  const refresh = async (answer: Promise<string[]>) => {
    const isNewest = versions.begin();
    const value = await answer;
    if (isNewest()) shown = value;
  };
  // The 20 s poll starts, the account is moved away, the post-move refresh starts and answers
  // first; the poll answers last with the list from before the move.
  const poll = deferred<string[]>();
  const afterMove = deferred<string[]>();
  const polling = refresh(poll.promise);
  const refreshing = refresh(afterMove.promise);
  afterMove.resolve(["Pine_Example_3"]);
  await refreshing;
  assert.deepEqual(shown, ["Pine_Example_3"]);
  poll.resolve(["Oak_Example_2", "Pine_Example_3"]);
  await polling;
  assert.deepEqual(shown, ["Pine_Example_3"], "the stale poll is dropped");
  // In order, every answer applies; invalidate() drops a read in flight (unmount).
  await refresh(Promise.resolve(["a"]));
  assert.deepEqual(shown, ["a"]);
  const late = deferred<string[]>();
  const pending = refresh(late.promise);
  versions.invalidate();
  late.resolve(["b"]);
  await pending;
  assert.deepEqual(shown, ["a"]);
});
