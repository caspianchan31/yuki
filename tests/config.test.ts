import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig, shadowedEnvKeys } from "../apps/server/src/config.ts";

test("the CopilotKit cloud key is optional: without it the config loads, blank is unset", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.HOST = "127.0.0.1";
  delete process.env.CPK_INTELLIGENCE_API_KEY;
  assert.equal(readConfig().intelligenceApiKey, undefined);
  process.env.CPK_INTELLIGENCE_API_KEY = " \t\n";
  assert.equal(readConfig().intelligenceApiKey, undefined);
  process.env.CPK_INTELLIGENCE_API_KEY = " test-project-key-never-sent ";
  assert.equal(readConfig().intelligenceApiKey, "test-project-key-never-sent");
});

test("web search is enabled by default with an explicit opt-out", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "model";
  process.env.HOST = "127.0.0.1";
  delete process.env.WEB_SEARCH_ENABLED;
  assert.equal(readConfig().webSearchEnabled, true);
  for (const value of ["true", "", "1", "TRUE"]) {
    process.env.WEB_SEARCH_ENABLED = value;
    assert.equal(readConfig().webSearchEnabled, true);
  }
  process.env.WEB_SEARCH_ENABLED = "false";
  assert.equal(readConfig().webSearchEnabled, false);
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("v1.7.2: a bad MODEL_THINKING stops the start", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.HOST = "127.0.0.1";
  delete process.env.MODEL_HISTORY_KB;
  for (const value of ["true", "none", "disabled"]) {
    process.env.MODEL_THINKING = value;
    assert.throws(() => readConfig(), /MODEL_THINKING must be one of/);
  }
  for (const value of ["", " Low ", "off"]) {
    process.env.MODEL_THINKING = value;
    assert.doesNotThrow(() => readConfig());
  }
});

test("v1.7.2: a bad MODEL_HISTORY_KB stops the start", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.HOST = "127.0.0.1";
  delete process.env.MODEL_THINKING;
  for (const value of ["32KB", "64.5", "-1", "5000"]) {
    process.env.MODEL_HISTORY_KB = value;
    assert.throws(() => readConfig(), /MODEL_HISTORY_KB must be a whole number/);
  }
  for (const value of ["", "0", " 96 "]) {
    process.env.MODEL_HISTORY_KB = value;
    assert.doesNotThrow(() => readConfig());
  }
});
