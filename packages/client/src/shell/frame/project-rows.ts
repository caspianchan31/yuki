/**
 * The pure model of the project rows the ≥1100 project column and
 * the phone's project panel share (prototype prow / badges / sortedProjects), plus the Chinese
 * wording of the project forms' errors. No react-native, so node:test can pin it.
 *
 * Sources: N1 (GET /api/projects/overview) gives counts per project; GET /api/projects (the
 * ProjectsProvider) is authoritative for which projects exist, their names after a rename and
 * the `deleting` flag. The current project's numbers come from the local shell counts, which are
 * fresher; both count the same 需要你 (N1 includes the account flags desktop error / no proxy).
 * Without N1 the rows have names and account counts only, no badges.
 */
import { projectNameMax } from "../../../../../packages/domain/src/projects.ts";
import {
  type ProjectsFailure,
  type ProjectView,
  projectGone,
  validProjectName,
} from "../../projects-core.ts";
import {
  type ProjectCounts,
  type ProjectOverview,
  type ShellCounts,
  sortProjects,
} from "../model.ts";
import { t } from "../strings.ts";

// ───────────────────────────── badges ─────────────────────────────

/** A project row shows one
 * coloured chip, 「等你 n」 (its whole 需要你, failures included); what runs, waits or is scheduled
 * is not shown on the row. */
export type ProjectBadgeTone = "amber";
export type ProjectBadgeKey = "needs";
export interface ProjectBadge {
  key: ProjectBadgeKey;
  tone: ProjectBadgeTone;
  count: number;
  label: string;
}

/** 「等你 n」 (amber) when the project has anything for the owner; nothing otherwise. */
export function projectBadges(counts: ProjectCounts): ProjectBadge[] {
  const needs = Math.max(0, counts.needsYou);
  return needs
    ? [{ key: "needs", tone: "amber", count: needs, label: t.projects.badgeNeeds(needs) }]
    : [];
}

/** The local shell counts in N1's shape (ShellCounts.running already includes queued). */
export function countsFromShell(counts: ShellCounts): ProjectCounts {
  return {
    needsYou: counts.needsYou,
    running: counts.running,
    queued: 0,
    waiting: counts.waiting,
    scheduled: counts.scheduled,
    failed7d: counts.failed,
  };
}

// ───────────────────────────── rows ─────────────────────────────

export interface ProjectRowModel {
  /** null = the default project (未分组). */
  id: string | null;
  /** The name to show (未分组 for the default project). */
  name: string;
  /** 「n 号」, 「n 个未分配」 for the default project; null when unknown. */
  countLabel: string | null;
  badges: ProjectBadge[];
  /** 需要你 of this project (0 without N1). */
  needsYou: number;
  current: boolean;
  /** A delete stopped halfway: the row offers 再试删除 and cannot be opened. */
  deleting: boolean;
}

const zero: ProjectCounts = {
  needsYou: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  scheduled: 0,
  failed7d: 0,
};

const countLabel = (id: string | null, accounts: number | null) =>
  accounts === null
    ? null
    : id === null
      ? t.projects.unassignedAccounts(accounts)
      : t.projects.accounts(accounts);

/** Overview ids that GET /api/projects does not list (created elsewhere since the list was
 * read): the list should be re-read. Empty without an overview. */
export function unknownProjectIds(
  overview: readonly ProjectOverview[] | null,
  projects: readonly Pick<ProjectView, "id">[],
): string[] {
  if (!overview) return [];
  const known = new Set(projects.map((project) => project.id));
  return overview
    .map((row) => row.id)
    .filter((id): id is string => id !== null && !known.has(id))
    .sort();
}

/**
 * Every project row, in display order (design §3.3): with N1, projects with something for you
 * first, then by latest activity, 未分组 last (sortProjects), the current project's numbers taken
 * from `currentCounts`; projects the overview does not know yet (just created, or deleting) join
 * with no numbers. Without N1 (`overview` null): 未分组 last, the others in the list's order,
 * names and account counts only, no badges.
 */
