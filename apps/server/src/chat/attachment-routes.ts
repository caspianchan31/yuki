// v1.6 聊天里发文件: the chat's attachment routes (/api/chat/attachments). The composer uploads
// each file before the message is sent and puts the ids it gets back into the message; the chat
// shows a file by its id. A download is served as what its name says, never as a page
// (HTML and SVG come back as plain text), with the UTF-8 file name.
import { Hono } from "hono";
import {
  attachmentMaxBytes,
  attachmentMediaType,
  cleanAttachmentName,
} from "../../../../packages/domain/src/chat-attachments.ts";
import {
  contentDisposition,
  extensionOf,
} from "../../../../packages/domain/src/workspace-files.ts";
import { AppError } from "../errors.ts";
import type { AttachmentMeta, AttachmentStore } from "./attachment-store.ts";

export interface AttachmentRouteHooks {
  /** Puts a copy of the file on the members' computer (/workspace/收到/<name>); the path it
   * got, or null when there is no computer to put it on. Never throws into the upload. */
  receive?(owner: string, name: string, bytes: Uint8Array): Promise<string | null>;
}

/** What the web gets of an attachment. */
export function publicAttachment(meta: AttachmentMeta) {
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    createdAt: meta.createdAt,
    workspacePath: meta.workspacePath,
  };
}

/** The media type a download is served as: never a page in the app's origin. */
export function servedMediaType(name: string, mimeType: string): string {
  const extension = extensionOf(name);
  if (
    extension === "html" ||
    extension === "htm" ||
    extension === "svg" ||
    extension === "xhtml" ||
    /^(text\/html|image\/svg|application\/xhtml)/.test(mimeType)
  )
    return "text/plain; charset=utf-8";
  if (mimeType.startsWith("text/") && !mimeType.includes("charset"))
    return `${mimeType}; charset=utf-8`;
  return mimeType;
}

export function attachmentRoutes(store: AttachmentStore, hooks: AttachmentRouteHooks = {}) {
  const routes = new Hono<{ Variables: { owner: string } }>();
  routes.post("/", async (c) => {
    const name = cleanAttachmentName(c.req.query("name") ?? "");
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > attachmentMaxBytes) throw new AppError("Files must be 10 MB or smaller", 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) throw new AppError("The file is empty", 400);
    const mimeType = attachmentMediaType(name, c.req.header("content-type"));
    const owner = c.get("owner");
    const meta = await store.save({ owner, name, mimeType, bytes });
    let workspacePath: string | null = null;
    if (hooks.receive) {
      try {
        workspacePath = await hooks.receive(owner, name, bytes);
      } catch {
        workspacePath = null;
      }
      if (workspacePath) await store.placed(meta.id, workspacePath);
    }
    return c.json(publicAttachment({ ...meta, workspacePath }), 201);
  });
  routes.get("/:id/meta", async (c) => {
    const meta = await store.meta(c.get("owner"), c.req.param("id"));
    if (!meta) throw new AppError("No such attachment", 404);
    return c.json(publicAttachment(meta));
  });
  routes.get("/:id", async (c) => {
    const file = await store.read(c.get("owner"), c.req.param("id"));
    if (!file) throw new AppError("No such attachment", 404);
    const inline = c.req.query("inline") === "1";
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": servedMediaType(file.meta.name, file.meta.mimeType),
        "Content-Disposition": contentDisposition(file.meta.name, inline),
        "Content-Length": String(file.bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
  return routes;
}
