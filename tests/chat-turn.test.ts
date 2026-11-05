import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatTurn } from "../packages/client/src/shell/chat/turn.ts";

describe("chatTurn", () => {
  it("sends when nothing is running", () => {
    assert.equal(chatTurn("看一下", false), "send");
    assert.equal(chatTurn("停", false), "send");
  });

  it("stops on 停 and does not treat it as a message", () => {
    assert.equal(chatTurn("停", true), "stop");
    assert.equal(chatTurn("  停  ", true), "stop");
  });

  it("interrupts a running reply with any other message", () => {
    assert.equal(chatTurn("先别做了，改看价格", true), "interrupt");
  });

  it("ignores an empty box", () => {
    assert.equal(chatTurn("   ", true), "ignore");
  });
});
