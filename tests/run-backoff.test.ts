// Runs stopped by the infrastructure again and again (a model provider down
// for hours, a desktop that does not answer) are retried less and less often: the first at once
// (the worker's lease), then 2, 4, 8, 16 minutes, at most 30; the count lives in the task's
// runFailure and starts over with any run that is not stopped. One rule for every task.
import assert from "node:assert/strict";
import test from "node:test";
import { stoppedRetryDelayMs, taskRunFailure } from "../packages/domain/src/agent.ts";

test("the retry after runs stopped in a row waits longer each time, at most 30 minutes", () => {
  const minutes = [1, 2, 3, 4, 5, 6, 7, 20].map((n) => stoppedRetryDelayMs(n) / 60_000);
  assert.deepEqual(minutes, [0, 2, 4, 8, 16, 30, 30, 30]);
  assert.equal(stoppedRetryDelayMs(0), 0);
});

test("a stored failure without a count (written before) reads as the first", () => {
  const at = "2026-10-17T02:00:00Z";
  assert.equal(taskRunFailure({ runFailure: { detail: "x", at } })?.count, 1);
  assert.equal(taskRunFailure({ runFailure: { detail: "x", at, count: 4 } })?.count, 4);
  assert.equal(taskRunFailure({ runFailure: { detail: "x", at, count: -2 } })?.count, 1);
});
