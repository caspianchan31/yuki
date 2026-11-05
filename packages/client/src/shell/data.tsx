/**
 * The shell's one data layer. Two providers:
 *
 *   OverviewProvider   (global, above the project key; unscoped client)  N1 project counts
 *   ShellDataProvider  (per project, inside WorkspaceContext, AgentWorkspaceProvider and
 *                       ThreadsProvider)  accounts, reports, reviews, brief + every
 *                       derived model (phases, account rows, 需要你, counts)
 *
 * Request budget (the server allows 120 requests per minute per signed-in user, rate-limit.ts;
 * every tab of every device of one person shares it, colleagues behind one office address do
 * not). Steady state with the app visible, one tab:
 *   GET /api/agent                       every 3 s (AgentWorkspaceProvider, existing)   20/min
 *   GET /api/chat-reports?threadId=…     every 5 s, the conversation on screen (existing) 12/min
 *   GET /api/chat-reports?threadId=main&limit=5  every 15 s, the main chat's latest (rail)  4/min
 *   GET /api/main-thread                 every 15 s, which chat is the main one (another
 *                                        member's 开新主聊天, ThreadsProvider)              4/min
 *   GET /api/environments                every 20 s (accounts, desktop state)      3/min
 *   GET /api/credentials/sign-ins        every 20 s (the project's own login facts, 需要你)  3/min
 *   GET /api/projects/overview           every 30 s (N1, project counts, red dot)          2/min
 *   GET /api/workspace                   on mount and foreground (App), and every 60 s only
 *                                        while a review is open: an awaiting_review proposal
 *                                        or a waiting_approval task (it reads Gmail and
 *                                        Calendar in live mode, so never on a timer otherwise)  0–1/min
 *                                                                               total ≈ 48–49/min
 * On demand only (never polled): /api/environments/unassigned (加入), /api/topology (accounts
 * page), /api/agent/brief (project notes), /api/chat-reports?taskId (task detail),
 * /api/agent/tasks/:id (task detail), chat turns and thread selection. That leaves room for a
 * second tab and the chat's own bursts (a turn, its saves, its "seen" marks). Every poller loads
 * once on mount whatever the page's visibility; a hidden page nobody has touched for a minute
 * then polls at a quarter of the pace, at most once a minute (poll-core.ts), never not at all.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ActionProposal } from "../../../../packages/domain/src";
import type { AgentMemory, AgentTask, ChatReport } from "../../../../packages/domain/src/agent";
import type { Topology } from "../../../../packages/domain/src/topology";
import { useAgentWorkspace } from "../agent-workspace";
import { MuseApi } from "../api";
import { activeSpaceId } from "../api-client";
import { ApiError } from "../api-response";
import { normalizeReports } from "../chat-reports-core";
import { environmentsUnavailable, normalizeEnvironment } from "../environments";
import { clearLastSeen, lastSeenScope, readLastSeen, writeLastSeen } from "../last-seen";
import { lastSeenStorage, scopeOf } from "../last-seen-store";
import { useMuseThread } from "../threads-state";
import { normalizeTopology } from "../topology-core";
import { useWorkspace } from "../workspace";
import { accountsDirectory } from "./accounts/directory";
import { withoutWaitCards } from "./chat/core";
import { forgetThreadNames } from "./frame/thread-rows";
import {
  type AccountModel,
  type AccountView,
  buildAccountModels,
  latestReports,
  type NeedItem,
  needItems,
  normalizeBrief,
  normalizeOverview,
  normalizeProjectSignIns,
  otherProjectsNeedsYou,
  type ProjectBrief,
  type ProjectOverview,
  type ProjectSignIn,
  type RailTasks,
  railTasks,
  type ShellCounts,
  type SpaceNeedGroup,
  shellCounts,
  spaceNeedCount,
  spaceNeeds,
  type TaskEntry,
  taskEntries,
  type WorkerHealth,
  workerHealth,
} from "./model";
import { usePoll } from "./poll";
import { pollMs, requestVersions } from "./poll-core";

export { pollMs };
/** Reports the rail shows (汇报 · 最新 5 条): the current main chat's newest. */
export const railReportsLimit = 5;
const noReports: ChatReport[] = [];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A clock that re-renders every `ms` (relative labels). */
export function useNow(ms: number = pollMs.clock): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// ───────────────────────────── N1 overview (global) ─────────────────────────────

export interface OverviewValue {
  /** Null until the first answer, or when the server has no overview route (old server). */
  projects: ProjectOverview[] | null;
  /** False when the server answered 404/405 (no N1 yet): the project list shows no numbers. */
  available: boolean;
  error: string;
  refresh: () => Promise<void>;
  /** 需要你 in every project except `current` (the header's red dot). */
  othersNeedYou: (current: string | null) => number;
}
const OverviewContext = createContext<OverviewValue | null>(null);

