// The live view's page (open core, v1.5): served by the Yuki service itself, never by the members'
// computer. The page and its scripts run in the service's own origin, where the person's session
// lives, and the computer runs whatever its members run: a script it served could read that
// session. So the page, its starter and the noVNC client all come from the service (noVNC from the
// pinned @novnc/novnc package), and the computer only answers the VNC websocket.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";

/** The frame's page. The script is a file of its own: the policy allows no inline script.
 * v1.7.3: `preload` lists the noVNC modules the starter needs (moduleGraph), so the browser asks
 * for all of them at once instead of one import level after another. */
export function viewerPageFor(preload: readonly string[] = []): string {
  const links = preload.map((href) => `<link rel="modulepreload" href="${href}">\n`).join("");
  return viewerPage.replace("</head>", `${links}</head>`);
}

export const viewerPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>电脑的实时画面</title>
<style>
html, body { margin: 0; height: 100%; background: #1f1f1f; overflow: hidden; }
#screen { position: absolute; inset: 0; }
#status { position: absolute; left: 0; right: 0; top: 45%; text-align: center; color: #ddd;
  font: 14px system-ui, sans-serif; }
</style>
</head>
<body>
<div id="screen"></div>
<div id="status">正在连接电脑…</div>
<script type="module" src="./view.js"></script>
</body>
</html>
`;

/** The page's starter: connects noVNC to this ticket's websocket, view-only unless the address
 * says view_only=0 (the person took the computer over). */
/** The starter, importing noVNC from `lib` (v1.7.3: the shared copy, ../lib/<version>/). */
export function viewerScriptFor(lib: string): string {
  return viewerScriptBody.replace("__LIB__", lib);
}

const viewerScriptBody = `import RFB from "__LIB__core/rfb.js";

const status = document.getElementById("status");
const say = (text) => {
  status.textContent = text;
  status.hidden = !text;
};
const params = new URLSearchParams(location.search);
const scheme = location.protocol === "https:" ? "wss" : "ws";
const socket = scheme + "://" + location.host + location.pathname.replace(/[^/]*$/, "websockify");
try {
  const rfb = new RFB(document.getElementById("screen"), socket);
  rfb.viewOnly = params.get("view_only") !== "0";
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", () => say(""));
  rfb.addEventListener("disconnect", (event) =>
    say(event.detail.clean ? "画面已断开，重新点「看电脑」" : "连不上电脑的画面"),
  );
  rfb.addEventListener("credentialsrequired", () => say("电脑的画面要求密码，连不上"));
} catch (error) {
  say("画面打不开：" + (error && error.message ? error.message : String(error)));
}
`;

/** The starter as v1.5 served it, importing noVNC next to the page (novnc/). */
export const viewerScript = viewerScriptFor("./novnc/");

/** Where the pinned noVNC package is: the folder holding its core/ and vendor/. */
/** The pinned noVNC package's version: the shared copy's address carries it, so the browser can
 * keep the files for good and a new version is a new address. */
export function novncVersion(root: () => string = novncRoot): string {
  try {
    const version = JSON.parse(readFileSync(resolve(root(), "package.json"), "utf8")).version;
    return typeof version === "string" && /^[0-9A-Za-z.-]{1,32}$/.test(version) ? version : "0";
  } catch {
    return "0";
  }
}

/** The noVNC modules `entry` imports, directly or not, in the order they are found (the entry
 * first): read from the files themselves, so the page can ask for all of them at once. */
export async function moduleGraph(files: ViewerFiles, entry = "core/rfb.js"): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift() as string;
    const text = await files.read(path);
    if (text === null) continue;
    found.push(path);
    const base = path.split("/").slice(0, -1);
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const parts = [...base];
      for (const part of (match[1] as string).split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      }
      const next = parts.join("/");
      if (!novncFile.test(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return found;
}

function novncRoot(): string {
  const entry = createRequire(import.meta.url).resolve("@novnc/novnc");
  return resolve(dirname(entry), "..");
}

/** The noVNC files the page may load: `.js` under core/ or vendor/, plain names only. */
export const novncFile = /^(?:core|vendor)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/;

export interface ViewerFiles {
  /** One noVNC file by its path under the package, or null when there is none. */
  read(path: string): Promise<string | null>;
}

/** The package's files, read once each. */
export function packageViewerFiles(root: () => string = novncRoot): ViewerFiles {
  const cache = new Map<string, string | null>();
  return {
    async read(path) {
      if (!novncFile.test(path) || path.split("/").includes("..")) return null;
      if (cache.has(path)) return cache.get(path) ?? null;
      const base = root();
      const file = resolve(base, path);
      if (!file.startsWith(base + sep)) return null;
      const text = await readFile(file, "utf8").catch(() => null);
      cache.set(path, text);
      return text;
    },
  };
}
