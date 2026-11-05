// Who says each item of the project
// conversation, where the avatar shows, the 运营专员's requests and the members bar.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type GroupSpeaker,
  groupMembers,
  groupTurns,
  hallMembers,
  inGroupChat,
  itemSpeaker,
  memberVoice,
  noticeSays,
  opsRequest,
  projectRef,
  type SpeakerLookup,
} from "../../../packages/client/src/shell/chat/group-core.ts";
import { jobToolView } from "../../../packages/client/src/shell/jobs/jobs-core.ts";
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
const founder = { environmentId: "env-ann", name: "Ann" };
const lookup: SpeakerLookup = {
  ops: "acmeskills 运营专员",
  accountOfTask: (taskId) =>
    taskId === "task-bob"
      ? { id: "env-bob", name: "Bob" }
      : taskId === "task-ann"
        ? { id: "env-ann", name: "Ann" }
        : null,
  founder,
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
    { kind: "account", name: "Bob", initial: "B", founder: false, environmentId: "env-bob" },
  );
  // The founder's task, by its account id.
  assert.deepEqual(itemSpeaker({ type: "need", report: report({ taskId: "task-ann" }) }, lookup), {
    kind: "account",
    name: "Ann",
    initial: "A",
    founder: true,
    environmentId: "env-ann",
  });
  // The founder's copy of its report in the project that gave the job names itself.
  assert.deepEqual(
    itemSpeaker(
      {
        type: "reports",
        reports: [report({ taskId: "elsewhere", speaker: { name: "Ann", founder: true } })],
      },
      lookup,
    ),
    { kind: "account", name: "Ann", initial: "A", founder: true },
  );
  // A task on the default desktop is the 运营专员's.
  assert.equal(itemSpeaker({ type: "reports", reports: [report()] }, lookup).kind, "ops");
});

test("a job taken or declined is said by that account; a job done by the 运营专员", () => {
  const taken = report({
    notice: { kind: "job_taken", account: "Ann", environmentId: "env-ann", jobTitle: "发一帖" },
  });
  assert.deepEqual(itemSpeaker({ type: "notice", report: taken }, lookup), {
    kind: "account",
    name: "Ann",
    initial: "A",
    founder: true,
    environmentId: "env-ann",
  });
  assert.equal(noticeSays(taken), "接了：发一帖");
  const declined = report({
    text: "",
    notice: { kind: "job_declined", account: "Bob", jobTitle: "发硬广", reason: "不合人设" },
  });
  assert.equal(itemSpeaker({ type: "notice", report: declined }, lookup).kind, "account");
  assert.equal(noticeSays(declined), "没接「发硬广」：不合人设");
  const done = report({ notice: { kind: "job_done", jobTitle: "发一帖" } });
  assert.equal(itemSpeaker({ type: "notice", report: done }, lookup).kind, "ops");
  assert.equal(noticeSays(done), "「发一帖」做完了。");
  assert.equal(noticeSays(report({ notice: { kind: "persona", account: "Bob" } })), null);
});

