// v1.7.1: WEB_INDEX_EXTRA (apps/web/index-extra.ts): a file of HTML goes into the built page
// before </body>; unset leaves the page alone; a missing file fails the build with its path.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readExtraHtml, withExtraHtml } from "../apps/web/index-extra.ts";

const page = '<!doctype html>\n<html><body>\n<div id="root"></div>\n</body></html>\n';

test("the snippet lands just before </body>, once", () => {
  const out = withExtraHtml(page, '<nav id="featured-on">x</nav>');
  assert.equal(
    out,
    '<!doctype html>\n<html><body>\n<div id="root"></div>\n<nav id="featured-on">x</nav>\n</body></html>\n',
  );
  assert.equal(withExtraHtml(page, null), page);
  assert.equal(withExtraHtml("<p>no body tag</p>", "<i>y</i>"), "<p>no body tag</p>\n<i>y</i>\n");
});

test("unset means the default file if any; a relative path is read from the repository root; a missing file throws", () => {
  const root = mkdtempSync(path.join(tmpdir(), "index-extra-"));
  writeFileSync(path.join(root, "extra.html"), "  <b>hi</b>\n");
  assert.equal(readExtraHtml({}, root), null);
  assert.equal(readExtraHtml({ WEB_INDEX_EXTRA: "  " }, root), null);
  // The file beside index.html is the default, only when it exists.
  assert.equal(readExtraHtml({}, root, path.join(root, "absent.html")), null);
  assert.equal(readExtraHtml({}, root, path.join(root, "extra.html")), "<b>hi</b>");
  assert.equal(readExtraHtml({ WEB_INDEX_EXTRA: "extra.html" }, root), "<b>hi</b>");
  assert.equal(
    readExtraHtml({ WEB_INDEX_EXTRA: path.join(root, "extra.html") }, root),
    "<b>hi</b>",
  );
  assert.throws(
    () => readExtraHtml({ WEB_INDEX_EXTRA: "nope.html" }, root),
    /missing file.*nope\.html/,
  );
});
