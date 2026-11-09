import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  backupReason,
  backupState,
  backupWords,
  isKeyExhausted,
  isKeyRefused,
  isModelOutage,
  modelSpec,
  resetKeyExhausted,
  takeBackup,
} from "../apps/server/src/engine/model-fallback.ts";
import { stoppedByInfrastructure } from "../packages/domain/src/agent.ts";

afterEach(() => resetKeyExhausted());

describe("isKeyExhausted", () => {
  it("recognises a provider quota and a stated weekly reset", () => {
    assert.equal(isKeyExhausted("insufficient_quota"), true);
    assert.equal(
      isKeyExhausted(
        "429 You have exceeded the weekly usage quota. It will reset at 2026-11-02 00:00:00 +0800 CST.",
        Date.parse("2026-10-31T00:00:00Z"),
      ),
      true,
    );
    assert.equal(isKeyExhausted("desktop timed out"), false);
  });
});

const out =
  "429 You have exceeded the 5-hour usage quota. It will reset at 2026-11-02 05:01:03 +0800 CST.";
const at = Date.parse("2026-11-01T19:33:17Z");
const resets = Date.parse("2026-11-01T21:01:03Z");

describe("modelSpec", () => {
  it("stays on the primary until the key is exhausted, then uses the backup", () => {
    assert.equal(modelSpec("openai/primary", "google/backup", at), "openai/primary");
    assert.equal(takeBackup(out, "google/backup", at), true);
    assert.equal(modelSpec("openai/primary", "google/backup", at), "google/backup");
    assert.equal(modelSpec("openai/primary", "  ", at), "openai/primary");
  });

  it("goes back to the primary a minute after the stated reset", () => {
    takeBackup(out, "google/backup", at);
    assert.equal(modelSpec("openai/primary", "google/backup", resets), "google/backup");
    assert.equal(modelSpec("openai/primary", "google/backup", resets + 60_000), "openai/primary");
  });

  it("tries the primary again after an hour when no reset was stated", () => {
    takeBackup("insufficient_quota", "google/backup", at);
    assert.equal(modelSpec("openai/primary", "google/backup", at + 3_599_000), "google/backup");
    assert.equal(modelSpec("openai/primary", "google/backup", at + 3_600_000), "openai/primary");
  });
});

describe("takeBackup", () => {
  it("takes the provider's real 429, which is also an infrastructure stop", () => {
    assert.equal(stoppedByInfrastructure(out), true);
    assert.equal(takeBackup(out, "google/backup", at), true);
  });

  it("moves once while the backup is in force, and again after the primary came back", () => {
    assert.equal(takeBackup(out, "google/backup", at), true);
    assert.equal(takeBackup(out, "google/backup", at + 1000), false);
    assert.equal(takeBackup("insufficient_quota", "google/backup", resets + 60_000), true);
  });

  it("does not move on another failure, or with no backup set", () => {
    assert.equal(takeBackup("desktop timed out", "google/backup", at), false);
    assert.equal(takeBackup("insufficient_quota", "  ", at), false);
    assert.equal(takeBackup(out, undefined, at), false);
    assert.equal(modelSpec("openai/primary", "google/backup", at), "openai/primary");
  });
});

describe("v1.7 模型兜底: the backup also takes a refused key and a model that does not answer", () => {
  it("tells the three reasons apart, and leaves the desktop's failures alone", () => {
    assert.equal(
      backupReason(
        "429 You have exceeded the monthly usage quota. It will reset at 2026-11-26 23:59:59 +0800 CST.",
        at,
      ),
      "quota",
    );
    assert.equal(backupReason("401 Incorrect API key provided", at), "auth");
    assert.equal(backupReason('403 {"error":{"message":"invalid x-api-key"}}', at), "auth");
    assert.equal(backupReason("502 Bad Gateway", at), "outage");
    assert.equal(backupReason("Upstream request failed", at), "outage");
    assert.equal(backupReason("TypeError: fetch failed", at), "outage");
    assert.equal(backupReason("429 Too Many Requests: rate limit", at), "outage");
    assert.equal(backupReason("desktop timed out", at), null);
    assert.equal(backupReason("Desktop in use by 对话", at), null);
    assert.equal(backupReason("The browser did not start", at), null);
    assert.equal(backupReason("proxy 502 for the sandbox", at), null);
    assert.equal(isKeyRefused("insufficient_quota"), false);
    assert.equal(isModelOutage("credit balance is too low"), false);
  });

  it("an outage moves to the backup for ten minutes, a refused key for an hour", () => {
    assert.equal(takeBackup("503 Service Unavailable", "anthropic/backup", at), true);
    let state = backupState("anthropic/backup", at);
    assert.equal(state.active, true);
    assert.equal(state.reason, "outage");
    assert.equal(Date.parse(state.until ?? "") - at, 10 * 60_000);
    assert.equal(
      modelSpec("openai/primary", "anthropic/backup", at + 9 * 60_000),
      "anthropic/backup",
    );
    assert.equal(
      modelSpec("openai/primary", "anthropic/backup", at + 11 * 60_000),
      "openai/primary",
    );
    resetKeyExhausted();
    assert.equal(takeBackup("401 Unauthorized", "anthropic/backup", at), true);
    state = backupState("anthropic/backup", at);
    assert.equal(state.reason, "auth");
    assert.equal(Date.parse(state.until ?? "") - at, 60 * 60_000);
  });

  it("a backup already in force does not move again, and the state is empty without a backup", () => {
    assert.equal(takeBackup(out, "anthropic/backup", at), true);
    assert.equal(takeBackup("502 Bad Gateway", "anthropic/backup", at + 1000), false);
    assert.equal(backupState(undefined, at).active, false);
    assert.equal(backupState("anthropic/backup", resets + 120_000).active, false);
  });

  it("the words name the reason and the model", () => {
    const words = backupWords("outage", "anthropic/deepseek-v4-pro", "2026-11-09T04:30:00.000Z");
    assert.equal(words.title, "主模型不通");
    assert.match(words.text, /已改用备用模型 anthropic\/deepseek-v4-pro/);
    assert.match(words.text, /12:30:00 再试主模型/);
    assert.equal(backupWords("quota", "x", null).title, "主钥匙额度用完");
    assert.equal(backupWords("auth", "x", null).title, "主钥匙被拒绝");
  });
});
