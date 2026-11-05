// Which desktop shows small beside the timeline.
import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopPreview,
  memberScreen,
} from "../../../packages/client/src/shell/desk/preview-core.ts";
import type { EntryPhase } from "../../../packages/client/src/shell/model.ts";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";

const entry = (
  id: string,
  env: string | null,
  key: string,
  updatedAt: string,
  stalled = false,
) => ({
  task: { id, title: `task ${id}`, updatedAt } as AgentTask,
  phase: { key, stalled } as unknown as EntryPhase,
  environmentId: env,
});
const accounts = [
  { id: "a", name: "Ann", desktop: "running" as const },
  { id: "b", name: "Bob", desktop: "running" as const },
  { id: "c", name: "Cid", desktop: "stopped" as const },
];

test("the account at work now shows: a run on a running desktop, the latest first", () => {
  const entries = [
    entry("1", "a", "run", "2026-10-26T01:00:00Z"),
    entry("2", "b", "run", "2026-10-26T02:00:00Z"),
    entry("3", "c", "run", "2026-10-26T03:00:00Z"),
    entry("4", null, "run", "2026-10-26T04:00:00Z"),
  ];
  assert.deepEqual(desktopPreview({ pin: true, pinned: null, accounts, entries }), {
    environmentId: "b",
    name: "Bob",
    doing: "task 2",
  });
});

test("the open member's rail shows her screen while she is at work", () => {
  const entries = [
    entry("1", "a", "run", "2026-10-26T01:00:00Z"),
    entry("2", "b", "run", "2026-10-26T02:00:00Z"),
  ];
  assert.deepEqual(memberScreen(accounts[0], entries), {
    environmentId: "a",
    name: "Ann",
    doing: "task 1",
  });
  assert.equal(memberScreen(accounts[2], entries), null);
  assert.equal(
    memberScreen(accounts[0], [entry("1", "a", "run", "2026-10-26T01:00:00Z", true)]),
    null,
  );
});

test("nothing shows on a narrow window, beside a pinned desktop, or when nobody is at work", () => {
  const entries = [entry("1", "a", "run", "2026-10-26T01:00:00Z")];
  assert.equal(desktopPreview({ pin: false, pinned: null, accounts, entries }), null);
  assert.equal(desktopPreview({ pin: true, pinned: "a", accounts, entries }), null);
  assert.equal(
    desktopPreview({
      pin: true,
      pinned: null,
      accounts,
      entries: [
        entry("1", "a", "wait", "2026-10-26T01:00:00Z"),
        entry("2", "b", "run", "2026-10-26T01:00:00Z", true),
      ],
    }),
    null,
  );
});