test("the avatar and name show once per run of one speaker; a silent item does not break it", () => {
  const ops: GroupSpeaker = { kind: "ops", name: "运营专员" };
  const bob: GroupSpeaker = { kind: "account", name: "Bob", initial: "B", founder: false };
  const ann: GroupSpeaker = { kind: "account", name: "Ann", initial: "A", founder: true };
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

test("the 运营专员 asks by name: the founder as 创始人, everyone as 所有号", () => {
  const view = jobToolView({
    jobId: "j1",
    title: "发一帖分镜流程",
    accounts: [{ name: "Ann" }, { name: "Bob" }],
  });
  assert.deepEqual(opsRequest("create_job", view, founder), {
    mentions: ["创始人 Ann", "Bob"],
    text: "请：发一帖分镜流程",
  });
  const everyone = jobToolView({ jobId: "j2", title: "每天看版", everyone: true, accounts: [] });
  assert.deepEqual(opsRequest("create_job", everyone, founder).mentions, ["所有号"]);
  const insisted = jobToolView({
    jobId: "j1",
    title: "发一帖",
    accounts: [{ name: "Bob" }],
    insisted: ["Ann"],
  });
  assert.deepEqual(opsRequest("assign_job", insisted, founder).mentions, ["创始人 Ann"]);
  assert.deepEqual(opsRequest("close_job", view, founder), {
    mentions: [],
    text: "「发一帖分镜流程」收工了。",
  });
  // A dropped assignee is not asked.
  const dropped = jobToolView({
    jobId: "j3",
    title: "x",
    accounts: [{ name: "Bob", status: "dropped" }],
  });
  assert.deepEqual(opsRequest("assign_job", dropped, founder).mentions, []);
});

test("the members: the 运营专员, then the founder (here or not), then the accounts", () => {
  const members = groupMembers(
    "acmeskills 运营专员",
    [
      { id: "env-bob", name: "Bob" },
      { id: "env-cid", name: "cid" },
    ],
    founder,
  );
  assert.deepEqual(
    members.map((m) => [m.kind, m.name, m.founder, m.initial]),
    [
      ["ops", "acmeskills 运营专员", false, ""],
      ["account", "Ann", true, "A"],
      ["account", "Bob", false, "B"],
      ["account", "cid", false, "C"],
    ],
  );
  // The founder in this project's list is not listed twice, and comes first.
  const here = groupMembers(
    "运营专员",
    [
      { id: "env-bob", name: "Bob" },
      { id: "env-ann", name: "Ann" },
    ],
    founder,
  );
  assert.deepEqual(
    here.map((m) => m.name),
    ["运营专员", "Ann", "Bob"],
  );
  assert.equal(groupMembers("运营专员", [], null).length, 1);
});

test("营销总群: a project's request is its 运营专员's; the line in the project is the founder's", () => {
  const request = report({
    notice: {
      kind: "founder_request",
      project: "acmeskills",
      jobTitle: "发一帖",
      account: "Ann",
      environmentId: "env-ann",
    },
  });
  assert.deepEqual(itemSpeaker({ type: "notice", report: request }, lookup), {
    kind: "ops",
    name: "acmeskills 运营专员",
  });
  const pointer = report({ notice: { kind: "in_hall", jobTitle: "发一帖", account: "Ann" } });
  assert.deepEqual(itemSpeaker({ type: "notice", report: pointer }, lookup), {
    kind: "account",
    name: "Ann",
    initial: "A",
    founder: true,
  });
  assert.equal(noticeSays(pointer), "汇报了「发一帖」，详情在 Yuki 的对话里。");
  // The founder asking a project to carry its work on is the founder's speech.
  const handover = report({
    notice: {
      kind: "project_request",
      project: "acmeskills",
      jobTitle: "接着回评论",
      account: "Ann",
      environmentId: "env-ann",
    },
  });
  assert.deepEqual(itemSpeaker({ type: "notice", report: handover }, lookup), {
    kind: "account",
    name: "Ann",
    initial: "A",
    founder: true,
  });
});

test("营销总群's members: its assistant, the founder, each project's 运营专员", () => {
  assert.deepEqual(
    hallMembers(founder, [
      { id: "p1", name: "acmeskills" },
      { id: "p2", name: "acmegame" },
    ]).map((m) => [m.kind, m.name, m.founder]),
    [
      ["ops", "Yuki", false],
      ["account", "Ann", true],
      ["ops", "acmeskills 运营专员", false],
      ["ops", "acmegame 运营专员", false],
    ],
  );
  assert.equal(hallMembers(null, []).length, 1);
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
    founder: false,
    environmentId: "m",
  });
  const hers = {
    kind: "account" as const,
    name: "晨报",
    initial: "晨",
    founder: false,
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
