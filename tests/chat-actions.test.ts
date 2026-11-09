// v1.6 聊天基础动作: the shared pieces — where a superseded stretch folds among the visible
// messages, the server payloads read defensively, and a fenced code block's head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantMarkdown, codeCopyLabel } from "../packages/client/src/assistant-markdown.ts";
import {
  normalizeFeedback,
  normalizeSegments,
  supersededPlacement,
} from "../packages/client/src/shell/chat/superseded-core.ts";
import { normalizeTurns } from "../packages/client/src/shell/chat/turn-time.ts";

const segment = (anchor: string | null, ids: [string, string][]) => ({
  anchor,
  at: "2026-11-08T10:00:00.000Z",
  messages: ids.map(([id, role]) => ({ id, role, content: `${role} ${id}` })),
});

test("a stretch after an edit folds before the message sent in its place", () => {
  const turns = normalizeTurns({
    turns: [
      { runId: "r1", at: "2026-11-08T09:00:00.000Z", end: null, messages: ["u1", "a1"] },
      { runId: "r3", at: "2026-11-08T10:00:00.000Z", end: null, messages: ["u3", "a3"] },
    ],
  });
  const visible = [{ id: "u1" }, { id: "a1" }, { id: "u3" }, { id: "a3" }];
  const placed = supersededPlacement(
    [
      segment("r3", [
        ["u2", "user"],
        ["a2", "assistant"],
        ["t2", "tool"],
      ]),
    ],
    turns,
    visible,
  );
  assert.deepEqual([...placed.before.keys()], ["u3"]);
  assert.deepEqual(
    placed.before.get("u3")?.[0]?.messages.map((m) => m.id),
    ["u2", "a2"],
    "the tool message is not shown",
  );
  assert.equal(placed.atEnd.length, 0);
});

test("a reply asked for again folds after the question, before the new answer", () => {
  const turns = normalizeTurns({
    turns: [{ runId: "r2", at: "2026-11-08T10:00:00.000Z", end: null, messages: ["u1", "a2"] }],
  });
  const visible = [{ id: "u1" }, { id: "a2" }];
  const placed = supersededPlacement(
    [
      segment("r2", [
        ["u1", "user"],
        ["a1", "assistant"],
      ]),
    ],
    turns,
    visible,
  );
  assert.deepEqual([...placed.before.keys()], ["a2"]);
  assert.deepEqual(
    placed.before.get("a2")?.[0]?.messages.map((m) => m.id),
    ["a1"],
    "the question, visible again, is not repeated",
  );
  // While the new answer streams (not in the turn's messages yet) the fold follows the question.
  const streaming = supersededPlacement(
    [
      segment("r2", [
        ["u1", "user"],
        ["a1", "assistant"],
      ]),
    ],
    normalizeTurns({
      turns: [{ runId: "r2", at: "2026-11-08T10:00:00.000Z", end: null, messages: ["u1"] }],
    }),
    [{ id: "u1" }, { id: "a2-live" }],
  );
  assert.deepEqual([...streaming.before.keys()], ["a2-live"]);
  // Before the replacement run began at all, the fold stands at the end.
  const pending = supersededPlacement([segment(null, [["a1", "assistant"]])], turns, [
    { id: "u1" },
  ]);
  assert.equal(pending.before.size, 0);
  assert.equal(pending.atEnd.length, 1);
  // Nothing left to show (everything visible again): no fold.
  assert.equal(
    supersededPlacement([segment("r2", [["u1", "user"]])], turns, visible).atEnd.length,
    0,
  );
});

test("the server's superseded and feedback payloads are read defensively", () => {
  assert.deepEqual(normalizeSegments(null), []);
  assert.deepEqual(
    normalizeSegments({
      segments: [
        {
          anchor: 7,
          at: "x",
          messages: [{ id: "a", role: "assistant", content: "hi" }, { id: 1 }],
        },
      ],
    }),
    [{ anchor: null, at: "x", messages: [{ id: "a", role: "assistant", content: "hi" }] }],
  );
  assert.deepEqual(normalizeFeedback({ feedback: { a: "up", b: "down", c: "meh", d: 1 } }), {
    a: "up",
    b: "down",
  });
  assert.deepEqual(normalizeFeedback("nope"), {});
  assert.equal(normalizeTurns({ turns: [{ at: "2026-11-08T10:00:00.000Z" }] })[0]?.runId, null);
});

test("a fenced code block gets a head with its language and a copy button, and no line numbers", () => {
  const html = assistantMarkdown.render(
    "Try this:\n\n```ts\nconst a = 1;\nconsole.log(a < 2);\n```\n",
  );
  assert.match(html, /<div class="code-block" data-lang="ts">/);
  assert.match(html, /<span class="code-lang">ts<\/span>/);
  assert.match(
    html,
    new RegExp(`<button type="button" class="code-copy" data-code-copy>${codeCopyLabel}</button>`),
  );
  assert.match(
    html,
    /<pre><code class="language-ts">const a = 1;\nconsole\.log\(a &lt; 2\);\n<\/code><\/pre>/,
  );
  assert.doesNotMatch(html, /line-number|<ol/);
  // No language: the head says 代码-less "code"; a hostile info string cannot break out.
  const bare = assistantMarkdown.render("```\nx\n```\n");
  assert.match(
    bare,
    /<div class="code-block"><div class="code-head"><span class="code-lang">code<\/span>/,
  );
  const hostile = assistantMarkdown.render('```js" onclick="x\nalert(1)\n```\n');
  assert.match(hostile, /data-lang="js"/);
  assert.doesNotMatch(hostile, /onclick=/);
});
