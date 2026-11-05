// A prepared email names no address but the sending account and
// its recipients, so a made-up signature address never reaches a review card.
import assert from "node:assert/strict";
import test from "node:test";
import { foreignAddresses } from "../apps/server/src/mail/draft-check.ts";

test("only the sending account and the recipients may be named", () => {
  const draft = {
    to: ["info@buyer.example"],
    cc: ["Partner@Agent.example"],
    subject: "Introduction",
    body: "Hello,\n\nReply to sales@factory.example or partner@agent.example.\n\nBest,\nexport@made-up.example.\nCall info@buyer.example",
  };
  assert.deepEqual(foreignAddresses(draft, "sales@factory.example"), ["export@made-up.example"]);
  assert.deepEqual(
    foreignAddresses({ ...draft, body: "Signed, SALES@factory.example" }, "sales@factory.example"),
    [],
  );
  assert.deepEqual(
    foreignAddresses(
      { to: ["a@b.example"], subject: "write to x@y.example", body: "x@y.example again" },
      "s@b.example",
    ),
    ["x@y.example"],
  );
});
