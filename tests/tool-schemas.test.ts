// Fork: every input schema a tool hands to the model must be a JSON Schema the model API accepts.
// A z.tuple becomes `prefixItems`, which the API rejected (set_account_pacing:
// "tools.13.custom.input_schema: JSON schema is invalid"), failing every task run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as accounts from "../packages/domain/src/accounts.ts";
import * as domain from "../packages/domain/src/agent.ts";
import * as jobs from "../packages/domain/src/jobs.ts";

const tuplish = (node: unknown): boolean => {
  if (!node || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  if ("prefixItems" in record || Array.isArray(record.items)) return true;
  return Object.values(record).some(tuplish);
};

test("no tool input schema uses tuple items", () => {
  // The account tools' and the jobs tools' schemas too.
  const schemas = Object.entries({ ...domain, ...accounts, ...jobs }).filter(
    ([, value]) => value && typeof value === "object" && "_zod" in (value as object),
  );
  assert.ok(schemas.length > 0);
  for (const [name, schema] of schemas) {
    const json = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" });
    assert.equal(tuplish(json), false, `${name} converts to tuple items`);
  }
});

test("set_account_pacing still takes an hour window as two numbers", () => {
  const ok = domain.accountPacingInputSchema.safeParse({ activeHours: [9, 23], reason: "r" });
  assert.equal(ok.success, true);
  assert.equal(
    domain.accountPacingInputSchema.safeParse({ activeHours: [9], reason: "r" }).success,
    false,
  );
  assert.equal(
    domain.accountPacingInputSchema.safeParse({ activeHours: [23, 9], reason: "r" }).success,
    false,
  );
});
