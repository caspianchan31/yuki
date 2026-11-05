// A report without `confirms` is about the row of this
// task's that waits for its address when they name the same item.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountAction } from "../apps/server/src/engine/action-ledger.ts";
import { reportsEarlierAction, waitingRowFor } from "../apps/server/src/engine/service.ts";
import type { RunStep } from "../packages/domain/src/agent.ts";

const now = Date.parse("2026-10-24T09:30:00.000Z");
const row = (over: Partial<AccountAction>): AccountAction =>
  ({
    id: "row",
    taskId: "task",
    projectOwner: "space:p",
    site: "v2ex.com",
    action: "reply",
    overCapacity: false,
    links: [],
    at: "2026-10-24T07:11:40.000Z",
    unconfirmed: true,
    ...over,
  }) as AccountAction;
const of = { taskId: "task", site: "v2ex.com", action: "reply", now };

test("a reply's own address ties a report to the waiting row of the thread it is in", () => {
  const v2ex = row({
    id: "a",
    target: "https://www.v2ex.com/t/1248208",
    links: ["https://www.v2ex.com/t/1248208?p=1#reply1"],
  });
  const found = waitingRowFor([v2ex], of, {
    address: "https://www.v2ex.com/t/1248208#r_18217080",
    target: null,
    links: ["https://www.v2ex.com/t/1248208#r_18217080"],
  });
  assert.equal(found?.id, "a");
  const reddit = row({
    id: "r",
    site: "reddit.com",
    action: "comment",
    target:
      "https://www.reddit.com/r/LocalLLaMA/comments/1xe2ypu/psa_streaming_ngrams_from_ssd_will_cause_ssd_wear",
    links: [],
  });
  assert.equal(
    waitingRowFor(
      [reddit],
      { ...of, site: "reddit.com", action: "comment" },
      {
        address: "https://www.reddit.com/r/LocalLLaMA/comments/1xe2ypu/comment/19rkqwh5o74pu/",
        target: null,
        links: [],
      },
    )?.id,
    "r",
  );
  // X: the reply's address is not under the post it answers; the report's target ties them.
  const x = row({ id: "x", site: "x.com", target: "https://x.com/someone/status/111", links: [] });
  const xOf = { ...of, site: "x.com" };
  assert.equal(
    waitingRowFor([x], xOf, {
      address: "https://x.com/yushen686/status/222",
      target: "https://x.com/someone/status/111",
      links: [],
    })?.id,
    "x",
  );
  assert.equal(
    waitingRowFor([x], xOf, {
      address: "https://x.com/yushen686/status/222",
      target: null,
      links: [],
    }),
    undefined,
  );
});

test("nothing ties a report to another thread, another task, a confirmed row or one older than a day", () => {
  const waiting = row({ id: "a", target: "https://www.v2ex.com/t/1248208" });
  const address = { address: "https://www.v2ex.com/t/999#r_1", target: null, links: [] };
  assert.equal(waitingRowFor([waiting], of, address), undefined);
  const mine = { address: "https://www.v2ex.com/t/1248208#r_1", target: null, links: [] };
  assert.equal(waitingRowFor([row({ ...waiting, taskId: "other" })], of, mine), undefined);
  assert.equal(waitingRowFor([row({ ...waiting, unconfirmed: undefined })], of, mine), undefined);
  assert.equal(
    waitingRowFor([row({ ...waiting, at: "2026-10-23T08:00:00.000Z" })], of, mine),
    undefined,
  );
  assert.equal(waitingRowFor([row({ ...waiting, action: "post" })], of, mine), undefined);
  // A shared path with no item in it (the site's node list) ties nothing.
  const node = row({ id: "n", target: "https://www.v2ex.com/go/localllm" });
  assert.equal(
    waitingRowFor([node], of, {
      address: "https://www.v2ex.com/go/other",
      target: null,
      links: [],
    }),
    undefined,
  );
  // The latest of two that match.
  const later = row({
    id: "b",
    target: "https://www.v2ex.com/t/1248208",
    at: "2026-10-24T07:27:00.000Z",
  });
  assert.equal(waitingRowFor([waiting, later], of, mine)?.id, "b");
});

test("only a run that typed nothing reports an earlier run's action", () => {
  const open: RunStep = { kind: "input", text: 'openmuse-browser "https://www.v2ex.com/t/1#r_2"' };
  const read: RunStep = { kind: "read", urls: ["https://www.v2ex.com/t/1"] };
  const typed: RunStep = { kind: "input", text: "a reply in words" };
  assert.equal(reportsEarlierAction([open, read]), true);
  assert.equal(reportsEarlierAction([]), true);
  assert.equal(reportsEarlierAction([open, typed, read]), false);
  assert.equal(reportsEarlierAction(undefined), false);
});
