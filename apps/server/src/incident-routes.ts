// An incident and its picture
// for the members of the space it happened in (/api/incidents, the request's space), and every
// space's incidents for the platform operator (/api/platform/incidents). Anyone else gets 404,
// the same answer as for an invented id.
import { Hono } from "hono";
import type { SessionUser } from "./auth.ts";
import type { IncidentRecord, Incidents } from "./incidents.ts";
import type { RequestSpace } from "./tenancy-port.ts";

type Variables = { owner: string; user: SessionUser; space: RequestSpace };

const image = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Mounted at /api/incidents: one incident of the request's space, and its picture. */
export function incidentRoutes(incidents: Incidents) {
  const app = new Hono<{ Variables: Variables }>();
  const mine = (c: { get: (key: "space") => RequestSpace }, id: string): Promise<IncidentRecord> =>
    incidents.inSpace(c.get("space").key, id);
  app.get("/:id", async (c) => {
    const [view] = await incidents.views([await mine(c, c.req.param("id"))]);
    // A member sees their own space's name in the app already; the list's names are the
    // operator's.
    return c.json({ ...view, space: { id: null, name: null } });
  });
  app.get("/:id/shot", async (c) => image(await incidents.shot(await mine(c, c.req.param("id")))));
  return app;
}

/** Mounted at /api/platform/incidents: every space's incidents, newest first, system ones first
 * (the client orders them too), and any incident's picture; only the operator. */
export function platformIncidentRoutes(
  incidents: Incidents,
  assertOperator: (user: SessionUser) => void,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.get("/", async (c) => {
    assertOperator(c.get("user"));
    const all = await incidents.all();
    return c.json({
      incidents: await incidents.views([
        ...all.filter((record) => record.system),
        ...all.filter((record) => !record.system),
      ]),
    });
  });
  app.get("/:id/shot", async (c) => {
    assertOperator(c.get("user"));
    const found = await incidents.find(c.req.param("id"));
    if (!found) return c.json({ error: "No picture" }, 404);
    return image(await incidents.shot(found.record));
  });
  return app;
}
