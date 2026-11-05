import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appsToConnect,
  capReportTasks,
  clockZoneNote,
  dropGuidedAccountNeeds,
  dutyText,
  goalRoutines,
  groupMemberMark,
  latestReportFor,
  loadedTaskReports,
  memberRoutines,
  memoriesForMember,
  newestReportSentence,
  queuedClockWake,
  recentReportsFor,
  routineSwitch,
  taskIdsForMember,
  taskReportPollMs,
  usageDayLabel,
} from "../packages/client/src/shell/members/member-detail.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { memoriesForRun } from "../packages/domain/src/member-thread.ts";

const task = (patch: Record<string, unknown>) =>
  ({
    id: "t",
    title: "看竞品价格",
    status: "scheduled",
    repeatMinutes: null,
    input: {},
    state: {},
    ...patch,
  }) as unknown as AgentTask;

describe("memberRoutines", () => {
  it("keeps a repeating task and a standing loop, and drops a finished task", () => {
    const routines = memberRoutines([
      task({ id: "daily", repeatMinutes: 1440 }),
      task({ id: "loop", title: "日常运营", status: "running", input: { accountLoop: true } }),
      task({ id: "done", status: "succeeded", repeatMinutes: 60 }),
    ]);
    assert.deepEqual(
      routines.map((routine) => routine.id),
      ["daily", "loop"],
    );
    assert.equal(routines[0]?.when, "每天");
    assert.equal(routines[0]?.on, true);
    assert.equal(routines[0]?.ready, true);
    assert.equal(routines[1]?.ready, false);
  });

  it("keeps the clock written on the routine", () => {
    const [routine] = memberRoutines([
      task({
        repeatMinutes: 1440,
        prompt: "早上交一页摘要。\n什么时候：每天 7:30",
      }),
    ]);
    assert.equal(routine?.when, "每天 7:30");
  });

  it("reads a paused routine as off", () => {
    const [routine] = memberRoutines([task({ status: "paused", repeatMinutes: 10080 })]);
    assert.equal(routine?.on, false);
    assert.equal(routine?.when, "每 7 天");
  });
});

describe("usageDayLabel", () => {
  it("reads the server's day as a short date", () => {
    assert.equal(usageDayLabel("2026-11-02"), "11月2日");
    assert.equal(usageDayLabel("nope"), "nope");
  });
});

describe("dutyText", () => {
  it("joins the parts that are written and skips the empty ones", () => {
    assert.equal(
      dutyText({ who: "负责调研", background: "", boundaries: "不猜" }),
      "负责调研\n不猜",
    );
    assert.equal(dutyText(null), "");
  });
});

describe("latestReportFor", () => {
  it("keeps the newest report of that routine", () => {
    const latest = latestReportFor(
      [
        { taskId: "daily", createdAt: "2026-11-01T01:00:00.000Z", title: "old" },
        { taskId: "other", createdAt: "2026-11-01T09:00:00.000Z", title: "other" },
        { taskId: "daily", createdAt: "2026-11-01T08:00:00.000Z", title: "new" },
      ],
      "daily",
    );
    assert.equal(latest?.title, "new");
    assert.equal(latestReportFor([], "daily"), null);
    assert.deepEqual(
      recentReportsFor(
        [
          { taskId: "daily", createdAt: "2026-11-01T01:00:00.000Z", title: "old" },
          { taskId: "daily", createdAt: "2026-11-01T08:00:00.000Z", title: "new" },
          { taskId: "daily", createdAt: "2026-11-01T04:00:00.000Z", title: "mid" },
        ],
        "daily",
        2,
      ).map((report) => report.title),
      ["new", "mid"],
    );
  });
});

describe("taskIdsForMember", () => {
  it("keeps the tasks on this member's desktop", () => {
    const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(
      taskIdsForMember(tasks, "mia", (item) => (item.id === "b" ? "ivy" : "mia")),
      ["a", "c"],
    );
  });
});

describe("taskIdsForMember, cancelled and many", () => {
  it("leaves out cancelled tasks, which never report again", () => {
    const tasks = [
      { id: "a", status: "scheduled" },
      { id: "b", status: "cancelled" },
      { id: "c", status: "paused" },
    ];
    assert.deepEqual(
      taskIdsForMember(tasks, "mia", () => "mia"),
      ["a", "c"],
    );
  });
  it("reads the newest twenty tasks of a member at most", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const kept = capReportTasks(ids);
    assert.equal(kept.length, 20);
    assert.equal(kept[19], "t49");
    assert.deepEqual(capReportTasks(["a", "b"]), ["a", "b"]);
  });
  it("slows the per-task read round down with the number of tasks, so fifty routines stay under the rate limit", () => {
    assert.equal(taskReportPollMs(1, 5000), 5000);
    assert.equal(taskReportPollMs(1, 5000), 5000);
    assert.equal(taskReportPollMs(20, 5000), 100000);
    assert.equal(taskReportPollMs(50, 15000), 250000);
    // requests per minute from one poll: tasks per round / round length
    for (const n of [1, 5, 20, 50])
      assert.ok((n * 60000) / taskReportPollMs(n, 5000) <= 12 + 1e-9 || n < 2);
  });
});

describe("routineSwitch", () => {
  it("pauses a routine that is on and resumes one that is off", () => {
    assert.equal(routineSwitch(true), "pause");
    assert.equal(routineSwitch(false), "resume");
  });
});

