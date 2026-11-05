// The schedule field and labels.
import assert from "node:assert/strict";
import test from "node:test";
import {
  intervalLabel,
  parseRepeatMinutes,
  scheduleLabel,
  waitLabel,
} from "../../../packages/client/src/task-schedule-core.ts";

test("the repeat field accepts whole minutes within a week or nothing", () => {
  assert.equal(parseRepeatMinutes(""), null);
  assert.equal(parseRepeatMinutes("  "), null);
  assert.equal(parseRepeatMinutes("15"), 15);
  assert.equal(parseRepeatMinutes(" 10080 "), 10080);
  for (const bad of ["0", "-5", "1.5", "abc", "10081"])
    assert.ok(typeof parseRepeatMinutes(bad) === "object", bad);
});

test("interval and schedule labels read naturally", () => {
  assert.equal(intervalLabel(1), "every 1 min");
  assert.equal(intervalLabel(90), "every 1 h 30 min");
  assert.equal(intervalLabel(120), "every 2 h");
  assert.equal(intervalLabel(1500), "every 1 d 1 h");
  assert.equal(scheduleLabel({ status: "queued", repeatMinutes: null }), null);
  assert.equal(
    scheduleLabel({ status: "queued", repeatMinutes: 30, runs: 0 }),
    "Repeats every 30 min · 0 runs so far",
  );
  const scheduled = scheduleLabel({
    status: "scheduled",
    repeatMinutes: 30,
    runs: 1,
    nextRunAt: "2026-10-10T10:00:00Z",
  });
  assert.ok(scheduled?.startsWith("Repeats every 30 min · 1 run so far · next "));
});

test("a task that paused itself with wait_until reads as waiting until its resume time", () => {
  const until = new Date(2026, 9, 10, 2, 40).toISOString();
  const wait = { minutes: 30, note: "Posted 1 of 3", since: "x", until };
  const task = { status: "scheduled" as const, nextRunAt: until, state: { wait } };
  const today = waitLabel(task, new Date(2026, 9, 10, 2, 10));
  assert.ok(today?.startsWith("Waiting · resumes "), today ?? "");
  assert.ok(today?.includes("40"), "the resume time");
  assert.ok(!today?.includes("Oct"), "no date when it resumes today");
  const tomorrow = waitLabel(task, new Date(2026, 9, 9, 23, 50));
  assert.ok(tomorrow !== today, "a later day adds the date");
  // Paused, run now (the next run moved) or no wait at all: not waiting.
  assert.equal(waitLabel({ ...task, status: "paused" as const }), null);
  assert.equal(waitLabel({ ...task, nextRunAt: new Date().toISOString() }), null);
  assert.equal(waitLabel({ status: "scheduled", nextRunAt: until, state: {} }), null);
});
