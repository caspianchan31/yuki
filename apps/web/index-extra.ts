/**
 * v1.7.1: a piece of HTML the site's owner wants in the page source itself, before `</body>` —
 * a directory's badge, a line a checker reads without running scripts. It is the file
 * `index-extra.html` beside `index.html` when there is one, or the file the build's
 * WEB_INDEX_EXTRA names (relative to the repository, or absolute). Neither: the page is as it is.
 * WEB_INDEX_EXTRA naming a missing file fails the build and says so, rather than shipping a page
 * without what was asked for.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The snippet to add, or null when none is asked for. `defaultFile` is the one beside index.html. */
export function readExtraHtml(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  defaultFile?: string,
): string | null {
  const given = env.WEB_INDEX_EXTRA?.trim();
  if (!given)
    return defaultFile && existsSync(defaultFile) ? readFileSync(defaultFile, "utf8").trim() : null;
  const file = path.isAbsolute(given) ? given : path.resolve(repoRoot, given);
  if (!existsSync(file)) throw new Error(`WEB_INDEX_EXTRA names a missing file: ${file}`);
  return readFileSync(file, "utf8").trim();
}

/** `html` with `extra` placed just before its closing body tag (at the end when there is none). */
export function withExtraHtml(html: string, extra: string | null): string {
  if (!extra) return html;
  const at = html.lastIndexOf("</body>");
  const block = `${extra}\n`;
  return at < 0 ? `${html}\n${block}` : `${html.slice(0, at)}${block}${html.slice(at)}`;
}
