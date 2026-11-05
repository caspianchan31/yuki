// 设置 → 外观: the choice kept in the browser, and what an unreadable store does.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appearanceKey,
  browserZone,
  parseAppearance,
  readAppearance,
  themeAttribute,
  writeAppearance,
} from "../packages/client/src/shell/task/settings-core.ts";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

test("only light and dark are choices; anything else follows the system", () => {
  assert.equal(parseAppearance("light"), "light");
  assert.equal(parseAppearance("dark"), "dark");
  for (const value of ["system", "", "Dark", null, undefined, 3]) {
    assert.equal(parseAppearance(value), "system", String(value));
  }
});

test("the choice is written, read back, and cleared by following the system", () => {
  const store = memory();
  assert.equal(readAppearance(store), "system");
  assert.equal(writeAppearance(store, "dark"), true);
  assert.equal(store.data.get(appearanceKey), "dark");
  assert.equal(readAppearance(store), "dark");
  assert.equal(writeAppearance(store, "light"), true);
  assert.equal(readAppearance(store), "light");
  assert.equal(writeAppearance(store, "system"), true);
  assert.equal(store.data.has(appearanceKey), false);
  assert.equal(readAppearance(store), "system");
  assert.equal(readAppearance(memory({ [appearanceKey]: "purple" })), "system");
});

test("a store that throws, or none, follows the system and does not break", () => {
  assert.equal(readAppearance(broken), "system");
  assert.equal(writeAppearance(broken, "dark"), false);
  assert.equal(readAppearance(null), "system");
  assert.equal(writeAppearance(null, "dark"), false);
});

test("data-theme is set only for a forced choice", () => {
  assert.equal(themeAttribute("system"), null);
  assert.equal(themeAttribute("light"), "light");
  assert.equal(themeAttribute("dark"), "dark");
});

test("the browser's zone, or null when it cannot say", () => {
  assert.equal(
    browserZone(() => " Asia/Tokyo "),
    "Asia/Tokyo",
  );
  assert.equal(
    browserZone(() => undefined),
    null,
  );
  assert.equal(
    browserZone(() => {
      throw new Error("no Intl");
    }),
    null,
  );
});
