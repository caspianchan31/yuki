// The built web app, served beside the API (WEB_DIR; the docker compose image sets it), so one
// published port is the whole product. A file under the folder is served as it is; any other
// path that is not the API answers the app's index page (the app routes in the browser).
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Hono } from "hono";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** The file a request path names inside `root`, or null when it names nothing there. */
export async function webFile(root: string, requestPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = normalize(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!extname(full)) return null;
  try {
    await readFile(full);
    return full;
  } catch {
    return null;
  }
}

export function mountWeb(app: Hono<any>, root: string) {
  app.get("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/")) return next();
    const file = await webFile(root, path);
    const target = file ?? join(root, "index.html");
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      return next();
    }
    c.header("Content-Type", types[extname(target)] ?? "application/octet-stream");
    // Hashed assets never change; the index page always does.
    c.header(
      "Cache-Control",
      file && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return c.body(new Uint8Array(bytes));
  });
}
