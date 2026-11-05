// Grouping by proxy exit and by project, and the mixed-project flag.
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountDetail,
  accountTitle,
  exitKey,
  exitLabel,
  MIXED_EXIT_WARNING,
  mixedExitsNotice,
  NO_PROXY_LABEL,
  normalizeTopology,
  projectName,
  type Topology,
  type TopologyEnvironment,
  topologyView,
  UNASSIGNED_LABEL,
  UNKNOWN_PROJECT_LABEL,
  UNREADABLE_PROXY_LABEL,
} from "../../../packages/client/src/topology-core.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const ORPHAN = "44444444-4444-4444-8444-444444444444";
let next = 0;
function account(
  name: string,
  projectId: string | null,
  proxy: TopologyEnvironment["proxy"],
  extra: Partial<TopologyEnvironment> = {},
): TopologyEnvironment {
  return {
    id: `env-${++next}`,
    name,
    accountLabel: null,
    projectId,
    proxy,
    proxyUnreadable: false,
    locale: "en-US",
    timezone: "America/Los_Angeles",
    desktop: "missing",
    ...extra,
  };
}
const shared = { scheme: "http", host: "203.0.113.10", port: 3128 };
const projects = [
  { id: A, name: "Alpha" },
  { id: B, name: "Beta" },
  { id: C, name: "Empty" },
];

test("the response is read defensively and keeps nothing but the proxy endpoint", () => {
  const topology = normalizeTopology({
    projects: [{ id: A, name: "Alpha" }, { name: "no id" }, "junk"],
    environments: [
      {
        id: "e1",
        name: "one",
        accountLabel: "u/one",
        projectId: A,
        proxy: { scheme: "http", host: "h.example", port: 8080, username: "u", password: "p" },
        proxyUnreadable: true,
        locale: "en-US",
        timezone: "UTC",
        desktop: "running",
      },
      { id: "e2", name: "two", proxy: { scheme: "http", host: "h", port: 70000 }, desktop: "?" },
      { name: "no id" },
      null,
    ],
  });
  assert.deepEqual(topology.projects, [{ id: A, name: "Alpha" }]);
  assert.equal(topology.environments.length, 2);
  const [one, two] = topology.environments;
  assert.deepEqual(one.proxy, { scheme: "http", host: "h.example", port: 8080 });
  assert.equal(one.proxyUnreadable, false, "a known endpoint is never unreadable");
  assert.equal(one.desktop, "running");
  assert.equal(two.proxy, null);
  assert.equal(two.desktop, "error");
  assert.equal(two.projectId, null);
  assert.equal(two.accountLabel, null);
  assert.deepEqual(normalizeTopology(null), { projects: [], environments: [] });
});

test("one proxy server is one exit, whatever the scheme spelling or host case", () => {
  assert.equal(
    exitKey({
      proxy: { scheme: "socks5", host: "Proxy.Example", port: 1080 },
      proxyUnreadable: false,
    }),
    exitKey({
      proxy: { scheme: "socks5h", host: "proxy.example", port: 1080 },
      proxyUnreadable: false,
    }),
  );
  assert.notEqual(
    exitKey({ proxy: { scheme: "http", host: "h", port: 1 }, proxyUnreadable: false }),
    exitKey({ proxy: { scheme: "http", host: "h", port: 2 }, proxyUnreadable: false }),
  );
  assert.equal(exitKey({ proxy: null, proxyUnreadable: false }), "none");
  assert.equal(exitKey({ proxy: null, proxyUnreadable: true }), "unreadable");
  assert.equal(exitLabel([shared], "proxy"), "http://203.0.113.10:3128");
  assert.equal(
    exitLabel(
      [
        { scheme: "socks5h", host: "p.example", port: 1080 },
        { scheme: "socks5", host: "p.example", port: 1080 },
      ],
      "proxy",
    ),
    "p.example:1080 (socks5, socks5h)",
  );
  assert.equal(exitLabel([], "none"), NO_PROXY_LABEL);
  assert.equal(exitLabel([], "unreadable"), UNREADABLE_PROXY_LABEL);
  assert.equal(projectName(null, projects), UNASSIGNED_LABEL);
  assert.equal(projectName(A, projects), "Alpha");
  assert.equal(projectName(ORPHAN, projects), UNKNOWN_PROJECT_LABEL);
});

