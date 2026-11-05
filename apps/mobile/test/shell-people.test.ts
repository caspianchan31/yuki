// The accounts page and the credentials page in the
// members-bar manner: each account a person (its state, its line, its 经营循环), a card only
// where the owner has to judge, group headings without counts, empty groups left out.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import { personRow } from "../../../packages/client/src/shell/accounts/people-core.ts";
import { normalizeCredentials } from "../../../packages/client/src/shell/credentials/credentials-core.ts";
import {
  judgedEntries,
  judgmentLine,
  needsJudgment,
  quietGroups,
  quietLine,
} from "../../../packages/client/src/shell/credentials/quiet-core.ts";
import { spokenLabel } from "../../../packages/client/src/shell/members/members-core.ts";
import { type AccountView, buildAccountModels } from "../../../packages/client/src/shell/model.ts";

const now = Date.parse("2026-10-17T02:00:00Z");

function view(
  id: string,
  name: string,
  projectId: string | null,
  over: Record<string, unknown> = {},
): AccountView {
  return {
    ...normalizeEnvironment({
      id,
      name,
      projectId,
      status: "running",
      settings: {
        timezone: null,
        locale: null,
        updatedAt: null,
      },
      ...over,
    }),
  };
}
const models = (views: AccountView[]) => buildAccountModels({ accounts: views, entries: [], now });

test("each account is a person: face, state, line; another project's says where to look", () => {
  const [alpha] = models([view("a1", "alpha", "p1", {})]);
  assert.deepEqual(personRow(alpha, now, { stalled: false }), {
    id: "a1",
    name: "alpha",
    label: null,
    initial: "A",
    state: "idle",
    line: "停着",
    desktopOn: true,
  });
  const other = personRow(alpha, now, { unknown: true, stalled: false });
  assert.equal(other.line, "切到所在群才看得到");
  assert.equal(other.state, "idle");
});

const credentials = normalizeCredentials({
  entries: [
    {
      id: "e-bad",
      kind: "site_login",
      site: "example.org",
      username: "bob",
      parts: { password: true, totp: null, cookies: null },
      usedBy: [{ type: "account", environmentId: "a2", name: "beta" }],
      lastResult: { status: "wrong_password", ok: false, at: "2026-10-17T01:00:00Z", detail: null },
      createdAt: "2026-10-10T01:00:00Z",
    },
    {
      id: "e-ok",
      kind: "site_login",
      site: "example.com",
      username: "alice",
      parts: { password: true, totp: null, cookies: null },
      usedBy: [{ type: "account", environmentId: "a1", name: "alpha" }],
      lastResult: { status: "signed_in", ok: true, at: "2026-10-17T01:00:00Z", detail: null },
      createdAt: "2026-10-10T01:00:00Z",
    },
    {
      id: "e-mail",
      kind: "mailbox",
      parts: {
        address: "sales@example.com",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        imapHost: null,
        imapPort: null,
        password: true,
      },
      usedBy: [{ type: "project" }],
      createdAt: "2026-10-10T01:00:00Z",
    },
    {
      id: "e-key",
      kind: "site_login",
      site: "example.net",
      username: "carol",
      parts: { password: true, totp: null, cookies: null },
      usedBy: [],
      createdAt: "2026-10-10T01:00:00Z",
      unreadable: true,
    },
  ],
  requests: [],
});

test("credentials: a card only for a failed or unreadable one; the rest quiet, grouped, no empties", () => {
  assert.deepEqual(
    credentials.entries.filter(needsJudgment).map((entry) => entry.id),
    ["e-bad", "e-key"],
  );
  assert.deepEqual(
    judgedEntries(credentials).map((entry) => entry.id),
    ["e-key", "e-bad"],
  );
  assert.equal(judgmentLine(judgedEntries(credentials)[1]), "example.org · bob · 上次：密码不对");
  const groups = quietGroups(credentials);
  // The unused login is a card, and so is beta's only login: their groups are left out.
  assert.deepEqual(
    groups.map((group) => [group.title, group.account?.initial ?? null, group.entries.length]),
    [
      ["发信邮箱", null, 1],
      ["alpha", "A", 1],
    ],
  );
  const ok = groups[1].entries[0];
  assert.equal(quietLine(ok), "上次：已登录");
  assert.equal(quietLine(groups[0].entries[0]), "用在：本群");
});

test("a member's spoken label says each part once", () => {
  assert.equal(
    spokenLabel(["alpha", "停着", "停着", null, "今天 2 件"]),
    "alpha · 停着 · 今天 2 件",
  );
  assert.equal(spokenLabel(["", undefined]), "");
});
