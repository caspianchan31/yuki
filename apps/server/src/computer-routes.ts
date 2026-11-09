// The computer API of the open core. With no computer container configured it is what there is to
// see (nothing connected) and every other route answers 503 or is absent; with one configured
// (docs/computer-container.md) it starts and pauses the members' computer, hands the live view and
// the controls to the person (接手 / 交还), runs commands and reads and writes files.
import { Hono } from "hono";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import {
  contentDisposition,
  workspaceFileMaxBytes,
  workspaceMediaType,
} from "../../../packages/domain/src/workspace-files.ts";
import type { ComputerService } from "./computer.ts";
import {
  desktopCommandSchema,
  desktopOf,
  desktopPathSchema,
  desktopRenameSchema,
  desktopWriteSchema,
  trashEntrySchema,
} from "./desktop-computer.ts";
import { desktopScreenshotRoutes } from "./desktop-screenshots.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

/** `owner` keys the computer; when mounted under an environment it is the derived owner,
 * `filesOwner` the real one (Files are shared) and `environmentRef` the environment. */
export type ComputerRouteVariables = {
  owner: string;
  filesOwner?: string;
  environmentRef?: EnvironmentRef;
};

export function computerRoutes(computer: ComputerService, _files: Files) {
  const app = new Hono<{ Variables: ComputerRouteVariables }>();
  const desktop = () => {
    const found = desktopOf(computer);
    if (!found) throw new AppError("No computer is connected (未接电脑).", 503);
    return found;
  };
  app.get("/", async (c) => c.json(await computer.snapshot(c.get("owner"))));
  if (!desktopOf(computer)) return app;
  app.post("/start", async (c) => c.json(await computer.start(c.get("owner"))));
  app.post("/stop", async (c) => c.json(await computer.stop(c.get("owner"))));
  // A screenshot a member took (computer_screenshot's shotId), for the chat's picture.
  app.route("/screenshots", desktopScreenshotRoutes(desktop));
  // The live view's address (a ticket in its path) and who drives; 409 while the computer is paused.
  app.get("/desktop", async (c) => c.json(await desktop().liveView(c.get("owner"))));
  // 接手 ({"by": "person"}) and 交还 ({"by": "member"}).
  app.post("/control", async (c) =>
    c.json(await desktop().setControl(c.get("owner"), await c.req.json())),
  );
  app.post("/commands", async (c) =>
    c.json(
      await computer.execute(c.get("owner"), desktopCommandSchema.parse(await c.req.json()), {
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.get("/files", async (c) => c.json(await desktop().list(c.req.query("path"))));
  app.post("/files/read", async (c) => {
    const { path } = desktopPathSchema.parse(await c.req.json());
    return c.json(await desktop().read(path));
  });
  app.post("/files/write", async (c) => {
    const { path, text } = desktopWriteSchema.parse(await c.req.json());
    return c.json(await desktop().write(path, text));
  });
  app.post("/files/mkdir", async (c) => {
    const { path } = desktopPathSchema.parse(await c.req.json());
    return c.json(await desktop().mkdir(path));
  });
  // ── v1.6 文件浏览器 (the person's file page; docs/computer-container.md) ──
  // Every folder and file at once, for the page's search (⌘K by file name).
  app.get("/files/tree", async (c) => c.json(await desktop().tree()));
  // A file's bytes: downloaded, or shown in the page (?inline=1: a picture, a PDF). Served with
  // the type its name says, never as HTML.
  app.get("/files/download", async (c) => {
    const { path } = desktopPathSchema.parse({ path: c.req.query("path") });
    const { name, bytes } = await desktop().readBytes(path);
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": workspaceMediaType(name),
      "Content-Disposition": contentDisposition(name, c.req.query("inline") === "1"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
  });
  // An upload: the file's bytes as the body, its whole path in the query; 10 MB at most.
  app.post("/files/upload", async (c) => {
    const { path } = desktopPathSchema.parse({ path: c.req.query("path") });
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > workspaceFileMaxBytes) throw new AppError("Files must be 10 MB or smaller", 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await desktop().writeBytes(path, bytes));
  });
  app.post("/files/rename", async (c) => {
    const { path, to } = desktopRenameSchema.parse(await c.req.json());
    return c.json(await desktop().rename(path, to));
  });
  // Deleted into the recycle bin (30 days), listed, brought back, or removed for good.
  app.post("/files/delete", async (c) => {
    const { path } = desktopPathSchema.parse(await c.req.json());
    return c.json(await desktop().remove(path));
  });
  app.get("/files/trash", async (c) => c.json(await desktop().trash()));
  app.post("/files/restore", async (c) => {
    const { id } = trashEntrySchema.parse(await c.req.json());
    return c.json(await desktop().restore(id));
  });
  app.post("/files/purge", async (c) => {
    const { id } = trashEntrySchema.parse(await c.req.json());
    return c.json(await desktop().purge(id));
  });
  return app;
}
