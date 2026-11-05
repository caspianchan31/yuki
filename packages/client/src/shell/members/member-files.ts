// v1.5 member files on the cards (docs/member-files.md): the paths the card asks for, what it
// shows of a file, and which notes it lists. Pure; the card's component only draws it.
import {
  firstLines,
  type MemberFileMeta,
  type MemberFileView,
  memberFileMaxBytes,
  noteDay,
  recentDays,
  yukiMemberId,
} from "../../../../../packages/domain/src/member-files.ts";

export { yukiMemberId };

/** The API path of a member's file list, or of one of her files. */
export const memberFilesPath = (memberId: string, path?: string) =>
  `/api/members/${encodeURIComponent(memberId)}/files${
    path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""
  }`;

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function normalizeFileList(raw: unknown): MemberFileMeta[] {
  const files = (raw as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((row): MemberFileMeta[] => {
    const file = row as Partial<MemberFileMeta> | null;
    if (!file || typeof file.path !== "string") return [];
    return [
      {
        path: file.path,
        size: typeof file.size === "number" ? file.size : 0,
        updatedAt: text(file.updatedAt),
        updatedBy: text(file.updatedBy),
      },
    ];
  });
}

export function normalizeFile(raw: unknown): MemberFileView | null {
  const file = raw as Partial<MemberFileView> | null;
  if (!file || typeof file.path !== "string" || typeof file.content !== "string") return null;
  return {
    path: file.path,
    content: file.content,
    size: typeof file.size === "number" ? file.size : file.content.length,
    updatedAt: text(file.updatedAt),
    updatedBy: text(file.updatedBy),
  };
}

/** The beginning of a file on a card: its first lines, headings left out (the card's own section
 * already names it: 职责, 记住的事). */
export function filePreview(content: string, lines = 4): string {
  const body = content
    .split("\n")
    .filter((line) => !/^#{1,6}\s/.test(line.trim()))
    .join("\n");
  return firstLines(body, lines);
}

/** Who changed it and when, for the editor's footer: `2026-11-05 14:03 · Mia`. */
export function changedLine(file: Pick<MemberFileMeta, "updatedAt" | "updatedBy">): string {
  const when = new Date(file.updatedAt);
  const day = Number.isNaN(when.getTime())
    ? ""
    : `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(
        when.getDate(),
      ).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(
        when.getMinutes(),
      ).padStart(2, "0")}`;
  const by = file.updatedBy === "system" ? "" : file.updatedBy;
  return [day, by].filter(Boolean).join(" · ");
}

/** The notes of the last `days` days that exist, newest first, as `{ day, path }`. `today` is
 * the viewer's own date (YYYY-MM-DD). */
export function recentNotes(
  files: readonly Pick<MemberFileMeta, "path">[],
  today: string,
  days = 7,
): { day: string; path: string }[] {
  const have = new Set(files.map((file) => file.path));
  return recentDays(today, days)
    .map((day) => ({ day, path: `notes/${day}.md` }))
    .filter((note) => have.has(note.path) && noteDay(note.path) === note.day);
}

/** The viewer's own date, YYYY-MM-DD. */
export function localDay(at = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

/** Whether the typed text fits the file limit (UTF-8 bytes). */
export const fitsFileLimit = (content: string) =>
  new TextEncoder().encode(content).length <= memberFileMaxBytes;
