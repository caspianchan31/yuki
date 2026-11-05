import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memberTemplateById } from "../packages/domain/src/member-templates.ts";
import {
  firstRunPlan,
  nextClockRun,
  repeatMinutesOfWhen,
  templateRoutineLine,
  templateSetup,
} from "../packages/domain/src/template-setup.ts";

describe("repeatMinutesOfWhen", () => {
  it("reads the intervals the templates use", () => {
    assert.equal(repeatMinutesOfWhen("每天 7:30"), 1440);
    assert.equal(repeatMinutesOfWhen("每 4 小时"), 240);
    assert.equal(repeatMinutesOfWhen("每周一 9:00"), 10080);
    assert.equal(repeatMinutesOfWhen("有新的调研任务时"), null);
    assert.equal(repeatMinutesOfWhen("每月 1 日 10:00"), null);
  });
});

describe("nextClockRun", () => {
  const now = new Date("2026-11-04T00:00:00.000Z");

  it("picks the next written clock in the time zone", () => {
    assert.equal(nextClockRun("每天 7:30", "UTC", now), "2026-11-04T07:30:00.000Z");
    assert.equal(nextClockRun("每周一 9:00", "UTC", now), "2026-11-09T09:00:00.000Z");
    assert.equal(nextClockRun("每天 7:30", "Asia/Shanghai", now), "2026-11-04T23:30:00.000Z");
    assert.equal(nextClockRun("每周一 9:00", "Asia/Shanghai", now), "2026-11-09T01:00:00.000Z");
    assert.equal(nextClockRun("每 4 小时", "UTC", now), null);
    assert.equal(nextClockRun("每天 7:30", "", now), null);
  });

  it("schedules a first wake only when it is soon and still ahead", () => {
    const at = "2026-11-09T09:00:00.000Z";
    assert.equal(firstRunPlan(at, now.getTime())?.status, "scheduled");
    assert.equal(firstRunPlan(at, now.getTime())?.nextRunAt, at);
    assert.equal(firstRunPlan(now.toISOString(), now.getTime()), null);
    assert.equal(firstRunPlan("not-a-date"), null);
  });
});

describe("templateRoutineLine", () => {
  it("marks a routine that cannot be scheduled", () => {
    assert.equal(
      templateRoutineLine({ title: "汇总一周动态", when: "每周一 9:00" }),
      "汇总一周动态（每周一 9:00，填了时区才按这个钟点）",
    );
    assert.equal(
      templateRoutineLine({ title: "汇总一周动态", when: "每周一 9:00" }, "UTC"),
      "汇总一周动态（每周一 9:00）",
    );
    assert.equal(
      templateRoutineLine({ title: "接一个调研问题", when: "有新的调研任务时" }),
      "接一个调研问题（有新的调研任务时，记在目标里）",
    );
  });
});

describe("templateSetup", () => {
  it("writes the persona, the apps, and a task per scheduled routine", () => {
    const template = memberTemplateById("morning-brief");
    assert.ok(template);
    const setup = templateSetup(template, "env-1");
    assert.equal(setup.persona.who, template.role);
    assert.match(setup.goal, /要连接：gmail/);
    assert.deepEqual(
      setup.tasks.map((task) => [task.title, task.repeatMinutes, task.input.environmentId]),
      [
        ["出一页晨报", 1440, "env-1"],
        ["白天补一次变化", 240, "env-1"],
      ],
    );
  });

  it("keeps a routine with no interval in the goal", () => {
    const template = memberTemplateById("researcher");
    assert.ok(template);
    const setup = templateSetup(template, "env-2");
    assert.equal(setup.tasks.length, 1);
    assert.match(setup.goal, /接一个调研问题（有新的调研任务时）/);
  });
});
