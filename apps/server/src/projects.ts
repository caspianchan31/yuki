// Fork feature: projects. A project is a partition of one workspace: everything stored by
// owner (conversations, tasks, goals, monitors, memories, notifications, files, browser
// sessions, the default desktop) lives under the project owner `${real}/proj:${id}`, so the
// existing services partition it with no change. Accounts (environments) stay under the real
// owner and carry an optional project assignment; their desktops never move. The default
// project is the real owner itself: nothing is migrated.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  isEmptyProjectWord,
  isProjectId,
  isReservedProjectName,
  normalizeProjectName,
  type Project,
  type ProjectView,
  projectNameMax,
  projectOwner,
  projectsMax,
  realOwnerOf,
} from "../../../packages/domain/src/projects.ts";
import type { BrowserService } from "./browser.ts";
import { ChatStore } from "./chat/chat-store.ts";
import type { ComputerService } from "./computer.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { AgentService } from "./engine/service.ts";
import type { EnvironmentService } from "./environments.ts";
import { AppError } from "./errors.ts";
import { ownerActor } from "./request-actor.ts";
import { withoutStrayGroups } from "./stray-groups.ts";

const kind = "projects";
const nameSchema = z.string().trim().min(1).max(projectNameMax);
const createSchema = z.object({ name: nameSchema });
const renameSchema = z.object({ name: nameSchema });

const notFound = () => new AppError("Project not found", 404);
const reserved = (name: string) =>
  new AppError(`Name "${name.trim()}" is reserved for the default project`, 422);
const unusable = (name: string) =>
  new AppError(`Name "${name.trim()}" is reserved (it stands for no value)`, 422);
const fileId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { projectOwner, realOwnerOf };

