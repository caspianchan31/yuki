/**
 * GET /api/projects/overview, the numbers behind the
 * project switcher and the header's red dot. One row per live project, sorted by name, then
 * the default project last as `{ id: null, name: "" }`:
 *
 *   { projects: [{ id, name, accounts, counts: { needsYou, running, queued, waiting,
 *                  scheduled, failed7d }, needs: [{ key, kind, title, account }],
 *                  lastActivityAt }] }
 *
 * Numbers, and (fork, one 需要你) the one line per 需要你 item behind `counts.needsYou`: the
 * whole space's 需要你 page lists the other projects' items by these lines (each opens its
 * project), so the count and the rows are one source: `counts.needsYou` is `needs.length`.
 * Nothing else is listed: it is not a dashboard. Read-only and computed on every read from
 * the records that already exist (tasks, review actions, accounts and their saved settings),
 * with no new storage. Desktops are never started, woken or attached: their states come from one
 * provider listing for every account (`computer.states`, as GET /api/environments and
 * /api/topology already do), and only when there are accounts. That listing (one provider call) is
 * the only thing kept between reads: 15 seconds per real owner and set of accounts (design §8.2
 * N4), so several open clients, each polling every 30 s, and quick re-reads share one listing;
 * a failed listing is not kept. Design §8.2 had N1 skip the desktop state; then a project's
 * 需要你 here left out its desktop errors while the same project counted them once it was opened
 * (round-2 review), against §5.2's one number everywhere.
 *
 * `needsYou` follows decision 4 of the redesign, the same 需要你 the client counts:
 *   - the tasks `taskPhase` puts in 需要你: ask_user questions (`waiting_input`, including
 *     auto-continue used up; waits have no limit), `waiting_approval`, failures within 7 days;
 *   - upstream reviews (`actions` awaiting_review) that no waiting_approval task stands for;
 *   - the project's accounts whose desktop is in error, once per account, exactly as the client's
 *     account flags read GET /api/environments: a desktop the listing reports in error, a
 *     listing that failed (every account then reads 出错) or saved settings that could not be
 *     loaded are desktop errors;
 * Site checks and sign-in walls are never in it, and neither is one account serving several
 * tasks. The other counts are the task phases: running, queued, waiting (a `wait_until` wait),
 * scheduled (a repeat or a one-off run later), failed7d.
 */
import { Hono } from "hono";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  ownerSignInStatuses,
  type SiteSignInFact,
} from "../../../packages/domain/src/credentials.ts";
import type { Environment } from "../../../packages/domain/src/environments.ts";
import type { ActionProposal } from "../../../packages/domain/src/index.ts";
import { isProjectId, projectOwner, realOwnerOf } from "../../../packages/domain/src/projects.ts";
import {
  type TaskPhaseCounts,
  taskEnvironmentId,
  taskPhase,
  taskPhaseCounts,
} from "../../../packages/domain/src/task-phase.ts";
import type { ComputerSettings, ComputerSettingsView, DesktopState } from "./computer.ts";
import { readSignIns } from "./credentials/facts.ts";
import type { Store } from "./db.ts";
import { type EnvironmentService, envOwner } from "./environments.ts";
import type { ProjectService } from "./projects.ts";

/** One 需要你 item of a project, as the client's needItems keys it (`task:<id>`, `review:<id>`,
 * `account:<id>`, `project:sign-ins`, and Fork 2026-10-21 one per site's sign-in step:
 * `account:<id>|site:<need>:<site>`, `project:sign-ins|site:<need>:<site>`), in the same order.
 * `kind` for a task is its phase key (input, approval, fail); `title` the task's or proposal's
 * title, the account's name, or empty for the project's own logins; `account` the name of the
 * account a task runs on. A site's step names its `site` and its `need` (the client's flag
 * status: the fact's status, or confirming / unconfirmed once the owner said he handled it). */
export interface ProjectNeedLine {
  key: string;
  kind: "input" | "approval" | "fail" | "review" | "account" | "project";
  title: string;
  account: string | null;
  site?: string;
  need?: string;
}
/** One site's sign-in step waiting on the owner (a 需要你 item of its own). */
export interface SiteNeed {
  site: string;
  need: string;
}
/**
 * each fact only the owner can act on, as the client's flags read it (model.ts `factFlag`). */
