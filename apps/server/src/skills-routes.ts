// v1.4 (docs/skills.md): the space's skills, for 设置 and the @ list. Saving by sentence and
// learning from a chat happen in the conversation's tools; the person edits and deletes here.
import { Hono } from "hono";
import { type Skills, skillInputSchema, skillPatchSchema } from "./skills.ts";

export function skillRoutes(skills: Skills) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await skills.list(c.get("owner"))));
  app.post("/", async (c) => {
    const input = skillInputSchema.parse(await c.req.json());
    return c.json((await skills.save(c.get("owner"), input, "sentence")).skill, 201);
  });
  app.patch("/:id", async (c) =>
    c.json(
      await skills.update(
        c.get("owner"),
        c.req.param("id"),
        skillPatchSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.delete("/:id", async (c) => {
    await skills.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  return app;
}
