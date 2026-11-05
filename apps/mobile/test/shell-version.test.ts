import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersion, versionLabel } from "../../../packages/client/src/shell/version.ts";

test("the version label names the version and the build it was made from", () => {
  assert.equal(versionLabel("90d41ac"), `${appVersion} · 90d41ac`);
  assert.equal(versionLabel(" "), `${appVersion} · 本地`);
  assert.equal(versionLabel(undefined), `${appVersion} · 本地`);
});
