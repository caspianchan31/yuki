// Older page reads leave the provider's context.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import {
  omittedPageText,
  prunePageTexts,
  prunePageTextsMiddleware,
} from "../apps/server/src/engine/prune-page-texts.ts";

const call = (id: string, name: string): ModelMessage => ({
  role: "assistant",
  content: null,
  toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
const result = (id: string, content: string): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content,
});
const page = (url: string) =>
  JSON.stringify({ ok: true, url, text: "words ".repeat(3000), links: [] });

test("the two latest page reads stay whole; an older one becomes a line naming its page", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "go" },
    call("a", "read_page_text"),
    result("a", page("https://www.v2ex.com/go/localllm")),
    call("s", "use_desktop"),
    result("s", "clicked"),
    call("b", "read_web"),
    result("b", page("https://example.com/b")),
    call("c", "read_page_text"),
    result("c", page("https://www.v2ex.com/t/1")),
  ];
  const pruned = prunePageTexts(messages, 2);
  assert.notEqual(pruned, messages);
  assert.equal(pruned[2].content, omittedPageText("https://www.v2ex.com/go/localllm"));
  assert.equal(pruned[4], messages[4], "another tool's result is untouched");
  assert.equal(pruned[6], messages[6]);
  assert.equal(pruned[8], messages[8]);
  // The call and its answer stay: the provider needs every call answered.
  assert.equal(pruned.length, messages.length);
  assert.equal(pruned[1], messages[1]);
  // Nothing to drop: the input itself.
  assert.equal(prunePageTexts(messages, 3), messages);
  // A result that is not JSON names the first address in it, or nothing.
  const plain = [
    call("x", "read_page_text"),
    result("x", "see https://a.example/p now"),
    call("y", "read_page_text"),
    result("y", "no address"),
  ];
  assert.equal(prunePageTexts(plain, 0)[1].content, omittedPageText("https://a.example/p"));
  assert.equal(prunePageTexts(plain, 0)[3].content, omittedPageText(null));
});

test("the middleware sets providerMessages only when something left", () => {
  const mw = prunePageTextsMiddleware(1);
  const few = [call("a", "read_page_text"), result("a", page("https://a.example/"))];
  assert.equal(mw.onConfig?.({} as never, { messages: few } as never), undefined);
  const more = [...few, call("b", "read_page_text"), result("b", page("https://b.example/"))];
  const out = mw.onConfig?.({} as never, { messages: more } as never) as {
    providerMessages: ModelMessage[];
  };
  assert.equal(out.providerMessages[1].content, omittedPageText("https://a.example/"));
});
