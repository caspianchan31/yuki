import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectThread,
  heldMayResume,
  lockRefusalAgent,
} from "../../../packages/client/src/local-thread.ts";

function fakeAgent() {
  const calls: string[] = [];
  const agent = {
    setMessages(messages: []) {
      calls.push(`messages:${messages.length}`);
    },
    setState(state: Record<string, never>) {
      calls.push(`state:${Object.keys(state).length}`);
    },
  };
  const copilotkit = {
    async connectAgent(input: { agent: typeof agent }) {
      assert.equal(input.agent, agent);
      calls.push("connect");
      return "connected";
    },
  };
  return { agent, copilotkit, calls };
}

test("every connect clears the agent first, so a replay never doubles the conversation", async () => {
  const local = fakeAgent();
  assert.equal(await connectThread(local.copilotkit, local.agent), "connected");
  assert.equal(await connectThread(local.copilotkit, local.agent), "connected");
  assert.deepEqual(local.calls, [
    "messages:0",
    "state:0",
    "connect",
    "messages:0",
    "state:0",
    "connect",
  ]);
});

test("only a queued turn claims a lock refusal", () => {
  const agent = { id: "agent" };
  assert.equal(lockRefusalAgent(agent, true), agent);
  assert.equal(lockRefusalAgent(agent, false), undefined);
});

test("a held message waits for a reading taken after the reply that held it", () => {
  const before = { lastRunId: "run-1", running: false };
  // The poll had not seen the other member's reply yet: that same reading never sends it again
  // (it would be refused at once, again and again).
  assert.equal(heldMayResume(before, before), false);
  assert.equal(heldMayResume(before, { ...before }), false);
  // While the other reply runs it waits; once a newer run is over, it goes.
  assert.equal(heldMayResume(before, { lastRunId: "run-2", running: true }), false);
  assert.equal(heldMayResume(before, { lastRunId: "run-2", running: false }), true);
  // Held while the poll already showed the reply running: that run being over is enough.
  assert.equal(
    heldMayResume({ lastRunId: "run-2", running: true }, { lastRunId: "run-2", running: false }),
    true,
  );
  // No reading at the hold: the first one that shows nothing running.
  assert.equal(heldMayResume(null, { lastRunId: "run-2", running: false }), true);
  assert.equal(heldMayResume(null, null), false);
});
