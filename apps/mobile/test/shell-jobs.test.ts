// The project's jobs and the account's own records as the
// owner reads them: the live panel's 活 rows, the account detail's 人设 and 手上的活, the chat's
// cards (a job declined with the three things he may say, a job done, a persona changed) and the
// job tools' lines, all in plain Chinese; and a report's notice survives the client's reading.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReport } from "../../../packages/client/src/chat-reports-core.ts";
import {
  normalizeAccountOperating,
  personaChanges,
  versionWho,
} from "../../../packages/client/src/shell/accounts/operating-core.ts";
import {
  accountGuide,
  accountJobLines,
  declinedSayings,
  jobPanelEmpty,
  jobRowLine,
  jobToolLine,
  jobToolView,
  normalizeJobDetail,
  normalizeJobs,
  noticeText,
  railJobs,
} from "../../../packages/client/src/shell/jobs/jobs-core.ts";
import { reportLabel, serverText } from "../../../packages/client/src/shell/strings.ts";
import { taskMenu } from "../../../packages/client/src/shell/task/detail-core.ts";
import type { ChatReport } from "../../../packages/domain/src/agent.ts";

const assignee = (envId: string, name: string, status: string, extra = {}) => ({
  envId,
  name,
  status,
  reason: null,
  note: null,
  ownerInsisted: false,
  at: "2026-10-14T08:00:00.000Z",
  live: true,
  ...extra,
});
const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `活 ${id}`,
  brief: "这周发两条",
  due: { text: "这周", at: null },
  everyone: false,
  assignees: [
    assignee("e1", "Nova", "taken"),
    assignee("e2", "Pop", "declined", { reason: "不合人设" }),
  ],
  status: "open",
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z",
  doneAt: null,
  archivedAt: null,
  closedReason: null,
  version: 3,
  ...extra,
});

