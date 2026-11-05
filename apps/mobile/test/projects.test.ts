import assert from "node:assert/strict";
import test from "node:test";
import { MuseApiClient, projectHeaders } from "../../../packages/client/src/api-client.ts";
import { ApiError } from "../../../packages/client/src/api-response.ts";
import {
  accountsLabel,
  memoryStorage,
  noContent,
  normalizeProject,
  normalizeProjects,
  PROJECT_STORAGE_KEY,
  type ProjectStorage,
  projectError,
  projectGone,
  projectKey,
  projectLabel,
  projectPath,
  projectsUnavailable,
  readStoredProject,
  resolveStoredProject,
  validProjectName,
  writeStoredProject,
} from "../../../packages/client/src/projects-core.ts";
import { PROJECT_HEADER } from "../../../packages/domain/src/projects.ts";

const id = "6f1d2c3a-1111-4222-8333-444455556666";
const other = "0f9e8d7c-2222-4333-8444-555566667777";
const view = {
  id,
  name: "Reddit outreach",
  deleting: false,
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T11:00:00.000Z",
  environments: 2,
};

test("each space opens the project last open in it", () => {
  const storage = memoryStorage();
  const other = "22222222-2222-4222-8222-222222222222";
  // Chosen before spaces: the first space still opens it.
  writeStoredProject(storage, id);
  assert.equal(readStoredProject(storage, "space-a"), id);
  writeStoredProject(storage, other, "space-b");
  writeStoredProject(storage, null, "space-a");
  assert.equal(readStoredProject(storage, "space-b"), other);
  assert.equal(readStoredProject(storage, "space-a"), null, "未分组 stays chosen in space A");
  writeStoredProject(storage, id, "space-a");
  assert.equal(readStoredProject(storage, "space-a"), id);
  assert.equal(readStoredProject(storage, "space-b"), other);
});

test("the chosen project survives a reload and unreadable storage reads as the default", () => {
  const storage = memoryStorage();
  assert.equal(readStoredProject(storage), null);
  writeStoredProject(storage, id);
  assert.equal(storage.getItem(PROJECT_STORAGE_KEY), id);
  assert.equal(readStoredProject(storage), id);
  // The default project clears the entry rather than storing a sentinel.
  writeStoredProject(storage, null);
  assert.equal(storage.getItem(PROJECT_STORAGE_KEY), null);
  assert.equal(readStoredProject(storage), null);
  // Only a UUID is trusted; anything else (tampered, legacy) is the default project.
  storage.setItem(PROJECT_STORAGE_KEY, "default");
  assert.equal(readStoredProject(storage), null);
  storage.setItem(PROJECT_STORAGE_KEY, "../x");
  assert.equal(readStoredProject(storage), null);
  // No storage at all (native) and a throwing one (blocked web storage) never break the app.
  assert.equal(readStoredProject(undefined), null);
  assert.equal(readStoredProject(null), null);
  writeStoredProject(undefined, id);
  const blocked: ProjectStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readStoredProject(blocked), null);
  assert.doesNotThrow(() => writeStoredProject(blocked, id));
  assert.doesNotThrow(() => writeStoredProject(blocked, null));
});

test("a stored project is kept only while it still exists and is not being deleted", () => {
  const projects = [view, { ...view, id: other, name: "Gone", deleting: true }];
  assert.equal(resolveStoredProject(id, projects), id);
  assert.equal(resolveStoredProject(other, projects), null);
  assert.equal(resolveStoredProject("1111aaaa-1111-4222-8333-444455556666", projects), null);
  assert.equal(resolveStoredProject(null, projects), null);
  assert.equal(resolveStoredProject(id, []), null);
});

test("project names are trimmed, limited and may not be the default", () => {
  assert.equal(validProjectName("  Reddit outreach "), "Reddit outreach");
  assert.deepEqual(validProjectName(""), { error: "Name is required" });
  assert.deepEqual(validProjectName("   "), { error: "Name is required" });
  assert.equal(validProjectName("x".repeat(64)), "x".repeat(64));
  assert.deepEqual(validProjectName("x".repeat(65)), {
    error: "Name must be at most 64 characters",
  });
  for (const name of ["default", "Default", " DEFAULT ", "默认"])
    assert.deepEqual(validProjectName(name), {
      error: `Name "${name.trim()}" is reserved for the default project`,
    });
});

