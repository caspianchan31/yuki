import assert from "node:assert/strict";
import { test } from "node:test";
import { afterOpening, beginOpening, openingOver } from "../packages/client/src/opening.ts";

// v1.7.2 对话快: one module-level opening per page, so the three stages run in order.
test("while the page opens, the reads its first screen does not need wait; the rest go at once", async () => {
  // Not opening (the phone app, tests): nothing waits.
  assert.equal(afterOpening("GET", "/api/skills"), undefined);
  let cap: (() => void) | undefined;
  beginOpening(1200, (run) => {
    cap = run;
  });
  assert.equal(afterOpening("GET", "/api/agent"), undefined, "the shell's own read");
  assert.equal(afterOpening("GET", "/api/main-thread"), undefined);
  assert.equal(afterOpening("GET", "/api/chat-reports"), undefined, "the rail's reports");
  assert.equal(afterOpening("POST", "/api/skills"), undefined, "only reads wait");
  const waiting = [
    "/api/skills",
    "/api/apps",
    "/api/topology",
    "/api/agent/routines",
    "/api/chat-reports?limit=50",
    "/api/environments/everyone",
    "/api/billing/plan",
    "/api/projects/overview",
  ].map((path) => afterOpening("GET", path));
  assert.ok(waiting.every(Boolean), "each of these waits");
  let released = false;
  void Promise.all(waiting).then(() => {
    released = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false);
  openingOver();
  await Promise.all(waiting);
  assert.equal(afterOpening("GET", "/api/skills"), undefined, "after the opening nothing waits");
  // The cap firing later changes nothing, and a second opening can be capped by its timer.
  cap?.();
  beginOpening(1200, (run) => {
    cap = run;
  });
  const capped = afterOpening("GET", "/api/apps");
  assert.ok(capped);
  cap?.();
  await capped;
});
