// 动作审查 settings are saved on every edit: quick edits never lose one (the sentences added one after another).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLatestSaver } from "../../../packages/client/src/shell/serial-save.ts";

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createLatestSaver", () => {
  it("sends saves one at a time in order and shows only the newest answer", async () => {
    const sent: string[][] = [];
    let running = 0;
    let overlap = false;
    const shown: string[][] = [];
    const save = createLatestSaver<string[]>({
      // the first save is slow: its answer would arrive after the second one's edit
      put: async (value) => {
        running += 1;
        overlap ||= running > 1;
        await later(value.length === 1 ? 30 : 1);
        sent.push(value);
        running -= 1;
        return value;
      },
      onSaved: (value) => shown.push(value),
      onError: () => assert.fail("no error expected"),
    });
    const first = save(["a"]);
    const second = save(["a", "b"]);
    const third = save(["a", "b", "c"]);
    await Promise.all([first, second, third]);
    assert.deepEqual(sent, [["a"], ["a", "b"], ["a", "b", "c"]], "in the order made");
    assert.equal(overlap, false, "never two at once");
    assert.deepEqual(shown, [["a", "b", "c"]], "an older answer never reaches the screen");
  });

  it("reports a failure only for the newest save, and later saves still go out", async () => {
    const errors: unknown[] = [];
    const shown: number[] = [];
    let calls = 0;
    const save = createLatestSaver<number>({
      put: async (value) => {
        calls += 1;
        if (value === 1) throw new Error("down");
        return value;
      },
      onSaved: (value) => shown.push(value),
      onError: (error) => errors.push(error),
    });
    await Promise.all([save(1), save(2)]);
    assert.equal(calls, 2);
    assert.deepEqual(shown, [2]);
    assert.deepEqual(errors, [], "the older failure is superseded");
    await save(1);
    assert.equal(errors.length, 1, "the newest failing save is reported");
  });
});
