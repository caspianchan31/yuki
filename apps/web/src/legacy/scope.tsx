/**
 * Phase C (docs/web.md): which desktop the desktop sheet shows, and its unsent drafts, from
 * environment-scope.tsx and computer-drafts.tsx. Those modules import the chat's desktop card
 * (React Native), so the web keeps the minimal bit here: a scope whose MuseApi sends every
 * /api/computer call to one account's desktop (scopeComputerPath), and a drafts store kept per
 * desktop for the whole session (the phone's ComputerDraftProvider sits at the app's root, so an
 * unsent command survives closing the sheet; this store does the same).
 */
import { MuseApi } from "@m/api";
import type { DraftPair, FileEditorDraft } from "@m/computer-workspace-state";
import {
  DEFAULT_DRAFT_KEY,
  type EnvironmentRef,
  environmentDraftKey,
  scopeComputerPath,
} from "@m/environments";
import { type Detail, useWorkspace, WorkspaceContext } from "@m/workspace";
import {
  createContext,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

/** A MuseApi whose /api/computer calls go to one environment's desktop. */
export class EnvironmentApi extends MuseApi {
  constructor(
    base: MuseApi,
    readonly environmentId: string,
  ) {
    // Keep the base client's project, so the desktop calls stay in it.
    super(base.token, base.projectId);
  }
  override request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    return super.request<T>(scopeComputerPath(path, this.environmentId), body, method);
  }
  override url(path: string) {
    return super.url(scopeComputerPath(path, this.environmentId));
  }
}

interface ScopeValue {
  /** The environment this subtree shows; null is the default desktop. */
  environment: EnvironmentRef | null;
  /** The drafts bucket of this desktop ("default" or "env:<id>"). */
  draftKey: string;
}
const ScopeContext = createContext<ScopeValue>({ environment: null, draftKey: DEFAULT_DRAFT_KEY });
export const useDesktopScope = () => useContext(ScopeContext);

/**
 * Point the desktop UI below at one environment (null: the default desktop). With one, the
 * workspace context's api rewrites /api/computer paths and its open() tags computer details with
 * the environment. Keyed by the environment, so switching remounts it (and the stream).
 */
export function DesktopScope({
  environment,
  children,
}: {
  environment: EnvironmentRef | null;
  children: ReactNode;
}) {
  const workspace = useWorkspace();
  const id = environment?.id ?? null;
  const api = useMemo(
    () => (id ? new EnvironmentApi(workspace.api, id) : workspace.api),
    [workspace.api, id],
  );
  const open = useCallback(
    (detail: Detail) =>
      workspace.open(
        detail.type === "computer" && environment
          ? Object.assign({}, detail, { environment })
          : detail,
      ),
    [workspace.open, environment],
  );
  const scoped = useMemo(() => ({ ...workspace, api, open }), [workspace, api, open]);
  const scope = useMemo(
    () => ({ environment, draftKey: environmentDraftKey(environment) }),
    [environment],
  );
  return (
    <ScopeContext.Provider key={id ?? DEFAULT_DRAFT_KEY} value={scope}>
      {id ? (
        <WorkspaceContext.Provider value={scoped}>{children}</WorkspaceContext.Provider>
      ) : (
        children
      )}
    </ScopeContext.Provider>
  );
}

// ---- drafts (computer-drafts.tsx) ----

export type ComputerTab = "Browser" | "Terminal" | "Files" | "Desktop";
interface DesktopDrafts {
  command: string;
  cwd: string;
  path: string;
  editor: FileEditorDraft | undefined;
}
interface ComputerDrafts extends DesktopDrafts {
  tab: ComputerTab;
}
const emptyDesktop: DesktopDrafts = {
  command: "",
  cwd: "/workspace",
  path: "/workspace",
  editor: undefined,
};
// The tab is shared; everything else belongs to one desktop, so an environment's unsent command
// never shows up on another desktop. Never persisted to disk.
let drafts: { tab: ComputerTab; desktops: Record<string, DesktopDrafts> } = {
  tab: "Browser",
  desktops: {},
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => drafts;
const view = (draftKey: string): ComputerDrafts => ({
  tab: drafts.tab,
  ...(drafts.desktops[draftKey] ?? emptyDesktop),
});

/** One draft of the current desktop and its setter, like useState. */
export function useComputerDraft<K extends keyof ComputerDrafts>(
  key: K,
): DraftPair<ComputerDrafts[K]> {
  const { draftKey } = useDesktopScope();
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback(
    (value: SetStateAction<ComputerDrafts[K]>) => {
      const current = view(draftKey);
      const next: ComputerDrafts = {
        ...current,
        [key]:
          typeof value === "function"
            ? (value as (old: ComputerDrafts[K]) => ComputerDrafts[K])(current[key])
            : value,
      };
      if (key === "tab") drafts = { ...drafts, tab: next.tab };
      else {
        const { command, cwd, path, editor } = next;
        drafts = {
          ...drafts,
          desktops: { ...drafts.desktops, [draftKey]: { command, cwd, path, editor } },
        };
      }
      for (const listener of listeners) listener();
    },
    [key, draftKey],
  );
  const value = { tab: state.tab, ...(state.desktops[draftKey] ?? emptyDesktop) }[key];
  return [value as ComputerDrafts[K], set] as const;
}
