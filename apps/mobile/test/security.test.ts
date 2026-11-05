// The operator's secrets check, read defensively and
// worded as three blocks.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSecurity, securityBlocks } from "../../../packages/client/src/security-core.ts";

test("the report is read defensively; an unknown key state is no report", () => {
  assert.equal(normalizeSecurity(null), null);
  assert.equal(normalizeSecurity({ credentialKey: "maybe" }), null);
  const view = normalizeSecurity({
    credentialKey: "apart",
    plaintext: {
      urlsWithPassword: [{ where: "records:settings", count: 2 }, { where: 5 }],
      envSecrets: [{ name: "OPENAI_API_KEY", where: "chat_runs", count: 1 }, {}],
    },
    backups: [
      { path: "/srv/app/.env.bak-1", secrets: 4 },
      { path: "/srv/backups/deploy-2/env.redacted", secrets: 0 },
      { path: "/srv/x/.env", secrets: null },
      { secrets: 1 },
    ],
    checkedAt: "2026-10-16T10:00:00.000Z",
  });
  assert.ok(view);
  assert.equal(view.urlsWithPassword.length, 1);
  assert.equal(view.envSecrets.length, 1);
  assert.equal(view.backups.length, 3);
});

test("three blocks: the key, what is left in the clear, the backups that still hold a secret", () => {
  const view = normalizeSecurity({
    credentialKey: "apart",
    plaintext: {
      urlsWithPassword: [],
      envSecrets: [{ name: "SLACK_CLIENT_SECRET", where: "records:notes", count: 1 }],
    },
    backups: [
      { path: "/srv/app/.env.bak-1", secrets: 4 },
      { path: "/b/env.redacted", secrets: 0 },
      { path: "/b/old/.env", secrets: null },
    ],
  });
  assert.ok(view);
  const blocks = securityBlocks(view);
  assert.deepEqual(
    blocks.map((block) => [block.title, block.lines.map((line) => `${line.tone}:${line.text}`)]),
    [
      ["凭据密钥", ["ok:凭据库的密钥单独存放，不在数据目录里"]],
      ["明文残留", ["bad:records:notes：1 处原样出现 SLACK_CLIENT_SECRET"]],
      [
        "备份",
        [
          "bad:/srv/app/.env.bak-1：含 4 项密钥",
          "unknown:/b/old/.env：读不了，没法检查",
          "ok:其余 1 份不含密钥",
        ],
      ],
    ],
  );
  const clean = normalizeSecurity({ credentialKey: "inside_data", plaintext: {}, backups: [] });
  assert.ok(clean);
  assert.deepEqual(
    securityBlocks(clean).map((block) => block.lines.map((line) => line.tone)),
    [["bad"], ["ok"], ["ok"]],
  );
});
