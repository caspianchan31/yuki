// v1.4 (docs/skills.md): skills in the @ list: kind 技能, after the routines and before apps,
// filtered and written like the other names.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMention,
  filterMentions,
  type MentionSource,
  mentionOptions,
  mentionTrigger,
} from "../../../packages/client/src/shell/chat/mention.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";

const source = (patch: Partial<MentionSource> = {}): MentionSource => ({
  main: { id: "main", name: "Yuki" },
  members: [],
  groups: [{ id: "g1", name: "营销" }],
  tasks: [{ id: "r1", title: "每日巡检", repeatMinutes: 60, status: "scheduled" }],
  groupId: null,
  groupName: (id) => id,
  skills: [
    { id: "s1", name: "周报" },
    { id: "s2", name: "  " },
    { id: "s3", name: "报销单" },
  ],
  apps: [{ id: "a1", name: "Gmail" }],
  ...patch,
});

describe("skills in the @ list", () => {
  it("come after the routines and before the apps, blank names left out", () => {
    const options = mentionOptions(source());
    assert.deepEqual(
      options.map((option) => option.key),
      ["member:main", "group:g1", "routine:r1", "skill:s1", "skill:s3", "app:a1"],
    );
    assert.equal(options.find((option) => option.key === "skill:s1")?.kind, "skill");
    assert.equal(t.mention.kinds.skill, "技能");
  });

  it("are filtered by their words and written as @name", () => {
    const options = mentionOptions(source());
    assert.deepEqual(
      filterMentions(options, "报").map((option) => option.name),
      ["报销单", "周报"],
    );
    const trigger = mentionTrigger("做 @周", 4);
    assert.ok(trigger);
    assert.deepEqual(applyMention("做 @周", trigger, 4, "周报"), { text: "做 @周报 ", caret: 6 });
  });

  it("are optional: a source without skills lists none", () => {
    assert.ok(
      !mentionOptions(source({ skills: undefined })).some((option) => option.kind === "skill"),
    );
  });
});
