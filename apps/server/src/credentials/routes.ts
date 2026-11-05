// /api/credentials, the one place the owner manages
// every credential of the current project (the X-OpenMuse-Project header; no header is the default
// project). Responses carry metadata only, never a value. An id of another project, or no entry at
// all, is the same 404.
import { Hono } from "hono";
import type { CredentialService } from "./service.ts";

export function credentialRoutes(credentials: CredentialService, available: () => void) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (_c, next) => {
    available();
    await next();
  });
  app.get("/", async (c) => c.json(await credentials.list(c.get("owner"))));
  app.post("/", async (c) =>
    c.json(await credentials.create(c.get("owner"), await c.req.json()), 201),
  );
  // Before /:id so "audit" and "sign-ins" are never read as an id. The project's own sign-in
  // facts (its default desktop's logins), for 需要你.
  app.get("/sign-ins", async (c) => c.json(await credentials.projectSignIns(c.get("owner"))));
  // The owner acted on the desktop for a site that needed a code: the AI looks again.
  app.post("/sign-ins/recheck", async (c) =>
    c.json(await credentials.recheck(c.get("owner"), await c.req.json())),
  );
  app.get("/audit", async (c) =>
    c.json(
      await credentials.history(c.get("owner"), {
        entry: c.req.query("entry") || undefined,
        before: c.req.query("before") || undefined,
      }),
    ),
  );
  app.get("/:id", async (c) => c.json(await credentials.get(c.get("owner"), c.req.param("id"))));
  app.patch("/:id", async (c) =>
    c.json(await credentials.patch(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/:id", async (c) => {
    await credentials.remove(c.get("owner"), c.req.param("id"));
    return c.body(null, 204);
  });
  return app;
}
