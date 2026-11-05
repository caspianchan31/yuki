import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { needsForMember } from "../packages/client/src/shell/members/member-detail.ts";

describe("needsForMember", () => {
  const needs = [
    { id: "q", who: "nova" },
    { id: "r", who: "mia" },
    { id: "loose", who: null },
  ];
  const who = (item: { who: string | null }) => item.who;

  it("keeps the open member's needs", () => {
    assert.deepEqual(
      needsForMember(needs, "nova", who).map((item) => item.id),
      ["q"],
    );
  });

  it("keeps only unplaced needs when no member is open", () => {
    assert.deepEqual(
      needsForMember(needs, null, who).map((item) => item.id),
      ["loose"],
    );
  });
});
