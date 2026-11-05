// v1.2: the adapter's per-turn token counts, and the daily records they add up to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { createStore } from "../apps/server/src/db.ts";
import {
  accountUsageOn,
  type ModelUsage,
  type ModelUsageRecord,
  modelUsageKind,
  modelUsageOf,
  pricePerMillion,
  recordAccountUsage,
  recordModelUsage,
  usageCostUsd,
} from "../apps/server/src/engine/model-usage.ts";
import { withUsage } from "../apps/server/src/engine/tanstack-agent.ts";

// v1.2: an adapter whose one turn yields `chunks`, in order.
function fakeAdapter(chunks: unknown[]) {
  return {
    async *chatStream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}
async function collect(stream: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

test("withUsage reports one turn's counts from a TanStack usage object", async () => {
  const chunks = [
    { type: EventType.RUN_STARTED },
    { type: EventType.TEXT_MESSAGE_CONTENT, delta: "done" },
    {
      type: EventType.RUN_FINISHED,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        promptTokensDetails: { cachedTokens: 30, cacheWriteTokens: 5 },
      },
    },
  ];
  const seen: ModelUsage[] = [];
  const adapter = withUsage(fakeAdapter(chunks), (usage) => seen.push(usage));
  const out = await collect(adapter.chatStream());
  assert.deepEqual(seen, [{ input: 100, output: 20, cacheRead: 30, cacheWrite: 5 }]);
  assert.deepEqual(out, chunks);
});

test("withUsage sums an AG-UI usage array and counts missing numbers as zero", async () => {
  const chunks = [
    {
      type: EventType.RUN_FINISHED,
      usage: [
        { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
        { inputTokens: 5, cacheWriteInputTokens: 3 },
        { inputTokens: 1 },
      ],
    },
  ];
  const seen: ModelUsage[] = [];
  const adapter = withUsage(fakeAdapter(chunks), (usage) => seen.push(usage));
  const out = await collect(adapter.chatStream());
  assert.deepEqual(seen, [{ input: 16, output: 2, cacheRead: 4, cacheWrite: 3 }]);
  assert.deepEqual(out, chunks);
});

test("withUsage calls onUsage once per run-ending chunk, not for other chunks", async () => {
  const chunks = [
    { type: EventType.RUN_FINISHED, usage: { promptTokens: 1, completionTokens: 1 } },
    { type: EventType.RUN_STARTED },
    { type: EventType.RUN_ERROR, usage: { promptTokens: 2, completionTokens: 3 } },
  ];
  const seen: ModelUsage[] = [];
  await collect(withUsage(fakeAdapter(chunks), (usage) => seen.push(usage)).chatStream());
  assert.deepEqual(seen, [
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test("a throwing onUsage does not break the stream", async () => {
  const chunks = [
    { type: EventType.RUN_FINISHED, usage: { promptTokens: 1, completionTokens: 1 } },
    { type: EventType.RUN_STARTED },
  ];
  const errors: string[] = [];
  const original = console.error;
  console.error = (message?: unknown, ...rest: unknown[]) => {
    errors.push([message, ...rest].map(String).join(" "));
  };
  try {
    const out = await collect(
      withUsage(fakeAdapter(chunks), () => {
        throw new Error("listener failed");
      }).chatStream(),
    );
    assert.deepEqual(out, chunks);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /listener failed/);
});

test("recordModelUsage sums turns on one day, starts a new record the next day, keeps models apart", async () => {
  const db = await createStore();
  try {
    const first = await recordModelUsage(
      db,
      "owner",
      "openai/gpt-5",
      { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
      new Date("2026-10-30T01:00:00.000Z"),
    );
    assert.equal(first.turns, 1);
    const second = await recordModelUsage(
      db,
      "owner",
      "openai/gpt-5",
      { input: 5, output: 1, cacheRead: 0, cacheWrite: 2 },
      new Date("2026-10-30T23:59:59.000Z"),
    );
    assert.deepEqual(second, {
      id: "2026-10-30:openai/gpt-5",
      day: "2026-10-30",
      model: "openai/gpt-5",
      turns: 2,
      input: 15,
      output: 3,
      cacheRead: 3,
      cacheWrite: 6,
      updatedAt: "2026-10-30T23:59:59.000Z",
    });
    assert.deepEqual(
      await db.get<ModelUsageRecord>("owner", modelUsageKind, "2026-10-30:openai/gpt-5"),
      second,
    );

    const nextDay = await recordModelUsage(
      db,
      "owner",
      "openai/gpt-5",
      { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 },
      new Date("2026-10-31T00:00:00.000Z"),
    );
    assert.equal(nextDay.id, "2026-10-31:openai/gpt-5");
    assert.equal(nextDay.turns, 1);

    await recordModelUsage(
      db,
      "owner",
      "google/gemini-3-pro",
      { input: 4, output: 4, cacheRead: 1, cacheWrite: 0 },
      new Date("2026-10-30T12:00:00.000Z"),
    );

    const rows = await modelUsageOf(db, "owner", "2026-10-30", "2026-10-31");
    assert.deepEqual(
      rows.map((row) => `${row.day} ${row.model}`),
      ["2026-10-30 google/gemini-3-pro", "2026-10-30 openai/gpt-5", "2026-10-31 openai/gpt-5"],
    );
    assert.deepEqual(
      (await modelUsageOf(db, "owner", "2026-10-31", "2026-10-31")).map((row) => row.id),
      ["2026-10-31:openai/gpt-5"],
    );
  } finally {
    await db.close();
  }
});

test("recordAccountUsage adds a day's tokens onto that account", async () => {
  const db = await createStore();
  try {
    const at = new Date("2026-10-30T08:00:00.000Z");
    await recordAccountUsage(
      db,
      "owner",
      "mia",
      { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      at,
    );
    const again = await recordAccountUsage(
      db,
      "owner",
      "mia",
      { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      at,
    );
    assert.equal(again.input, 13);
    assert.equal(again.output, 6);
    assert.equal(again.turns, 2);
    assert.equal((await accountUsageOn(db, "owner", "mia", "2026-10-30"))?.turns, 2);
    assert.equal(await accountUsageOn(db, "owner", "mia", "2026-10-31"), null);
  } finally {
    await db.close();
  }
});

test("usageCostUsd prices a day only when both per-million rates are set", () => {
  assert.equal(pricePerMillion(""), null);
  assert.equal(pricePerMillion("nope"), null);
  assert.equal(usageCostUsd(1_000_000, 0, null, 1), null);
  assert.equal(usageCostUsd(1_000_000, 500_000, 3, 15), 3 + 7.5);
});
