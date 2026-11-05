// The computer's second layer. From 1024 the account
// detail's 看看 pins the account's desktop beside the timeline; narrower it opens the desktop
// sheet as before, and a step only the owner can do always does. The pinned desktop shows only while the
// account is still one of the conversation's.
import assert from "node:assert/strict";
import test from "node:test";
import {
  breakpoints,
  layoutFor,
  pinnedDesktop,
} from "../../../packages/client/src/shell/layout-core.ts";

const account = (id: string, desktop: string, over: Record<string, unknown> = {}) =>
  ({ id, name: `acct-${id}`, desktop, view: {}, ...over }) as never;

test("the desktop pins beside the timeline from 1024, not below", () => {
  assert.equal(breakpoints.pin, 1024);
  assert.equal(layoutFor(1023).pin, false);
  assert.equal(layoutFor(1024).pin, true);
  assert.equal(layoutFor(1440).pin, true);
  assert.equal(layoutFor(390).pin, false);
  assert.equal(layoutFor(1024).pinWidth, 400);
});

test("the pinned desktop shows only while wide and while the account is still here", () => {
  const accounts = [
    account("a", "running", { view: { accountLabel: "u/alice" } }),
    account("b", "stopped"),
  ];
  assert.deepEqual(pinnedDesktop({ pin: true, pinned: "a", accounts }), {
    environmentId: "a",
    name: "acct-a",
    accountLabel: "u/alice",
    running: true,
  });
  assert.equal(pinnedDesktop({ pin: true, pinned: "b", accounts })?.running, false);
  assert.equal(pinnedDesktop({ pin: true, pinned: "b", accounts })?.accountLabel, null);
  // Narrowed: nothing shows (the pin is kept for when the window widens again).
  assert.equal(pinnedDesktop({ pin: false, pinned: "a", accounts }), null);
  // Moved away or deleted, or nothing pinned: nothing shows.
  assert.equal(pinnedDesktop({ pin: true, pinned: "gone", accounts }), null);
  assert.equal(pinnedDesktop({ pin: true, pinned: null, accounts }), null);
});
