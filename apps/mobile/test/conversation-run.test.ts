import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationTurnError,
  chatErrorText,
  claimThreadLock,
  historyUnavailable,
  isThreadLocked,
  type LockableAgent,
  replayedRunError,
  runConversationTurn,
  showsRunError,
  threadLocked,
} from "../../../packages/client/src/conversation-run.ts";

const lockBody = {
  error: "This conversation is still replying. Try again when it finishes.",
  code: "agent_thread_locked",
};

/** The Error @ag-ui/client's runHttpRequest builds for a non-2xx answer. */
function httpError(status: number, payload: unknown) {
  const error = new Error(
    `HTTP ${status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`,
  ) as Error & { status?: number; payload?: unknown };
  error.status = status;
  error.payload = payload;
  return error;
}

class AgentThreadLockedError extends Error {
  constructor(threadId: string) {
    super(`Thread ${threadId} is locked`);
    this.name = "AgentThreadLockedError";
  }
}

type Event = { error: unknown; code?: string; context?: { agentId?: string } };

/** A CopilotKit-like error bus: execute() reports each event to the listeners, then resolves. */
function reporter(events: Event[]) {
  const listeners = new Set<(event: Event) => void>();
  return {
    execute: async () => {
      for (const event of events) for (const listener of listeners) listener(event);
    },
    subscribe: (listener: (event: Event) => void) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    listeners,
  };
}

test("a server-side 409 lock refusal in SSE mode is a thread lock", () => {
  // CopilotKit reports the 409 as agent_run_failed.
  assert.equal(isThreadLocked({ code: "agent_run_failed", error: httpError(409, lockBody) }), true);
  // The same error first reaches onRunFailed as agent_run_failed_event.
  assert.equal(
    isThreadLocked({ code: "agent_run_failed_event", error: httpError(409, lockBody) }),
    true,
  );
  // A body that was not parsed as JSON is still recognised by the message.
  assert.equal(
    isThreadLocked({
      code: "agent_run_failed",
      error: httpError(409, JSON.stringify(lockBody)),
    }),
    true,
  );
  // A lock found after the stream began arrives as a RUN_ERROR whose code is on the error.
  const inStream = Object.assign(new Error("This conversation is still replying."), {
    code: "agent_thread_locked",
  });
  assert.equal(isThreadLocked({ code: "agent_run_error_event", error: inStream }), true);
});

test("AgentThreadLockedError lock reports keep working", () => {
  assert.equal(isThreadLocked({ code: threadLocked, error: new Error("Thread is locked") }), true);
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new AgentThreadLockedError("t-1") }),
    true,
  );
});

test("other failures are not thread locks", () => {
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(500, { error: "Boom" }) }),
    false,
  );
  assert.equal(
    isThreadLocked({
      code: "agent_run_failed",
      error: httpError(404, { error: "Thread not found" }),
    }),
    false,
  );
  // A lock code on a different status is not a lock refusal.
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(500, lockBody) }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(409, { error: "Conflict" }) }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(409, "Conflict") }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new Error("Network down") }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new Error("agent_thread_locked") }),
    false,
  );
  assert.equal(isThreadLocked({ code: "agent_run_failed", error: "HTTP 409: locked" }), false);
  assert.equal(isThreadLocked({ error: undefined }), false);
});

test("a turn refused by the SSE 409 fails as threadLocked, not as the generic follow-up", async () => {
  const error = httpError(409, lockBody);
  const bus = reporter([
    { code: "agent_run_failed_event", error, context: { agentId: "openmuse-t-1" } },
    { code: "agent_run_failed", error, context: { agentId: "openmuse-t-1" } },
  ]);
  const failure = await runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe).then(
    () => assert.fail("the turn should fail"),
    (e: unknown) => e,
  );
  assert.ok(failure instanceof ConversationTurnError);
  assert.equal(failure.code, threadLocked);
  assert.equal(failure.cause, error);
  assert.match(failure.message, /^HTTP 409:/);
  assert.equal(bus.listeners.size, 0);
});

