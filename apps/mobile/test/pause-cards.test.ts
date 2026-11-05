// The chat's pause_task and resume_task cards read as the
// redirect card does (the task's title and state word, confirmed by their own field), the timeline
// and the chat's reasons for them are in Chinese, and a loop paused this way reads 已暂停 and is
// not in 需要你.
import assert from "node:assert/strict";
import test from "node:test";
import { redirectView, taskControlWords } from "../../../packages/client/src/shell/chat/core.ts";
import { phaseWords, serverText } from "../../../packages/client/src/shell/strings.ts";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import { taskPhase } from "../../../packages/domain/src/task-phase.ts";

test("pause and resume cards: title and state word, confirmed only by their own field", () => {
  assert.deepEqual(
    redirectView(
      { account: "Nova_Harrison" },
      { paused: true, taskId: "loop-1", task: "Nova_Harrison 的日常运营", state: "已暂停" },
      "pause",
    ),
    { taskId: "loop-1", line: "Nova_Harrison 的日常运营 · 已暂停", failed: false, reason: null },
  );
  assert.deepEqual(
    redirectView(
      { taskId: "loop-1", words: "继续" },
      JSON.stringify({ resumed: true, taskId: "loop-1", task: "日常运营", state: "排队中" }),
      "resume",
    ),
    { taskId: "loop-1", line: "日常运营 · 排队中", failed: false, reason: null },
  );
  // Another tool's confirmation is not this one's.
  assert.equal(redirectView({}, { redirected: true, task: "x", state: "y" }, "pause").failed, true);
  assert.equal(redirectView({}, { paused: true, task: "x", state: "y" }, "resume").failed, true);
  assert.deepEqual(
    redirectView({}, { error: "This account has no operating loop" }, "pause").reason,
    "这个号没在经营。",
  );
  assert.deepEqual(
    [taskControlWords("pause").done, taskControlWords("pause").group("日常运营")],
    ["已暂停任务", "暂停了：日常运营"],
  );
  assert.deepEqual(
    [taskControlWords("resume").failed, taskControlWords("resume").group("日常运营")],
    ["没能恢复任务", "恢复了：日常运营"],
  );
  assert.equal(taskControlWords("redirect").group("日常运营"), "转告了：日常运营");
});

test("the server's words for pausing and resuming read in Chinese", () => {
  for (const [english, chinese] of [
    ["Paused as you said", "按你说的暂停了"],
    ["Could not pause the task", "没能暂停任务。"],
    ["Could not resume the task", "没能恢复任务。"],
    ["Give the task id or the account", "没说是哪个任务或哪个号。"],
  ])
    assert.equal(serverText(english), chinese);
});

test("a loop paused on the owner's word reads 已暂停 and is not in 需要你", () => {
  const loop = {
    id: "loop-1",
    kind: "agent",
    title: "Nova_Harrison 的日常运营",
    prompt: "用这个账号推广 AcmeGame",
    status: "paused",
    question: null,
    input: { environmentId: "env-1", accountLoop: true, forGoal: true },
    state: { lastUpdate: "按主人的话停在这里" },
    plan: [],
    evidence: [],
    artifactIds: [],
    attempts: 3,
    createdAt: "2026-10-20T01:00:00Z",
    updatedAt: "2026-10-20T02:00:00Z",
  } as unknown as AgentTask;
  const phase = taskPhase(loop, { words: phaseWords });
  assert.equal(phase.label, "已暂停");
  assert.equal(phase.needsYou, false);
  assert.equal(phase.stopped, undefined);
});