test("an exit serving more than one project is flagged and listed first", () => {
  const topology: Topology = {
    projects,
    environments: [
      account("a-1", A, shared, { desktop: "running", accountLabel: "u/a1" }),
      account("b-1", B, { ...shared, scheme: "HTTP" }),
      account("a-2", A, { scheme: "socks5", host: "solo.example", port: 1080 }),
      account("a-3", A, { scheme: "socks5h", host: "Solo.Example", port: 1080 }),
      account("loose", null, { scheme: "http", host: "198.51.100.7", port: 8000 }),
      account("b-2", B, { scheme: "http", host: "198.51.100.7", port: 8000 }),
      account("bare-a", A, null),
      account("bare-b", B, null),
      account("broken", null, null, { proxyUnreadable: true }),
    ],
  };
  const view = topologyView(topology);
  assert.deepEqual(
    view.exits.map((group) => [group.label, group.mixed, group.accounts.map((a) => a.name)]),
    [
      ["http://198.51.100.7:8000", true, ["b-2", "loose"]],
      ["http://203.0.113.10:3128", true, ["a-1", "b-1"]],
      ["solo.example:1080 (socks5, socks5h)", false, ["a-2", "a-3"]],
      [UNREADABLE_PROXY_LABEL, false, ["broken"]],
      [NO_PROXY_LABEL, false, ["bare-a", "bare-b"]],
    ],
  );
  // Unassigned counts as a project of its own; "No proxy" is never a shared exit.
  assert.deepEqual(
    view.exits[0].projects.map((p) => p.name),
    ["Beta", UNASSIGNED_LABEL],
  );
  assert.equal(view.mixedExits, 2);
  assert.equal(mixedExitsNotice(view.mixedExits), "2 proxy exits are shared across projects.");
  assert.equal(mixedExitsNotice(1), "1 proxy exit is shared across projects.");
  assert.equal(mixedExitsNotice(0), null);
  assert.ok(MIXED_EXIT_WARNING.includes("one project"));
  assert.equal(view.summary, "9 accounts · 3 proxy exits · 3 projects");
  const a1 = view.exits[1].accounts[0];
  assert.equal(a1.projectName, "Alpha");
  assert.equal(a1.exitMixed, true);
  assert.equal(accountTitle(a1), "a-1 (u/a1)");
  assert.equal(accountDetail(a1), "Running · en-US · America/Los_Angeles");
  assert.equal(
    accountDetail({ desktop: "stopped", locale: null, timezone: null }),
    "Paused · sandbox kept · language not set · time zone not set",
  );
});

test("each project lists its accounts, exits and shared exits; unassigned comes last", () => {
  const view = topologyView({
    projects,
    environments: [
      account("a-1", A, shared),
      account("a-2", A, { scheme: "socks5", host: "solo.example", port: 1080 }),
      account("a-3", A, null),
      account("b-1", B, shared),
      account("lost", ORPHAN, { scheme: "http", host: "10.0.0.1", port: 1 }),
      account("loose", null, null, { proxyUnreadable: true }),
    ],
  });
  assert.deepEqual(
    view.projects.map((group) => [group.name, group.accounts.map((a) => a.name), group.countLine]),
    [
      [
        "Alpha",
        ["a-1", "a-2", "a-3"],
        "3 accounts · 2 proxy exits · 1 shared with another project · 1 without a known exit",
      ],
      ["Beta", ["b-1"], "1 account · 1 proxy exit · 1 shared with another project"],
      ["Empty", [], "No accounts"],
      [UNKNOWN_PROJECT_LABEL, ["lost"], "1 account · 1 proxy exit"],
      [UNASSIGNED_LABEL, ["loose"], "1 account · 0 proxy exits · 1 without a known exit"],
    ],
  );
  const alpha = view.projects[0];
  assert.equal(alpha.id, A);
  assert.equal(alpha.exits, 2);
  assert.equal(alpha.sharedExits, 1);
  assert.equal(view.projects.at(-1)?.id, null);
  // No unassigned accounts, no unassigned group.
  assert.ok(
    !topologyView({ projects, environments: [account("a", A, shared)] }).projects.some(
      (group) => group.id === null,
    ),
  );
});

test("an empty topology has no groups and still names its projects", () => {
  const view = topologyView({ projects, environments: [] });
  assert.deepEqual(view.exits, []);
  assert.equal(view.summary, "0 accounts · 0 proxy exits · 3 projects");
  assert.deepEqual(
    view.projects.map((group) => group.countLine),
    ["No accounts", "No accounts", "No accounts"],
  );
});
