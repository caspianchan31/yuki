import assert from "node:assert/strict";
import { test } from "node:test";
import { isComposingKey } from "../../../packages/client/src/ime.ts";

test("Enter during or confirming an input-method composition is not a send", () => {
  assert.equal(isComposingKey({ key: "Enter", isComposing: true, keyCode: 13 }), true);
  assert.equal(isComposingKey({ key: "Enter", isComposing: false, keyCode: 229 }), true);
  assert.equal(isComposingKey({ key: "Enter", isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposingKey({ key: "Enter" }), false);
  assert.equal(isComposingKey(undefined), false);
});
