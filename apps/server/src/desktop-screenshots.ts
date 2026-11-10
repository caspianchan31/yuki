// The pictures members take of the computer (open core, v1.5): computer_screenshot keeps each one
// (desktop-computer.ts `keepShot`; since v1.6 on disk, desktop-shots-store.ts) and names it in its
// result (shotId); the chat shows it from here. Mounted at /api/computer/screenshots, behind the
// session check.
import { Hono } from "hono";
import type { DesktopComputer } from "./desktop-computer.ts";
import { sniffImage } from "./image-generation.ts";

/** GET /:id: a kept screenshot (JPEG since v1.7.5, PNG before); 404 when there is no such picture (never kept, past the
 * retention, or its conversation was deleted). */
export function desktopScreenshotRoutes(desktop: () => DesktopComputer) {
  const app = new Hono();
  app.get("/:id", (c) => {
    const png = desktop().shotOf(c.req.param("id"));
    if (!png) return c.json({ error: "This screenshot is gone" }, 404);
    c.header("Content-Type", sniffImage(png) ?? "image/png");
    // A picture never changes once kept; the browser may keep it for a day.
    c.header("Cache-Control", "private, max-age=86400");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(png));
  });
  return app;
}