test("a lone agent_run_failed carrying the SSE 409 is still threadLocked", async () => {
  const bus = reporter([{ code: "agent_run_failed", error: httpError(409, lockBody) }]);
  await assert.rejects(
    runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe),
    (e: unknown) => e instanceof ConversationTurnError && e.code === threadLocked,
  );
});

test("a generic run failure keeps its own code", async () => {
  const bus = reporter([
    { code: "agent_run_failed_event", error: httpError(500, { error: "Boom" }) },
    { code: "agent_run_failed", error: httpError(500, { error: "Boom" }) },
  ]);
  await assert.rejects(
    runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe),
    (e: unknown) => e instanceof ConversationTurnError && e.code === "agent_run_failed_event",
  );
});

test("reports for other agents and ignored codes do not fail the turn", async () => {
  const bus = reporter([
    { code: "agent_run_failed", error: httpError(409, lockBody), context: { agentId: "other" } },
    { code: replayedRunError, error: new Error("Saved failure") },
  ]);
  await runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe, [replayedRunError]);
});

test("a history the server could not read fails the load although replayed errors are ignored", async () => {
  // CopilotKit reports the connect's RUN_ERROR as agent_run_error_event and copies its
  // code onto the error.
  const unavailable = Object.assign(
    new Error("This conversation could not be loaded. Try again."),
    {
      code: historyUnavailable,
    },
  );
  const bus = reporter([
    { code: replayedRunError, error: new Error("Saved failure") },
    { code: replayedRunError, error: unavailable },
  ]);
  await assert.rejects(
    runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe, [replayedRunError]),
    (error: unknown) =>
      error instanceof ConversationTurnError &&
      error.cause === unavailable &&
      error.code === replayedRunError,
  );
});

test("a queued turn refused by the SSE 409 is held silently; anything else shows", () => {
  const event = { code: "agent_run_failed", error: httpError(409, lockBody) };
  assert.equal(showsRunError(event, { replaying: false, queuedTurn: true }), false);
  assert.equal(
    showsRunError(
      { code: "agent_run_failed_event", error: httpError(409, lockBody) },
      { replaying: false, queuedTurn: true },
    ),
    false,
  );
  // Retry is not a queued turn, so the refusal shows.
  assert.equal(showsRunError(event, { replaying: false, queuedTurn: false }), true);
  // A different failure during a queued turn still shows.
  assert.equal(
    showsRunError(
      { code: "agent_run_failed", error: httpError(500, { error: "Boom" }) },
      { replaying: false, queuedTurn: true },
    ),
    true,
  );
  // Replayed history errors stay hidden while replaying.
  assert.equal(
    showsRunError(
      { code: replayedRunError, error: new Error("Saved failure") },
      { replaying: true, queuedTurn: false },
    ),
    false,
  );
});

type LockSubscriber = Parameters<LockableAgent["subscribe"]>[0];
type Claim = { stopPropagation: true } | undefined;

/** An agent that, like @ag-ui/client, offers each failure to its subscribers in order. */
function lockableAgent() {
  const subscribers = new Set<LockSubscriber>();
  return {
    subscribe: (subscriber: LockSubscriber) => {
      subscribers.add(subscriber);
      return { unsubscribe: () => subscribers.delete(subscriber) };
    },
    /** The first stopPropagation, as AbstractAgent.onError takes it (no log, no rethrow). */
    fail: (error: Error) =>
      [...subscribers].map((s) => s.onRunFailed?.({ error }) as Claim).find(Boolean),
    runError: (event: { code?: string; message?: string }) =>
      [...subscribers].map((s) => s.onRunErrorEvent?.({ event }) as Claim).find(Boolean),
    subscribers,
  };
}

