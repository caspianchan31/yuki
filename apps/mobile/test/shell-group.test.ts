// Who says each item of the project
// conversation, where the avatar shows, the 运营专员's requests and the members bar.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type GroupSpeaker,
  groupTurns,
  inGroupChat,
  itemSpeaker,
  memberVoice,
  projectRef,
  type SpeakerLookup,
} from "../../../packages/client/src/shell/chat/group-core.ts";
import type { ChatReport } from "../../../packages/domain/src/agent.ts";

const report = (over: Partial<ChatReport> = {}): ChatReport => ({
  id: "r1",
  taskId: "task-1",
  taskTitle: "日常运营",
  threadId: "main",
  kind: "report",
  title: "Update",
  text: "回了一条评论",
  links: [],
  createdAt: "2026-10-16T08:00:00.000Z",
  readAt: null,
  ...over,
});
const lookup: SpeakerLookup = {
  ops: "acmeskills 运营专员",
  accountOfTask: (taskId) =>
    taskId === "task-bob"
      ? { id: "env-bob", name: "Bob" }
      : taskId === "task-ann"
        ? { id: "env-ann", name: "Ann" }
        : null,
};

test("the person, the 运营专员 and the accounts each speak as themselves", () => {
  assert.deepEqual(
    itemSpeaker({ type: "message", message: { role: "user", content: "hi" } }, lookup),
    {
      kind: "owner",
    },
  );
  assert.deepEqual(
    itemSpeaker({ type: "message", message: { role: "assistant", content: "好的" } }, lookup),
    { kind: "ops", name: "acmeskills 运营专员" },
  );
  assert.deepEqual(
    itemSpeaker({ type: "message", message: { role: "assistant", content: "" } }, lookup),
    { kind: "silent" },
  );
  assert.deepEqual(
    itemSpeaker({ type: "reports", reports: [report({ taskId: "task-bob" })] }, lookup),
    { kind: "account", name: "Bob", initial: "B", environmentId: "env-bob" },
  );
  // A task on the default desktop is the 运营专员's.
  assert.equal(itemSpeaker({ type: "reports", reports: [report()] }, lookup).kind, "ops");
});

test("the avatar and name show once per run of one speaker; a silent item does not break it", () => {
  const ops: GroupSpeaker = { kind: "ops", name: "运营专员" };
  const bob: GroupSpeaker = { kind: "account", name: "Bob", initial: "B" };
  const ann: GroupSpeaker = { kind: "account", name: "Ann", initial: "A" };
  const heads = groupTurns([
    { kind: "owner" },
    ops,
    { kind: "silent" },
    ops,
    bob,
    bob,
    ann,
    ops,
  ]).map((turn) => turn.head);
  assert.deepEqual(heads, [true, true, false, false, true, false, true, true]);
});

// The hall's results that name a project: create_project's and a task handed to one.
test("projectRef: a project made in the hall, a task handed to a project, nothing else", () => {
  assert.deepEqual(
    projectRef(JSON.stringify({ project: { id: "p1", name: "alpha" }, created: true })),
    {
      id: "p1",
      name: "alpha",
      created: true,
      title: null,
      account: null,
    },
  );
  assert.deepEqual(
    projectRef({
      id: "t1",
      title: "[Bob] 回一帖",
      project: "alpha",
      projectId: "p1",
      account: "Bob",
    }),
    { id: "p1", name: "alpha", created: null, title: "[Bob] 回一帖", account: "Bob" },
  );
  assert.equal(projectRef({ id: "t1", title: "回一帖" }), null);
  assert.equal(projectRef({ error: "No project named" }), null);
  assert.equal(projectRef("not json"), null);
});

test("in her chat the assistant's words are hers", () => {
  assert.deepEqual(memberVoice({ kind: "ops", name: "Yuki" }, { id: "m", name: "晨报" }), {
    kind: "account",
    name: "晨报",
    initial: "晨",

    environmentId: "m",
  });
  const hers = {
    kind: "account" as const,
    name: "晨报",
    initial: "晨",
  };
  assert.equal(memberVoice(hers, { id: "m", name: "晨报" }), hers);
  assert.deepEqual(memberVoice({ kind: "ops", name: "Yuki" }, null), {
    kind: "ops",
    name: "Yuki",
  });
});

test("a member's own chat is not the group, even in the hall", () => {
  assert.equal(inGroupChat({ hall: true, pro: false, memberOpen: true }), false);
  assert.equal(inGroupChat({ hall: true, pro: false, memberOpen: false }), true);
  assert.equal(inGroupChat({ hall: false, pro: false, memberOpen: false }), true);
  assert.equal(inGroupChat({ hall: true, pro: true, memberOpen: true }), true);
  assert.equal(inGroupChat({ hall: false, pro: true, memberOpen: false }), false);
});
