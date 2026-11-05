// When the AI hits something it
// cannot clear itself (a sign-in only the owner can act on, or a system incident only the
// operator can fix), the server keeps the desktop's picture as it is at that moment, as a file of
// its own tied to that incident (the desktop's one "latest" screenshot is overwritten by the next
// action). An incident is an `incidents` record under the desktop's owner (an account's derived
// owner or a project's own), so deleting the account or the project takes it along; its picture
// is `DATA_DIR/incident-shots/<id>.jpg` (0600). Both are deleted after 30 days. Recording one never
// fails the caller: no desktop, a failed screenshot or a failed write leaves the incident without
// a picture (or, at worst, unrecorded, with a log line).
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "../../../packages/domain/src/environments.ts";
import {
  type IncidentView,
  incidentRetentionDays,
} from "../../../packages/domain/src/incidents.ts";
import { parseOwner, spaceKeyOf } from "../../../packages/domain/src/projects.ts";
import type { Store } from "./db.ts";
import { connectionOf } from "./db.ts";
import { parseEnvOwner } from "./environments.ts";
import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

export const incidentKind = "incidents";
export const incidentShotDirectory = "incident-shots";
export const incidentRetentionMs = incidentRetentionDays * 24 * 60 * 60 * 1000;
/** A screenshot that takes longer than this is given up on (the incident is kept without it). */
export const incidentShotTimeoutMs = 10_000;
const lineMax = 300;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IncidentRecord {
  id: string;
  at: string;
  /** The space's key (the real owner). */
  space: string;
  /** The project owner the account is in (or the project itself). */
  scope: string;
  account: { id: string; name: string } | null;
  site: string | null;
  kind: string;
  line: string;
  shot: boolean;
  system: boolean;
  /** The picture kept with a sign-in record that is no incident
   * (signed_in, other…), the evidence of what the run looked at; not in the incident list. */
  evidence?: true;
}

/** What the desktop side gives an incident: its picture now, masking, and where it belongs. */
export interface IncidentDesktop {
  /** The desktop's picture now; null when it is not running or the screenshot failed. */
  screenshot(owner: string): Promise<Uint8Array | null>;
  /** `text` with every secret that desktop holds masked; null when that cannot be checked. */
  mask(owner: string, text: string): Promise<string | null>;
  /** The project owner the desktop belongs to; null for an account that no longer exists. */
  scope(owner: string): Promise<string | null>;
}

/** One plain line: whitespace collapsed, cut at `lineMax` characters. */
export function incidentLine(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > lineMax ? `${flat.slice(0, lineMax - 1)}…` : flat;
}

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

