/**
 * Phase C (docs/web.md): the web app's root, the same order as the phone's App.tsx:
 * public pages (the tenancy port: invite link, sign-up, its status, a password reset link, 官网) →
 * sign-in → space (the tenancy port) → project list → the workspace of the chosen project (CopilotKit runtime, snapshot, shell data) →
 * the shell.
 * Everything above the shell is the phone's shared logic; only the drawing is the web's.
 */

import { AgentWorkspaceProvider } from "@m/agent-workspace";
import { API_URL, MuseApi } from "@m/api";
import { projectHeaders, spaceHeaders } from "@m/api-client";
import { readLastSeen, writeLastSeen } from "@m/last-seen";
import { lastSeenStorage, scopeOf } from "@m/last-seen-store";
import { projectKey } from "@m/projects-core";
import { ProjectsProvider, useProjects } from "@m/projects-state";
import { OverviewProvider, ShellDataProvider } from "@m/shell/data";
import { useClosePanel } from "@m/shell/layout";
import {
  carriedNoticeText,
  clearCarriedNotice,
  railSectionForLegacy,
  routeDetail,
  ShellNavProvider,
  useShellNav,
} from "@m/shell/nav";
import { useRetryWhile } from "@m/shell/poll";
import { serverText, t } from "@m/shell/strings";
import { ThreadsProvider } from "@m/threads-state";
import { type Detail, WorkspaceContext, type WorkspaceContextValue } from "@m/workspace";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { Section, Workspace } from "../../../packages/domain/src";
import { loadAccountZone } from "./account-zone";
import { AuthGate } from "./gate/AuthGate";
import { Centered } from "./gate/Centered";
import { CopilotKitProvider } from "./platform/copilotkit-headless";
import { Shell } from "./shell/Shell";
import { setFrame } from "./shell/state";
import { useTenancyUi } from "./tenancy-ui";
import { Btn, Skeleton, Spinner } from "./ui/primitives";

document.documentElement.lang = t.app.lang;

/** The multi-tenant layer (when there is one) shows the public pages (官网, sign-up, an invite, a
 * reset link) before sign-in and opens a space after it: the tenancy port's PublicRoutes and Gate
 * (tenancy-ui.tsx). Without one this is the sign-in and then the project list. */
export function App() {
  const ui = useTenancyUi();
  return (
    <ui.PublicRoutes fallback={<Opening />}>
      {({ signInAs }) => (
        <AuthGate username={signInAs}>
          {(session) => (
            <ui.Gate token={session.token}>
              <ProjectsProvider token={session.token}>
                <OverviewProvider token={session.token}>
                  <ProjectedWorkspace token={session.token} />
                </OverviewProvider>
              </ProjectsProvider>
            </ui.Gate>
          )}
        </AuthGate>
      )}
    </ui.PublicRoutes>
  );
}

