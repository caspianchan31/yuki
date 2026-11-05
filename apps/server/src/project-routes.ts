// Fork feature: the /api/projects contract. These routes always act as the real owner: the
// project header is ignored here, so a client inside one project can still list, create,
// rename and delete projects.
import { Hono } from "hono";
import { type ProjectOverviewSources, projectOverviewRoutes } from "./project-overview.ts";
import type { ProjectService } from "./projects.ts";

/** A line of the space's activity (`owner` is the space's key). */
export type ActivityHook = (
  owner: string,
  action: "project.create" | "project.rename" | "project.delete",
  subject: string,
  detail: string | null,
) => Promise<void>;

export function projectRoutes(
  projects: ProjectService,
  overview?: ProjectOverviewSources,
  activity: ActivityHook = async () => {},
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await projects.list(c.get("owner"))));
  // Every project's numbers; before /:id so "overview" is never an id.
  if (overview) app.route("/overview", projectOverviewRoutes(overview));
  app.post("/", async (c) => {
    const project = await projects.create(c.get("owner"), await c.req.json());
    await activity(c.get("owner"), "project.create", project.name, null);
    return c.json(project, 201);
  });
  app.patch("/:id", async (c) => {
    const before = await projects.get(c.get("owner"), c.req.param("id"));
    const project = await projects.rename(c.get("owner"), c.req.param("id"), await c.req.json());
    if (before.name !== project.name)
      await activity(c.get("owner"), "project.rename", before.name, project.name);
    return c.json(project);
  });
  app.delete("/:id", async (c) => {
    const before = await projects.find(c.get("owner"), c.req.param("id"));
    await projects.remove(c.get("owner"), c.req.param("id"));
    if (before) await activity(c.get("owner"), "project.delete", before.name, null);
    return c.body(null, 204);
  });
  return app;
}
