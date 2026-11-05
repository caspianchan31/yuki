import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  isKeyExhausted,
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
