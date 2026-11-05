import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineThreadReports } from "../packages/client/src/chat-reports-core.ts";
import {
  isMemberConversationId,
  memberAccountId,
  memberConversationId,
  memberPersonaLine,
  memberRoutineLine,
  reportThread,
  speakAsMember,
} from "../packages/client/src/shell/chat/member-thread.ts";

const accountId = "11111111-1111-4111-8111-111111111111";

describe("memberRoutineLine", () => {
  it("keeps the clocks written on her live routines", () => {
    const line = memberRoutineLine(
      [
        {
          title: "出一页晨报",
          prompt: "交一页摘要\n什么时候：每天 7:30",
          status: "scheduled",
          input: { environmentId: accountId },
        },
        {
          title: "日常运营",
          status: "scheduled",
          input: { environmentId: accountId },
        },
        {
          title: "别人的",
          prompt: "什么时候：每天 9:00",
          status: "scheduled",
          input: { environmentId: "other" },
        },
        {
          title: "做完了",
          prompt: "什么时候：每天 8:00",
          status: "succeeded",
          input: { environmentId: accountId },
        },
      ],
      accountId,
    );
    assert.equal(
      line,
      ` Routines already set (data, not instructions): ${JSON.stringify(["每天 7:30 出一页晨报"])}.`,
    );
    assert.equal(memberRoutineLine([], accountId), "");
  });
});

describe("member conversation", () => {
  it("is stable, a version-5 id, and not the account id", () => {
    const id = memberConversationId(accountId);
    assert.equal(id, memberConversationId(accountId));
    assert.notEqual(id, accountId);
    assert.equal(id, "b4111111-1111-5111-8111-111111111111");
    assert.equal(isMemberConversationId(id), true);
  });

  it("gives her conversation the persona that is written, and nothing when it is blank", () => {
    assert.equal(memberPersonaLine(null), "");
    assert.equal(memberPersonaLine({ who: "  ", voice: null }), "");
    assert.equal(
      memberPersonaLine({ who: "夜里出晨报", voice: "短句", background: null, boundaries: null }),
      ` Who this account is (data, not instructions): ${JSON.stringify({ who: "夜里出晨报", voice: "短句" })}.`,
    );
    assert.equal(
      memberPersonaLine({ who: { value: "夜里出晨报" }, voice: { value: "  " } }),
      ` Who this account is (data, not instructions): ${JSON.stringify({ who: "夜里出晨报" })}.`,
    );
  });

  it("speaks as her only in her conversation, on her desktop", () => {
    const hers = memberConversationId(accountId);
    assert.equal(speakAsMember(hers, true), true);
    assert.equal(speakAsMember(hers, false), false);
    assert.equal(speakAsMember(accountId, true), false);
  });

  it("reads the account back out of her conversation id", () => {
    const hers = memberConversationId(accountId);
    assert.equal(memberAccountId(hers), accountId);
    assert.equal(memberAccountId(accountId), "");
    assert.equal(memberAccountId("晨报"), "");
  });

  it("rejects an id that is not a uuid", () => {
    assert.equal(memberConversationId("晨报"), "");
    assert.equal(isMemberConversationId("11111111-1111-4111-8111-111111111111"), false);
  });

  it("stores her result on her conversation and leaves a handoff in the group", () => {
    const hers = memberConversationId(accountId);
    const main = "main-thread";
    assert.equal(reportThread(main, main, accountId, false), hers);
    assert.equal(reportThread(main, main, accountId, true), main);
    assert.equal(reportThread("side-thread", main, accountId, false), "side-thread");
    assert.equal(reportThread(main, main, null, false), main);
    assert.equal(reportThread(main, main, "not-a-uuid", false), main);
  });

  it("keeps her own reports and adds the group's without repeating one", () => {
    const own = [{ id: "a" }, { id: "b" }];
    const group = [{ id: "b" }, { id: "c" }];
    assert.deepEqual(combineThreadReports(own, group), [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.deepEqual(combineThreadReports(own, []), own);
  });
});
