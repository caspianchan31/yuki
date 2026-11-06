// How the chat reads a computer screenshot's tool result (packages/client/src/tool-cards-core.ts):
// the open build's computer_screenshot names the picture the person sees (shotId); nothing else
// is taken for one.
import assert from "node:assert/strict";
import test from "node:test";
import { computerShotId } from "../../../packages/client/src/tool-cards-core.ts";

test("a computer screenshot's result names the picture the chat shows; nothing else does", () => {
  const id = "AbCdEfGhIjKlMnOpQrStUv";
  assert.equal(
    computerShotId(JSON.stringify({ screenshot: "attached", shotId: id, control: "member" })),
    id,
  );
  assert.equal(computerShotId({ shotId: id }), id);
  assert.equal(computerShotId(JSON.stringify({ shotId: "../../etc" })), null);
  assert.equal(computerShotId(JSON.stringify({ error: "The computer is not running" })), null);
  assert.equal(computerShotId("not json"), null);
  assert.equal(computerShotId(undefined), null);
});
