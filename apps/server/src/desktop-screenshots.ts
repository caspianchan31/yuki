// The pictures members take of the computer (open core, v1.5): computer_screenshot keeps each one
// for an hour (desktop-computer.ts `keepShot`) and names it in its result (shotId); the chat shows
// it from here. Mounted at /api/computer/screenshots, behind the session check.
import { Hono } from "hono";
import type { DesktopComputer } from "./desktop-computer.ts";

/** GET /:id: a kept screenshot as PNG; 404 when unknown or older than an hour. */
export function desktopScreenshotRoutes(desktop: () => DesktopComputer) {
  const app = new Hono();
  app.get("/:id", (c) => {
    const png = desktop().shotOf(c.req.param("id"));
    if (!png) return c.json({ error: "This screenshot is gone (kept for an hour)" }, 404);
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "private, max-age=3600");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(png));
  });
  return app;
}