test("claimThreadLock claims only lock refusals, which stops their propagation", () => {
  const agent = lockableAgent();
  const lock = claimThreadLock(agent);
  assert.equal(agent.fail(httpError(500, { error: "Boom" })), undefined);
  assert.equal(agent.runError({ code: "model_error", message: "Boom" }), undefined);
  assert.equal(lock.refusal(), undefined);
  // The 409, an AgentThreadLockedError, and a RUN_ERROR with the lock code.
  const refused = httpError(409, lockBody);
  assert.deepEqual(agent.fail(refused), { stopPropagation: true });
  assert.equal(lock.refusal(), refused);
  assert.deepEqual(agent.fail(new AgentThreadLockedError("t-1")), { stopPropagation: true });
  assert.equal(lock.refusal(), refused, "the first refusal is kept");
  lock.unsubscribe();
  assert.equal(agent.subscribers.size, 0);

  const streamed = claimThreadLock(agent);
  assert.deepEqual(agent.runError({ code: threadLocked, message: "Busy" }), {
    stopPropagation: true,
  });
  const error = streamed.refusal();
  assert.equal(error?.message, "Busy");
  assert.equal(isThreadLocked({ error }), true);
  streamed.unsubscribe();
});

test("a turn holding on lock rethrows a claimed refusal as threadLocked and unsubscribes", async () => {
  const agent = lockableAgent();
  const bus = reporter([]);
  await assert.rejects(
    runConversationTurn(
      "openmuse-t-1",
      async () => {
        // A claimed refusal reaches no CopilotKit onError listener, and the run resolves.
        assert.deepEqual(agent.fail(new AgentThreadLockedError("t-1")), { stopPropagation: true });
      },
      bus.subscribe,
      [],
      agent,
    ),
    (e: unknown) =>
      e instanceof ConversationTurnError &&
      e.code === threadLocked &&
      e.name === "AgentThreadLockedError",
  );
  assert.equal(agent.subscribers.size, 0);
  assert.equal(bus.listeners.size, 0);
  // Other failures still reach onError and fail the turn with their own code.
  const failing = reporter([
    { code: "agent_run_failed", error: httpError(500, { error: "Boom" }) },
  ]);
  await assert.rejects(
    runConversationTurn(
      "openmuse-t-1",
      async () => {
        assert.equal(agent.fail(httpError(500, { error: "Boom" })), undefined);
        await failing.execute();
      },
      failing.subscribe,
      [],
      agent,
    ),
    (e: unknown) => e instanceof ConversationTurnError && e.code === "agent_run_failed",
  );
  assert.equal(agent.subscribers.size, 0);
});

test("a refused or failed request reads in plain Chinese, never the raw English error", () => {
  // CopilotKit's /info failure (Runtime info request failed with status 429).
  const info = Object.assign(new Error("Runtime info request failed with status 429"), {
    runtimeInfoStatus: 429,
  });
  assert.equal(
    chatErrorText({ code: "runtime_info_fetch_failed", error: info }),
    "刚才的请求太多了，过一分钟再发一次。",
  );
  assert.equal(
    chatErrorText({
      code: "agent_run_failed",
      error: httpError(429, { error: "Too many requests. Try again in a minute." }),
    }),
    "刚才的请求太多了，过一分钟再发一次。",
  );
  const down = Object.assign(new Error("Runtime info request failed with status 502"), {
    runtimeInfoStatus: 502,
  });
  for (const event of [
    { code: "runtime_info_fetch_failed", error: down },
    { error: down },
    { code: "agent_run_failed", error: httpError(503, { error: "对话记录暂时读不到" }) },
  ])
    assert.equal(chatErrorText(event), "聊天服务暂时连不上，稍后再发一次。");
  // The agent's own error is shown as it is.
  assert.equal(chatErrorText({ error: new Error("模型说：不行") }), "模型说：不行");
  // What the
  // infrastructure stopped reads in Chinese (the server tried the reply once more already).
  for (const raw of [
    "400 Upstream request failed",
    "502 Bad gateway",
    "empty_stream",
    "fetch failed",
  ])
    assert.equal(
      chatErrorText({ error: new Error(raw), code: replayedRunError }),
      "服务暂时出错，重试也没成功。稍等一下再点重新回复。",
    );
  // A provider answer the owner must act on keeps its words.
  assert.equal(
    chatErrorText({
      error: new Error("429 insufficient_quota: check your plan and billing details"),
    }),
    // v1.7 出错时页面直说: the provider's quota line reads in plain words now
    "主模型的额度用完了；配了备用模型的话下一条会自动改用它。",
  );
});
