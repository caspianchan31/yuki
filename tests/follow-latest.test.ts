import assert from "node:assert/strict";
import { test } from "node:test";
import { scrollIntent } from "../packages/client/src/shell/chat/follow-latest.ts";

test("v1.6.1 打开对话停在最新: the follower's own scroll is not the person leaving", () => {
  // The follower put the box at 7252 - 744; the content then grew to 11864 before the event.
  assert.equal(
    scrollIntent({ scrollTop: 6508, scrollHeight: 11864, clientHeight: 744 }, 6508),
    "ours",
  );
  // One pixel off is still ours (sub-pixel rounding), two is not.
  assert.equal(
    scrollIntent({ scrollTop: 6509, scrollHeight: 11864, clientHeight: 744 }, 6508),
    "ours",
  );
  assert.equal(
    scrollIntent({ scrollTop: 6510, scrollHeight: 11864, clientHeight: 744 }, 6508),
    "away",
  );
});

test("the person's scroll: near the end keeps following, away from it stops", () => {
  assert.equal(
    scrollIntent({ scrollTop: 11100, scrollHeight: 11864, clientHeight: 744 }, 6508),
    "near",
  );
  assert.equal(
    scrollIntent({ scrollTop: 11021, scrollHeight: 11864, clientHeight: 744 }, null),
    "near",
  );
  assert.equal(
    scrollIntent({ scrollTop: 11020, scrollHeight: 11864, clientHeight: 744 }, null),
    "away",
  );
  assert.equal(
    scrollIntent({ scrollTop: 0, scrollHeight: 11864, clientHeight: 744 }, null),
    "away",
  );
});

test("nothing programmatic yet: plain distance decides", () => {
  assert.equal(scrollIntent({ scrollTop: 0, scrollHeight: 500, clientHeight: 744 }, null), "near");
});