export function projectRows(input: {
  overview: readonly ProjectOverview[] | null;
  projects: readonly ProjectView[];
  /** GET /api/projects answered (false = projects are off on this server, or not read yet). */
  projectsAvailable: boolean;
  current: string | null;
  /** The current project's local counts; null to use N1's. */
  currentCounts: ShellCounts | null;
  /** The space has a founder: her account lives in the hall (the default project), so N1 counts
   * her there, but she is the space's 创始人, never 未分配 (docs/founder.md). */
  founderInHall?: boolean;
}): ProjectRowModel[] {
  const { overview, projects, projectsAvailable, current } = input;
  // 「n 个未分配」 of the hall: its accounts but the founder.
  const accountsOf = (row: Pick<ProjectOverview, "id" | "accounts">) =>
    row.accounts < 0
      ? null
      : row.id === null && input.founderInHall
        ? Math.max(0, row.accounts - 1)
        : row.accounts;
  const byId = new Map(projects.map((project) => [project.id, project]));
  // The space's own conversation (the default project) leads the column.
  const hallFirst = <T extends { id: string | null }>(rows: T[]) => [
    ...rows.filter((row) => row.id === null),
    ...rows.filter((row) => row.id !== null),
  ];
  if (!overview) {
    return hallFirst([
      ...projects.map(
        (project): ProjectRowModel => ({
          id: project.id,
          name: project.name,
          countLabel: countLabel(project.id, project.environments),
          badges: [],
          needsYou: 0,
          current: project.id === current,
          deleting: project.deleting,
        }),
      ),
      {
        id: null,
        name: t.projects.defaultName,
        countLabel: null,
        badges: [],
        needsYou: 0,
        current: current === null,
        deleting: false,
      },
    ]);
  }
  const listed = overview.filter(
    (row) => row.id === null || !projectsAvailable || byId.has(row.id),
  );
  const seen = new Set(listed.map((row) => row.id));
  const merged: ProjectOverview[] = [
    ...listed.map((row) => {
      const project = row.id === null ? undefined : byId.get(row.id);
      const counts =
        row.id === current && input.currentCounts
          ? countsFromShell(input.currentCounts)
          : row.counts;
      return { ...row, name: project?.name ?? row.name, counts };
    }),
    ...projects
      .filter((project) => !seen.has(project.id))
      .map(
        (project): ProjectOverview => ({
          id: project.id,
          name: project.name,
          accounts: project.environments,
          counts:
            project.id === current && input.currentCounts
              ? countsFromShell(input.currentCounts)
              : zero,
          lastActivityAt: null,
        }),
      ),
  ];
  if (!seen.has(null))
    merged.push({
      id: null,
      name: "",
      accounts: -1,
      counts: current === null && input.currentCounts ? countsFromShell(input.currentCounts) : zero,
      lastActivityAt: null,
    });
  return hallFirst(sortProjects(merged)).map((row) => ({
    id: row.id,
    name: row.id === null ? t.projects.defaultName : row.name || t.projects.defaultName,
    countLabel: countLabel(row.id, accountsOf(row)),
    badges: projectBadges(row.counts),
    needsYou: row.counts.needsYou,
    current: row.id === current,
    deleting: row.id !== null && byId.get(row.id)?.deleting === true,
  }));
}

/** 「12 号 · 当前」 in the panel; the plain count in the column. */
export function rowCountText(row: ProjectRowModel, inPanel: boolean): string {
  const parts = [row.countLabel, inPanel && row.current ? t.projects.current : null].filter(
    (part): part is string => !!part,
  );
  return parts.join(t.common.sep);
}

// ───────────────────────────── forms ─────────────────────────────

/** The name to send, or why not, in Chinese (validProjectName's rules, its words translated). */
export function checkProjectName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const valid = validProjectName(name);
  if (typeof valid === "string") return { ok: true, name: valid };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: t.projects.nameRequired };
  if (trimmed.length > projectNameMax)
    return { ok: false, error: t.projects.nameTooLong(projectNameMax) };
  return { ok: false, error: t.projects.nameReserved(trimmed) };
}

/** A project request's error, for the panel. Server messages are data and stay as they are. */
export function projectErrorText(error: unknown): string {
  if (projectGone(error)) return t.projects.gone;
  return `${t.common.errorPrefix}${error instanceof Error ? error.message : String(error)}`;
}

/** The ProjectsProvider's last failure (`failure`), for the panel; "" = none. */
export function providerErrorText(failure: ProjectsFailure | null): string {
  if (!failure) return "";
  if (failure.kind === "delete")
    return t.projects.deleteUnfinished(failure.gone ? t.projects.gone : failure.message);
  return failure.gone ? t.projects.gone : `${t.common.errorPrefix}${failure.message}`;
}
