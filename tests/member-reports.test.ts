import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reportsForMember, simpleViewReports } from "../packages/client/src/chat-reports-core.ts";
import { memberConversationId } from "../packages/domain/src/member-thread.ts";

const report = (taskId: string) => ({
  taskId,
  kind: "outcome" as const,
  notice: undefined,
  project: undefined,
});
const handoff = (taskId: string) => ({
  taskId,
  kind: "report" as const,
  notice: { kind: "job_done" as const },
  project: undefined,
});

describe("reportsForMember", () => {
  const environmentOf = (taskId: string) => (taskId === "nova-task" ? "nova" : "mia");

  it("keeps every report when no member is open", () => {
    const reports = [report("nova-task"), report("mia-task")];
    assert.deepEqual(reportsForMember(reports, null, environmentOf), reports);
  });

  it("keeps only the open member's task reports", () => {
    const reports = [report("nova-task"), report("mia-task"), report("gone")];
    assert.deepEqual(
      reportsForMember(reports, "nova", (taskId) =>
        taskId === "gone" ? null : environmentOf(taskId),
      ).map((item) => item.taskId),
      ["nova-task"],
    );
  });
});

describe("simpleViewReports", () => {
  const environmentOf = (taskId: string) =>
    taskId === "nova-task" ? "nova" : taskId === "mia-task" ? "mia" : null;
  const reports = [report("nova-task"), report("mia-task"), handoff("handoff"), report("loose")];

  it("keeps only the open member's reports", () => {
    assert.deepEqual(
      simpleViewReports(reports, "nova", true, environmentOf).map((item) => item.taskId),
      ["nova-task"],
    );
  });

  it("keeps group speech and unplaced reports in the hall", () => {
    assert.deepEqual(
      simpleViewReports(reports, null, true, environmentOf).map((item) => item.taskId),
      ["handoff", "loose"],
    );
  });

  it("keeps the handoff in a project group while no member is open", () => {
    assert.deepEqual(
      simpleViewReports(reports, null, false, environmentOf).map((item) => item.taskId),
      ["handoff"],
    );
  });

  it("leaves a handoff about her task in the group", () => {
    const hers = report("nova-task");
    const line = handoff("nova-task");
    assert.deepEqual(
      simpleViewReports([hers, line], "nova", true, environmentOf).map((item) => item.kind),
      ["outcome"],
    );
    assert.deepEqual(
      simpleViewReports([hers, line], null, true, environmentOf).map(
        (item) => item.notice?.kind ?? item.kind,
      ),
      ["job_done"],
    );
  });

  it("keeps what she posted in her chat and out of the group", () => {
    const posted = {
      taskId: "nova-task",
      kind: "report" as const,
      notice: undefined,
      project: "营销总群",
    };
    assert.deepEqual(
      simpleViewReports([posted], "nova", true, environmentOf).map((item) => item.taskId),
      ["nova-task"],
    );
    assert.deepEqual(simpleViewReports([posted], null, true, environmentOf), []);
  });

  it("does not pull a write-up stored on her conversation back into the group", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const stored = {
      taskId: "gone",
      kind: "report" as const,
      notice: undefined,
      project: "营销总群",
      threadId: memberConversationId(accountId),
    };
    assert.deepEqual(
      simpleViewReports([stored], null, true, () => null),
      [],
    );
    assert.deepEqual(
      simpleViewReports([stored], "nova", true, () => null, stored.threadId).map(
        (item) => item.taskId,
      ),
      ["gone"],
    );
  });

  it("keeps a result written on her conversation after its task is gone", () => {
    const hers = { ...report("gone"), threadId: "her-thread" };
    const group = { ...report("loose"), threadId: "group" };
    assert.deepEqual(
      simpleViewReports([hers, group], "nova", true, () => null, "her-thread").map(
        (item) => item.taskId,
      ),
      ["gone"],
    );
  });
});
