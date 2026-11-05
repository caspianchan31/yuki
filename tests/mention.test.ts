// v1.2: the @ list under the chat box: when an @ opens it, what it lists, how it filters and what
// choosing a name writes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMention,
  filterMentions,
  type MentionSource,
  mentionOptions,
  mentionTrigger,
  moveMentionIndex,
} from "../packages/client/src/shell/chat/mention.ts";

describe("mentionTrigger", () => {
  it("opens on an @ at the start or after a space or line break", () => {
    assert.deepEqual(mentionTrigger("@", 1), { start: 0, query: "" });
    assert.deepEqual(mentionTrigger("请 @An", 5), { start: 2, query: "An" });
    assert.deepEqual(mentionTrigger("看一下\n@a", 7), { start: 4, query: "a" });
  });

  it("is not an email address, and not past the caret", () => {
    assert.equal(mentionTrigger("me@example.com", 14), null);
    assert.equal(mentionTrigger("hello", 5), null);
    assert.deepEqual(mentionTrigger("@Ann 你好", 4), { start: 0, query: "Ann" });
  });

  it("lets a name hold spaces but not a line break", () => {
    assert.deepEqual(mentionTrigger("@Ann L", 6), { start: 0, query: "Ann L" });
    assert.equal(mentionTrigger("@Ann\nL", 6), null);
    assert.equal(mentionTrigger(`@${"x".repeat(60)}`, 61), null);
  });
});

const source = (patch: Partial<MentionSource> = {}): MentionSource => ({
  main: { id: "main", name: "Yuki" },
  members: [
    { id: "ann", name: "Ann Lee", projectId: "g1" },
    { id: "bob", name: "Bob", projectId: "g2" },
    { id: "cai", name: "蔡", projectId: "g1" },
    { id: "dan", name: "Dan", projectId: null },
  ],
  groups: [
    { id: "g1", name: "写作群" },
    { id: "g2", name: "运营群" },
  ],
  tasks: [
    { id: "t1", title: "每天看评论", repeatMinutes: 1440, status: "scheduled" },
    { id: "t2", title: "一次性的活", repeatMinutes: null, status: "scheduled" },
    { id: "t3", title: "已结束的例行", repeatMinutes: 60, status: "succeeded" },
  ],
  groupId: "g1",
  groupName: (id) => (id === "g1" ? "写作群" : "运营群"),
  ...patch,
});

describe("mentionOptions", () => {
  it("lists this group's members, then Yuki and the others, the groups, then routines", () => {
    assert.deepEqual(
      mentionOptions(source()).map((option) => `${option.kind}:${option.name}`),
      [
        "member:Ann Lee",
        "member:蔡",
        "member:Yuki",
        "member:Bob",
        "member:Dan",
        "group:写作群",
        "group:运营群",
        "routine:每天看评论",
      ],
    );
  });

  it("works in a one-on-one or the main chat, with Yuki in the list and nobody ahead", () => {
    const options = mentionOptions(source({ groupId: null }));
    assert.equal(options[0]?.name, "Yuki");
    assert.ok(options.every((option) => !option.here));
  });

  it("marks a member of this group and names the group of the others", () => {
    const options = mentionOptions(source());
    assert.equal(options.find((option) => option.name === "Ann Lee")?.here, true);
    assert.equal(options.find((option) => option.name === "Bob")?.hint, "运营群");
    assert.equal(options.find((option) => option.name === "Dan")?.hint, "");
  });

  it("has no apps until a directory gives some", () => {
    assert.equal(
      mentionOptions(source()).some((option) => option.kind === "app"),
      false,
    );
    const withApps = mentionOptions(source({ apps: [{ id: "gmail", name: "Gmail" }] }));
    assert.equal(withApps.at(-1)?.kind, "app");
  });
});

describe("filterMentions", () => {
  const options = mentionOptions(source());

  it("keeps everything for an empty query", () => {
    assert.equal(filterMentions(options, "").length, options.length);
  });

  it("matches anywhere in the name, ignoring case, prefix first within a section", () => {
    assert.deepEqual(
      filterMentions(options, "n").map((option) => option.name),
      ["Ann Lee", "Dan"],
    );
    assert.deepEqual(
      filterMentions(options, "ann l").map((option) => option.name),
      ["Ann Lee"],
    );
  });

  it("never puts a later section ahead of this group's members", () => {
    const names = filterMentions(options, "a").map((option) => option.name);
    assert.ok(names.indexOf("Ann Lee") < names.indexOf("Dan"));
    assert.ok(names.indexOf("Dan") < names.indexOf("每天看评论") || !names.includes("每天看评论"));
  });

  it("finds Chinese names and routines", () => {
    assert.deepEqual(
      filterMentions(options, "评论").map((option) => option.key),
      ["routine:t1"],
    );
  });

  it("is empty when nothing matches", () => {
    assert.deepEqual(filterMentions(options, "zzz"), []);
  });
});

describe("applyMention", () => {
  it("writes @name and a space over the typed @ and its words, caret after", () => {
    const trigger = mentionTrigger("请 @An 看看", 5);
    assert.ok(trigger);
    const result = applyMention("请 @An 看看", trigger, 5, "Ann Lee");
    assert.equal(result.text, "请 @Ann Lee  看看");
    assert.equal(result.caret, "请 @Ann Lee ".length);
  });

  it("works at the end of the text, with a name that has spaces", () => {
    const trigger = mentionTrigger("@", 1);
    assert.ok(trigger);
    assert.deepEqual(applyMention("@", trigger, 1, "Ann Lee"), { text: "@Ann Lee ", caret: 9 });
  });
});

describe("moveMentionIndex", () => {
  it("wraps around both ways", () => {
    assert.equal(moveMentionIndex(0, 3, -1), 2);
    assert.equal(moveMentionIndex(2, 3, 1), 0);
    assert.equal(moveMentionIndex(1, 3, 1), 2);
    assert.equal(moveMentionIndex(0, 0, 1), 0);
  });
});
