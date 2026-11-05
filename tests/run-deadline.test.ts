import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeadline } from "../apps/server/src/engine/model.ts";

test("a run that keeps producing events is not cut off by the idle timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const deadline = runDeadline({ idleMs: 1000, maxMs: 10000, onTimeout: (r) => reasons.push(r) });
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(900);
    deadline.touch();
  }
  assert.deepEqual(reasons, []);
  t.mock.timers.tick(1000);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /no progress/);
});

test("the hard cap ends a run that never stops producing events", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const deadline = runDeadline({ idleMs: 1000, maxMs: 5000, onTimeout: (r) => reasons.push(r) });
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(600);
    deadline.touch();
  }
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /timed out after/);
  deadline.touch();
  t.mock.timers.tick(10000);
  assert.equal(reasons.length, 1);
});

test("clear stops both timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const deadline = runDeadline({ idleMs: 1000, maxMs: 5000, onTimeout: (r) => reasons.push(r) });
  deadline.clear();
  t.mock.timers.tick(20000);
  assert.deepEqual(reasons, []);
});
