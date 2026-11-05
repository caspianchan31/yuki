// v1.2: making a member needs a name, a shape and a color (and, optionally, a template). The
// body, the name check, the Chinese refusals and the template setup are plain functions.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMemberTemplate,
  browserTimezone,
  newMemberBody,
  newMemberError,
  newMemberNameProblem,
} from "../packages/client/src/shell/members/new-member.ts";
import { t } from "../packages/client/src/shell/strings.ts";
import { identityName } from "../packages/domain/src/member-face.ts";
import { memberTemplateById, memberTemplates } from "../packages/domain/src/member-templates.ts";

test("the body carries the trimmed name, the face and the browser's time zone", () => {
  assert.deepEqual(
    newMemberBody({
      name: "  Ann  ",
      face: { shape: "pill", color: "#E5484D" },
      timezone: "Asia/Shanghai",
    }),
    { name: "Ann", face: { shape: "pill", color: "#E5484D" }, timezone: "Asia/Shanghai" },
  );
  const bare = newMemberBody({
    name: "Ann",
    face: { shape: "cloud", color: "#8D8D8D" },
    timezone: "",
  });
  assert.ok(!("timezone" in bare), "an unknown zone is not sent");
  assert.ok(!("proxyUrl" in bare) && !("locale" in bare), "no proxy, language or login is asked");
});

test("the browser's zone is used only in the spelling the server accepts", () => {
  assert.equal(
    browserTimezone(() => "asia/shanghai"),
    "Asia/Shanghai",
  );
  assert.equal(
    browserTimezone(() => "Mars/Base"),
    "",
  );
  assert.equal(
    browserTimezone(() => undefined),
    "",
  );
  assert.equal(
    browserTimezone(() => {
      throw new Error("no Intl");
    }),
    "",
  );
});

test("a name is checked before it is sent", () => {
  assert.equal(newMemberNameProblem("Ann"), null);
  assert.equal(newMemberNameProblem("   "), t.newMember.nameRequired);
  assert.equal(newMemberNameProblem("x".repeat(65)), t.newMember.nameTooLong(64));
  assert.equal(newMemberNameProblem("x".repeat(64)), null);
  assert.equal(newMemberNameProblem(" Default "), t.newMember.nameReserved("Default"));
});

test("the server's refusals read in Chinese, in the words of a member", () => {
  assert.equal(
    newMemberError('An environment named "Ann" already exists'),
    "已经有叫「Ann」的成员了，换一个名字",
  );
  assert.equal(
    newMemberError("Environments are limited to 20"),
    "成员最多 20 个，删掉一个才能再建",
  );
  assert.equal(newMemberError("Name is required"), "名字必填");
  assert.equal(newMemberError("Name must be 64 characters or fewer"), "名字最多 64 个字");
  assert.equal(
    newMemberError('Name "default" is reserved for the default desktop'),
    "「default」是保留名，换一个名字",
  );
  assert.equal(
    newMemberError("Face shape is not one of the listed shapes"),
    t.newMember.faceInvalid,
  );
  assert.equal(
    newMemberError("Face color is not one of the listed colors"),
    t.newMember.faceInvalid,
  );
  // An English sentence nobody mapped never reaches the dialog as English.
  assert.equal(newMemberError("Something odd happened"), t.server.unmapped);
});

test("a template is saved as persona, goal and one repeating task per routine with an interval", async () => {
  const calls: { path: string; body: unknown; method?: string }[] = [];
  const api = {
    async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
      calls.push({ path, body, method });
      return undefined as T;
    },
  };
  const template = memberTemplateById("morning-brief");
  assert.ok(template);
  await applyMemberTemplate(api, template, "env 1", "Asia/Shanghai");
  assert.equal(calls[0].path, "/api/agent/accounts/env%201/persona");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[1].path, "/api/agent/accounts/env%201/goal");
  assert.equal(calls[1].method, "PUT");
  const tasks = calls.slice(2);
  assert.equal(tasks.length, 2);
  for (const call of tasks) {
    assert.equal(call.path, "/api/agent/tasks");
    assert.deepEqual((call.body as { input: unknown }).input, { environmentId: "env 1" });
  }
  // The 7:30 clock routine wakes at a fixed time in the browser's zone.
  assert.ok((tasks[0].body as { nextRunAt?: string }).nextRunAt);
});

test("a template without a zone still saves, its clock routines just have no first wake", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = {
    async request<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ path, body });
      return undefined as T;
    },
  };
  await applyMemberTemplate(api, memberTemplates[0], "e1", "");
  const first = calls.find((call) => call.path === "/api/agent/tasks");
  assert.ok(first);
  assert.ok(!("nextRunAt" in (first.body as object)));
});

test("a space made before the rename goes by Yuki; a name the owner chose stays", () => {
  assert.equal(identityName("OpenMuse"), "Yuki");
  assert.equal(identityName(undefined), "Yuki");
  assert.equal(identityName("Mira"), "Mira");
});
