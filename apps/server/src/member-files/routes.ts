// /api/members/:id/files: a member's AGENTS.md, MEMORY.md and daily notes. `yuki` is the main
// member; any other id must be an account of the request's space.
import { Hono } from "hono";
import { z } from "zod";
import {
  memberFileMaxBytes,
  parseMemberFilePath,
} from "../../../../packages/domain/src/member-files.ts";
import type { AgentService } from "../engine/service.ts";
import { AppError } from "../errors.ts";
import type { AppEnv } from "../tenancy-port.ts";

const bodySchema = z.object({ content: z.string().max(memberFileMaxBytes) });

export function memberFileRoutes(agent: AgentService) {
  const app = new Hono<AppEnv>();
  const member = async (owner: string, id: string) => {
    const ref = await agent.memberRef(owner, id);
    if (!ref) throw new AppError("Member not found", 404);
    return ref;
  };
  /** Everything after `/<id>/files/` in the request's path, decoded, and checked. */
  const pathOf = (url: string, id: string) => {
    let raw = "";
    try {
      const pathname = decodeURIComponent(new URL(url).pathname);
      const marker = `/${id}/files/`;
      raw = pathname.slice(pathname.indexOf(marker) + marker.length);
    } catch {
      // a bad escape is no path
    }
    const path = parseMemberFilePath(raw);
    if (!path) throw new AppError("That file is not available", 400);
    return path;
  };
  app.get("/:id/files", async (c) => {
    const ref = await member(c.get("owner"), c.req.param("id"));
    return c.json({
      member: { id: ref.id, name: ref.name },
      files: await agent.memberFiles.list(ref),
    });
  });
  app.get("/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const ref = await member(c.get("owner"), id);
    const file = await agent.memberFiles.read(ref, pathOf(c.req.url, id));
    if (!file) throw new AppError("File not found", 404);
    return c.json(file);
  });
  app.put("/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const ref = await member(c.get("owner"), id);
    const path = pathOf(c.req.url, id);
    const { content } = bodySchema.parse(await c.req.json());
    const meta = await agent.memberFiles.write(ref, path, content, c.get("user").username);
    return c.json({ ...meta, content });
  });
  return app;
}
