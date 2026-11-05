import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assignedLine,
  groupKeepsOneLine,
  groupTaskLine,
  handoffLine,
  routineCreatedLine,
} from "../packages/client/src/shell/chat/handoff.ts";

describe("handoffLine", () => {
  it("says who took it", () => {
    assert.equal(
      handoffLine({ kind: "job_taken", account: "Mia", jobTitle: "看竞品价格" }),
      "Mia 接了「看竞品价格」",
    );
  });

  it("says the work came back when it is done", () => {
    assert.equal(
      handoffLine({ kind: "job_done", account: "Mia", jobTitle: "看竞品价格" }),
      "Mia 做完了「看竞品价格」，回到这里",
    );
  });

  it("is only for a handoff", () => {
    assert.equal(
      handoffLine({ kind: "job_declined", account: "Mia", jobTitle: "看竞品价格" }),
      null,
    );
  });

  it("says she created a routine", () => {
    assert.equal(
      routineCreatedLine("Mia", "每天", "看竞品价格"),
      "Mia 新建了例行 · 每天 看竞品价格",
    );
    assert.equal(routineCreatedLine("Mia", "", "看竞品价格"), "Mia 新建了例行 · 看竞品价格");
    assert.equal(routineCreatedLine("Mia", "每天", "  "), "");
  });

  it("says who was given the work", () => {
    assert.equal(
      assignedLine("Ann", "发版说明和试用邮件", ["Ivy"]),
      "Ann 把「发版说明和试用邮件」交给了 Ivy",
    );
    assert.equal(
      assignedLine("Ann", "发版说明", ["Ivy", "Leo"]),
      "Ann 把「发版说明」交给了 Ivy、Leo",
    );
    assert.equal(assignedLine("", "发版说明", ["Ivy"]), null);
  });

  it("keeps one line in the simple group and the card in the pro view", () => {
    assert.equal(
      groupKeepsOneLine(false, true, "Ann 把「标题」交给了 Ivy"),
      "Ann 把「标题」交给了 Ivy",
    );
    assert.equal(groupKeepsOneLine(true, true, "Ann 把「标题」交给了 Ivy"), null);
    assert.equal(groupKeepsOneLine(false, false, "Ann 把「标题」交给了 Ivy"), null);
    assert.equal(groupKeepsOneLine(false, true, "  "), null);
    assert.equal(groupTaskLine("Ann", "发版说明", []), "Ann 安排了「发版说明」");
    assert.equal(groupTaskLine("Ann", "发版说明", ["Ivy"]), "Ann 把「发版说明」交给了 Ivy");
  });
});
