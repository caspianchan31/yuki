// v1.6 聊天里发文件: the files the person sends in the chat, kept on disk under
// `<DATA_DIR>/attachments`: the bytes as `<id>`, what is known about the file as `<id>.json`
// (whose, its name, media type, size, when, and where a copy went on the members' computer), and
// once read, its words as `<id>.txt`. A file goes when it is older than the retention
// (ATTACHMENT_RETENTION_DAYS, 90 by default), when the folder grows past its cap
// (ATTACHMENT_MAX_GB, 5 by default; the oldest go first), or when its conversation is deleted.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachmentIdPattern,
  attachmentMaxBytes,
  attachmentRetentionDays,
  attachmentsOf,
  generatedImageOf,
} from "../../../../packages/domain/src/chat-attachments.ts";
import { spaceKeyOf } from "../../../../packages/domain/src/projects.ts";
import { AppError } from "../errors.ts";
import { attachmentText } from "./attachment-text.ts";

export const defaultAttachmentMaxGb = 5;
const dayMs = 24 * 60 * 60_000;

export interface AttachmentMeta {
  id: string;
  /** The space the file belongs to (spaceKeyOf the uploader's owner). */
  space: string;
  name: string;
  mimeType: string;
  size: number;
  /** ISO 8601. */
  createdAt: string;
  /** Where the members' computer got its copy (/workspace/收到/…), when it did. */
  workspacePath: string | null;
}

export interface AttachmentStoreOptions {
  retentionMs?: number;
  maxBytes?: number;
  now?: () => number;
  /** How often the folder is pruned; null never schedules (tests call `prune` themselves). */
  pruneEveryMs?: number | null;
}

export class AttachmentStore {
  readonly retentionMs: number;
  readonly maxBytes: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly dir: string,
    options: AttachmentStoreOptions = {},
  ) {
    this.retentionMs = options.retentionMs ?? attachmentRetentionDays * dayMs;
    this.maxBytes = options.maxBytes ?? defaultAttachmentMaxGb * 1024 ** 3;
    this.now = options.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    if (options.pruneEveryMs !== null) {
      const every = options.pruneEveryMs ?? 60 * 60_000;
      this.timer = setInterval(() => void this.prune().catch(() => {}), every);
      this.timer.unref?.();
      void this.prune().catch(() => {});
    }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
  /** Keeps a file for the owner's space; its record. */
  async save(input: {
    owner: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    workspacePath?: string | null;
  }): Promise<AttachmentMeta> {
    if (input.bytes.length > attachmentMaxBytes)
      throw new AppError("Files must be 10 MB or smaller", 413);
    const id = randomBytes(16).toString("base64url");
    const meta: AttachmentMeta = {
      id,
      space: spaceKeyOf(input.owner),
      name: input.name,
      mimeType: input.mimeType,
      size: input.bytes.length,
      createdAt: new Date(this.now()).toISOString(),
      workspacePath: input.workspacePath ?? null,
    };
    await writeFile(this.pathOf(id), input.bytes);
    await writeFile(`${this.pathOf(id)}.json`, JSON.stringify(meta));
    return meta;
  }
  /** Notes where the members' computer got its copy. */
  async placed(id: string, workspacePath: string): Promise<void> {
    const meta = await this.readMeta(id);
    if (!meta) return;
    await writeFile(`${this.pathOf(id)}.json`, JSON.stringify({ ...meta, workspacePath }));
  }
  /** The record of a file of the owner's space; null when there is none (never kept, pruned,
   * its conversation deleted) or it is another space's. */
  async meta(owner: string, id: string): Promise<AttachmentMeta | null> {
    const meta = await this.readMeta(id);
    return meta && meta.space === spaceKeyOf(owner) ? meta : null;
  }
  /** A file's bytes with its record, or null as `meta`. */
  async read(owner: string, id: string): Promise<{ meta: AttachmentMeta; bytes: Buffer } | null> {
    const meta = await this.meta(owner, id);
    if (!meta) return null;
    try {
      return { meta, bytes: await readFile(this.pathOf(id)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  /** A file's words (a document or text file turned into text, cached beside it); null as
   * `meta`; an empty string for a file that has no words to give. */
  async text(owner: string, id: string): Promise<{ meta: AttachmentMeta; text: string } | null> {
    const meta = await this.meta(owner, id);
    if (!meta) return null;
    const cached = `${this.pathOf(id)}.txt`;
    try {
      return { meta, text: await readFile(cached, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const file = await this.read(owner, id);
    if (!file) return null;
    const text = await attachmentText(meta.name, meta.mimeType, file.bytes);
    await writeFile(cached, text);
    return { meta, text };
  }
  /** Takes the named files away (a deleted conversation's). Unknown ids are nothing. */
  async remove(ids: Iterable<string>): Promise<number> {
    let removed = 0;
    for (const id of new Set(ids)) {
      if (!attachmentIdPattern.test(id)) continue;
      try {
        await rm(this.pathOf(id));
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rm(`${this.pathOf(id)}.json`, { force: true });
      await rm(`${this.pathOf(id)}.txt`, { force: true });
    }
    return removed;
  }
  /** Removes what is past the retention, then the oldest past the folder's cap. */
  async prune(): Promise<number> {
    const names = await readdir(this.dir);
    const files: { id: string; mtime: number; size: number }[] = [];
    for (const name of names) {
      if (!attachmentIdPattern.test(name)) continue;
      try {
        const info = await stat(join(this.dir, name));
        // The record's own time (the store's clock), the file's as a fallback.
        const created = Date.parse((await this.readMeta(name))?.createdAt ?? "");
        files.push({
          id: name,
          mtime: Number.isFinite(created) ? created : info.mtimeMs,
          size: info.size,
        });
      } catch {}
    }
    const cutoff = this.now() - this.retentionMs;
    const old = files.filter((file) => file.mtime < cutoff).map((file) => file.id);
    let removed = await this.remove(old);
    const kept = files.filter((file) => file.mtime >= cutoff).sort((a, b) => a.mtime - b.mtime);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    const over: string[] = [];
    for (const file of kept) {
      if (total <= this.maxBytes) break;
      over.push(file.id);
      total -= file.size;
    }
    removed += await this.remove(over);
    return removed;
  }
  private pathOf(id: string) {
    return join(this.dir, id);
  }
  private async readMeta(id: string): Promise<AttachmentMeta | null> {
    if (!attachmentIdPattern.test(id)) return null;
    try {
      const raw = JSON.parse(await readFile(`${this.pathOf(id)}.json`, "utf8")) as AttachmentMeta;
      return raw && typeof raw.id === "string" ? raw : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

/** The attachment ids a conversation's events name (its user messages' parts, and v1.6 生成图片
 * the pictures its generate_image results made), for a delete. */
export function attachmentIdsOf(events: Iterable<unknown>): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const loose = event as {
      type?: string;
      input?: { messages?: unknown[] };
      messages?: unknown[];
      content?: unknown;
    };
    if (loose.type === "TOOL_CALL_RESULT" && typeof loose.content === "string") {
      const made = generatedImageOf(loose.content);
      if (made) ids.add(made.id);
      continue;
    }
    const messages = loose.type === "RUN_STARTED" ? loose.input?.messages : loose.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const content = (message as { role?: string; content?: unknown })?.content;
      for (const file of attachmentsOf(content)) ids.add(file.id);
    }
  }
  return [...ids];
}
