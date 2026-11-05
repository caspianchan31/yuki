// A task's result artifact reads in the owner's words: keys humanized, nested
// values flattened to 「名：值」, never JSON, long text folded until the whole result is open.
import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactFields,
  artifactView,
  foldText,
  humanizeKey,
  inlineValue,
  kindLabel,
  longText,
} from "../../../packages/client/src/shell/results/artifact-core.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";

test("keys and headings from the model are humanized, ordinary words stay", () => {
  assert.equal(humanizeKey("upstream_status"), "Upstream status");
  assert.equal(humanizeKey("EXECUTION ROADMAP"), "Execution roadmap");
  assert.equal(humanizeKey("EXECUTION_ROADMAP"), "Execution roadmap");
  assert.equal(humanizeKey("nextSteps"), "Next steps");
  assert.equal(humanizeKey("go-to-market"), "Go to market");
  assert.equal(humanizeKey("seo_plan"), "SEO plan");
  assert.equal(humanizeKey("下一步_计划"), "下一步 计划");
  assert.equal(humanizeKey("下一步计划"), "下一步计划");
  assert.equal(humanizeKey("Launch plan for Q4"), "Launch plan for Q4");
  assert.equal(humanizeKey("SEO"), "SEO");
  assert.equal(humanizeKey("  "), "");
});

test("the kind reads in Chinese", () => {
  assert.equal(kindLabel("plan"), "计划");
  assert.equal(kindLabel("comparison"), "对比");
  assert.equal(kindLabel("report"), "报告");
  assert.equal(kindLabel("weekly_digest"), "Weekly digest");
});

test("a value on one line is never JSON", () => {
  assert.equal(inlineValue("  ok "), "ok");
  assert.equal(inlineValue(3), "3");
  assert.equal(inlineValue(true), "是");
  assert.equal(inlineValue(false), "否");
  assert.equal(inlineValue(null), "—");
  assert.equal(inlineValue(["a", "b"]), "a、b");
  assert.equal(inlineValue([]), "—");
  assert.equal(inlineValue({}), "—");
  assert.equal(
    inlineValue({ upstream_status: "ready", retry_count: 2 }),
    "Upstream status：ready，Retry count：2",
  );
  assert.equal(inlineValue([{ step: 1 }, { step: 2 }]), "Step：1；Step：2");
  const deep = inlineValue({ a: { b: { c: { d: 1 } } } });
  assert.ok(!deep.includes("{") && !deep.includes('"'), deep);
  assert.equal(deep, "A：B：…");
});

test("the fields: numbers, text, lists, and objects as 名：值 rows", () => {
  const fields = artifactFields({
    total_reach: 1200,
    summary_text: "short",
    next_steps: ["one", { owner: "Ann", due: "Fri" }],
    upstream: { upstream_status: "ok", meta: { region: "us" } },
    skipped: undefined,
  });
  assert.deepEqual(
    fields.map((field) => [field.label, field.value.type]),
    [
      ["Total reach", "number"],
      ["Summary text", "text"],
      ["Next steps", "list"],
      ["Upstream", "pairs"],
    ],
  );
  assert.deepEqual(fields[2]?.value, { type: "list", items: ["one", "Owner：Ann，Due：Fri"] });
  assert.deepEqual(fields[3]?.value, {
    type: "pairs",
    pairs: [
      { label: "Upstream status", text: "ok" },
      { label: "Meta", text: "Region：us" },
    ],
  });
  for (const field of fields) assert.ok(!JSON.stringify(field.value).includes('{\\"'));
  assert.deepEqual(artifactFields(null), []);
});

test("folded: four fields, five items, long text cut; the toggle only when something is folded", () => {
  const long = "x".repeat(longText + 30);
  assert.equal(foldText("short"), "short");
  assert.equal(foldText(long), `${"x".repeat(longText)}…`);
  assert.equal(foldText("line one\nline two"), "line one…");

  const small = artifactFields({ a_b: "one", c: 2 });
  assert.equal(artifactView(small, false).more, false, "nothing to open: no button");

  const big = artifactFields({
    a: 1,
    b: 2,
    c: 3,
    d: ["1", "2", "3", "4", "5", "6", "7"],
    e: long,
  });
  const folded = artifactView(big, false);
  assert.equal(folded.more, true);
  assert.equal(folded.fields.length, 4);
  const list = folded.fields[3]?.value;
  assert.equal(list?.type === "list" ? list.items.length : -1, 5);
  const whole = artifactView(big, true);
  assert.equal(whole.fields.length, 5);
  assert.equal(whole.more, true, "收起 stays while the whole result is open");
  const text = whole.fields[4]?.value;
  assert.equal(text?.type === "text" ? text.text : "", long);
  assert.equal(artifactView(artifactFields({ note: long }), false).more, true);
});

test("the card's fixed words are Chinese", () => {
  assert.equal(t.artifacts.more, "查看完整结果");
  assert.equal(t.artifacts.less, "收起");
});
