// The accounts page and the credentials page in the
// members-bar manner: each account a person (its state, its line, its 经营循环), a card only
// where the owner has to judge, group headings without counts, empty groups left out.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnvironment } from "../../../packages/client/src/environments.ts";
import {
  groupByExit,
  groupByProject,
} from "../../../packages/client/src/shell/accounts/accounts-core.ts";
import {
  judgmentCards,
  personRow,
  plainGroupTitle,
} from "../../../packages/client/src/shell/accounts/people-core.ts";
import { normalizeCredentials } from "../../../packages/client/src/shell/credentials/credentials-core.ts";
import { spokenLabel } from "../../../packages/client/src/shell/members/members-core.ts";
import {
  type AccountView,
  buildAccountModels,
  normalizePacing,
} from "../../../packages/client/src/shell/model.ts";

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
      proxyConfigured: true,
      settings: {
        proxy: { configured: true, preview: "http://•••@203.0.113.7:8080" },
        timezone: null,
        locale: null,
        updatedAt: null,
        unreadable: false,
      },
      ...over,
    }),
    pacing: normalizePacing({ status: { usedToday: { "x/post": 2 }, lastActionAt: null } }),
  };
}
const models = (views: AccountView[]) => buildAccountModels({ accounts: views, entries: [], now });

test("each account is a person: face, state, line, 经营循环; another project's says where to look", () => {
  const [alpha] = models([view("a1", "alpha", "p1", { founder: true })]);
  assert.deepEqual(personRow(alpha, now, { stalled: false }), {
    id: "a1",
    name: "alpha",
    label: null,
    initial: "A",
    founder: true,
    state: "idle",
    line: "停着",
    routine: "今天 2 件",
    desktopOn: true,
  });
  const other = personRow(alpha, now, { unknown: true, stalled: false });
  assert.equal(other.line, "切到所在群才看得到");
  assert.equal(other.state, "idle");
});

test("only an account with something the owner must judge gets a card, in words", () => {
  const list = models([
    view("a1", "beta", "p1", { proxyConfigured: false, settings: undefined }),
    view("a2", "alpha", "p1"),
  ]);
  const flagged = list.filter((account) => account.flags.length);
  assert.ok(flagged.length >= 1);
  const cards = judgmentCards(list);
  assert.deepEqual(
    cards.map((card) => card.id),
    flagged.map((account) => account.id),
  );
  assert.ok(cards.every((card) => card.text.length > 0 && !/\d+ 个/.test(card.text)));
  // A flagged account of another project still reads as one that needs the owner.
  assert.equal(personRow(flagged[0], now, { unknown: true, stalled: false }).state, "needs");
});

test("group headings name the group, never count it", () => {
  const list = models([view("a1", "alpha", "p1"), view("a2", "beta", null)]);
  const names = {
    projectName: (id: string | null) => (id === "p1" ? "acmeskills" : "未分配"),
    exitLabel: (exit: string) => exit,
  };
  const byProject = groupByProject(list, [{ id: "p1", name: "acmeskills" }], "p1");
  assert.deepEqual(
    byProject.map((group) => plainGroupTitle(group, names)),
    ["acmeskills", "未分配"],
  );
  const byExit = groupByExit(list, {
    exitOf: (account) => account.exit,
    labels: new Map(),
    projectName: names.projectName,
  });
  for (const group of byExit) assert.doesNotMatch(plainGroupTitle(group, names), /\d+ 个|\(\d+\)/);
  assert.equal(plainGroupTitle(byExit[0], names), "203.0.113.7:8080 · acmeskills");
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
      id: "e-proxy",
      kind: "proxy",
      parts: { scheme: "socks5", host: "203.0.113.7", port: 1080, auth: true },
      usedBy: [{ type: "account", environmentId: "a1", name: "alpha" }],
      createdAt: "2026-10-10T01:00:00Z",
    },
  ],
  requests: [],
});

test("a member's spoken label says each part once", () => {
  assert.equal(
    spokenLabel(["alpha", "停着", "停着", null, "今天 2 件"]),
    "alpha · 停着 · 今天 2 件",
  );
  assert.equal(spokenLabel(["", undefined]), "");
});
