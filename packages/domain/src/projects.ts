/**
 * Projects (fork feature): partitions of one OpenMuse workspace. Conversations, tasks, goals,
 * monitors, memories, notifications, files, browser sessions and the default desktop belong
 * to one project each; accounts (environments) are global and carry an optional project
 * assignment. The default project is the unprefixed owner that already exists.
 */
export interface Project {
  id: string;
  name: string;
  /** Set while the project's desktop, files and records are being removed. */
  deleting: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectView extends Project {
  /** Environments currently assigned to this project (not deleting). */
  environments: number;
}

export const projectNameMax = 64;
export const projectsMax = 20;
/** v1.2: a group (a project) holds at most this many members. */
export const groupMembersMax = 6;
/** Reserved for the default project, which is not a record. */
export const defaultProjectName = "default";
/** Request header naming the project a request acts on; absent means the default project. */
export const PROJECT_HEADER = "X-OpenMuse-Project";

export function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedProjectName(name: string): boolean {
  const normalized = normalizeProjectName(name);
  return normalized === defaultProjectName || normalized === "默认";
}

/** Words a model or a client sends for "no value" and that are never a group's name: a request
 * for no project once made a group called "null". */
const emptyWords = new Set(["null", "undefined", "none", "nil", "nan", "无", "没有", "空"]);
export function isEmptyProjectWord(name: string): boolean {
  return emptyWords.has(normalizeProjectName(name));
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isProjectId = (value: string) => uuidPattern.test(value);

// The only separator between a real owner and a project id. A real owner never contains
// "/proj:" and an environment's "#env:" suffix is only ever appended to a real owner.
const ownerSeparator = "/proj:";

/** The owner string every project-scoped record is keyed by. */
export function projectOwner(real: string, projectId: string): string {
  if (real.includes(ownerSeparator) || real.includes("#") || !isProjectId(projectId))
    throw new Error("Project owner could not be derived");
  return `${real}${ownerSeparator}${projectId}`;
}

/** Splits any owner into its real owner and project id (null for the default project).
 * An environment suffix, if present, is kept on the real part untouched. */
export function parseOwner(owner: string): { real: string; projectId: string | null } {
  const at = owner.indexOf(ownerSeparator);
  if (at < 0) return { real: owner, projectId: null };
  const real = owner.slice(0, at);
  const rest = owner.slice(at + ownerSeparator.length);
  const hash = rest.indexOf("#");
  const projectId = hash < 0 ? rest : rest.slice(0, hash);
  if (!isProjectId(projectId)) return { real: owner, projectId: null };
  return { real: hash < 0 ? real : real + rest.slice(hash), projectId };
}

export const realOwnerOf = (owner: string) => parseOwner(owner).real;
/** The space key of any owner: a project's or an account's owner belongs to its space. */
export function spaceKeyOf(owner: string): string {
  const real = realOwnerOf(owner);
  const hash = real.indexOf("#");
  return hash < 0 ? real : real.slice(0, hash);
}
export const isProjectOwner = (owner: string) => parseOwner(owner).projectId !== null;