export class ProjectService {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly computer: ComputerService,
    private readonly environments: EnvironmentService,
    private readonly browser: BrowserService,
    private readonly agent: AgentService,
  ) {}
  /** Every record, deleting ones included, sorted by name. `owner` may be any owner; the
   * records live under its real owner. */
  async records(owner: string): Promise<Project[]> {
    const records = await this.db.list<Project>(realOwnerOf(owner), kind);
    return (await withoutStrayGroups(this.db, realOwnerOf(owner), records)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  async find(owner: string, id: string): Promise<Project | null> {
    if (!isProjectId(id)) return null;
    return this.db.get<Project>(realOwnerOf(owner), kind, id);
  }
  /** The live project, or 404. */
  async get(owner: string, id: string): Promise<Project> {
    const record = await this.find(owner, id);
    if (!record || record.deleting) throw notFound();
    return record;
  }
  /** The owner a request acts as: the real owner without a project header, otherwise the
   * named project's owner. An unknown or deleting project is a 404 so a stale client never
   * silently writes into the default project. */
  async resolveOwner(real: string, header: string | undefined): Promise<string> {
    const id = header?.trim();
    if (!id) return real;
    if (!isProjectId(id)) throw notFound();
    const project = await this.get(real, id);
    return projectOwner(real, project.id);
  }
  private async view(real: string, project: Project): Promise<ProjectView> {
    // Counts what the project's Environments page lists, pending deletes included.
    const environments = (await this.environments.allRecords(real)).filter(
      (record) => record.projectId === project.id,
    ).length;
    return { ...project, environments };
  }
  async list(owner: string): Promise<ProjectView[]> {
    const real = realOwnerOf(owner);
    return Promise.all((await this.records(real)).map((project) => this.view(real, project)));
  }
  async create(owner: string, raw: unknown): Promise<ProjectView> {
    const real = realOwnerOf(owner);
    const input = createSchema.parse(raw);
    if (isReservedProjectName(input.name)) throw reserved(input.name);
    if (isEmptyProjectWord(input.name)) throw unusable(input.name);
    const existing = await this.records(real);
    if (existing.length >= projectsMax)
      throw new AppError(`Projects are limited to ${projectsMax}`, 422);
    const normalized = normalizeProjectName(input.name);
    const taken = existing.find((record) => normalizeProjectName(record.name) === normalized);
    if (taken) throw new AppError(`A project named "${taken.name}" already exists`, 409);
    const now = new Date().toISOString();
    const record: Project = {
      id: randomUUID(),
      name: input.name,
      deleting: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.db.insertIfAbsent(real, kind, record)))
      throw new AppError("Project could not be created", 500);
    // The project's own agent identity, so its first snapshot looks like the default one.
    await this.agent.ensure(projectOwner(real, record.id));
    return this.view(real, record);
  }
  async rename(owner: string, id: string, raw: unknown): Promise<ProjectView> {
    const real = realOwnerOf(owner);
    const input = renameSchema.parse(raw);
    const current = await this.get(real, id);
    if (isReservedProjectName(input.name)) throw reserved(input.name);
    if (isEmptyProjectWord(input.name)) throw unusable(input.name);
    const normalized = normalizeProjectName(input.name);
    const others = (await this.records(real)).filter((record) => record.id !== current.id);
    const taken = others.find((record) => normalizeProjectName(record.name) === normalized);
    if (taken) throw new AppError(`A project named "${taken.name}" already exists`, 409);
    const saved = await this.db.compareAndSwap<Project>(
      real,
      kind,
      current.id,
      { deleting: false },
      { name: input.name, updatedAt: new Date().toISOString() },
    );
    if (!saved) throw notFound();
    return this.view(real, saved);
  }
  /** Marks the project deleting, returns its accounts to unassigned (their desktops and
   * sign-ins are untouched), destroys the project's default desktop, closes its browser
   * sessions, removes its file blobs and every record under its owner, then the project
   * record. A failed destroy keeps the record deleting so the delete can be retried. */
  async remove(owner: string, id: string): Promise<void> {
    const real = realOwnerOf(owner);
    const record = await this.find(real, id);
    if (!record) throw notFound();
    const scoped = projectOwner(real, record.id);
    await this.db.compareAndSwap<Project>(
      real,
      kind,
      record.id,
      { deleting: false },
      { deleting: true, updatedAt: new Date().toISOString() },
    );
    // Its accounts return to unassigned, their logins (and the other entries
    // they use) with them, recorded in both histories. The project is marked
    // deleting first and a move into it holds the project record, so an account added meanwhile
    // either is listed here or was refused; one being deleted itself is left to that delete.
    for (const environment of await this.environments.allRecords(real))
      if (environment.projectId === record.id && !environment.deleting)
        await this.environments
          .move(real, environment.id, record.id, null, ownerActor())
          .catch((error) => {
            if (!(error instanceof AppError && error.status === 404)) throw error;
          });
    if (this.config.computerEnabled) {
      try {
        await this.computer.destroy(scoped);
      } catch (error) {
        if (error instanceof AppError && error.status === 409)
          throw new AppError(
            `The desktop of project "${record.name}" is busy or its last stop was not confirmed. Retry the delete shortly.`,
            409,
          );
        throw error;
      }
    }
    for (const session of await this.db.list<{ id: string; status?: string }>(scoped, "browsers"))
      if (session.status !== "closed")
        await this.browser.close(scoped, session.id).catch(() => undefined);
    const directory = resolve(this.config.dataDir, "files");
    for (const file of await this.db.list<{ id: string }>(scoped, "files")) {
      if (!fileId.test(file.id)) continue;
      const path = resolve(directory, `${file.id}.pdf`);
      if (!path.startsWith(`${directory}${sep}`)) continue;
      await rm(path, { force: true });
    }
    // The pictures of its default desktop's incidents (the records
    // go with the purge below).
    await this.computer.incidents.removeOwner(scoped);
    await this.db.purgeOwner(scoped);
    // The project's conversations, kept on this server, go too.
    await (await ChatStore.open(this.db)).purgeOwner(scoped);
    // What is left of the project's credentials, history and requests.
    await this.environments.store.purgeScope(scoped);
    await this.db.remove(real, kind, record.id);
  }
}