export function siteNeeds(
  signIns: readonly Pick<
    SiteSignInFact,
    "site" | "status" | "ownerHandledAt" | "ownerHandledStale"
  >[],
): SiteNeed[] {
  return signIns
    .filter((fact) => ownerSignInStatuses.includes(fact.status))
    .map((fact) => ({
      site: fact.site,
      need:
        (fact.status === "needs_code" || fact.status === "needs_owner") && fact.ownerHandledAt
          ? fact.ownerHandledStale
            ? "unconfirmed"
            : "confirming"
          : fact.status,
    }));
}

/** One row of the overview; `id` null is the default project. */
export interface ProjectOverviewRow {
  id: string | null;
  name: string;
  /** Live accounts assigned to the project (the default project: the unassigned ones). */
  accounts: number;
  counts: TaskPhaseCounts;
  /** Every 需要你 item; `counts.needsYou` is its length. */
  needs: ProjectNeedLine[];
  /** The newest `updatedAt` of the project's tasks; null without tasks. */
  lastActivityAt: string | null;
}
export interface ProjectsOverview {
  projects: ProjectOverviewRow[];
}

/** What the overview reads. The computer is narrowed to the saved settings and the one listing
 * of desktop states on purpose: the overview never starts, wakes or attaches a desktop. */
export interface ProjectOverviewSources {
  db: Pick<Store, "list"> & Partial<Pick<Store, "get">>;
  projects: Pick<ProjectService, "records">;
  environments: Pick<EnvironmentService, "allRecords" | "available">;
  computer: {
    settings: Pick<ComputerSettings, "view">;
    states: (owners: string[]) => Promise<DesktopState[]>;
  };
  /** Shares one desktop listing between reads for a short while; without it every read lists. */
  listing?: DesktopListingCache;
}

/** How long one desktop listing serves the overview (design §8.2 N4: 15–20 s). */
export const desktopListingTtlMs = 15_000;

/** The desktop states of a real owner's accounts, by derived owner. */
export type DesktopStates = Map<string, DesktopState>;

export interface DesktopListingCache {
  /** The states of `owners` (`real`'s accounts): the listing made for the same set of owners
   * within the last `ttlMs` (or still running), else a new `list(owners)`. A listing that fails
   * is not kept, so the next read lists again. */
  states(
    real: string,
    owners: readonly string[],
    list: (owners: string[]) => Promise<DesktopState[]>,
  ): Promise<DesktopStates>;
  /** Forget every kept listing. */
  clear(): void;
}

/** A per-owner cache of the provider's desktop listing (design §8.2 N4). */
export function desktopListingCache(
  options: { ttlMs?: number; now?: () => number } = {},
): DesktopListingCache {
  const ttlMs = options.ttlMs ?? desktopListingTtlMs;
  const now = options.now ?? Date.now;
  const kept = new Map<string, { key: string; at: number; states: Promise<DesktopStates> }>();
  return {
    states(real, owners, list) {
      // The same accounts in any order are the same listing; a new or deleted account is not.
      const key = [...owners].sort().join("\n");
      const at = now();
      const hit = kept.get(real);
      if (hit && hit.key === key && at - hit.at < ttlMs) return hit.states;
      const asked = [...owners];
      const states = list(asked).then(
        (result): DesktopStates => new Map(asked.map((owner, index) => [owner, result[index]])),
      );
      const entry = { key, at, states };
      kept.set(real, entry);
      states.catch(() => {
        if (kept.get(real) === entry) kept.delete(real);
      });
      return states;
    },
    clear() {
      kept.clear();
    },
  };
}

/** Facts only the owner can act on: a site refused the saved password,
 * asks for a code, suspended the account or has no saved login. */
export function factsNeedYou(facts: { signIns: readonly Pick<SiteSignInFact, "status">[] }) {
  return facts.signIns.some((fact) => ownerSignInStatuses.includes(fact.status));
}
/** The account-level 需要你 item (design §5.2 item 4, decision 4), the way the client's
 * accountFlags reads an environment view: its desktop is in error (EnvironmentService.compose:
 * the listing says so, or the saved settings could not be loaded), or (fork, credentials) one
 * of its facts only the owner can act on. One item per account. */
export function accountNeedsYou(
  state: DesktopState,
  settings: ComputerSettingsView | "failed",
  facts: { signIns: readonly Pick<SiteSignInFact, "status">[] } = { signIns: [] },
): boolean {
  if (state.state === "error" || settings === "failed") return true;
  return factsNeedYou(facts);
}

