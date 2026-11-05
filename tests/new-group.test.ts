// v1.2: the new-group dialog's rules: who can be picked, how many, the checks before sending, and
// the moves that put members in the group (two requests for a member who is in another group).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allMembers,
  canPick,
  failureLines,
  groupChoices,
  groupError,
  groupMembersMax,
  groupNameProblem,
  moveMembersInto,
  newGroupProblem,
  togglePick,
} from "../packages/client/src/shell/members/groups.ts";
import { rosterSections } from "../packages/client/src/shell/members/roster.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

describe("allMembers and groupChoices", () => {
  const members = allMembers({
    accounts: [
      { id: "ann", name: "Ann", projectId: null },
      { id: "bob", name: "Bob", projectId: A },
    ],
    environments: [
      { id: "bob", name: "Bob", projectId: A },
      { id: "cai", name: "Cai", projectId: B },
    ],
  });

  it("lists each member once, the open project's first", () => {
    assert.deepEqual(
      members.map((member) => member.id),
      ["ann", "bob", "cai"],
    );
  });

  it("says which group the others are in", () => {
    const choices = groupChoices(members, (id) => (id === A ? "写作群" : "运营群"));
    assert.deepEqual(
      choices.map((choice) => [choice.id, choice.group]),
      [
        ["ann", null],
        ["bob", "写作群"],
        ["cai", "运营群"],
      ],
    );
  });
});

describe("picking", () => {
  it("takes a member out when she is picked again", () => {
    assert.deepEqual(togglePick(["a", "b"], "a"), ["b"]);
  });

  it("stops at the limit and keeps the picks", () => {
    const full = ["1", "2", "3", "4", "5", "6"];
    assert.equal(groupMembersMax, 6);
    assert.deepEqual(togglePick(full, "7"), full);
    assert.equal(canPick(full, "7"), false);
    assert.equal(canPick(full, "3"), true, "a picked member can still be taken out");
    assert.equal(canPick(full.slice(0, 5), "7"), true);
  });
});

describe("the checks before sending", () => {
  it("asks for a name, within the limit, not the reserved ones", () => {
    assert.match(groupNameProblem("  ") ?? "", /群名必填/);
    assert.match(groupNameProblem("x".repeat(65)) ?? "", /最多 64/);
    assert.match(groupNameProblem("default") ?? "", /保留名/);
    assert.equal(groupNameProblem("写作群"), null);
  });

  it("asks for 2 to 6 members", () => {
    assert.match(newGroupProblem("写作群", ["a"]) ?? "", /至少选 2/);
    assert.equal(newGroupProblem("写作群", ["a", "b"]), null);
    assert.match(newGroupProblem("写作群", ["1", "2", "3", "4", "5", "6", "7"]) ?? "", /最多 6/);
  });

  it("words the server's refusals in Chinese", () => {
    assert.match(groupError('A project named "写作群" already exists'), /已经有叫「写作群」的群/);
    assert.match(groupError("Projects are limited to 20"), /群最多 20 个/);
    assert.equal(groupError("一个群最多 6 个成员"), "一个群最多 6 个成员");
  });
});

describe("moveMembersInto", () => {
  const call =
    (log: string[]) =>
    async (id: string, step: { header: string | null; projectId: string | null }) => {
      log.push(`${id}:${step.header ?? "-"}>${step.projectId ?? "-"}`);
    };

  it("moves a free member in one request and one from another group in two", async () => {
    const log: string[] = [];
    const result = await moveMembersInto(
      NEW,
      [
        { id: "ann", name: "Ann", from: null },
        { id: "bob", name: "Bob", from: A },
      ],
      call(log),
      String,
    );
    assert.deepEqual(log, [`ann:${NEW}>${NEW}`, `bob:${A}>-`, `bob:${NEW}>${NEW}`]);
    assert.deepEqual(result.moved, ["ann", "bob"]);
    assert.deepEqual(result.failed, []);
  });

  it("reports a refusal, leaves her in no group when the second step failed, and goes on", async () => {
    const log: string[] = [];
    const send = async (id: string, step: { header: string | null; projectId: string | null }) => {
      log.push(`${id}:${step.projectId ?? "-"}`);
      if (id === "bob" && step.projectId === NEW) throw new Error("一个群最多 6 个成员");
      if (id === "cai") throw new Error("账号不存在");
    };
    const result = await moveMembersInto(
      NEW,
      [
        { id: "bob", name: "Bob", from: A },
        { id: "cai", name: "Cai", from: null },
        { id: "dan", name: "Dan", from: null },
      ],
      send,
      (e) => (e instanceof Error ? e.message : String(e)),
    );
    assert.deepEqual(result.moved, ["dan"]);
    assert.deepEqual(
      result.failed.map((item) => [item.id, item.stuck, item.from]),
      [
        ["bob", true, null],
        ["cai", false, null],
      ],
    );
    assert.deepEqual(failureLines(result), [
      "Bob：已经从原来的群出来了，但没能进新群（一个群最多 6 个成员）。",
      "Cai：账号不存在",
    ]);
  });
});

describe("the contact list's 群 section", () => {
  it("stays with no group when asked to, so 新建群 has a place", () => {
    assert.deepEqual(
      rosterSections({ members: [], groups: [], keepGroups: true }).map((section) => section.key),
      ["groups"],
    );
    assert.deepEqual(rosterSections({ members: [], groups: [] }), []);
  });
});