describe("newestReportSentence", () => {
  it("keeps her newest result as one line", () => {
    const text = newestReportSentence(
      [
        { taskId: "daily", createdAt: "2026-11-01T00:00:00.000Z", text: "旧的", title: "" },
        {
          taskId: "daily",
          createdAt: "2026-11-02T00:00:00.000Z",
          text: "早报好了\n第二行",
          title: "完成",
        },
        { taskId: "other", createdAt: "2026-11-03T00:00:00.000Z", text: "别人的", title: "" },
      ],
      "daily",
    );
    assert.equal(text, "早报好了");
    assert.equal(newestReportSentence([], "daily"), "");
    assert.equal(
      newestReportSentence(
        [{ taskId: "daily", createdAt: "t", text: "Finished", title: "Finished" }],
        "daily",
      ),
      "",
    );
    assert.equal(
      newestReportSentence(
        [{ taskId: "daily", createdAt: "t", text: "字".repeat(90) }],
        "daily",
      ).endsWith("…"),
      true,
    );
  });
});

describe("loadedTaskReports", () => {
  it("keeps the pages that loaded and leaves the screen alone when every page failed", () => {
    assert.deepEqual(loadedTaskReports([[{ id: "a" }], null, [{ id: "b" }]]), [
      { id: "a" },
      { id: "b" },
    ]);
    assert.equal(loadedTaskReports([null, null]), null);
    assert.deepEqual(loadedTaskReports([]), []);
  });
});

describe("groupMemberMark", () => {
  it("puts a need ahead of a running desktop, and keeps a quieter line otherwise", () => {
    assert.deepEqual(groupMemberMark({ state: "needs", line: "无代理", desktop: "running" }), {
      tone: "wait",
      text: "等你",
    });
    assert.deepEqual(groupMemberMark({ state: "running", line: "正在做", desktop: "running" }), {
      tone: "desk",
      text: "在用电脑",
    });
    assert.deepEqual(groupMemberMark({ state: "idle", line: "停着", desktop: "stopped" }), {
      tone: "plain",
      text: "停着",
    });
    assert.equal(groupMemberMark({ state: "idle", line: "  ", desktop: "absent" }).text, "空闲");
  });
});

describe("dropGuidedAccountNeeds", () => {
  it("hides an account need whose guide card is already in the conversation", () => {
    const needs = [
      { kind: "account", account: { id: "mia" } },
      { kind: "task", id: "q" },
      { kind: "account", account: { id: "ivy" } },
    ];
    const left = dropGuidedAccountNeeds(needs, new Set(["mia"]), (item) =>
      item.kind === "account" ? (item.account?.id ?? null) : null,
    );
    assert.deepEqual(
      left.map((item) => item.kind),
      ["task", "account"],
    );
    assert.equal(left[1] && "account" in left[1] ? left[1].account?.id : "", "ivy");
  });
});

describe("memoriesForMember", () => {
  it("keeps facts remembered on this member's desktop", () => {
    const memories = [
      { text: "你喜欢表格", accountId: "mia" },
      { text: "全项目的事" },
      { text: "付费墙标待核", accountId: "ivy" },
    ];
    assert.deepEqual(
      memoriesForMember(memories, "mia").map((memory) => memory.text),
      ["你喜欢表格"],
    );
  });
});

describe("queuedClockWake", () => {
  it("waits for a written clock only when the task has never run", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const task = {
      status: "queued",
      prompt: "交一页摘要\n什么时候：每天 7:30",
    };
    assert.equal(queuedClockWake(task, "Asia/Shanghai", now), "2026-11-04T23:30:00.000Z");
    assert.equal(queuedClockWake(task, "", now), null);
    assert.equal(
      queuedClockWake({ ...task, nextRunAt: now.toISOString() }, "Asia/Shanghai", now),
      null,
    );
    assert.equal(
      queuedClockWake({ ...task, prompt: "什么时候：每 4 小时" }, "Asia/Shanghai", now),
      null,
    );
  });
});

describe("memoriesForRun", () => {
  it("keeps unscoped facts and hers, and drops another account's", () => {
    const memories = [
      { text: "全项目", accountId: null },
      { text: "她的", accountId: "mia" },
      { text: "别人的", accountId: "ivy" },
      { text: "没标" },
    ];
    assert.deepEqual(
      memoriesForRun(memories, "mia").map((memory) => memory.text),
      ["全项目", "她的", "没标"],
    );
    assert.deepEqual(
      memoriesForRun(memories, null).map((memory) => memory.text),
      ["全项目", "没标"],
    );
  });
});

describe("goalRoutines", () => {
  it("keeps routines the clock cannot run and skips the apps line", () => {
    assert.deepEqual(
      goalRoutines(
        "夜里巡一遍。\n要连接：gmail\n盯报错（有报错时）：看日志\n月报（每月 1 日 10:00）：交一页",
      ),
      [
        { title: "盯报错", when: "有报错时" },
        { title: "月报", when: "每月 1 日 10:00" },
      ],
    );
    assert.deepEqual(goalRoutines(null), []);
  });
});

describe("appsToConnect", () => {
  it("reads the template line and ignores the rest of the goal", () => {
    assert.equal(
      appsToConnect("夜里巡一遍。\n要连接：gmail、google-calendar、slack\n来信才做"),
      "gmail、google-calendar、slack",
    );
    assert.equal(appsToConnect("没有这一行"), "");
    assert.equal(appsToConnect(null), "");
  });
});

describe("clockZoneNote", () => {
  it("names the account's zone for a written clock only", () => {
    assert.equal(clockZoneNote("每天 7:30", "Asia/Shanghai"), "按 Asia/Shanghai");
    assert.equal(clockZoneNote("每周一 9:00", " Europe/Paris "), "按 Europe/Paris");
    assert.equal(clockZoneNote("每 4 小时", "Asia/Shanghai"), "");
    assert.equal(clockZoneNote("每天 7:30", ""), "");
    assert.equal(clockZoneNote("每天 7:30", null), "");
  });
});