/** Whether each account needs you, in order: one provider listing for all of them, and each
 * account's saved settings. A malformed id names no owner: it is not listed and never counted
 * (GET /api/environments cannot show it either). */
async function accountsNeedingYou(
  sources: ProjectOverviewSources,
  real: string,
  accounts: readonly Environment[],
): Promise<{ flagged: boolean; sites: SiteNeed[] }[]> {
  const owners = accounts.map((record) => {
    try {
      return envOwner(real, record.id);
    } catch {
      return null;
    }
  });
  const listed = owners.filter((owner): owner is string => owner !== null);
  const list = (asked: string[]) => sources.computer.states(asked);
  let stateOf: DesktopStates;
  try {
    if (!listed.length) stateOf = new Map();
    else if (sources.listing) stateOf = await sources.listing.states(real, listed, list);
    else {
      const states = await list(listed);
      stateOf = new Map(listed.map((owner, index) => [owner, states[index]]));
    }
  } catch (error) {
    // As GET /api/environments shows it: every account's desktop reads 出错.
    const text = error instanceof Error ? error.message : String(error);
    stateOf = new Map(listed.map((owner) => [owner, { state: "error", message: text }]));
  }
  return Promise.all(
    owners.map(async (owner, _index) => {
      if (owner === null) return { flagged: false, sites: [] };
      const settings = await sources.computer.settings.view(owner).catch((): "failed" => "failed");
      const state = stateOf.get(owner) ?? { state: "error", message: "Not listed" };
      const facts = { signIns: await readSignIns(sources.db, owner) };
      // The account's own item (its desktop) and one per site's step.
      return {
        flagged: accountNeedsYou(state, settings, { signIns: [] }),
        sites: siteNeeds(facts.signIns),
      };
    }),
  );
}

/** Reviews in 需要你 that no waiting_approval task already stands for. */
export function pendingReviewItems<A extends Pick<ActionProposal, "id" | "status">>(
  tasks: readonly Pick<AgentTask, "status" | "actionId">[],
  actions: readonly A[],
): A[] {
  const counted = new Set(
    tasks.filter((task) => task.status === "waiting_approval").map((task) => task.actionId),
  );
  return actions.filter((action) => action.status === "awaiting_review" && !counted.has(action.id));
}
export const pendingReviews = (
  tasks: readonly Pick<AgentTask, "status" | "actionId">[],
  actions: readonly Pick<ActionProposal, "id" | "status">[],
): number => pendingReviewItems(tasks, actions).length;

/** A project's 需要你 lines in the client's order (model.ts needItems): the tasks in 需要你 (by
 * the same priority: questions and reviews, then failures; newest first), the reviews no task
 * stands for, the accounts that need the owner, the project's own logins. */
export function projectNeedLines(input: {
  tasks: readonly AgentTask[];
  actions: readonly ActionProposal[];
  /** `needsYou`: the account's own item (its desktop); `sites`: each
   * site's sign-in step, an item of its own. */
  accounts: readonly {
    record: Pick<Environment, "id" | "name">;
    needsYou: boolean;
    sites?: readonly SiteNeed[];
  }[];
  /** Every account by id, for a task's account name . */
  accountNames?: ReadonlyMap<string, string>;
  /** The project's own logins: each site's step (`own`: kept for older callers, always false). */
  projectFacts: boolean | { own: boolean; sites: readonly SiteNeed[] };
  now: Date | number;
}): ProjectNeedLine[] {
  const project =
    typeof input.projectFacts === "boolean"
      ? { own: input.projectFacts, sites: [] as readonly SiteNeed[] }
      : input.projectFacts;
  const siteKey = (base: string, need: SiteNeed) => `${base}|site:${need.need}:${need.site}`;
  const tasks = input.tasks
    .map((task) => ({ task, phase: taskPhase(task, { now: input.now }) }))
    .filter(({ phase }) => phase.needsYou)
    .sort(
      (a, b) => a.phase.rank - b.phase.rank || b.task.updatedAt.localeCompare(a.task.updatedAt),
    );
  return [
    ...tasks.map(({ task, phase }): ProjectNeedLine => {
      const environmentId = taskEnvironmentId(task);
      return {
        key: `task:${task.id}`,
        kind: phase.key === "input" || phase.key === "approval" ? phase.key : "fail",
        title: task.title,
        account: (environmentId && input.accountNames?.get(environmentId)) || null,
      };
    }),
    ...pendingReviewItems(input.tasks, input.actions).map(
      (action): ProjectNeedLine => ({
        key: `review:${action.id}`,
        kind: "review",
        title: action.title,
        account: action.account ?? null,
      }),
    ),
    ...input.accounts.flatMap(({ record, needsYou, sites = [] }): ProjectNeedLine[] => [
      ...(needsYou
        ? [
            {
              key: `account:${record.id}`,
              kind: "account" as const,
              title: record.name,
              account: record.name,
            },
          ]
        : []),
      ...sites.map(
        (need): ProjectNeedLine => ({
          key: siteKey(`account:${record.id}`, need),
          kind: "account",
          title: record.name,
          account: record.name,
          site: need.site,
          need: need.need,
        }),
      ),
    ]),
    ...(project.own
      ? [{ key: "project:sign-ins", kind: "project" as const, title: "", account: null }]
      : []),
    ...project.sites.map(
      (need): ProjectNeedLine => ({
        key: siteKey("project:sign-ins", need),
        kind: "project",
        title: "",
        account: null,
        site: need.site,
        need: need.need,
      }),
    ),
  ];
}