test("the live panel's 活 rows: open jobs with due, who has them and how many work on them; archived ones folded", () => {
  const jobs = normalizeJobs([
    job("a"),
    job("b", { archivedAt: "2026-10-13T00:00:00.000Z", status: "done", brief: "" }),
    job("c", { everyone: true, due: null, assignees: [assignee("e1", "Nova", "assigned")] }),
    { title: "no id" },
  ]);
  assert.equal(jobs.length, 3);
  const { open, archived } = railJobs(jobs);
  assert.deepEqual(
    open.map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(
    archived.map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(jobRowLine(open[0]), {
    title: "活 a",
    detail: "这周 · 派给 Nova、Pop · 1 个在做 / 1 个没接",
  });
  assert.equal(jobRowLine(open[1]).detail, "所有号都接（现在：Nova） · 1 个在做");
});

test("the account detail's 手上的活 says where the account stands, with its own reason when it declined", () => {
  const jobs = normalizeJobs([
    job("a"),
    job("b", {
      archivedAt: "2026-10-13T00:00:00.000Z",
      assignees: [assignee("e2", "Pop", "done")],
    }),
    job("c", { assignees: [assignee("e2", "Pop", "dropped", { dropped: "moved" })] }),
  ]);
  assert.deepEqual(
    accountJobLines(jobs, "e2").map((line) => line.line),
    ["活 a · 这周 · 没接：不合人设", "活 c · 这周 · 号已移走", "活 b · 这周 · 做完了"],
  );
  assert.deepEqual(accountJobLines(jobs, "nobody"), []);
});

test("a job's detail reads defensively; its actions keep their links", () => {
  const detail = normalizeJobDetail({
    job: job("a"),
    actions: [
      {
        account: "Nova",
        environmentId: "e1",
        site: "forum.example.com",
        action: "post",
        permalink: "https://forum.example.com/t/1",
        target: null,
        at: "2026-10-14T09:00:00.000Z",
      },
      { account: "x" },
    ],
  });
  assert.equal(detail?.job.assignees[1].reason, "不合人设");
  assert.equal(detail?.actions.length, 1);
  assert.equal(normalizeJobDetail({}), null);
});

test("the chat's cards: a declined job with three sayings, a job done, a persona changed; the notice survives reading", () => {
  const raw = {
    id: "r1",
    taskId: "loop",
    threadId: "main",
    createdAt: "2026-10-14T09:00:00.000Z",
    title: "Job declined",
    text: "Pop 没接",
    notice: {
      kind: "job_declined",
      jobId: "j1",
      jobTitle: "接 B 品牌",
      environmentId: "e2",
      account: "Pop",
      reason: "Pop 只聊摄影",
      bogus: 1,
    },
  };
  const report = normalizeReport(raw) as ChatReport;
  assert.deepEqual(report.notice, {
    kind: "job_declined",
    jobId: "j1",
    jobTitle: "接 B 品牌",
    environmentId: "e2",
    account: "Pop",
    reason: "Pop 只聊摄影",
  });
  assert.equal(
    noticeText(report),
    "Pop 没接「接 B 品牌」：Pop 只聊摄影。要换个号，或者改改它的人设，跟我说一声就行。",
  );
  const sayings = declinedSayings(report.notice as NonNullable<ChatReport["notice"]>);
  assert.deepEqual(
    sayings.map((item) => [item.label, item.text, item.send]),
    [
      ["换个号", "「接 B 品牌」换个号来做，别让 Pop 接了。", true],
      ["改人设", "把 Pop 的人设改一下：", false],
      ["还是让它接", "还是让 Pop 接「接 B 品牌」。", true],
    ],
  );
  assert.equal(
    noticeText({ text: "", notice: { kind: "job_done", jobId: "j1", jobTitle: "推 S" } }),
    "「推 S」做完了，已归档。",
  );
  // Taking a job the owner gave again after its reason: the card says it took it.
  assert.equal(
    noticeText({
      text: "",
      notice: { kind: "job_taken", jobId: "j1", jobTitle: "接 B 品牌", account: "Pop" },
    }),
    "Pop 接了「接 B 品牌」。",
  );
  assert.equal(
    noticeText({
      text: "",
      notice: {
        kind: "persona",
        account: "Nova",
        version: 3,
        changed: ["voice", "boundaries"],
        reason: "她最近的帖子更冷幽默",
      },
    }),
    "Nova 的人设更新到第 3 版：说话方式、不碰什么，她最近的帖子更冷幽默。",
  );
  // A reason that ends with its own full stop is not given a second one.
  assert.equal(
    noticeText({ text: "", notice: { ...report.notice, reason: "接了会不像它自己。" } }),
    "Pop 没接「接 B 品牌」：接了会不像它自己。要换个号，或者改改它的人设，跟我说一声就行。",
  );
  // Against the project's jobs, the sayings stay only while the job is open and still declined.
  const declinedJob = job("j1", {
    title: "接 B 品牌",
    assignees: [assignee("e2", "Pop", "declined", { reason: "Pop 只聊摄影" })],
  });
  const ofNotice = report.notice as NonNullable<ChatReport["notice"]>;
  const jobs = (extra: Record<string, unknown>) => normalizeJobs([{ ...declinedJob, ...extra }]);
  assert.equal(declinedSayings(ofNotice, jobs({})).length, 3);
  for (const over of [
    { status: "done", archivedAt: "2026-10-14T10:00:00.000Z" },
    { assignees: [assignee("e2", "Pop", "taken", { ownerInsisted: true })] },
    { assignees: [assignee("e2", "Pop", "dropped")] },
  ])
    assert.deepEqual(declinedSayings(ofNotice, jobs(over)), [], JSON.stringify(over));
  assert.deepEqual(declinedSayings(ofNotice, []), [], "a job it cannot see");
  // An unknown kind is no notice: the report reads as an ordinary one.
  assert.equal(normalizeReport({ ...raw, notice: { kind: "other" } })?.notice, undefined);
  assert.equal(reportLabel("Job declined"), "没接活");
  assert.equal(reportLabel("Job done"), "活做完了");
});

test("the chat's job tools read as the capybara's lines", () => {
  const made = jobToolView(
    JSON.stringify({
      jobId: "j1",
      title: "推 S",
      everyone: false,
      reason: "两个号都聊视频",
      accounts: [
        { name: "Nova", status: "assigned" },
        { name: "Pop", status: "assigned" },
      ],
    }),
  );
  assert.equal(jobToolLine("create_job", made), "新活「推 S」派给了 Nova、Pop。");
  assert.equal(made.reason, "两个号都聊视频");
  assert.equal(
    jobToolLine("create_job", { ...made, everyone: true }),
    "新活「推 S」派给了这个群的所有号，之后加进来的号也接。",
  );
  assert.equal(
    jobToolLine("assign_job", { ...made, insisted: ["Pop"] }),
    "「推 S」又派给了 Pop：它会知道你看过它的理由。",
  );
  assert.equal(jobToolLine("close_job", made), "「推 S」结束了，已归档。");
  assert.equal(jobToolView({ error: "Job not found" }).error, "Job not found");
  assert.equal(serverText("Job not found"), "找不到这件活。");
  assert.equal(serverText("New job"), "新的活");
  assert.equal(serverText("note\nRuns again now: a new job"), "note\n有新的活，马上再跑");
});

test("the timeline's persona and sibling lines read in plain Chinese", () => {
  assert.equal(
    serverText(
      "v1: who, voice, background, boundaries\nreason: 第一版\nset by the owner, left as they are: boundaries",
    ),
    "第 1 版：是谁、说话方式、背景、不碰什么\n理由：第一版\n你手动定的保持不变：不碰什么",
  );
  assert.equal(serverText("nothing written"), "没有改动：这几项是你手动定的");
  assert.equal(
    serverText("Upvoted\n[sibling touched: Nova_Harrison https://forum.example.com/t/1/r/2]"),
    "Upvoted\n碰到自己人：Nova_Harrison https://forum.example.com/t/1/r/2",
  );
  assert.equal(serverText("[sibling touched: Pine_Example_3]"), "碰到自己人：Pine_Example_3");
  assert.equal(
    serverText("[same place as Pine_Example_3: https://forum.example.com/t/1]"),
    "和 Pine_Example_3 进了同一处：https://forum.example.com/t/1",
  );
  assert.equal(reportLabel("Persona v2"), "人设第 2 版");
  assert.equal(reportLabel("Plan v1"), "计划第 1 版");
});

test("the persona in the account detail: who set each part, versions, and only the parts the owner changed are sent", () => {
  const view = normalizeAccountOperating({
    persona: {
      id: "persona",
      version: 2,
      fields: {
        who: { value: "伦敦的独立剪辑师", source: "owner", by: { userId: "u1" }, reason: null },
        voice: {
          value: "冷幽默",
          source: "ai",
          by: { taskId: "t", title: "经营 · Nova" },
          reason: "她的旧帖",
        },
        background: null,
        boundaries: null,
      },
    },
    personaVersions: [
      {
        version: 1,
        fields: {},
        source: "ai",
        by: { taskId: "t", title: "经营 · Nova" },
        at: "2026-10-14T08:00:00.000Z",
      },
      {
        version: 2,
        fields: {},
        source: "owner",
        by: { userId: "u1" },
        at: "2026-10-14T09:00:00.000Z",
      },
      {
        version: 3,
        fields: {},
        source: "owner",
        by: { userId: "u1" },
        restoredFrom: 1,
        at: "2026-10-14T10:00:00.000Z",
      },
    ],
    goal: { text: "运营电影剪辑社区", setAt: "2026-10-14T08:00:00.000Z" },
    plan: null,
  });
  assert.equal(view.persona?.parts.voice?.source, "ai");
  assert.deepEqual(
    view.personaVersions.map((version) => versionWho(version)),
    ["用回第 1 版", "你改的", "任务「经营 · Nova」写的"],
  );
  assert.equal(view.goal?.text, "运营电影剪辑社区");
  // The owner only rewrote "who" and emptied nothing else: the AI's "voice" stays the AI's.
  assert.deepEqual(
    personaChanges(view.persona?.parts ?? null, {
      who: "住伦敦的独立剪辑师",
      voice: "冷幽默",
      background: "",
      boundaries: "不碰政治",
    }),
    { who: "住伦敦的独立剪辑师", boundaries: "不碰政治" },
  );
  assert.deepEqual(
    personaChanges(view.persona?.parts ?? null, {
      who: "伦敦的独立剪辑师",
      voice: "",
      background: "",
      boundaries: "",
    }),
    { voice: null },
  );
  assert.equal(normalizeAccountOperating({}).persona, null);
});

test("Cancel on an account's loop reads 停止经营, and a loop has no interval to change", () => {
  const loop = { kind: "agent" as const, status: "scheduled" as const, repeatMinutes: null };
  assert.deepEqual(
    taskMenu({ ...loop, input: { environmentId: "e1", accountLoop: true } }).map((item) => [
      item.op,
      item.label,
    ]),
    [["cancel", "停止经营"]],
  );
  assert.deepEqual(
    taskMenu({ ...loop, input: {} }).map((item) => item.op),
    ["interval", "cancel"],
  );
});

test("a job made with no account yet guides the owner: add an account, then one saying hands it the job and asks for its sign-ins", () => {
  const made = jobToolView({
    jobId: "j1",
    title: "提高仓库的影响力",
    everyone: true,
    status: "open",
    accounts: [],
    waitsForFirstAccount: true,
  });
  assert.equal(made.waitsForFirstAccount, true);
  assert.deepEqual(accountGuide("create_job", made, [], false), { stage: "add" });
  // Still loading the project's accounts: nothing yet rather than a wrong prompt.
  assert.deepEqual(accountGuide("create_job", made, [], true), { stage: "none" });
  const ready = accountGuide("create_job", made, [{ name: "acct-1" }], false);
  assert.equal(ready.stage, "ready");
  assert.ok(ready.stage === "ready" && ready.say.includes("acct-1"));
  assert.ok(ready.stage === "ready" && ready.say.includes("提高仓库的影响力"));
  assert.ok(ready.stage === "ready" && ready.say.includes("登录卡"));
  // Only under create_job, only while the job waits and is open.
  assert.deepEqual(accountGuide("assign_job", made, [], false), { stage: "none" });
  assert.deepEqual(
    accountGuide("create_job", { ...made, waitsForFirstAccount: false }, [], false),
    { stage: "none" },
  );
  assert.deepEqual(accountGuide("create_job", { ...made, status: "done" }, [], false), {
    stage: "none",
  });
});

test("a job that is gone says so once; a read that failed says only why", () => {
  assert.deepEqual(jobPanelEmpty({ loading: true, gone: false, error: "" }), {
    title: "正在读取这件活…",
    line: "",
    error: "",
  });
  // The server's 404: one line, not also its 「找不到这件活。」, and the title is the panel's.
  assert.deepEqual(jobPanelEmpty({ loading: false, gone: true, error: "" }), {
    title: "活",
    line: "这件活已经不在了。",
    error: "",
  });
  // No network: the job may still be there, so it is not called gone.
  assert.deepEqual(jobPanelEmpty({ loading: false, gone: false, error: "连不上服务器" }), {
    title: "活",
    line: "",
    error: "连不上服务器",
  });
});
