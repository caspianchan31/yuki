// v1.6 文件浏览器: the person's file page over the members' computer's /workspace. The service
// turns the page's requests into the files helper's operations (paths normalised, uploads
// bounded), the open routes serve a download with the type its name says (never HTML) and keep
// the recycle bin's ids to the helper's own form, and the pure helpers the page and the server
// share sort out kinds, crumbs and names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { computerRoutes } from "../apps/server/src/computer-routes.ts";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopComputer } from "../apps/server/src/desktop-computer.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  cleanFileName,
  contentDisposition,
  parentPath,
  pathCrumbs,
  sizeLabel,
  workspaceFileKind,
  workspaceMediaType,
} from "../packages/domain/src/workspace-files.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

/** The fake agent answering each file operation the way the helper does. */
class FilesAgent extends FakeAgent {
  override async files<T>(request: Record<string, unknown>): Promise<T> {
    this.fileRequests.push(request);
    const path = request.path as string;
    switch (request.operation) {
      case "read_bytes":
        return { path, base64: Buffer.from("<svg>x</svg>").toString("base64"), size: 11 } as T;
      case "delete":
        return { id: "20261107120000-0a1b2c3d", path, deletedAt: "2026-11-07T12:00:00Z" } as T;
      case "trash_list":
        return { entries: [], days: 30 } as T;
      case "tree":
        return { entries: [], truncated: false } as T;
      default:
        return { path: (request.to as string) ?? path } as T;
    }
  }
}

async function setup() {
  const agent = new FilesAgent();
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    now: () => 1_000_000,
    idleMs: 15 * 60_000,
    sweepMs: null,
  });
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", "o");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request" }, 400);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status as 400);
    return c.json({ error: String(error) }, 500);
  });
  app.route("/", computerRoutes({ container: computer } as never, {} as never));
  return { agent, computer, app };
}

test("the service sends the helper the page's operations, paths normalised, uploads bounded", async () => {
  const { agent, computer } = await setup();
  await computer.rename("收到/a.txt", "/workspace/成品/b.txt");
  await computer.remove("成品/b.txt");
  await computer.restore("20261107120000-0a1b2c3d");
  await computer.purge("20261107120000-0a1b2c3d");
  await computer.trash();
  await computer.tree();
  await computer.writeBytes("收到/pic.png", new Uint8Array([1, 2, 3]));
  const read = await computer.readBytes("/workspace/成品/图.svg");
  assert.equal(read.name, "图.svg");
  assert.equal(read.bytes.toString(), "<svg>x</svg>");
  assert.deepEqual(
    agent.fileRequests.map((request) => request.operation),
    [
      "rename",
      "delete",
      "restore",
      "trash_delete",
      "trash_list",
      "tree",
      "write_bytes",
      "read_bytes",
    ],
  );
  assert.deepEqual(agent.fileRequests[0], {
    operation: "rename",
    path: "/workspace/收到/a.txt",
    to: "/workspace/成品/b.txt",
  });
  assert.equal(agent.fileRequests[6]?.base64, Buffer.from([1, 2, 3]).toString("base64"));
  await assert.rejects(
    () => computer.writeBytes("big.bin", new Uint8Array(10 * 1024 * 1024 + 1)),
    (error: AppError) => error.status === 413,
  );
  await assert.rejects(
    () => computer.rename("a", "/etc/b"),
    (error: AppError) => error.status === 400,
  );
  await assert.rejects(
    () => computer.remove("/workspace/../x"),
    (error: AppError) => error.status === 400,
  );
});

