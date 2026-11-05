// The live view of the members' computer, through the Yuki service (open core, v1.5): the person's
// 看电脑 frame loads the viewer page and opens its websocket here, same-origin. The page, its
// starter and the noVNC client are the service's own (desktop-viewer.ts): the computer runs what
// its members run, and a script it served would run in this origin, next to the person's session.
// Only the websocket is relayed to the computer container, which is never published on the host.
// An iframe cannot send the session's bearer token, so the path carries a ticket the signed-in
// session got from GET /api/computer/desktop (desktop-computer.ts `liveView`); it is checked on
// every request. The websocket goes to the view-only VNC server unless the person took over.
import type { IncomingMessage } from "node:http";
import { connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import type { DesktopComputer } from "./desktop-computer.ts";
import {
  novncFile,
  packageViewerFiles,
  type ViewerFiles,
  viewerPage,
  viewerScript,
} from "./desktop-viewer.ts";

const ticketPattern = "[A-Za-z0-9_-]{20,64}";
const socketPath = new RegExp(`^/api/computer/live/(${ticketPattern})/websockify(?:\\?.*)?$`);
/** A path under the ticket: plain names only. */
const assetPath = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
/** The page only ever loads the service's own files and talks to this origin (its websocket
 * comes back here); no inline script runs. */
export const viewerPolicy =
  "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'";

/** GET /api/computer/live/<ticket>/<file>: the viewer page (view.html), its starter (view.js) and
 * the noVNC client (novnc/core/…, novnc/vendor/…), all from the service, never from the computer.
 * Mounted before the session check (the ticket is the check). */
export function desktopLiveRoutes(
  computer: () => DesktopComputer | null,
  files: ViewerFiles = packageViewerFiles(),
) {
  const app = new Hono();
  app.get("/:ticket/*", async (c) => {
    const desktop = computer();
    const ticket = c.req.param("ticket");
    if (!desktop || !new RegExp(`^${ticketPattern}$`).test(ticket) || !desktop.liveOwner(ticket))
      return c.json({ error: "This view expired; open 看电脑 again" }, 403);
    let rest: string;
    try {
      rest = decodeURIComponent(c.req.path.split(`/${ticket}/`)[1] ?? "");
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    if (!assetPath.test(rest) || rest.split("/").includes(".."))
      return c.json({ error: "Not found" }, 404);
    let body: string | null = null;
    let type = "text/javascript; charset=utf-8";
    if (rest === "view.html") {
      body = viewerPage;
      type = "text/html; charset=utf-8";
    } else if (rest === "view.js") body = viewerScript;
    else if (rest.startsWith("novnc/") && novncFile.test(rest.slice("novnc/".length)))
      body = await files.read(rest.slice("novnc/".length));
    if (body === null) return c.json({ error: "Not found" }, 404);
    c.header("Content-Type", type);
    c.header("Content-Security-Policy", viewerPolicy);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(body);
  });
  return app;
}

export interface UpgradeServer {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  listenerCount(event: string): number;
}

const refuse = (socket: Duplex, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

/** Relays the live view's websocket to the computer's VNC bridge. `origins`: the origins the
 * API accepts (a page elsewhere cannot open the person's live view with a leaked ticket). */
export function attachDesktopLive(
  server: UpgradeServer,
  computer: () => DesktopComputer | null,
  origins: ReadonlySet<string>,
  connect: typeof tcpConnect = tcpConnect,
) {
  server.on("upgrade", (request, socket, head) => {
    const match = socketPath.exec(request.url ?? "");
    if (!match) {
      // Nobody else answers an upgrade on this server.
      if (server.listenerCount("upgrade") === 1) refuse(socket, "404 Not Found");
      return;
    }
    const origin = request.headers.origin;
    const key = request.headers["sec-websocket-key"];
    if (!origin || !origins.has(origin) || typeof key !== "string")
      return refuse(socket, "403 Forbidden");
    const desktop = computer();
    if (!desktop) return refuse(socket, "404 Not Found");
    void desktop.liveTarget(match[1]).then(
      (target) => {
        if (!target) return refuse(socket, "403 Forbidden");
        const upstream = connect(target.port, target.host);
        let release = () => false;
        const closeBoth = () => {
          release();
          socket.destroy();
          upstream.destroy();
        };
        release = (() => {
          const held = desktop.holdSocket({ driver: target.driver, close: closeBoth });
          return () => held();
        })();
        upstream.on("connect", () => {
          const protocol = request.headers["sec-websocket-protocol"];
          upstream.write(
            [
              `GET /websockify?token=${encodeURIComponent(target.token)} HTTP/1.1`,
              `Host: ${target.host}:${target.port}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${key}`,
              "Sec-WebSocket-Version: 13",
              ...(typeof protocol === "string" ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
              "",
              "",
            ].join("\r\n"),
          );
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        // The person's input keeps the computer awake; a watching frame does not.
        if (target.driver === "person") socket.on("data", () => desktop.touch());
        upstream.on("error", closeBoth);
        socket.on("error", closeBoth);
        upstream.on("close", closeBoth);
        socket.on("close", closeBoth);
      },
      () => refuse(socket, "502 Bad Gateway"),
    );
  });
}
