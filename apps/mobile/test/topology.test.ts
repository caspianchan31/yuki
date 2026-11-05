// Reading the members' topology (v1.5: no proxy or exit, so nothing is grouped by one).
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountDetail,
  accountTitle,
  normalizeTopology,
  projectName,
  UNASSIGNED_LABEL,
  UNKNOWN_PROJECT_LABEL,
} from "../../../packages/client/src/topology-core.ts";

const A = "11111111-1111-4111-8111-111111111111";

test("the response is read defensively and keeps no proxy or exit, whatever it carries", () => {
  const topology = normalizeTopology({
    projects: [{ id: A, name: "Alpha" }, { name: "no id" }, "junk"],
    environments: [
      {
        id: "e1",
        name: "one",
        accountLabel: "u/one",
        projectId: A,
        // An older server's fields are not read.
        proxy: { scheme: "http", host: "h.example", port: 8080, username: "u", password: "p" },
        proxyUnreadable: true,
        locale: "en-US",
        timezone: "UTC",
        desktop: "running",
      },
      { id: "e2", name: "two", desktop: "?" },
      { name: "no id" },
      null,
    ],
  });
  assert.deepEqual(topology.projects, [{ id: A, name: "Alpha" }]);
  assert.equal(topology.environments.length, 2);
  const [one, two] = topology.environments;
  assert.deepEqual(one, {
    id: "e1",
    name: "one",
    accountLabel: "u/one",
    projectId: A,
    locale: "en-US",
    timezone: "UTC",
    desktop: "running",
  });
  assert.equal(two.desktop, "error");
  assert.equal(two.projectId, null);
  assert.equal(two.accountLabel, null);
  assert.deepEqual(normalizeTopology(null), { projects: [], environments: [] });
});

test("an account names its project, its desktop, its language and its time zone", () => {
  assert.equal(projectName(null, []), UNASSIGNED_LABEL);
  assert.equal(projectName(A, [{ id: A, name: "Alpha" }]), "Alpha");
  assert.equal(projectName("gone", [{ id: A, name: "Alpha" }]), UNKNOWN_PROJECT_LABEL);
  assert.equal(
    accountDetail({ desktop: "running", locale: "en-US", timezone: "UTC" }),
    "Running · en-US · UTC",
  );
  assert.equal(
    accountDetail({ desktop: "missing", locale: null, timezone: null }),
    "Not created · language not set · time zone not set",
  );
  assert.equal(accountTitle({ name: "one", accountLabel: "u/one" }), "one (u/one)");
  assert.equal(accountTitle({ name: "one", accountLabel: null }), "one");
});