test("a download is served as what its name says, never as a page; an upload too large is refused", async () => {
  const { app, agent } = await setup();
  const svg = await app.request("/files/download?path=/workspace/成品/图.svg&inline=1");
  assert.equal(svg.status, 200);
  // SVG (and HTML) come back as plain text: a file in the workspace never runs in the app.
  assert.equal(svg.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    svg.headers.get("content-disposition") ?? "",
    /^inline; filename="_.svg"; filename\*=UTF-8''%E5%9B%BE\.svg$/,
  );
  assert.equal(await svg.text(), "<svg>x</svg>");
  const attached = await app.request("/files/download?path=/workspace/a.png");
  assert.match(attached.headers.get("content-disposition") ?? "", /^attachment; filename="a.png"/);
  assert.equal(attached.headers.get("content-type"), "image/png");
  assert.equal((await app.request("/files/download?path=/etc/passwd")).status, 400);
  assert.equal((await app.request("/files/download")).status, 400);
  const uploaded = await app.request("/files/upload?path=/workspace/收到/x.bin", {
    method: "POST",
    body: new Uint8Array([9, 9]),
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), { path: "/workspace/收到/x.bin" });
  assert.equal(agent.fileRequests.at(-1)?.operation, "write_bytes");
  const tooBig = await app.request("/files/upload?path=/workspace/收到/big.bin", {
    method: "POST",
    headers: { "content-length": String(11 * 1024 * 1024) },
    body: new Uint8Array([1]),
  });
  assert.equal(tooBig.status, 413);
});

test("the recycle bin's routes: delete, list, restore, purge; an id not the helper's is refused", async () => {
  const { app, agent } = await setup();
  const deleted = await app.request("/files/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "收到/old.txt" }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).id, "20261107120000-0a1b2c3d");
  assert.equal((await app.request("/files/trash")).status, 200);
  for (const route of ["/files/restore", "/files/purge"]) {
    const ok = await app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "20261107120000-0a1b2c3d" }),
    });
    assert.equal(ok.status, 200, route);
    const bad = await app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../../etc" }),
    });
    assert.equal(bad.status, 400, route);
  }
  const renamed = await app.request("/files/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/workspace/a", to: "/workspace/b" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await app.request("/files/tree")).status, 200);
  assert.deepEqual(
    agent.fileRequests.map((request) => request.operation),
    ["delete", "trash_list", "restore", "trash_delete", "rename", "tree"],
  );
});

test("kinds, media types, crumbs and names the page relies on", () => {
  assert.equal(workspaceFileKind("/workspace/成品/报告.md"), "markdown");
  assert.equal(workspaceFileKind("notes.MARKDOWN"), "markdown");
  assert.equal(workspaceFileKind("a.PNG"), "image");
  assert.equal(workspaceFileKind("a.pdf"), "pdf");
  assert.equal(workspaceFileKind("script.py"), "text");
  assert.equal(workspaceFileKind(".gitignore"), "other", "a dot file has no extension");
  assert.equal(workspaceFileKind("report.docx"), "other");
  assert.equal(workspaceMediaType("a.jpeg"), "image/jpeg");
  assert.equal(workspaceMediaType("a.html"), "text/plain; charset=utf-8");
  assert.equal(workspaceMediaType("a.unknown"), "application/octet-stream");
  assert.equal(
    contentDisposition("/workspace/报告 v2.pdf", false),
    "attachment; filename=\"__ v2.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.pdf",
  );
  assert.equal(parentPath("/workspace"), "/workspace");
  assert.equal(parentPath("/workspace/a.txt"), "/workspace");
  assert.equal(parentPath("/workspace/收到/深/x"), "/workspace/收到/深");
  assert.deepEqual(pathCrumbs("/workspace/收到/深", "电脑"), [
    { label: "电脑", path: "/workspace" },
    { label: "收到", path: "/workspace/收到" },
    { label: "深", path: "/workspace/收到/深" },
  ]);
  assert.deepEqual(pathCrumbs("/workspace", "电脑"), [{ label: "电脑", path: "/workspace" }]);
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(2048), "2 KB");
  assert.equal(sizeLabel(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(cleanFileName("  报告.md "), "报告.md");
  for (const bad of ["", " ", ".", "..", ".hidden", "a/b", "a\\b", "x".repeat(256)])
    assert.equal(cleanFileName(bad), null, JSON.stringify(bad));
});
