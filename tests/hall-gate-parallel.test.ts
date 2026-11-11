// v1.4 acceptance fix: the hall's routing turn opens only route_request; a call to another tool
// made in that same turn (the model hands the work over at once) is answered "Unknown tool" by
// the SDK and made again after the routing. That answer must not reach the conversation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { lastValueFrom, Observable, toArray } from "rxjs";
import {
  anthropicRoute,
  forceRoute,
  type HallGate,
  hallGateMiddleware,
  hideUnroutedCalls,
  missingGroupResult,
  notYetResult,
  routedName,
} from "../apps/server/src/engine/hall-gate.ts";

const start = (toolCallId: string, toolCallName: string) =>
  ({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName }) as BaseEvent;
const result = (toolCallId: string, content: string) =>
  ({ type: EventType.TOOL_CALL_RESULT, toolCallId, content }) as BaseEvent;
const shown = async (gate: HallGate, events: (BaseEvent | (() => void))[]) => {
  const source = new Observable<BaseEvent>((subscriber) => {
    for (const event of events) {
      if (typeof event === "function") event();
      else subscriber.next(event);
    }
    subscriber.complete();
  });
  return (await lastValueFrom(hideUnroutedCalls(source, gate).pipe(toArray()))).map(
    (event) =>
      `${event.type}:${(event as { toolCallName?: string }).toolCallName ?? (event as { toolCallId?: string }).toolCallId}`,
  );
};

test("a call made beside route_request, answered Unknown tool, is not shown", async () => {
  const gate: HallGate = { decided: null };
  const lines = await shown(gate, [
    start("r", "route_request"),
    start("d", "delegate_task"),
    () => {
      gate.decided = { project: "Yuki" };
    },
    result("r", '{"project":{"name":"Yuki"}}'),
    result("d", '{"error":"Unknown tool: delegate_task"}'),
    start("d2", "delegate_task"),
    result("d2", '{"id":"t1"}'),
  ]);
  assert.deepEqual(lines, [
    `${EventType.TOOL_CALL_START}:route_request`,
    `${EventType.TOOL_CALL_RESULT}:r`,
    `${EventType.TOOL_CALL_START}:delegate_task`,
    `${EventType.TOOL_CALL_RESULT}:d2`,
  ]);
});

test("a request for no project hides its routing and the calls beside it", async () => {
  const gate: HallGate = { decided: null };
  const lines = await shown(gate, [
    start("r", "route_request"),
    start("s", "learn_skill"),
    () => {
      gate.decided = "none";
    },
    result("r", '{"forNoProject":true,"why":"x"}'),
    result("s", '{"error":"Unknown tool: learn_skill"}'),
    start("s2", "learn_skill"),
    result("s2", '{"saved":true}'),
  ]);
  assert.deepEqual(lines, [
    `${EventType.TOOL_CALL_START}:learn_skill`,
    `${EventType.TOOL_CALL_RESULT}:s2`,
  ]);
});

test("the routing turn answers a call beside route_request 'not run', and a routed reply keeps only its own tools", async () => {
  const gate: HallGate = { decided: null };
  const mw = hallGateMiddleware(gate, false);
  const call = (toolName: string) => ({ toolName }) as never;
  const before = mw.onBeforeToolCall as (ctx: never, c: never) => unknown;
  assert.equal(before(undefined as never, call("route_request")), undefined);
  assert.deepEqual(before(undefined as never, call("delegate_task")), {
    type: "skip",
    result: notYetResult,
  });
  assert.match(JSON.stringify(notYetResult), /"notYet":true/);
  gate.decided = { project: "Yuki" };
  assert.equal(before(undefined as never, call("delegate_task")), undefined);
  assert.equal(before(undefined as never, call("app_x__get_weather")), undefined);
  assert.equal((before(undefined as never, call("browse_web")) as { type: string }).type, "skip");
  gate.decided = "none";
  assert.equal(before(undefined as never, call("browse_web")), undefined);
});

