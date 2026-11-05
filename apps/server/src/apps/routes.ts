// v1.4 (docs/apps.md): /api/apps, the directory and the connections. The two OAuth callbacks
// (/api/slack/callback, /api/apps/mcp/callback) are registered in app.ts before the session check.
import { Hono } from "hono";
import { connectAppSchema, customMcpSchema } from "../../../../packages/domain/src/apps.ts";
import { AppError } from "../errors.ts";
import { mcpPresets, slugOf } from "./mcp.ts";
import type { AppsService } from "./service.ts";

export interface GoogleHandles {
  connect: (owner: string) => Promise<unknown>;
  disconnect: (owner: string) => Promise<unknown>;
}

export function appRoutes(apps: AppsService, google: GoogleHandles) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await apps.directory(c.get("owner"))));
  // A custom MCP server: name, address, optional bearer token.
  app.post("/mcp", async (c) => {
    const body = customMcpSchema.parse(await c.req.json());
    const slug = slugOf(body.name);
    if (!slug) throw new AppError("名字里要有字母或数字", 400);
    if (mcpPresets.some((preset) => preset.slug === slug))
      throw new AppError("这个名字是预设应用的，直接在列表里连接它", 409);
    return c.json(
      await apps.connectMcp(c.get("owner"), {
        slug,
        name: body.name,
        url: body.url,
        token: body.token || undefined,
        threadId: body.threadId,
      }),
    );
  });
  app.post("/:id/connect", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    if (id === "gmail" || id === "google-calendar") return c.json(await google.connect(owner));
    const body = connectAppSchema.parse(await c.req.json().catch(() => ({})));
    if (id === "slack") return c.json(await apps.connectSlack(owner, body.threadId));
    if (id === "mailbox") throw new AppError("邮箱在本群的凭据里添加", 409);
    const preset = mcpPresets.find((item) => `mcp:${item.slug}` === id);
    if (!preset) throw new AppError("没有这个应用", 404);
    return c.json(
      await apps.connectMcp(owner, {
        slug: preset.slug,
        name: preset.name,
        url: preset.url,
        token: body.token || undefined,
        preset: true,
        threadId: body.threadId,
      }),
    );
  });
  app.post("/:id/disconnect", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    if (id === "gmail" || id === "google-calendar") await google.disconnect(owner);
    else if (id === "mailbox") throw new AppError("邮箱在本群的凭据里移除", 409);
    else await apps.disconnect(owner, id);
    return c.json({ ok: true });
  });
  return app;
}