/** The newest task update, or null. */
export function lastActivity(tasks: readonly Pick<AgentTask, "updatedAt">[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    const ms = Date.parse(task.updatedAt);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = task.updatedAt;
      latestMs = ms;
    }
  }
  return latest;
}

/** The overview of every project of the real owner behind `owner`. */
export async function buildProjectsOverview(
  sources: ProjectOverviewSources,
  owner: string,
  now: Date | number = Date.now(),
): Promise<ProjectsOverview> {
  const real = realOwnerOf(owner);
  const available = sources.environments.available();
  const [projectRecords, environmentRecords] = await Promise.all([
    sources.projects.records(real),
    // Accounts exist only where environments are available; elsewhere every project has none.
    available ? sources.environments.allRecords(real) : Promise.resolve([]),
  ]);
  const accounts = environmentRecords.filter((record) => !record.deleting);
  const flagged = await accountsNeedingYou(sources, real, accounts);
  const accountNames = new Map(accounts.map((record) => [record.id, record.name]));
  const rows = [
    ...projectRecords
      // A record being deleted is unusable; a malformed id could not name an owner.
      .filter((project) => !project.deleting && isProjectId(project.id))
      .map((project) => ({
        id: project.id as string | null,
        name: project.name,
        owner: projectOwner(real, project.id),
      })),
    { id: null, name: "", owner: real },
  ];
  return {
    projects: await Promise.all(
      rows.map(async ({ id, name, owner: scoped }): Promise<ProjectOverviewRow> => {
        const [tasks, actions] = await Promise.all([
          sources.db.list<AgentTask>(scoped, "tasks"),
          sources.db.list<ActionProposal>(scoped, "actions"),
        ]);
        const counts = taskPhaseCounts(tasks, now);
        const own = accounts
          .map((record, index) => ({ record, fact: flagged[index] }))
          .filter(({ record }) => (record.projectId ?? null) === id)
          .map(({ record, fact }) => ({
            record,
            needsYou: fact.flagged,
            sites: fact.sites,
          }));
        // The project's own logins (its default desktop) count too, each
        // site's step as an item of its own (2026-10-21).
        const projectSignIns = available ? await readSignIns(sources.db, scoped) : [];
        const projectFacts = { own: false, sites: available ? siteNeeds(projectSignIns) : [] };
        // One source: the count is the number of lines the 需要你 page lists.
        const needs = projectNeedLines({
          tasks,
          actions,
          accounts: own,
          accountNames,
          projectFacts,
          now,
        });
        counts.needsYou = needs.length;
        return {
          id,
          name,
          accounts: own.length,
          counts,
          needs,
          lastActivityAt: lastActivity(tasks),
        };
      }),
    ),
  };
}

/** GET /overview, mounted under /api/projects: unscoped, so the project header is ignored. */
export function projectOverviewRoutes(sources: ProjectOverviewSources) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await buildProjectsOverview(sources, c.get("owner"))));
  return app;
}
