// v1.4 acceptance fix: the hall's routing turn opens only route_request; a call to another tool
// made in that same turn (the model hands the work over at once) is answered "Unknown tool" by
// the SDK and made again after the routing. That answer must not reach the conversation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { lastValueFrom, Observable, toArray } from "rxjs";
import {
  type HallGate,
  hallGateMiddleware,
  hideUnroutedCalls,
  notYetResult,
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