export function OverviewProvider({ token, children }: { token: string; children: ReactNode }) {
  // Unscoped on purpose: N1 reads every project of the real owner (design §8.2).
  const api = useMemo(() => new MuseApi(token), [token]);
  // The shell's module-level caches outlive a project switch on purpose, but not the session:
  // this provider lives exactly as long as one sign-in (above the project key), so a sign-out
  // or a new session starts from nothing (no accounts or chat names of the last one).
  useEffect(
    () => () => {
      accountsDirectory.reset();
      forgetThreadNames();
      // Nothing of this session stays on the device.
      clearLastSeen(lastSeenStorage());
    },
    [token],
  );
  // The projects' overview this device last read for the space, at once.
  const overviewScope = lastSeenScope(activeSpaceId(), null);
  const [projects, setProjects] = useState<ProjectOverview[] | null>(
    () => readLastSeen<ProjectOverview[]>(lastSeenStorage(), overviewScope, "overview") ?? null,
  );
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const list = normalizeOverview(await api.request<unknown>("/api/projects/overview"));
      setProjects(list);
      if (list)
        writeLastSeen(lastSeenStorage(), lastSeenScope(activeSpaceId(), null), "overview", list);
      setAvailable(list !== null);
      setError("");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
        setAvailable(false);
        setProjects(null);
        setError("");
      } else setError(errorText(e));
    }
  }, [api]);
  usePoll(refresh, pollMs.overview, available);
  const value = useMemo<OverviewValue>(
    () => ({
      projects,
      available,
      error,
      refresh,
      othersNeedYou: (current) => otherProjectsNeedsYou(projects, current),
    }),
    [projects, available, error, refresh],
  );
  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

export function useOverview(): OverviewValue {
  const value = useContext(OverviewContext);
  if (!value) throw new Error("Project overview is unavailable");
  return value;
}

// ───────────────────────────── per-project data ─────────────────────────────

