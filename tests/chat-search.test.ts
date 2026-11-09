// v1.6 搜对话内容: the pure pieces: how words are tokenized and matched, the snippet, and how the
// web reads and labels a hit.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hitConversationLabel,
  hitDayLabel,
  normalizeHits,
} from "../packages/client/src/shell/chat/search-hits.ts";
import {
  matchesQuery,
  messageSearchText,
  searchQuery,
  searchTokens,
  snippetOf,
} from "../packages/domain/src/chat-search.ts";

test("tokens: CJK bigrams, a lone CJK character, lowercased words; each once", () => {
  assert.deepEqual(searchTokens("暗号是 Pineapple 42，再说一遍 pineapple"), [
    "暗号",
    "号是",
    "pineapple",
    "42",
    "再说",
    "说一",
    "一遍",
  ]);
  assert.deepEqual(searchTokens("A好b"), ["a", "好", "b"]);
  assert.deepEqual(searchTokens("  \n"), []);
  // Punctuation and spaces split runs: no bigram across them.
  assert.deepEqual(searchTokens("你好，世界"), ["你好", "世界"]);
  assert.ok(searchTokens("日本語とハングル한글").includes("語と"));
});

test("query: phrases must each appear; bigrams and word prefixes narrow; a lone character does not", () => {
  assert.equal(searchQuery("   "), null);
  assert.deepEqual(searchQuery("暗号"), { phrases: ["暗号"], tsquery: "'暗号'" });
  assert.deepEqual(searchQuery("Pine 暗号是"), {
    phrases: ["pine", "暗号是"],
    tsquery: "'pine':* & '暗号' & '号是'",
  });
  assert.deepEqual(searchQuery("暗"), { phrases: ["暗"], tsquery: "" });
  assert.deepEqual(searchQuery("a'b"), { phrases: ["a'b"], tsquery: "'a':* & 'b':*" });
  const query = searchQuery("暗号 pine");
  assert.ok(query && matchesQuery("回复：暗号是 Pineapple", query));
  assert.ok(query && !matchesQuery("回复：暗号是 apple", query));
});

test("snippet: the words around the first phrase found, cut with ellipses", () => {
  const query = searchQuery("暗号");
  assert.ok(query);
  assert.deepEqual(snippetOf("回复：暗号是 Pineapple 42", query), {
    before: "回复：",
    match: "暗号",
    after: "是 Pineapple 42",
  });
  const long = `${"前".repeat(50)}暗号${"后".repeat(50)}`;
  const cut = snippetOf(long, query, 10);
  assert.equal(cut.before, `…${"前".repeat(10)}`);
  assert.equal(cut.match, "暗号");
  assert.equal(cut.after, `${"后".repeat(10)}…`);
  // The phrase as written (case kept), newlines flattened.
  const mixed = searchQuery("pine");
  assert.ok(mixed);
  assert.deepEqual(snippetOf("first line\nPINEAPPLE here", mixed), {
    before: "first line ",
    match: "PINE",
    after: "APPLE here",
  });
  // Nothing found (a hit by another phrase order): the start of the text.
  assert.deepEqual(snippetOf("no match", query, 3), { before: "no mat…", match: "", after: "" });
});

test("a message's searchable words: its text plus the names of the files sent", () => {
  assert.equal(messageSearchText("hello"), "hello");
  assert.equal(
    messageSearchText([
      { type: "text", text: "看看\n这份合同" },
      {
        type: "binary",
        mimeType: "application/pdf",
        id: "AAAAAAAAAAAAAAAAAAAAAA",
        filename: "租房合同.pdf",
      },
    ]),
    "看看 这份合同 租房合同.pdf",
  );
  assert.equal(messageSearchText(null), "");
  assert.equal(messageSearchText([{ type: "text", text: "  " }]), "");
});

test("the web reads hits leniently and labels them", () => {
  assert.deepEqual(normalizeHits({ hits: "nope" }), []);
  assert.deepEqual(
    normalizeHits({ hits: [{ threadId: 1 }, { threadId: "t1", messageId: "m1" }] }),
    [
      {
        threadId: "t1",
        threadName: null,
        archived: false,
        messageId: "m1",
        role: "assistant",
        at: "",
        snippet: { before: "", match: "", after: "" },
      },
    ],
  );
  const words = { mainId: "main-1", main: "主聊天", untitled: "未命名对话", archived: "已归档" };
  assert.equal(
    hitConversationLabel({ threadId: "main-1", threadName: null, archived: false }, words),
    "主聊天",
  );
  assert.equal(
    hitConversationLabel({ threadId: "s1", threadName: null, archived: false }, words),
    "未命名对话",
  );
  assert.equal(
    hitConversationLabel({ threadId: "s1", threadName: "订货", archived: true }, words),
    "订货（已归档）",
  );
  const now = new Date(2026, 10, 8, 12, 0, 0);
  assert.equal(hitDayLabel(new Date(2026, 10, 8, 1).toISOString(), now), "今天");
  assert.equal(hitDayLabel(new Date(2026, 10, 7, 23).toISOString(), now), "昨天");
  assert.equal(hitDayLabel(new Date(2026, 9, 1).toISOString(), now), "10月1日");
  assert.equal(hitDayLabel(new Date(2025, 11, 31).toISOString(), now), "2025年12月31日");
  assert.equal(hitDayLabel("garbage", now), "");
});
