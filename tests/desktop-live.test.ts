// The live view through the Yuki service (apps/server/src/desktop-live.ts): the viewer page, its
// starter and the noVNC client are the service's own and are served only for a valid ticket and a
// plain path; nothing is ever fetched from the computer (it runs what its members run, and what it
// served would run next to the person's session). The websocket is relayed only for a ticket, an
// allowed origin and a well-formed handshake. The computer's address is never given to the browser.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopComputer } from "../apps/server/src/desktop-computer.ts";
import {
  attachDesktopLive,
  desktopLiveRoutes,
  viewerPolicy,
} from "../apps/server/src/desktop-live.ts";
import {
  novncFile,
  packageViewerFiles,
  type ViewerFiles,
} from "../apps/server/src/desktop-viewer.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

async function setup() {
  const agent = new FakeAgent();
  agent.running = true;
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    sweepMs: null,
  });
  const view = await computer.liveView("owner");
  const ticket = view.url.match(/live\/([A-Za-z0-9_-]+)\//)?.[1] ?? "";
  const read: string[] = [];
  const files: ViewerFiles = {
    async read(path) {
      read.push(path);
      return path === "core/rfb.js" ? "export default class RFB {}" : null;
    },
  };
  const app = desktopLiveRoutes(() => computer, files);
  return { agent, computer, ticket, read, app };
}

test("a valid ticket gets the service's viewer page, with a policy that allows no inline or foreign script", async () => {
  const { app, ticket } = await setup();
  const reply = await app.request(`/${ticket}/view.html?view_only=1`);
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type") ?? "", /text\/html/);
  const page = await reply.text();
  assert.match(page, /<script type="module" src="\.\/view\.js"><\/script>/);
  assert.doesNotMatch(page, /<script>(?!<)/, "no inline script");
  const policy = reply.headers.get("content-security-policy") ?? "";
  assert.equal(policy, viewerPolicy);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
});

test("the starter connects noVNC to the websocket next to the page, view-only unless view_only=0", async () => {
  const { app, ticket } = await setup();
  const reply = await app.request(`/${ticket}/view.js`);
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type") ?? "", /text\/javascript/);
  const script = await reply.text();
  assert.match(script, /import RFB from "\.\/novnc\/core\/rfb\.js"/);
  assert.match(script, /replace\(\/\[\^\/\]\*\$\/, "websockify"\)/);
  assert.match(script, /params\.get\("view_only"\) !== "0"/);
});

test("noVNC's files come from the service's own copy, only .js under core/ and vendor/", async () => {
  const { app, ticket, read } = await setup();
  const rfb = await app.request(`/${ticket}/novnc/core/rfb.js`);
  assert.equal(rfb.status, 200);
  assert.equal(await rfb.text(), "export default class RFB {}");
  assert.equal((await app.request(`/${ticket}/novnc/core/missing.js`)).status, 404);
  assert.deepEqual(read, ["core/rfb.js", "core/missing.js"]);
  for (const path of ["core/rfb.js", "vendor/pako/lib/zlib/inflate.js", "core/decoders/raw.js"])
    assert.ok(novncFile.test(path), path);
  for (const path of ["app/ui.js", "core/../x.js", "core/rfb.json", "vnc.html", "core/", ".js"])
    assert.ok(!novncFile.test(path), path);
});

test("the pinned noVNC package is read from disk, and nothing outside it", async () => {
  const files = packageViewerFiles();
  assert.match((await files.read("core/rfb.js")) ?? "", /export default class RFB/);
  assert.ok((await files.read("vendor/pako/lib/zlib/inflate.js"))?.length);
  assert.equal(await files.read("../package.json"), null);
  assert.equal(await files.read("core/../../package.json"), null);
  assert.equal(await files.read("LICENSE.txt"), null);
});

test("a missing, unknown, short or malformed ticket is refused before anything is read", async () => {
  const { app, read } = await setup();
  for (const ticket of [
    "nope",
    "a".repeat(30),
    "../".repeat(10),
    `${"a".repeat(19)}`,
    "a".repeat(65),
  ])
    assert.ok(
      [403, 404].includes((await app.request(`/${ticket}/view.html`)).status),
      `refused: ${ticket}`,
    );
  assert.deepEqual(read, []);
});

