// The operator's secrets check reports paths and counts,
// never a value: the credential key apart from the data, a URL with a password or one of the
// server's own secrets in the database, and an .env copy on disk that holds a secret.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { envSecretLines, isEnvCopy, securityReport } from "../apps/server/src/security.ts";

test("an env line holds a secret unless it is a kept setting, empty or <redacted>", () => {
  const text = [
    "# OPENAI_API_KEY=sk-in-a-comment",
    "MODEL=openai/gemini",
    "export PORT=8787",
    "OPENAI_API_KEY=sk-live-1234567890",
    "TOKEN_ENCRYPTION_KEY=<redacted>",
    "SLACK_CLIENT_SECRET=",
    "OPENAI_BASE_URL=https://u:p@gw.example/v1",
    'WORKER_TOKEN="quoted-secret-value"',
    "",
  ].join("\n");
  assert.equal(envSecretLines(text), 3);
  assert.equal(envSecretLines("MODEL=x\nPORT=1\n"), 0);
  assert.equal(isEnvCopy(".env", true), false);
  assert.equal(isEnvCopy(".env.example", true), false);
  assert.equal(isEnvCopy(".env.bak-model-1", true), true);
  assert.equal(isEnvCopy(".env", false), true);
  assert.equal(isEnvCopy("env.redacted", false), true);
});

test("the report finds secrets in the database and on disk and never shows one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "om-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app");
  const backups = join(root, "backups");
  await mkdir(join(app, "data"), { recursive: true });
  await mkdir(join(backups, "deploy-1", "postgres"), { recursive: true });
  await mkdir(join(backups, "move-1"), { recursive: true });
  const secret = "sk-live-abcdefghijklmnop";
  await writeFile(join(app, ".env"), `OPENAI_API_KEY=${secret}\n`);
  await writeFile(join(app, ".env.bak-old"), `OPENAI_API_KEY=${secret}\nMODEL=x\n`);
  await writeFile(
    join(backups, "deploy-1", "env.redacted"),
    "OPENAI_API_KEY=<redacted>\nMODEL=x\n",
  );
  await writeFile(join(backups, "deploy-1", "postgres", ".env"), `OPENAI_API_KEY=${secret}\n`);
  await writeFile(join(backups, "move-1", ".env"), `OPENAI_API_KEY=${secret}\n`);

  const db = await createStore();
  t.after(() => db.close());
  await db.put("space-a", "settings", {
    id: "s1",
    proxy: "http://alice:Pass-Word-1@203.0.113.9:8080",
  });
  await db.put("space-b", "notes", { id: "n1", text: `pasted ${secret} here` });
  await db.put("space-b", "notes", { id: "n2", text: "http://•••@203.0.113.9:8080 is masked" });

  const report = await securityReport({
    db,
    dataDir: join(app, "data"),
    credentialKeyFile: join(root, "etc", "credential.key"),
    backupDirs: [backups],
    appDir: app,
    secrets: { OPENAI_API_KEY: secret, SHORT: "short", UNSET: undefined },
  });
  assert.equal(report.credentialKey, "apart");
  assert.deepEqual(report.plaintext.urlsWithPassword, [{ where: "records:settings", count: 1 }]);
  assert.deepEqual(report.plaintext.envSecrets, [
    { name: "OPENAI_API_KEY", where: "records:notes", count: 1 },
  ]);
  assert.deepEqual(
    report.backups.map((item) => [item.path.slice(root.length), item.secrets]),
    [
      ["/app/.env.bak-old", 1],
      ["/backups/deploy-1/env.redacted", 0],
      ["/backups/move-1/.env", 1],
    ],
  );
  const json = JSON.stringify(report);
  assert.ok(!json.includes(secret), "no secret value in the report");
  assert.ok(!json.includes("Pass-Word-1"), "no password in the report");

  const inside = await securityReport({
    db,
    dataDir: join(app, "data"),
    credentialKeyFile: join(app, "data", "credential.key"),
    backupDirs: [],
    appDir: join(root, "nowhere"),
    secrets: {},
  });
  assert.equal(inside.credentialKey, "inside_data");
  assert.deepEqual(inside.backups, []);
  const unset = await securityReport({
    ...{ db, dataDir: app, backupDirs: [], appDir: app, secrets: {} },
    credentialKeyFile: undefined,
  });
  assert.equal(unset.credentialKey, "unset");
});