test("a call answered 'not run' in the routing turn is not shown", async () => {
  const gate: HallGate = { decided: null };
  const lines = await shown(gate, [
    start("r", "route_request"),
    start("a", "app_x__get_weather"),
    () => {
      gate.decided = "none";
    },
    result("r", '{"forNoProject":true,"why":"x"}'),
    result("a", JSON.stringify(notYetResult)),
    start("a2", "app_x__get_weather"),
    result("a2", '{"ok":true}'),
  ]);
  assert.deepEqual(lines, [
    `${EventType.TOOL_CALL_START}:app_x__get_weather`,
    `${EventType.TOOL_CALL_RESULT}:a2`,
  ]);
});

// v1.7.6: a request routed to a group that does not exist: nothing runs, the tools stay declared,
// and the routing (with its missingGroup) is shown: the person's button lives under it.
test("a group that does not exist: every call is skipped, the tools stay, the routing is shown", async () => {
  const gate: HallGate = { decided: { missing: "acme" } };
  const middleware = hallGateMiddleware(gate, false);
  const tools = [{ name: "route_request" }, { name: "delegate_task" }, { name: "browse_web" }];
  const config = middleware.onConfig?.(
    {} as never,
    { tools, modelOptions: { tool_choice: "x" } } as never,
  ) as {
    tools: { name: string }[];
    modelOptions: Record<string, unknown>;
  };
  assert.ok(
    config.tools.some((tool) => tool.name === "delegate_task"),
    "declared",
  );
  assert.equal(config.modelOptions.tool_choice, undefined, "nothing forced");
  for (const toolName of ["delegate_task", "create_routine", "save_skill", "browse_web"]) {
    const answer = middleware.onBeforeToolCall?.({} as never, { toolName } as never) as {
      type: string;
      result: { error: string };
    };
    assert.equal(answer.type, "skip", toolName);
    assert.match(answer.result.error, /no group named acme yet/);
  }
  // Final for the reply: a second routing does not run either.
  const again = middleware.onBeforeToolCall?.(
    {} as never,
    { toolName: "route_request" } as never,
  ) as {
    type: string;
  };
  assert.equal(again.type, "skip");
  assert.equal(routedName(gate), null);
  assert.equal(routedName({ decided: { project: "alpha" } }), "alpha");
  assert.equal(routedName({ decided: "none" }), null);
  const lines = await shown({ decided: null }, [
    start("r", "route_request"),
    result("r", '{"missingGroup":"acme","groups":[]}'),
  ]);
  assert.deepEqual(lines, [
    `${EventType.TOOL_CALL_START}:route_request`,
    `${EventType.TOOL_CALL_RESULT}:r`,
  ]);
});

test("v1.7.6: a call skipped because the group does not exist is not shown to the person", async () => {
  const gate: HallGate = { decided: null };
  const lines = await shown(gate, [
    start("r", "route_request"),
    () => {
      gate.decided = { missing: "acme" };
    },
    result("r", '{"missingGroup":"acme","groups":[]}'),
    start("d", "delegate_task"),
    result("d", JSON.stringify(missingGroupResult("acme"))),
  ]);
  assert.deepEqual(lines, [
    `${EventType.TOOL_CALL_START}:route_request`,
    `${EventType.TOOL_CALL_RESULT}:r`,
  ]);
});

test("v1.7.6: the forced routing in each route's own shape (Anthropic: type tool)", () => {
  assert.deepEqual(forceRoute(false, true), { type: "tool", name: "route_request" });
  assert.deepEqual(forceRoute(true), { type: "function", function: { name: "route_request" } });
  assert.deepEqual(forceRoute(false), { type: "function", name: "route_request" });
  assert.ok(anthropicRoute("anthropic/some-model"));
  assert.ok(!anthropicRoute("openai/some-model"));
  const gate: HallGate = { decided: null };
  const config = hallGateMiddleware(gate, false, true).onConfig?.(
    {} as never,
    { tools: [{ name: "route_request" }], modelOptions: {} } as never,
  ) as {
    modelOptions: { tool_choice: unknown };
  };
  assert.deepEqual(config.modelOptions.tool_choice, { type: "tool", name: "route_request" });
});