test("project views are read defensively", () => {
  assert.deepEqual(normalizeProject(view), view);
  const empty = normalizeProject({});
  assert.deepEqual(empty, {
    id: "",
    name: "",
    deleting: false,
    createdAt: "",
    updatedAt: "",
    environments: 0,
  });
  assert.equal(normalizeProject(null).id, "");
  assert.equal(normalizeProject({ ...view, deleting: "yes" }).deleting, false);
  assert.equal(normalizeProject({ ...view, environments: "3" }).environments, 0);
  assert.equal(normalizeProject({ ...view, environments: 2.9 }).environments, 2);
  assert.equal(normalizeProject({ ...view, environments: -1 }).environments, 0);
  assert.equal(normalizeProject({ ...view, environments: Number.NaN }).environments, 0);
  // Lists drop entries without an id and keep the server's (by name) order.
  const list = normalizeProjects([{ ...view, name: "B" }, { name: "no id" }, null, view]);
  assert.deepEqual(
    list.map((item) => item.name),
    ["B", "Reddit outreach"],
  );
  assert.deepEqual(normalizeProjects({ not: "a list" }), []);
});

test("labels, keys and paths", () => {
  assert.equal(projectLabel(null), "Default");
  assert.equal(projectLabel(undefined), "Default");
  assert.equal(projectLabel(view), "Reddit outreach");
  assert.equal(accountsLabel(0), "0 accounts");
  assert.equal(accountsLabel(1), "1 account");
  assert.equal(accountsLabel(2), "2 accounts");
  assert.equal(projectKey(null), "default");
  assert.equal(projectKey(id), id);
  assert.equal(projectPath("a b"), "/api/projects/a%20b");
});

test("only the feature-off 503 hides projects; a project 404 is explained", () => {
  assert.equal(projectsUnavailable(new ApiError("Projects are disabled", 503)), true);
  assert.equal(projectsUnavailable(new ApiError("Service unavailable", 502)), false);
  assert.equal(projectsUnavailable(new Error("offline")), false);
  assert.equal(projectGone(new ApiError("Project not found", 404)), true);
  assert.equal(projectGone(new ApiError("Not found", 404)), false);
  assert.equal(
    projectError(new ApiError("Project not found", 404)),
    "This project no longer exists. Pick another one.",
  );
  assert.equal(projectError(new ApiError("Project name is taken", 409)), "Project name is taken");
  assert.equal(projectError("boom"), "boom");
});

test("a 204 reads as success, every other failure is kept", async () => {
  await noContent(Promise.reject(new Error("The server returned an unreadable response (204).")));
  await assert.rejects(noContent(Promise.reject(new ApiError("Project not found", 404))), {
    status: 404,
  });
  await assert.rejects(noContent(Promise.reject(new Error("offline"))), /offline/);
  await noContent(Promise.resolve({ ok: true }));
});

test("the project header is sent on every scoped request and never on an unscoped one", async () => {
  assert.deepEqual(projectHeaders(id), { [PROJECT_HEADER]: id });
  assert.deepEqual(projectHeaders(null), {});
  assert.deepEqual(projectHeaders(undefined), {});
  assert.deepEqual(projectHeaders(""), {});

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const scoped = new MuseApiClient("http://api.test", "tok", id);
    assert.deepEqual(scoped.headers(), { Authorization: "Bearer tok", [PROJECT_HEADER]: id });
    assert.deepEqual(await scoped.request("/api/workspace"), { ok: true });
    await scoped.request("/api/projects", { name: "x" });
    await scoped.request("/api/environments/abc", { projectId: null }, "PATCH");
    const form = new FormData();
    form.append("file", new Blob(["%PDF"]), "a.pdf");
    await scoped.request("/api/files", form);
    assert.deepEqual(
      calls.map((call) => [call.url, call.init.method]),
      [
        ["http://api.test/api/workspace", "GET"],
        ["http://api.test/api/projects", "POST"],
        ["http://api.test/api/environments/abc", "PATCH"],
        ["http://api.test/api/files", "POST"],
      ],
    );
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer tok");
      assert.equal(headers[PROJECT_HEADER], id);
    }
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], undefined);
    assert.equal(
      (calls[1].init.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.equal(calls[1].init.body, JSON.stringify({ name: "x" }));
    assert.equal((calls[3].init.headers as Record<string, string>)["Content-Type"], undefined);
    assert.equal(calls[3].init.body, form);

    calls.length = 0;
    const unscoped = new MuseApiClient("http://api.test/", "tok");
    assert.equal(unscoped.projectId, null);
    assert.deepEqual(unscoped.headers(), { Authorization: "Bearer tok" });
    await unscoped.request("/api/projects");
    assert.equal(PROJECT_HEADER in (calls[0].init.headers as Record<string, string>), false);
    // url() is untouched by the project: it only prefixes relative paths.
    assert.equal(scoped.url("/api/x"), "http://api.test/api/x");
    assert.equal(scoped.url("https://cdn.test/y"), "https://cdn.test/y");
  } finally {
    globalThis.fetch = original;
  }
});