export class Incidents {
  /** When old incidents were last deleted (at most once an hour after the first). */
  private prunedAt = 0;
  constructor(
    private readonly db: Store,
    private readonly dataDir: string,
    private readonly desktop: IncidentDesktop,
    private readonly shotTimeoutMs = incidentShotTimeoutMs,
  ) {}
  private get directory() {
    return join(this.dataDir, incidentShotDirectory);
  }
  private file(id: string) {
    return join(this.directory, `${id}.jpg`);
  }
  /** Records one incident of the desktop `owner` (an account's derived owner or a project's
   * own), with the desktop's picture now when it can be taken, or, given `picture`, that picture
   * (the picture of the run's look at what it did, kept with
   * the step, dated `at`, when it happened; never the desktop's latest picture at report time).
   * The line is masked here like the desktop's output (record_sign_in's detail already was).
   * Never throws. */
  async record(input: {
    owner: string;
    kind: string;
    site?: string | null;
    line?: string | null;
    system: boolean;
    evidence?: boolean;
    picture?: Uint8Array;
    at?: string;
  }): Promise<IncidentRecord | null> {
    try {
      const id = randomUUID();
      const at = input.at ?? new Date().toISOString();
      const env = parseEnvOwner(input.owner);
      const scope = (await this.desktop.scope(input.owner).catch(() => null)) ?? input.owner;
      let account: IncidentRecord["account"] = null;
      if (env) {
        const record = await this.db.get<Environment>(env.real, "environments", env.environmentId);
        account = { id: env.environmentId, name: record?.name ?? "" };
      }
      const raw = incidentLine(input.line);
      const line = raw
        ? incidentLine(await this.desktop.mask(input.owner, raw).catch(() => null))
        : "";
      const shot = await this.saveShot(input.owner, id, input.picture);
      const record: IncidentRecord = {
        id,
        at,
        space: spaceKeyOf(input.owner),
        scope,
        account,
        site: input.site ?? null,
        kind: input.kind,
        line,
        shot,
        system: input.system,
        ...(input.evidence ? { evidence: true as const } : {}),
      };
      await this.db.put(input.owner, incidentKind, record);
      return record;
    } catch (error) {
      backgroundFailure("incident record", error);
      return null;
    }
  }
  /** Writes `picture`, or the desktop's picture now, as the incident's; false when none. */
  private async saveShot(owner: string, id: string, picture?: Uint8Array) {
    const image =
      picture ??
      (await withTimeout(
        this.desktop.screenshot(owner).catch(() => null),
        this.shotTimeoutMs,
      ));
    if (!image?.length) return false;
    const temporary = join(this.directory, `${id}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, image, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file(id));
      return true;
    } catch {
      return false;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  /** One incident by id, with the owner it is kept under; null when there is none. */
  async find(id: string): Promise<{ owner: string; record: IncidentRecord } | null> {
    if (!idPattern.test(id)) return null;
    const { rows } = await connectionOf(this.db).query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 AND id=$2 LIMIT 1",
      [incidentKind, id],
    );
    const row = rows[0]?.data as { owner: string; value: IncidentRecord } | undefined;
    return row ? { owner: row.owner, record: row.value } : null;
  }
  /** One incident of the space `spaceKey`; another space's (or an invented id) is a 404. */
  async inSpace(spaceKey: string, id: string): Promise<IncidentRecord> {
    const found = await this.find(id);
    if (!found || found.record.space !== spaceKey || spaceKeyOf(found.owner) !== spaceKey)
      throw new AppError("Incident not found", 404);
    return found.record;
  }
  /** The picture of an incident the caller may see (`record` was looked up for them). */
  async shot(record: IncidentRecord): Promise<Buffer> {
    if (!record.shot || !idPattern.test(record.id)) throw new AppError("No picture", 404);
    try {
      return await readFile(this.file(record.id));
    } catch {
      throw new AppError("No picture", 404);
    }
  }
  /** Every incident of every space, newest first (a sign-in's evidence picture is none). */
  async all(): Promise<IncidentRecord[]> {
    return (await this.db.scan<IncidentRecord>(incidentKind))
      .map((row) => row.value)
      .filter((record) => !record.evidence)
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  /** The view of `records` with the space and project names (the operator's list). */
  async views(records: readonly IncidentRecord[]): Promise<IncidentView[]> {
    const spaces = new Map(
      (await this.db.list<{ id: string; name: string; key: string }>("system", "spaces")).map(
        (space) => [space.key, space],
      ),
    );
    const projects = new Map<string, string | null>();
    const projectName = async (scope: string) => {
      const { real, projectId } = parseOwner(scope);
      if (!projectId) return null;
      if (!projects.has(scope))
        projects.set(
          scope,
          (await this.db.get<{ name: string }>(real, "projects", projectId))?.name ?? null,
        );
      return projects.get(scope) ?? null;
    };
    const views: IncidentView[] = [];
    for (const record of records) {
      const space = spaces.get(record.space);
      views.push({
        id: record.id,
        at: record.at,
        space: { id: space?.id ?? null, name: space?.name ?? null },
        project: { id: parseOwner(record.scope).projectId, name: await projectName(record.scope) },
        account: record.account,
        site: record.site,
        kind: record.kind,
        line: record.line,
        shot: record.shot,
        system: record.system,
      });
    }
    return views;
  }
  /** Deletes one incident and its picture (a sign-in record that was not the
   * site's doing, service.ts `backfillDesktopConflicts`). */
  async remove(owner: string, id: string) {
    await this.db.remove(owner, incidentKind, id);
    if (idPattern.test(id)) await unlink(this.file(id)).catch(() => {});
  }
  /** Deletes every incident kept under `owner` and its pictures (an account or a project is
   * deleted). */
  async removeOwner(owner: string) {
    for (const record of await this.db.list<IncidentRecord>(owner, incidentKind)) {
      await this.db.remove(owner, incidentKind, record.id);
      if (idPattern.test(record.id)) await unlink(this.file(record.id)).catch(() => {});
    }
  }
  /** Deletes incidents older than 30 days and their pictures, and pictures left without a
   * record past that age. `force` runs it now; otherwise at most once an hour. */
  async prune(now = Date.now(), force = false) {
    if (!force && now - this.prunedAt < 60 * 60 * 1000) return 0;
    this.prunedAt = now;
    const cutoff = new Date(now - incidentRetentionMs).toISOString();
    const { rows } = await connectionOf(this.db).query(
      "DELETE FROM records WHERE kind=$1 AND data->>'at' < $2 RETURNING jsonb_build_object('id',id) AS data",
      [incidentKind, cutoff],
    );
    for (const row of rows) {
      const id = String(row.data.id ?? "");
      if (idPattern.test(id)) await unlink(this.file(id)).catch(() => {});
    }
    // A picture whose record went with a purged owner, or a write cut short.
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < now - incidentRetentionMs) await unlink(path).catch(() => {});
    }
    return rows.length;
  }
}
