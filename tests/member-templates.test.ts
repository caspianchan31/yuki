// v1.2: the 8 member templates a new member can start from. The list, its order and
// the apps it may name are the contract the picker and the server build on, so they are checked
// here rather than in the picker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberTemplateById, memberTemplates } from "../packages/domain/src/member-templates.ts";

const templateIds = [
  "morning-brief",
  "inbox-triage",
  "researcher",
  "watcher",
  "writer",
  "social",
  "data-reporter",
  "support",
];

const connectableApps = new Set([
  "gmail",
  "google-calendar",
  "google-sheets",
  "google-docs",
  "slack",
  "github",
  "notion",
  "linear",
  "x",
  "reddit",
  "v2ex",
  "web",
]);

test("member templates: exactly 8, in the fixed id order", () => {
  assert.equal(memberTemplates.length, 8);
  assert.deepEqual(
    memberTemplates.map((template) => template.id),
    templateIds,
  );
});

test("member templates: ids are unique and kebab-case", () => {
  const seen = new Set<string>();
  for (const { id } of memberTemplates) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(seen.has(id), false, `duplicate id: ${id}`);
    seen.add(id);
  }
});

test("member templates: every template has a name, role, persona and routines", () => {
  for (const template of memberTemplates) {
    assert.ok(template.name.trim().length > 0, `${template.id}: name is empty`);
    assert.ok(template.role.trim().length > 0, `${template.id}: role is empty`);
    assert.ok(template.persona.trim().length > 0, `${template.id}: persona is empty`);
    assert.ok(template.routines.length > 0, `${template.id}: no routines`);
    for (const routine of template.routines) {
      assert.ok(routine.title.trim().length > 0, `${template.id}: routine title is empty`);
      assert.ok(routine.when.trim().length > 0, `${template.id}: routine when is empty`);
      assert.ok(
        routine.instruction.trim().length > 0,
        `${template.id}: routine instruction is empty`,
      );
    }
  }
});

test("member templates: every app is connectable", () => {
  for (const template of memberTemplates) {
    assert.ok(template.apps.length > 0, `${template.id}: connects no apps`);
    for (const app of template.apps) {
      assert.ok(connectableApps.has(app), `${template.id}: unknown app ${app}`);
    }
  }
});

test("member templates: memberTemplateById finds a template and rejects an unknown id", () => {
  assert.equal(memberTemplateById("researcher")?.name, "调研员");
  assert.equal(memberTemplateById("no-such-template"), undefined);
});
