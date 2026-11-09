// v1.6 文件浏览器: what the server and the web agree on about the members' computer's files
// (/workspace): the two folders with a fixed meaning, what kind of file a name is (which decides
// how the person's file page opens it), the media type a download is served as, and the
// recycle bin's retention. Pure, no imports.

/** Where the person puts files for the members (uploads land here). */
export const receivedFolder = "收到";
/** Where members put what they deliver; the file page shows it at the top. */
export const deliveredFolder = "成品";
export const receivedPath = `/workspace/${receivedFolder}`;
export const deliveredPath = `/workspace/${deliveredFolder}`;
/** How long the recycle bin keeps a deleted file (apps/desktop/files.py TRASH_DAYS). */
export const trashDays = 30;
/** The most a download or an upload may be (files.py BYTES_LIMIT). */
export const workspaceFileMaxBytes = 10 * 1024 * 1024;

/** How the file page opens a file: Markdown is edited in place; text and code are read; a
 * picture is shown; a PDF is opened in the reader; anything else is downloaded. */
export type WorkspaceFileKind = "markdown" | "text" | "image" | "pdf" | "other";

const textExtensions = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "bash",
  "zsh",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "sql",
  "env",
  "gitignore",
  "diff",
  "patch",
]);
const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};
const otherTypes: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wav: "audio/wav",
};

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function workspaceFileKind(name: string): WorkspaceFileKind {
  const extension = extensionOf(name);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension in imageTypes) return "image";
  if (extension === "pdf") return "pdf";
  if (textExtensions.has(extension)) return "text";
  return "other";
}

/** The media type a file is served as; octet-stream for one not known (the browser downloads
 * it). HTML and SVG are served as text so a page in the workspace never runs in the app's origin. */
export function workspaceMediaType(name: string): string {
  const extension = extensionOf(name);
  if (extension === "html" || extension === "htm" || extension === "svg")
    return "text/plain; charset=utf-8";
  return imageTypes[extension] ?? otherTypes[extension] ?? "application/octet-stream";
}

/** The `Content-Disposition` for a download (or an inline view), with a UTF-8 file name. */
export function contentDisposition(name: string, inline: boolean): string {
  const base = name.slice(name.lastIndexOf("/") + 1) || "file";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/** The folder a path is in ("/workspace" for a file at the root; "/workspace" stays). */
export function parentPath(path: string): string {
  if (path === "/workspace") return path;
  const cut = path.lastIndexOf("/");
  return cut <= "/workspace".length - 1 ? "/workspace" : path.slice(0, cut);
}

/** The crumbs of a path: [["电脑", "/workspace"], ["收到", "/workspace/收到"], …]; the first
 * label is the caller's. */
export function pathCrumbs(path: string, rootLabel: string): { label: string; path: string }[] {
  const crumbs = [{ label: rootLabel, path: "/workspace" }];
  if (path === "/workspace") return crumbs;
  let here = "/workspace";
  for (const part of path.slice("/workspace/".length).split("/")) {
    if (!part) continue;
    here = `${here}/${part}`;
    crumbs.push({ label: part, path: here });
  }
  return crumbs;
}

/** A size for a row: 0 B, 12 KB, 3.4 MB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name a person typed (a new folder, a rename): one component, nothing hidden, no
 * separators; null when it will not do. */
export function cleanFileName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === "." || name === ".." || name.length > 255) return null;
  if (/[/\\\0]/.test(name) || name.startsWith(".")) return null;
  return name;
}
