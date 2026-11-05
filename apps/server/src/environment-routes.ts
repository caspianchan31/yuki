// The /api/environments contract (members). Everything under /:id/computer is the
// ordinary computer API acting on the environment's derived owner; Files keep the real one.
import { Hono } from "hono";
import { z } from "zod";
import type { ComputerService } from "./computer.ts";
import { type ComputerRouteVariables, computerRoutes } from "./computer-routes.ts";
import { type EnvironmentService, environmentRef, envOwner } from "./environments.ts";
import type { Files } from "./files.ts";

const threadSchema = z.string().min(1).max(200);
const selectSchema = z.object({ environmentId: z.string().nullable() });
// A PATCH carrying projectId is an assignment, not an edit.
const assignSchema = z.object({ projectId: z.string().nullable() });

/** A line of the space's activity (`owner`: the request's owner). */
export type AccountActivityHook = (
  owner: string,
  action: "account.create" | "account.delete" | "account.move",
  subject: string,
  detail: string | null,
) => Promise<void>;

export function environmentRoutes(
  environments: EnvironmentService,
  computer: ComputerService,
  files: Files,
  activity: AccountActivityHook = async () => {},
  /** The name of a project of the request's space (null: unassigned), for an account's move. */
  projectName: (owner: string, projectId: string | null) => Promise<string | null> = async () =>
    null,
) {
  const app = new Hono<{ Variables: ComputerRouteVariables }>();
  app.use("*", async (_c, next) => {
    environments.assertAvailable();
    await next();
  });
  // Registered before the mount so it runs first: the environment must exist and not be
  // deleting, then the computer routes see the derived owner while Files keep the real one.
  app.use("/:id/computer/*", async (c, next) => {
    const owner = c.get("owner");
    const environment = await environments.get(owner, c.req.param("id"));
    c.set("filesOwner", owner);
    c.set("environmentRef", environmentRef(environment));
    c.set("owner", envOwner(owner, environment.id));
    await next();
  });
  app.get("/", async (c) => c.json(await environments.list(c.get("owner"))));
  app.post("/", async (c) => {
    const created = await environments.create(c.get("owner"), await c.req.json());
    await activity(c.get("owner"), "account.create", created.name, null);
    return c.json(created, 201);
  });
  // Conversation selection, before /:id so "conversation" is never read as an id.
  app.get("/conversation/:threadId", async (c) =>
    c.json(
      await environments.selection(c.get("owner"), threadSchema.parse(c.req.param("threadId"))),
    ),
  );
  app.put("/conversation/:threadId", async (c) => {
    const { environmentId } = selectSchema.parse(await c.req.json());
    return c.json(
      await environments.select(
        c.get("owner"),
        threadSchema.parse(c.req.param("threadId")),
        environmentId,
      ),
    );
  });
  // Unassigned accounts a project may take; before /:id like "conversation".
  app.get("/unassigned", async (c) => c.json(await environments.listUnassigned(c.get("owner"))));
  app.get("/everyone", async (c) => c.json(await environments.everyone(c.get("owner"))));
  app.get("/:id", async (c) => c.json(await environments.view(c.get("owner"), c.req.param("id"))));
  app.patch("/:id", async (c) => {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && "projectId" in body) {
      const target = assignSchema.parse(body).projectId;
      // An assignment is always a move (anything else is refused before this).
      const moved = await environments.assign(c.get("owner"), c.req.param("id"), target);
      await activity(
        c.get("owner"),
        "account.move",
        moved.name,
        await projectName(c.get("owner"), target),
      );
      return c.json(moved);
    }
    return c.json(await environments.patch(c.get("owner"), c.req.param("id"), body));
  });
  app.delete("/:id", async (c) => {
    const before = await environments.find(c.get("owner"), c.req.param("id"));
    await environments.remove(c.get("owner"), c.req.param("id"));
    if (before) await activity(c.get("owner"), "account.delete", before.name, null);
    return c.body(null, 204);
  });
  app.route("/:id/computer", computerRoutes(computer, files));
  return app;
}
