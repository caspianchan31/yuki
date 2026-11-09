// v1.6 (open core): the pictures members take of the computer are kept on disk, under
// `<DATA_DIR>/screenshots`, one PNG per kept screenshot, named by its id. Before, the newest few
// lived in the process for an hour and a restart lost them; now an old conversation still shows
// its pictures, and the replay (回顾, v1.6) has something to play. A picture goes when it is older
// than the retention (SCREENSHOT_RETENTION_DAYS, 90 by default), when the folder grows past its
// cap (SCREENSHOT_MAX_GB, 5 by default; the oldest go first), or when its conversation is deleted.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const defaultRetentionDays = 90;
export const defaultMaxGb = 5;
const dayMs = 24 * 60 * 60_000;
/** An id is what `keep` made: base64url of 16 random bytes. Anything else is not a file name. */
const idPattern = /^[A-Za-z0-9_-]{16,32}$/;

export interface ShotStoreOptions {
  /** How long a picture is kept, in milliseconds (default 90 days). */
  retentionMs?: number;
  /** The folder's cap in bytes (default 5 GB); past it the oldest pictures go. */
  maxBytes?: number;
  /** The clock (tests). */
  now?: () => number;
  /** How often the folder is pruned; null never schedules (tests call `prune` themselves). */
  pruneEveryMs?: number | null;
}

/** The screenshots folder: `keep` writes a picture and names it, `read` gives it back, `prune`
 * and `remove` take pictures away. Writes and reads are synchronous: a picture is small (about
 * 40 to 400 KB) and `keepShot` is called from a tool result that needs the id at once. */
export class ShotStore {
  readonly retentionMs: number;
  readonly maxBytes: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private pruning: Promise<void> | null = null;
  constructor(
    readonly dir: string,
    options: ShotStoreOptions = {},
  ) {
    this.retentionMs = options.retentionMs ?? defaultRetentionDays * dayMs;
    this.maxBytes = options.maxBytes ?? defaultMaxGb * 1024 ** 3;
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
  /** Keeps a picture (base64 PNG); its id. */
  keep(pngBase64: string): string {
    const id = randomBytes(16).toString("base64url");
    writeFileSync(this.pathOf(id), Buffer.from(pngBase64, "base64"));
    return id;
  }
  /** A kept picture's PNG bytes; null when there is no such picture (never kept, pruned, or its
   * conversation deleted). */
  read(id: string): Buffer | null {
    if (!idPattern.test(id)) return null;
    try {
      return readFileSync(this.pathOf(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  /** Takes the named pictures away (a deleted conversation's). Unknown ids are nothing. */
  async remove(ids: Iterable<string>): Promise<number> {
    let removed = 0;
    for (const id of new Set(ids)) {
      if (!idPattern.test(id)) continue;
      try {
        await rm(this.pathOf(id));
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
  /** Removes pictures older than the retention, then the oldest ones while the folder is past
   * its cap. One prune runs at a time; a second call joins the running one. */
  prune(): Promise<void> {
    if (!this.pruning)
      this.pruning = this.doPrune().finally(() => {
        this.pruning = null;
      });
    return this.pruning;
  }
  private async doPrune() {
    const cutoff = this.now() - this.retentionMs;
    const kept: { id: string; at: number; size: number }[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".png")) continue;
      const id = name.slice(0, -4);
      if (!idPattern.test(id)) continue;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(join(this.dir, name));
      } catch {
        continue;
      }
      if (info.mtimeMs < cutoff) await rm(join(this.dir, name), { force: true });
      else kept.push({ id, at: info.mtimeMs, size: info.size });
    }
    let total = kept.reduce((sum, shot) => sum + shot.size, 0);
    kept.sort((a, b) => a.at - b.at);
    for (const shot of kept) {
      if (total <= this.maxBytes) break;
      await rm(this.pathOf(shot.id), { force: true });
      total -= shot.size;
    }
  }
  private pathOf(id: string) {
    return join(this.dir, `${id}.png`);
  }
}

/** The ids of the pictures a conversation's events name (computer_screenshot results carry
 * `shotId`), so a deleted conversation takes its pictures with it. */
export function shotIdsOf(events: Iterable<unknown>): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const loose = event as { type?: string; content?: unknown };
    if (loose.type !== "TOOL_CALL_RESULT" || typeof loose.content !== "string") continue;
    const match = /"shotId":"([A-Za-z0-9_-]{16,32})"/.exec(loose.content);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}
