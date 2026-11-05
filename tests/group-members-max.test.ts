// v1.2: a group holds at most groupMembersMax members; a seventh is refused in Chinese, and a
// group that is already over the limit keeps its members and can still send one back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { groupMembersMax, projectOwner } from "../packages/domain/src/projects.ts";
import { type Harness, harness, proxy } from "./helpers/sign-in-harness.ts";

async function group(h: Harness, name: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.db.put(h.owner, "projects", {
    id,
    name,
    deleting: false,
    createdAt: now,
    updatedAt: now,
  });
  return { id, owner: projectOwner(h.owner, id) };
}
const member = (h: Harness, name: string) =>
  h.environments.create(h.owner, { name, proxyUrl: proxy });

test("a full group refuses a new member with the Chinese limit message", async (t) => {
  const h = await harness(t);
  const g = await group(h, "满员群");
  assert.equal(groupMembersMax, 6);
  for (let i = 0; i < groupMembersMax; i++)
    await h.environments.assign(g.owner, (await member(h, `m${i}`)).id, g.id);
  const extra = await member(h, "extra");
  await assert.rejects(h.environments.assign(g.owner, extra.id, g.id), /一个群最多 6 个成员/);
  // Still unassigned, and a free seat lets her in.
  assert.equal((await h.environments.unassigned(g.owner)).length, 1);
  const [first] = await h.environments.records(g.owner);
  await h.environments.assign(g.owner, first.id, null);
  await h.environments.assign(g.owner, extra.id, g.id);
  assert.equal((await h.environments.records(g.owner)).length, groupMembersMax);
});

test("a group over the limit already keeps its members and can still send one back", async (t) => {
  const h = await harness(t);
  const g = await group(h, "旧的大群");
  const ids: string[] = [];
  // Seven members through the lower-level move, as older data would have them.
  for (let i = 0; i < groupMembersMax + 1; i++) {
    const created = await member(h, `old${i}`);
    await h.environments.move(h.owner, created.id, null, g.id);
    ids.push(created.id);
  }
  assert.equal((await h.environments.records(g.owner)).length, groupMembersMax + 1);
  await h.environments.assign(g.owner, ids[0], null);
  assert.equal((await h.environments.records(g.owner)).length, groupMembersMax);
});
