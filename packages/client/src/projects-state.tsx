/**
 * The projects state of projects.tsx without React Native: the current
 * project, the list, and create / rename / delete (ProjectsProvider, useProjects). The menu
 * section that draws them stays in projects.tsx.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MuseApi } from "./api";
import { activeSpaceId } from "./api-client";
import { lastSeenScope, readLastSeen, writeLastSeen } from "./last-seen";
import { lastSeenStorage } from "./last-seen-store";
import { isWeb } from "./platform-env";
import {
  memoryStorage,
  noContent,
  normalizeProject,
  normalizeProjects,
  type ProjectStorage,
  type ProjectsFailure,
  type ProjectView,
  projectError,
  projectPath,
  projectsFailure,
  projectsUnavailable,
  readStoredProject,
  resolveStoredProject,
  writeStoredProject,
} from "./projects-core";

export interface ProjectsValue {
  /** The server offers projects (GET /api/projects did not answer the feature-off 503). */
  available: boolean;
  /** The first list request has settled, so `current` is final for this load. */
  ready: boolean;
  loading: boolean;
  projects: ProjectView[];
  /** The current project id; null is the default project. */
  current: string | null;
  /** The current project's view; null in the default project. */
  project: ProjectView | null;
  error: string;
  /** `error` as data (the new shell words it in Chinese); null = none. */
  failure: ProjectsFailure | null;
  select: (projectId: string | null) => void;
  create: (name: string) => Promise<ProjectView>;
  rename: (projectId: string, name: string) => Promise<ProjectView>;
  remove: (projectId: string) => Promise<void>;
  refresh: () => Promise<void>;
}
const ProjectsContext = createContext<ProjectsValue | null>(null);
export function useProjects() {
  const context = useContext(ProjectsContext);
  if (!context) throw new Error("Projects provider is unavailable");
  return context;
}

/** localStorage on web when the browser allows it; otherwise the choice lives for the session. */
function platformStorage(): ProjectStorage {
  if (isWeb) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    } catch {
      // Blocked storage (private mode, sandboxed frame): fall through.
    }
  }
  return memoryStorage();
}

export function ProjectsProvider({ token, children }: { token: string; children: ReactNode }) {
  // Unscoped on purpose: the project routes always act on the real owner.
  const api = useMemo(() => new MuseApi(token), [token]);
  const storage = useMemo(platformStorage, []);
  // The space this provider lives in (the app is keyed by it).
  const [space] = useState(activeSpaceId);
  // The projects this device last read for the space open at once.
  const [seen] = useState(() =>
    readLastSeen<ProjectView[]>(lastSeenStorage(), lastSeenScope(space, null), "projects"),
  );
  const [projects, setProjects] = useState<ProjectView[]>(seen ?? []);
  const [current, setCurrent] = useState<string | null>(() => readStoredProject(storage, space));
  const [available, setAvailable] = useState(!!seen);
  const [ready, setReady] = useState(!!seen);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<ProjectsFailure | null>(null);
  const version = useRef(0);
  const mounted = useRef(true);
  // The project before the current one, so deleting the current project lands back there.
  const previous = useRef<string | null>(null);
  const listed = useRef<ProjectView[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => writeStoredProject(storage, current, space), [storage, current, space]);

  const refresh = useCallback(async () => {
    const attempt = ++version.current;
    setLoading(true);
    try {
      const list = normalizeProjects(await api.request<unknown>("/api/projects"));
      if (attempt !== version.current || !mounted.current) return;
      setProjects(list);
      writeLastSeen(lastSeenStorage(), lastSeenScope(space, null), "projects", list);
      listed.current = list;
      setAvailable(true);
      setError("");
      setFailure(null);
      // A persisted project that was deleted elsewhere falls back to the default project.
      setCurrent((chosen) => resolveStoredProject(chosen, list));
    } catch (e) {
      if (attempt !== version.current || !mounted.current) return;
      if (projectsUnavailable(e)) {
        setProjects([]);
        setAvailable(false);
        setCurrent(null);
        setError("");
        setFailure(null);
      } else {
        setError(projectError(e));
        setFailure(projectsFailure("list", e));
      }
    } finally {
      if (attempt === version.current && mounted.current) {
        setLoading(false);
        setReady(true);
      }
    }
  }, [api, space]);
  useEffect(() => {
    void refresh();
    return () => {
      version.current++;
    };
  }, [refresh]);

  const select = useCallback(
    (projectId: string | null) =>
      setCurrent((chosen) => {
        if (chosen !== projectId) previous.current = chosen;
        return projectId;
      }),
    [],
  );
  const create = useCallback(
    async (name: string) => {
      const created = normalizeProject(await api.request<unknown>("/api/projects", { name }));
      await refresh();
      return created;
    },
    [api, refresh],
  );
  const rename = useCallback(
    async (projectId: string, name: string) => {
      const renamed = normalizeProject(
        await api.request<unknown>(projectPath(projectId), { name }, "PATCH"),
      );
      await refresh();
      return renamed;
    },
    [api, refresh],
  );
  const remove = useCallback(
    async (projectId: string) => {
      const back = previous.current === projectId ? null : previous.current;
      let removed = false;
      // Leave the project first: the moment the server marks it deleting, its pollers would
      // get 404s. The delete route itself is unscoped, so it needs no current project. Land
      // on the project the person came from when it still exists, else on the default one.
      const landing =
        back && listed.current.some((item) => item.id === back && !item.deleting) ? back : null;
      setCurrent((chosen) => (chosen === projectId ? landing : chosen));
      try {
        await noContent(api.request<unknown>(projectPath(projectId), undefined, "DELETE"));
        removed = true;
      } catch (e) {
        // The sheet closes when the workspace falls back to the default project, so the
        // reason is kept here and shown above the list until the next successful call.
        if (mounted.current) {
          setError(`The delete did not finish: ${projectError(e)}`);
          setFailure(projectsFailure("delete", e));
        }
        throw e;
      } finally {
        // Done or not, the list decides what is left: a project that a failed attempt left
        // `deleting` is unusable (its requests are 404s), so the refresh moves the workspace
        // to the default project and the row offers a retry.
        if (mounted.current) await refresh();
      }
      // Back to the project the person came from, when it still exists.
      if (removed && back && mounted.current)
        setCurrent((chosen) =>
          chosen === null && listed.current.some((item) => item.id === back && !item.deleting)
            ? back
            : chosen,
        );
    },
    [api, refresh],
  );

  const project = useMemo(
    () => (current ? (projects.find((item) => item.id === current) ?? null) : null),
    [current, projects],
  );
  return (
    <ProjectsContext.Provider
      value={{
        available,
        ready,
        loading,
        projects,
        current,
        project,
        error,
        failure,
        select,
        create,
        rename,
        remove,
        refresh,
      }}
    >
      {children}
    </ProjectsContext.Provider>
  );
}