export interface Loadable<T> {
  value: T;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

export interface ShellData {
  /** Re-rendered every 30 s; pass it to every label that says "还剩 / 下次". */
  now: number;
  /** /api/agent has answered at least once. */
  ready: boolean;
  agentError: string;
  tasks: AgentTask[];
  memories: AgentMemory[];
  entries: TaskEntry[];
  entryById: Map<string, TaskEntry>;
  worker: WorkerHealth;
  /** The worker has no heartbeat (once /api/agent has answered): nothing moves. Every word that
   * says something runs reads it (此刻, the members, the sidebar's dots, 进度汇报's 正在做, the
   * chat's status lines), and so does every run's phase in `entries` (and so in the accounts'
   * tasks): it reads 「后台停着」 wherever it shows (stalledPhase), so none says 在跑 / 运行中 /
   * 正在做 under the red bar. */
  stalled: boolean;
  /** Environments are off on this server (no desktop provider): the account UI hides itself. */
  accountsUnavailable: boolean;
  accounts: Loadable<AccountModel[]>;
  accountById: Map<string, AccountModel>;
  /** Unassigned accounts (for 加入); loaded on demand with `unassigned.refresh()`. */
  unassigned: Loadable<AccountView[]>;
  /** Every account of every project (GET /api/topology); loaded on demand. */
  topology: Loadable<Topology | null>;
  /** The current main chat's latest reports (the rail's 汇报 · 最新 5 条), newest first. */
  reports: Loadable<ChatReport[]>;
  /** Upstream proposals awaiting review (email / calendar drafts; never a site action). */
  reviews: ActionProposal[];
  needs: NeedItem[];
  counts: ShellCounts;
  rail: RailTasks;
  /** The whole space's 需要你 by project, the current project first (its items are `needs`): the
   * one source of the 需要你 page and of every 需要你 count. */
  spaceNeeds: SpaceNeedGroup[];
  /** 需要你 here plus in every other project (sidebar, tab title, bottom bar): the rows of
   * `spaceNeeds`, always. */
  totalNeedsYou: number;
  /** Project brief (GET/PUT /api/agent/brief); `available` false after a 404. */
  brief: Loadable<ProjectBrief> & { available: boolean; save: (text: string) => Promise<void> };
  /** One task's reports (N2 `taskId`), newest first. */
  taskReports: (taskId: string) => Promise<ChatReport[]>;
  /** A client acting on another project (cross-project account moves, global page edits). */
  apiFor: (projectId: string | null) => MuseApi;
  /** Refresh tasks, accounts, reports and reviews now (after an action). */
  refreshAll: () => Promise<void>;
  /** Drop a deleted account from this project's lists at once (a read already in flight, from
   * before the delete, is dropped too); the next read confirms it. */
  forgetAccount: (id: string) => void;
  /** The owner acted on a desktop (an account's, or null: the project's
   * default desktop) for a site that needed a code; the AI looks again. */
  recheckSignIn: (site: string, environmentId: string | null) => Promise<void>;
}

const ShellDataContext = createContext<ShellData | null>(null);

export function useShellData(): ShellData {
  const value = useContext(ShellDataContext);
  if (!value) throw new Error("Shell data is unavailable");
  return value;
}

/** Reads GET /api/environments. */
export function normalizeAccountViews(payload: unknown): AccountView[] {
  return (Array.isArray(payload) ? payload : [])
    .map((item) => normalizeEnvironment(item))
    .filter((view) => view.id !== "");
}

const reportsQuery = (query: Record<string, string>) =>
  Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

export function ShellDataProvider({ children }: { children: ReactNode }) {
  const { api, workspace, refresh: refreshWorkspace } = useWorkspace();
  const { data, error: agentError, refresh: refreshAgent } = useAgentWorkspace();
  const { mainId, enabled: richThreads } = useMuseThread();
  const now = useNow();
  const overview = useOverview();

  // Accounts of this project (with desktop state).
  // The accounts this device last read for this space and project, at once.
  const [accountViews, setAccountViews] = useState<AccountView[]>(
    () => readLastSeen<AccountView[]>(lastSeenStorage(), scopeOf(api), "accounts") ?? [],
  );
  useEffect(() => {
    const seen = readLastSeen<AccountView[]>(lastSeenStorage(), scopeOf(api), "accounts");
    if (seen) setAccountViews(seen);
  }, [api]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [accountsUnavailable, setAccountsUnavailable] = useState(false);
  // The 20 s poll and the refresh after a move or an edit overlap: only the newest read's answer
  // is applied (like AgentWorkspaceProvider), so a poll that started before a move and answers
  // after the post-move refresh cannot put the old list back.
  const [accountsVersions] = useState(requestVersions);
  const refreshAccounts = useCallback(async () => {
    const isNewest = accountsVersions.begin();
    try {
      const views = normalizeAccountViews(await api.request<unknown>("/api/environments"));
      if (!isNewest()) return;
      setAccountViews(views);
      writeLastSeen(lastSeenStorage(), scopeOf(api), "accounts", views);
      setAccountsError("");
      setAccountsUnavailable(false);
    } catch (e) {
      if (!isNewest()) return;
      if (environmentsUnavailable(e)) {
        setAccountsUnavailable(true);
        setAccountViews([]);
        setAccountsError("");
      } else setAccountsError(errorText(e));
    } finally {
      if (isNewest()) setAccountsLoading(false);
    }
  }, [api, accountsVersions]);
  usePoll(refreshAccounts, pollMs.environments, !accountsUnavailable);

  // The project's own sign-in facts (its default desktop's logins): one 需要你 item, counted by
  // the overview the same way. A failed read keeps the last answer; a server without the route
  // (404) has none.
  const [projectSignIns, setProjectSignIns] = useState<ProjectSignIn[]>([]);
  const [signInsVersions] = useState(requestVersions);
  const refreshProjectSignIns = useCallback(async () => {
    const isNewest = signInsVersions.begin();
    try {
      const answer = await api.request<unknown>("/api/credentials/sign-ins");
      if (isNewest()) {
        setProjectSignIns(normalizeProjectSignIns(answer));
      }
    } catch (e) {
      if (isNewest() && e instanceof ApiError && e.status === 404) {
        setProjectSignIns([]);
      }
    }
  }, [api, signInsVersions]);
  // The owner acted on a desktop for a site that needed a code; the AI looks
  // again. Nothing to show for it: the fact changes when the AI records what it sees.
  const recheckSignIn = useCallback(
    async (site: string, environmentId: string | null) => {
      await api
        .request("/api/credentials/sign-ins/recheck", { site, environmentId })
        .catch(() => undefined);
      await Promise.allSettled([refreshProjectSignIns()]);
    },
    [api, refreshProjectSignIns],
  );
  usePoll(refreshProjectSignIns, pollMs.environments, !accountsUnavailable);

  // Unassigned accounts, on demand. Versioned too: a read that started before a move or a
  // delete and answers after it cannot put the account back into 未分配.
  const [unassigned, setUnassigned] = useState<AccountView[]>([]);
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  const [unassignedError, setUnassignedError] = useState("");
  const [unassignedVersions] = useState(requestVersions);
  const refreshUnassigned = useCallback(async () => {
    const isNewest = unassignedVersions.begin();
    setUnassignedLoading(true);
    try {
      const views = normalizeAccountViews(
        await api.request<unknown>("/api/environments/unassigned"),
      );
      if (!isNewest()) return;
      setUnassigned(views);
      setUnassignedError("");
    } catch (e) {
      if (!isNewest()) return;
      setUnassignedError(errorText(e));
    } finally {
      if (isNewest()) setUnassignedLoading(false);
    }
  }, [api, unassignedVersions]);

  // Topology, on demand.
  const [topology, setTopology] = useState<Topology | null>(null);
  const [topologyLoading, setTopologyLoading] = useState(false);
  const [topologyError, setTopologyError] = useState("");
  // With no computer connected there is no topology to read (the server has no /api/topology).
  const noComputer = workspace.runtime.computer === false;
  const refreshTopology = useCallback(async () => {
    if (noComputer) return;
    setTopologyLoading(true);
    try {
      setTopology(normalizeTopology(await api.request<unknown>("/api/topology")));
      setTopologyError("");
    } catch (e) {
      setTopologyError(errorText(e));
    } finally {
      setTopologyLoading(false);
    }
  }, [api, noComputer]);

  // The rail's 汇报 · 最新 5 条 are the current main chat's (a side chat's
  // task reports stay in that side chat and the task's detail). After 开新主聊天 they start empty.
  // Kept with the main chat they were read for: right after the main chat moves, the former
  // one's reports are not shown (as side-chat reports) while the new one's are read.
  // The main chat's reports this device last read, at once.
  const [reportsRead, setReports] = useState<{ threadId: string; items: ChatReport[] }>(() => ({
    threadId: mainId,
    items: readLastSeen<ChatReport[]>(lastSeenStorage(), scopeOf(api), `reports:${mainId}`) ?? [],
  }));
  useEffect(() => {
    const seen = readLastSeen<ChatReport[]>(lastSeenStorage(), scopeOf(api), `reports:${mainId}`);
    if (seen) setReports({ threadId: mainId, items: seen });
  }, [api, mainId]);
  const reports = reportsRead.threadId === mainId ? reportsRead.items : noReports;
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState("");
  // Versioned like the accounts: the 15 s poll and the refresh after an action overlap.
  const [reportsVersions] = useState(requestVersions);
  const refreshReports = useCallback(async () => {
    const isNewest = reportsVersions.begin();
    try {
      if (!richThreads || mainId === "local") return;
      const query = { threadId: mainId, limit: String(railReportsLimit) };
      const payload = await api.request<unknown>(`/api/chat-reports?${reportsQuery(query)}`);
      if (!isNewest()) return;
      // The cards a wait wrote before waits stopped being reports are not
      // shown (chat/core.ts withoutWaitCards).
      const items = latestReports(withoutWaitCards(normalizeReports(payload)), railReportsLimit);
      setReports({ threadId: query.threadId, items });
      writeLastSeen(lastSeenStorage(), scopeOf(api), `reports:${query.threadId}`, items);
      setReportsError("");
    } catch (e) {
      if (!isNewest()) return;
      setReportsError(errorText(e));
    } finally {
      if (isNewest()) setReportsLoading(false);
    }
  }, [api, mainId, richThreads, reportsVersions]);
  // Answers that arrive after the provider is gone are dropped.
  useEffect(
    () => () => {
      accountsVersions.invalidate();
      unassignedVersions.invalidate();
      reportsVersions.invalidate();
    },
    [accountsVersions, unassignedVersions, reportsVersions],
  );
  usePoll(refreshReports, pollMs.reports, true, mainId);

  const taskReports = useCallback(
    async (taskId: string) =>
      latestReports(
        withoutWaitCards(
          normalizeReports(
            await api.request<unknown>(
              `/api/chat-reports?${reportsQuery({ taskId, limit: "50" })}`,
            ),
          ),
        ),
        50,
      ),
    [api],
  );

  // Upstream reviews: /api/workspace at once when a task starts waiting for one, then once a
  // minute while a review is open (to see it decided or expired). Otherwise only on mount and
  // foreground (App): in live mode with Google connected every read lists Gmail and Calendar and
  // writes their cache, so it is never polled for nothing.
  const approvalKey = (data?.tasks ?? [])
    .filter((task) => task.status === "waiting_approval")
    .map((task) => task.id)
    .sort()
    .join(",");
  const reviewOpen =
    approvalKey !== "" || workspace.actions.some((action) => action.status === "awaiting_review");
  usePoll(refreshWorkspace, pollMs.workspace, reviewOpen, approvalKey);

  // Project brief, once.
  const [brief, setBrief] = useState<ProjectBrief>({ text: "", updatedAt: null });
  const [briefAvailable, setBriefAvailable] = useState(true);
  const [briefLoading, setBriefLoading] = useState(true);
  const [briefError, setBriefError] = useState("");
  const refreshBrief = useCallback(async () => {
    try {
      setBrief(normalizeBrief(await api.request<unknown>("/api/agent/brief")));
      setBriefAvailable(true);
      setBriefError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setBriefAvailable(false);
      else setBriefError(errorText(e));
    } finally {
      setBriefLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refreshBrief();
  }, [refreshBrief]);
  const saveBrief = useCallback(
    async (text: string) => {
      setBrief(normalizeBrief(await api.request<unknown>("/api/agent/brief", { text }, "PUT")));
    },
    [api],
  );

  const forgetAccount = useCallback(
    (id: string) => {
      // Reads in flight started before the delete: their answers still list the account.
      accountsVersions.invalidate();
      unassignedVersions.invalidate();
      setAccountViews((views) => views.filter((view) => view.id !== id));
      setUnassigned((views) => views.filter((view) => view.id !== id));
      setUnassignedLoading(false);
    },
    [accountsVersions, unassignedVersions],
  );

  const apiFor = useCallback(
    (projectId: string | null) =>
      projectId === api.projectId ? api : new MuseApi(api.token, projectId),
    [api],
  );
  const refreshAll = useCallback(async () => {
    await Promise.allSettled([
      refreshAgent(),
      refreshAccounts(),
      refreshProjectSignIns(),
      refreshReports(),
      refreshWorkspace(),
      overview.refresh(),
    ]);
  }, [
    refreshAgent,
    refreshAccounts,
    refreshProjectSignIns,
    refreshReports,
    refreshWorkspace,
    overview,
  ]);

  const tasks = data?.tasks ?? [];
  const worker = useMemo(() => workerHealth(data?.worker, now), [data?.worker, now]);
  // No heartbeat once /api/agent has answered: nothing moves, so a run reads 后台停着 everywhere
  // its phase shows (stalledPhase), from this one flag.
  const stalled = !!data && worker.down;
  const entries = useMemo(() => taskEntries(tasks, now, stalled), [tasks, now, stalled]);
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.task.id, entry])),
    [entries],
  );
  const accountModels = useMemo(
    () => buildAccountModels({ accounts: accountViews, entries, now }),
    [accountViews, entries, now],
  );
  const accountById = useMemo(
    () => new Map(accountModels.map((account) => [account.id, account])),
    [accountModels],
  );
  const reviews = useMemo(
    () => workspace.actions.filter((action) => action.status === "awaiting_review"),
    [workspace.actions],
  );
  const needs = useMemo(
    () =>
      needItems({
        entries,
        actions: reviews,
        accounts: accountModels,
        projectSignIns: accountsUnavailable ? [] : projectSignIns,
      }),
    [entries, reviews, accountModels, projectSignIns, accountsUnavailable],
  );
  const counts = useMemo(() => shellCounts(entries, needs), [entries, needs]);
  const rail = useMemo(() => railTasks(entries, now), [entries, now]);
  const groups = useMemo(
    () => spaceNeeds(needs, overview.projects, api.projectId),
    [needs, overview.projects, api.projectId],
  );

  const value: ShellData = {
    now,
    ready: !!data,
    agentError,
    tasks,
    memories: data?.memories ?? [],
    entries,
    entryById,
    worker,
    stalled,
    accountsUnavailable,
    accounts: {
      value: accountModels,
      loading: accountsLoading,
      error: accountsError,
      refresh: refreshAccounts,
    },
    accountById,
    unassigned: {
      value: unassigned,
      loading: unassignedLoading,
      error: unassignedError,
      refresh: refreshUnassigned,
    },
    topology: {
      value: topology,
      loading: topologyLoading,
      error: topologyError,
      refresh: refreshTopology,
    },
    reports: {
      value: reports,
      loading: reportsLoading,
      error: reportsError,
      refresh: refreshReports,
    },
    reviews,
    needs,
    counts,
    rail,
    spaceNeeds: groups,
    totalNeedsYou: spaceNeedCount(groups),
    brief: {
      value: brief,
      loading: briefLoading,
      error: briefError,
      refresh: refreshBrief,
      available: briefAvailable,
      save: saveBrief,
    },
    taskReports,
    apiFor,
    refreshAll,
    forgetAccount,
    recheckSignIn,
  };
  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}
