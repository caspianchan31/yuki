import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bucketsFromAgent,
  groupNeedCount,
  rosterLine,
  rosterPreview,
  rosterSections,
  taskRoutineBucket,
  weekMinutes,
} from "../packages/client/src/shell/members/roster.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { memberConversationId } from "../packages/domain/src/member-thread.ts";

const task = (patch: Record<string, unknown>) =>
  ({
    status: "scheduled",
    repeatMinutes: null,
    input: {},
    state: {},
    ...patch,
  }) as unknown as AgentTask;

describe("taskRoutineBucket", () => {
  it("has no routine without a live task", () => {
    assert.equal(taskRoutineBucket([]), "none");
    assert.equal(taskRoutineBucket([task({ status: "succeeded", repeatMinutes: 60 })]), "none");
  });

  it("calls a wake sooner than a week daily, including a standing loop", () => {
    assert.equal(taskRoutineBucket([task({ repeatMinutes: 10 })]), "daily");
    assert.equal(taskRoutineBucket([task({ repeatMinutes: 1440 })]), "daily");
    assert.equal(taskRoutineBucket([task({ input: { accountLoop: true } })]), "daily");
  });

  it("calls a week or longer weekly, and a shorter wake wins", () => {
    assert.equal(taskRoutineBucket([task({ repeatMinutes: weekMinutes })]), "weekly");
    assert.equal(
      taskRoutineBucket([task({ repeatMinutes: weekMinutes }), task({ repeatMinutes: 60 })]),
      "daily",
    );
    assert.equal(
      taskRoutineBucket([
        task({ repeatMinutes: weekMinutes }),
        task({ input: { accountLoop: true } }),
      ]),
      "daily",
    );
  });
});

describe("rosterLine", () => {
  it("keeps a need, and shows the latest result when she is quiet", () => {
    assert.equal(rosterLine("无代理", "早报好了", false), "无代理");
    assert.equal(rosterLine("空闲", "早报好了\n第二行", true), "早报好了");
    assert.equal(rosterLine("", null, true), "");
    assert.equal(rosterLine("空闲", "字".repeat(50), true).endsWith("…"), true);
    assert.equal(rosterLine("空闲", "字".repeat(50), true).length, 43);
  });

  it("picks her newest report, not someone else's", () => {
    const hers = {
      id: "t1",
      input: { environmentId: "mia" },
    } as never;
    const preview = rosterPreview([hers], [
      { taskId: "t1", createdAt: "2026-11-01T00:00:00.000Z", text: "旧的", title: "" },
      { taskId: "t1", createdAt: "2026-11-02T00:00:00.000Z", text: "新的", title: "" },
      { taskId: "other", createdAt: "2026-11-03T00:00:00.000Z", text: "别人的", title: "" },
    ] as never);
    assert.equal(preview.get("mia")?.text, "新的");
    assert.equal(preview.get("mia")?.at, "2026-11-02T00:00:00.000Z");
    assert.equal(preview.has("other"), false);
  });

  it("reads a result stored on her conversation after the task is gone, and skips a handoff", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const preview = rosterPreview([], [
      {
        taskId: "gone",
        threadId: memberConversationId(accountId),
        createdAt: "2026-11-02T00:00:00.000Z",
        text: "早报好了",
        title: "",
      },
      {
        taskId: "gone",
        threadId: memberConversationId(accountId),
        createdAt: "2026-11-03T00:00:00.000Z",
        text: "交给了别人",
        title: "",
        notice: { kind: "job_done" },
      },
    ] as never);
    assert.equal(preview.get(accountId)?.text, "早报好了");
  });
});

describe("rosterSections", () => {
  const member = (id: string, bucket: "daily" | "weekly" | "none") => ({
    id,
    name: id,
    line: "",
    bucket,
    founder: false,
    projectId: null,
  });

  it("keeps the design order and drops empty sections", () => {
    const sections = rosterSections({
      members: [member("mia", "daily"), member("leo", "weekly"), member("ivy", "none")],
      groups: [{ id: null, name: "Yuki", line: "", deleting: false }],
    });
    assert.deepEqual(
      sections.map((section) => section.label),
      ["每天", "每周", "没有例行", "群"],
    );
    assert.equal(sections[3]?.groups[0]?.id, null);
  });

  it("leaves out a frequency with nobody in it", () => {
    const sections = rosterSections({
      members: [member("ivy", "none")],
      groups: [],
    });
    assert.deepEqual(
      sections.map((section) => section.label),
      ["没有例行"],
    );
  });
});

describe("bucketsFromAgent", () => {
  it("reads the tasks bound to each account", () => {
    const buckets = bucketsFromAgent({
      tasks: [
        task({ input: { environmentId: "mia" }, repeatMinutes: 1440 }),
        task({ input: { environmentId: "leo" }, repeatMinutes: weekMinutes }),
        task({ input: { environmentId: "gone" }, status: "cancelled", repeatMinutes: 60 }),
      ],
    });
    assert.equal(buckets.get("mia"), "daily");
    assert.equal(buckets.get("leo"), "weekly");
    assert.equal(buckets.get("gone"), "none");
  });
});

describe("groupNeedCount", () => {
  it("counts only what stays in the group", () => {
    assert.equal(
      groupNeedCount([
        { kind: "review", account: null },
        { kind: "input", account: "晨报" },
        { kind: "account", account: null },
        { kind: "project", account: null },
        { kind: "unknown", account: null },
      ]),
      3,
    );
  });
});
