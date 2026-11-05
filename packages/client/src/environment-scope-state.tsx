/**
 * Phase C (docs/web.md): the desktop scope of the computer UI, from environment-scope.tsx,
 * free of React Native so the web app scopes its desktop cards and sheets the same way.
 * Isolation environments (fork feature): point the existing computer UI at one environment's
 * desktop. Every /api/computer call made through the scoped MuseApi is rewritten to
 * /api/environments/<id>/computer..., so ComputerSheet, LinuxWorkspace, DesktopStream and the
 * desktop tool card work unchanged inside an EnvironmentScope.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { MuseApi } from "./api";
import {
  DEFAULT_DRAFT_KEY,
  DELETED_SELECTION_NOTICE,
  type EnvironmentRef,
  environmentDraftKey,
  scopeComputerPath,
} from "./environments";
import { useThreadEnvironment } from "./thread-environment";
import { type Detail, useWorkspace, WorkspaceContext } from "./workspace";

/** A MuseApi whose /api/computer calls go to one environment's desktop. */
export class EnvironmentApi extends MuseApi {
  constructor(
    base: MuseApi,
    readonly environmentId: string,
  ) {
    // Keep the base client's project, so the environment's desktop calls stay
    // in the same project.
    super(base.token, base.projectId);
  }
  override request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    return super.request<T>(scopeComputerPath(path, this.environmentId), body, method);
  }
  override url(path: string) {
    return super.url(scopeComputerPath(path, this.environmentId));
  }
}

export interface EnvironmentContextValue {
  /** The environment this subtree shows; null is the default desktop. */
  environment: EnvironmentRef | null;
  /** The ComputerDraftProvider bucket for this desktop ("default" or "env:<id>"). */
  draftKey: string;
}
const defaultScope: EnvironmentContextValue = { environment: null, draftKey: DEFAULT_DRAFT_KEY };
export const EnvironmentContext = createContext<EnvironmentContextValue>(defaultScope);
/** The enclosing desktop scope; outside any EnvironmentScope it is the default desktop. */
export function useEnvironmentContext() {
  return useContext(EnvironmentContext);
}

/**
 * Scope the computer UI below to one environment. With an environment, the workspace context
 * is replaced by one whose api rewrites /api/computer paths and whose open() tags computer
 * details with the environment; with null, children render against the default desktop. The
 * subtree is keyed by environment id, so switching remounts it (and reconnects the VNC stream).
 */
export function EnvironmentScope({
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
    <EnvironmentContext.Provider key={id ?? DEFAULT_DRAFT_KEY} value={scope}>
      {id ? (
        <WorkspaceContext.Provider value={scoped}>{children}</WorkspaceContext.Provider>
      ) : (
        children
      )}
    </EnvironmentContext.Provider>
  );
}

const LOADING_NOTICE =
  "The conversation's desktop is still being looked up. Try again in a moment.";

/**
 * While the thread's desktop is unknown or deleted, opening the computer sheet from below
 * would show the default desktop (or a deleted environment's); say why instead.
 */
export function HoldComputerOpen({
  reason,
  children,
}: {
  reason: string | null;
  children: ReactNode;
}) {
  const workspace = useWorkspace();
  const held = useMemo(
    () => ({
      ...workspace,
      open: (detail: Detail) =>
        detail.type === "computer" && reason ? workspace.notify(reason) : workspace.open(detail),
    }),
    [workspace, reason],
  );
  return reason ? (
    <WorkspaceContext.Provider value={held}>{children}</WorkspaceContext.Provider>
  ) : (
    children
  );
}

/** Why the conversation's desktop card may not poll or open the computer now (its desktop is
 * still being looked up, or names a deleted environment); null when it may. */
export function useDesktopHoldReason(): string | null {
  const { loading, stale } = useThreadEnvironment();
  return stale ? `${DELETED_SELECTION_NOTICE}.` : loading ? LOADING_NOTICE : null;
}

/** The environment the conversation's computer tools use (null: the default desktop). */
export function useThreadEnvironmentScope() {
  return useThreadEnvironment().environment;
}
