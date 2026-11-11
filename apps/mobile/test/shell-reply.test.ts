// A reply shows its result; its steps fold into one line.
import assert from "node:assert/strict";
import test from "node:test";
import {
  isResultTool,
  splitToolCalls,
} from "../../../packages/client/src/shell/chat/reply-core.ts";

const call = (name: string) => ({ id: name, function: { name, arguments: "{}" } });

test("a reply's result cards stay; reading, searching, the desktop and status reads are its steps", () => {
  const calls = [
    "browse_web",
    "search_web",
    "use_desktop",
    "agent_status",
    "create_project",
    "delegate_task",
    "read_mail_thread",
  ].map(call);
  const { result, steps } = splitToolCalls(calls);
  assert.deepEqual(
    result.map((item) => item.function.name),
    ["create_project", "delegate_task"],
  );
  assert.deepEqual(
    steps.map((item) => item.function.name),
    ["browse_web", "search_web", "use_desktop", "agent_status", "read_mail_thread"],
  );
  for (const name of [
    "request_credential",
    "present_choices",
    "create_job",
    "redirect_task",
    "computer_screenshot",
  ])
    assert.ok(isResultTool(name), name);
  // A tool the client does not know is a step: it never stands as the reply's result.
  assert.equal(isResultTool("something_new"), false);
});

test("v1.7.6: a call can be made a result card by itself (a routing that found no such group)", () => {
  const calls = [
    { id: "r", function: { name: "route_request" } },
    { id: "b", function: { name: "browse_web" } },
  ];
  assert.deepEqual(splitToolCalls(calls).result, []);
  const { result, steps } = splitToolCalls(calls, (call) => call.id === "r");
  assert.deepEqual(
    result.map((call) => call.id),
    ["r"],
  );
  assert.deepEqual(
    steps.map((call) => call.id),
    ["b"],
  );
});
