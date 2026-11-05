// Where member files are kept. The core's own store is a directory of plain .md files; a layer
// above the core may plug in another through `Tenancy.memberFileStore` (tenancy-port.ts).
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  isMemberFileId,
  type MemberFileMeta,
  type MemberFileView,
  memberFileMaxBytes,
  parseMemberFilePath,
} from "../../../../packages/domain/src/member-files.ts";
import { AppError } from "../errors.ts";

export interface MemberFileStore {
  /** The files a member has, newest change first. */
  list(space: string, memberId: string): Promise<MemberFileMeta[]>;
  read(space: string, memberId: string, path: string): Promise<MemberFileView | null>;
  /** Just the text of a file (a run's start needs no more), null when there is none. */
  text(space: string, memberId: string, path: string): Promise<string | null>;
  /** Replaces the file (creating it); `by` is who changed it. */
  write(
    space: string,
    memberId: string,
    path: string,
    content: string,
    by: string,
  ): Promise<MemberFileMeta>;
}

/** The checks every store runs before it touches anything. */
export function checkedTarget(memberId: string, path: string, content?: string): string {
  const ok = parseMemberFilePath(path);
  if (!ok || !isMemberFileId(memberId)) throw new AppError("That file is not available", 400);
  if (content !== undefined && Buffer.byteLength(content, "utf8") > memberFileMaxBytes)
    throw new AppError(`A member file is at most ${memberFileMaxBytes / 1024} KB`, 413);
  return ok;
}

type Sidecar = Record<string, { by: string; at: number }>;
const sidecarName = ".changes.json";

/** Plain files under `<root>/<member id>/`, a sidecar beside them for who changed what. A file
 * changed by hand later than the sidecar's note reads as changed by "editor". */
export class DiskMemberFileStore implements MemberFileStore {
  constructor(private readonly root: string) {}
  private dir(memberId: string) {
    const dir = resolve(this.root, memberId);
    if (!dir.startsWith(resolve(this.root) + sep)) throw new AppError("Bad member id", 400);
    return dir;
  }
  private async sidecar(dir: string): Promise<Sidecar> {
    try {
      return JSON.parse(await readFile(join(dir, sidecarName), "utf8")) as Sidecar;
    } catch {
      return {};
    }
  }
  private meta(path: string, size: number, mtimeMs: number, note: Sidecar[string] | undefined) {
    const by = note && mtimeMs <= note.at + 2000 ? note.by : "editor";
    return { path, size, updatedAt: new Date(mtimeMs).toISOString(), updatedBy: by };
  }
  async list(_space: string, memberId: string): Promise<MemberFileMeta[]> {
    if (!isMemberFileId(memberId)) throw new AppError("Bad member id", 400);
    const dir = this.dir(memberId);
    const notes = await this.sidecar(dir);
    const names = [
      "AGENTS.md",
      "MEMORY.md",
      ...(await readdir(join(dir, "notes")).then(
        (found) => found.map((name) => `notes/${name}`),
        () => [],
      )),
    ];
    const out: MemberFileMeta[] = [];
    for (const path of names) {
      if (!parseMemberFilePath(path)) continue;
      const info = await stat(join(dir, path)).catch(() => null);
      if (info?.isFile()) out.push(this.meta(path, info.size, info.mtimeMs, notes[path]));
    }
    return out.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path),
    );
  }
  async read(_space: string, memberId: string, path: string): Promise<MemberFileView | null> {
    checkedTarget(memberId, path);
    const dir = this.dir(memberId);
    const file = join(dir, path);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    const content = await readFile(file, "utf8");
    const notes = await this.sidecar(dir);
    return { ...this.meta(path, info.size, info.mtimeMs, notes[path]), content };
  }
  async text(_space: string, memberId: string, path: string): Promise<string | null> {
    checkedTarget(memberId, path);
    return readFile(join(this.dir(memberId), path), "utf8").catch(() => null);
  }
  async write(
    _space: string,
    memberId: string,
    path: string,
    content: string,
    by: string,
  ): Promise<MemberFileMeta> {
    checkedTarget(memberId, path, content);
    const dir = this.dir(memberId);
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
    const info = await stat(file);
    const notes = await this.sidecar(dir);
    notes[path] = { by, at: info.mtimeMs };
    await writeFile(join(dir, sidecarName), JSON.stringify(notes), "utf8");
    return this.meta(path, info.size, info.mtimeMs, notes[path]);
  }
}

/** Files kept in memory: what a service with no data directory uses (nothing survives it). */
export class MemoryMemberFileStore implements MemberFileStore {
  private readonly files = new Map<string, MemberFileView>();
  async list(_space: string, memberId: string): Promise<MemberFileMeta[]> {
    if (!isMemberFileId(memberId)) throw new AppError("Bad member id", 400);
    return [...this.files]
      .filter(([key]) => key.startsWith(`${memberId}\n`))
      .map(([, { content: _, ...meta }]) => meta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
  }
  async read(_space: string, memberId: string, path: string): Promise<MemberFileView | null> {
    return this.files.get(`${memberId}\n${checkedTarget(memberId, path)}`) ?? null;
  }
  async text(_space: string, memberId: string, path: string): Promise<string | null> {
    return this.files.get(`${memberId}\n${checkedTarget(memberId, path)}`)?.content ?? null;
  }
  async write(
    _space: string,
    memberId: string,
    path: string,
    content: string,
    by: string,
  ): Promise<MemberFileMeta> {
    const ok = checkedTarget(memberId, path, content);
    const file = {
      path: ok,
      content,
      size: Buffer.byteLength(content, "utf8"),
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    };
    this.files.set(`${memberId}\n${ok}`, file);
    const { content: _, ...meta } = file;
    return meta;
  }
}
