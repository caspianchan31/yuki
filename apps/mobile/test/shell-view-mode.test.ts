// The pro view is for internal spaces only (a customer's store never offers it). v1.2 opens
// on the address book; pro is this device's choice when the person turns it on. It brings
// back the project column and the docked live rail, never on a phone.
import assert from "node:assert/strict";
import test from "node:test";
import { canSwitchProject, layoutFor } from "../../../packages/client/src/shell/layout-core.ts";
import {
  proViewAllowed,
  proViewOn,
  readProViewChoice,
  writeProViewChoice,
} from "../../../packages/client/src/shell/view-mode.ts";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

test("pro only in an internal space, and only after it is turned on", () => {
  assert.equal(proViewAllowed({ store: true }), false);
  assert.equal(proViewAllowed({ store: false }), true);
  assert.equal(proViewOn({ allowed: true, choice: null }), false);
  assert.equal(proViewOn({ allowed: true, choice: true }), true);
  assert.equal(proViewOn({ allowed: true, choice: false }), false);
  assert.equal(proViewOn({ allowed: false, choice: true }), false, "a store never shows pro");
  const storage = memory();
  assert.equal(readProViewChoice(storage), null);
  writeProViewChoice(storage, false);
  assert.equal(readProViewChoice(storage), false);
  writeProViewChoice(storage, true);
  assert.equal(readProViewChoice(storage), true);
  assert.equal(readProViewChoice(null), null);
});

test("the pro view's columns by width; the simple view is one column everywhere", () => {
  const simple = layoutFor(1280);
  assert.deepEqual([simple.projectColumn, simple.rail, simple.drawer], [false, false, false]);
  const desk = layoutFor(1280, true);
  assert.deepEqual([desk.projectColumn, desk.rail, desk.pro], [true, true, true]);
  const tablet = layoutFor(900, true);
  assert.deepEqual([tablet.projectColumn, tablet.rail], [false, true]);
  const phone = layoutFor(375, true);
  assert.deepEqual(
    [phone.projectColumn, phone.rail, phone.pro, phone.drawer],
    [false, false, false, false],
  );
  // The header's ▾ gives way to the project column; a store never switches.
  assert.equal(canSwitchProject({ store: false, projectColumn: desk.projectColumn }), false);
  assert.equal(canSwitchProject({ store: false, projectColumn: simple.projectColumn }), true);
  assert.equal(canSwitchProject({ store: true }), false);
});