function Opening({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  // While a workspace opens (first load, a project switch) the frame keeps its shape.
  if (!error)
    return (
      <div className="app no-pane opening-frame" aria-busy="true">
        <aside className="sidebar">
          <div className="sb-sec">
            <Skeleton lines={5} />
          </div>
        </aside>
        <main className="main">
          <div className="topbar" />
          <div className="content">
            <div className="col">
              <Skeleton lines={6} />
            </div>
          </div>
        </main>
        <aside className="pane" />
      </div>
    );
  return (
    <Centered>
      {error ? (
        <>
          <p className="err">{serverText(error)}</p>
          {onRetry ? <Btn onClick={onRetry}>{t.app.retry}</Btn> : null}
        </>
      ) : (
        <Spinner label={t.app.opening} />
      )}
    </Centered>
  );
}

// The chat runtime and the API carry the current project's header, and the whole workspace is
// keyed by the project, so a switch remounts every screen, thread and poller.
function ProjectedWorkspace({ token }: { token: string }) {
  const { current, ready } = useProjects();
  if (!ready) return <Opening />;
  const key = projectKey(current);
  return (
    <CopilotKitProvider
      key={key}
      runtimeUrl={`${API_URL}/api/copilotkit`}
      headers={{ Authorization: `Bearer ${token}`, ...spaceHeaders(), ...projectHeaders(current) }}
      defaultThrottleMs={0}
    >
      <WorkspaceApp key={key} token={token} projectId={current} />
    </CopilotKitProvider>
  );
}

function WorkspaceApp({ token, projectId }: { token: string; projectId: string | null }) {
  const api = useMemo(() => new MuseApi(token, projectId), [token, projectId]);
  // The workspace this browser last read opens the shell at once; the server's replaces it.
  const [workspace, setWorkspace] = useState<Workspace | undefined>(() =>
    readLastSeen<Workspace>(lastSeenStorage(), scopeOf(api), "workspace"),
  );
  const [toast, setToast] = useState(carriedNoticeText);
  useEffect(clearCarriedNotice, []);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    const snapshot = await api.request<Workspace>("/api/workspace");
    setWorkspace(snapshot);
    writeLastSeen(lastSeenStorage(), scopeOf(api), "workspace", snapshot);
    setError("");
  }, [api]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void refresh().catch((e) => setError(String(e)));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  const retry = useCallback(async () => {
    try {
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, [refresh]);
  useRetryWhile(!!error, retry);
  const shown = !!workspace;
  const live = workspace?.mode === "live";
  useEffect(() => {
    if (live) void loadAccountZone(api);
  }, [live, api]);
  useEffect(() => {
    if (!toast || !shown) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast, shown]);
  const ask = useCallback((text: string) => setPrompt({ id: Date.now(), text }), []);
  const clearToast = useCallback(() => setToast(""), []);
  if (!workspace)
    return (
      <Opening
        error={error || undefined}
        onRetry={() => void refresh().catch((e) => setError(String(e)))}
      />
    );
  return (
    <ShellNavProvider>
      <WorkspaceBridge
        workspace={workspace}
        api={api}
        refresh={refresh}
        notify={setToast}
        ask={ask}
      >
        <AgentWorkspaceProvider>
          <ThreadsProvider>
            <ShellDataProvider>
              <Shell toast={toast} clearToast={clearToast} error={error} prompt={prompt} />
            </ShellDataProvider>
          </ThreadsProvider>
        </AgentWorkspaceProvider>
      </WorkspaceBridge>
    </ShellNavProvider>
  );
}

/** The WorkspaceContext the shared code reads, wired to the shell (as on the phone). */
function WorkspaceBridge({
  workspace,
  api,
  refresh,
  notify,
  ask,
  children,
}: Pick<WorkspaceContextValue, "workspace" | "api" | "refresh" | "notify" | "ask"> & {
  children: ReactNode;
}) {
  const { openPanel, closePanel, setView, openDrawer } = useShellNav();
  const close = useClosePanel();
  const open = useCallback(
    (detail: Detail) => {
      const route = routeDetail(detail);
      // The accounts page is gone from the web app: the roster is the list of members.
      if (route.view) {
        closePanel();
        setView(route.view === "accounts" ? "work" : route.view);
      }
      if (route.panel) openPanel(route.panel);
    },
    [openPanel, closePanel, setView],
  );
  const navigate = useCallback(
    (section: Section) => {
      closePanel();
      setView("work");
      if (section === "environments") return setFrame({ drawer: true });
      const target = railSectionForLegacy(section);
      if (target) openDrawer(target);
    },
    [closePanel, setView, openDrawer],
  );
  const askInChat = useCallback(
    (text: string) => {
      closePanel();
      setView("work");
      ask(text);
    },
    [ask, closePanel, setView],
  );
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace,
      api,
      section: "chat",
      navigate,
      refresh,
      open,
      close,
      notify,
      ask: askInChat,
    }),
    [workspace, api, navigate, refresh, open, close, notify, askInChat],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
