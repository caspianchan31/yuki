// The workspace snapshot never fails because Google refuses. A fresh
// connection ran over Gmail's per-user minute quota (the app reads the snapshot on each opening
// and retries a failed one every few seconds), which locked the whole app behind the error. Now a
// Google read is reused for a minute, and a refused one shows what was last read.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { Mail } from "../packages/domain/src/index.ts";
import { config as base } from "./helpers/computer.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

const message = (id: string): Mail => ({
  id,
  threadId: id,
  from: "buyer@importer.example",
  sender: "Buyer",
  to: ["sales@example.com"],
  subject: `Inquiry ${id}`,
  body: "Price for 200 bed frames?",
  date: "2026-10-17T10:00:00.000Z",
  unread: true,
  label: "Inbox",
  attachments: [],
});

test("a refused Google read shows the last read, and reads are reused for a minute", async () => {
  const config: Config = { ...base, mode: "live" };
  const tokens = { connectionId: "c1", account: "sales@example.com", scopes: [] };
  const workspace = new WorkspaceService(
    db,
    config,
    new Files(db, config, new Auth(db, config, "sample-signing-key")),
    { tokens: async () => tokens } as never,
  );
  let calls = 0;
  let refuse = false;
  workspace.google = (() => ({
    listMail: async () => {
      calls++;
      if (refuse) throw new Error("Google API (403): Quota exceeded");
      return [message("m1")];
    },
    listEvents: async () => [],
  })) as never;
  const owner = "quota-user";

  const first = await workspace.snapshot(owner);
  assert.deepEqual(
    first.mail.map((m) => m.id),
    ["m1"],
  );
  await workspace.snapshot(owner);
  await workspace.snapshot(owner);
  assert.equal(calls, 1, "reused within the minute");

  // A minute later Google refuses: the snapshot still answers, with the mail last read.
  const kept = (workspace as unknown as { googleReads: Map<string, { at: number }> }).googleReads;
  for (const entry of kept.values()) entry.at -= 61_000;
  refuse = true;
  const degraded = await workspace.snapshot(owner);
  assert.deepEqual(
    degraded.mail.map((m) => m.id),
    ["m1"],
  );
  assert.equal(calls, 2);
  // The refusal is kept for the minute too: retries do not hit Google again.
  await workspace.snapshot(owner);
  assert.equal(calls, 2);
});