test("a path that is not a plain file path, or not one of the viewer's files, is refused", async () => {
  const { app, ticket, read } = await setup();
  const bad = [
    "..%2F..%2Fetc%2Fpasswd",
    "%2e%2e/%2e%2e/etc/passwd",
    "a/../../b",
    "a%2F..%2Fb",
    "%00",
    "a%00b",
    "a//b",
    "a b",
    "a%5Cb",
    "%252e%252e/x",
    "%E0%A4%A",
    "vnc_lite.html",
    "vnc.html",
    "novnc/app/ui.js",
    "novnc/../package.json",
  ];
  for (const path of bad) {
    const reply = await app.request(`/${ticket}/${path}`);
    assert.ok([400, 403, 404].includes(reply.status), `${path} -> ${reply.status}`);
  }
  assert.ok(
    read.every((path) => novncFile.test(path)),
    `only noVNC paths were looked up: ${read.join(", ")}`,
  );
});

test("the viewer's files need a live ticket, not a running computer; no computer, no page", async () => {
  const { app, ticket, agent } = await setup();
  agent.running = false;
  assert.equal((await app.request(`/${ticket}/view.html`)).status, 200);
  assert.equal((await desktopLiveRoutes(() => null).request(`/${ticket}/view.html`)).status, 403);
});

// ---- the websocket ------------------------------------------------------------------------------

class FakeServer extends EventEmitter {}
function handshake(
  server: FakeServer,
  url: string,
  headers: Record<string, string>,
): Promise<{ written: string; ended: boolean }> {
  const socket = new PassThrough();
  let written = "";
  socket.on("data", (chunk) => {
    written += String(chunk);
  });
  server.emit("upgrade", { url, headers }, socket, Buffer.alloc(0));
  return new Promise((resolve) =>
    setTimeout(() => resolve({ written, ended: socket.writableEnded || socket.destroyed }), 50),
  );
}

test("the websocket is relayed only for a ticket, an allowed origin and a key", async () => {
  const { computer, ticket } = await setup();
  const server = new FakeServer();
  server.on("upgrade", () => {});
  const connections: { port: number; host: string }[] = [];
  attachDesktopLive(server, () => computer, new Set(["http://localhost:8787"]), ((
    port: number,
    host: string,
  ) => {
    connections.push({ port, host });
    return Object.assign(new PassThrough(), { destroy() {}, pipe: () => new PassThrough() });
  }) as never);
  const good = {
    origin: "http://localhost:8787",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  const path = `/api/computer/live/${ticket}/websockify`;

  const wrongOrigin = await handshake(server, path, { ...good, origin: "http://evil.example" });
  assert.match(wrongOrigin.written, /^HTTP\/1.1 403/);
  const noOrigin = await handshake(server, path, {
    "sec-websocket-key": good["sec-websocket-key"],
  });
  assert.match(noOrigin.written, /^HTTP\/1.1 403/);
  const noKey = await handshake(server, path, { origin: good.origin });
  assert.match(noKey.written, /^HTTP\/1.1 403/);
  const badTicket = await handshake(
    server,
    `/api/computer/live/${"z".repeat(30)}/websockify`,
    good,
  );
  assert.match(badTicket.written, /^HTTP\/1.1 403/);
  assert.deepEqual(connections, [], "nothing was opened to the computer");

  await handshake(server, path, good);
  assert.deepEqual(connections, [{ port: 6080, host: "computer" }]);
});

test("an upgrade for another path is not this relay's: refused when nobody else listens", async () => {
  const { computer } = await setup();
  const server = new FakeServer();
  attachDesktopLive(server, () => computer, new Set(["http://localhost:8787"]));
  const other = await handshake(server, "/api/other", {});
  assert.match(other.written, /^HTTP\/1.1 404/);
  const traversal = await handshake(server, "/api/computer/live/../websockify", {});
  assert.match(traversal.written, /^HTTP\/1.1 404/);
});
