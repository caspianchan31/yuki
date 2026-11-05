/**
 * The accounts unit's hooks — the cross-project directory as React
 * state, looking an account up wherever it lives (this project's polled list, the directory, or
 * one fetch), and the account actions every screen shares (move in one or two steps, start /
 * pause the desktop on the person's click, delete, reload one account). Requests always carry the
 * account's own project header (`apiFor(projectId)`); nothing here polls.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ApiError } from "../../api-response";
import { settingsError } from "../../computer-settings";
import { scopeComputerPath } from "../../environments";
import { noContent } from "../../projects-core";
import { useProjects } from "../../projects-state";
import { normalizeTopology } from "../../topology-core";
import { useWorkspace } from "../../workspace";
import { normalizeAccountViews, useShellData } from "../data";
import { type AccountModel, type AccountView, buildAccountModels } from "../model";
import { refusalText, t } from "../strings";
import {
  editorError,
  type MoveOutcome,
  movedTo,
  movePlan,
  projectToRead,
  runMove,
} from "./accounts-core";
import { accountsDirectory } from "./directory";

export const environmentPath = (id: string) => `/api/environments/${encodeURIComponent(id)}`;

/** A request error in the shell's words: a 404 says the account is gone; the missing-key 503 is
 * reworded; every other refusal reads in Chinese (refusalText). */
export function accountErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return t.accountEditor.gone;
  return refusalText(editorError(settingsError(error)));
}

/** A credentials-page request error: a 404 says the credential is gone; every other refusal
 * reads in Chinese (refusalText). */
export function credentialErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return t.credentials.gone;
  return refusalText(settingsError(error));
}

/** The directory as React state: re-renders on every change. */
export function useAccountsDirectory() {
  const version = useSyncExternalStore(
    accountsDirectory.subscribe,
    accountsDirectory.getVersion,
    accountsDirectory.getVersion,
  );
  const reloadToken = useSyncExternalStore(
    accountsDirectory.subscribe,
    accountsDirectory.reloadToken,
    accountsDirectory.reloadToken,
  );
  return { directory: accountsDirectory, version, reloadToken };
}

/** Project names: the live projects, 未分配 for none, 已删除的项目 for an unknown id. */
export function useProjectName() {
  const { projects } = useProjects();
  return useCallback(
    (projectId: string | null) =>
      projectId === null
        ? t.accountsPage.unassigned
        : (projects.find((project) => project.id === projectId)?.name ??
          t.accountsPage.unknownProject),
    [projects],
  );
}

export interface AccountLookup {
  /** The account row model: with 此刻 / tasks / reports when it is in the current project. */
  model: AccountModel | null;
  /** The account is in the project on screen (its tasks and reports are known here). */
  isCurrent: boolean;
  loading: boolean;
  error: string;
}

/**
 * One account wherever it lives: this project's polled list (with tasks and reports), else the
 * directory (another project or 未分配), else one fetch (topology → its project → the view).
 */
export function useAccountLookup(environmentId: string): AccountLookup {
  const data = useShellData();
  const { current } = useProjects();
  const { directory, version } = useAccountsDirectory();
  const local = data.accountById.get(environmentId) ?? null;
  const [loading, setLoading] = useState(() => !local && !accountsDirectory.get(environmentId));
  const [error, setError] = useState("");
  // `version` re-reads the directory.
  const cached = useMemo(
    () => directory.get(environmentId) ?? null,
    [directory, environmentId, version],
  );
  const { apiFor, now } = data;

  const fetchOne = useCallback(
    async (projectId: string | null | undefined) => {
      let project = projectId;
      if (project === undefined) {
        const topology = normalizeTopology(await apiFor(current).request<unknown>("/api/topology"));
        directory.setTopology(topology);
        // Not in this project's topology: an account in no project (the founder) is read in 未分组.
        project = projectToRead(
          topology.environments.find((item) => item.id === environmentId),
          current,
        );
        if (project === undefined) throw new ApiError(t.accountDetail.gone, 404);
      }
      const [view] = normalizeAccountViews([
        await apiFor(project).request<unknown>(environmentPath(environmentId)),
      ]);
      if (!view) throw new ApiError(t.accountDetail.gone, 404);
      directory.put(view);
    },
    [apiFor, current, directory, environmentId],
  );
  // Deleted from this client: gone, and never read again (its detail closes on the delete).
  const removed = useMemo(
    () => directory.wasRemoved(environmentId),
    [directory, environmentId, version],
  );
  // Not known anywhere: one fetch (topology → its project → the view). Again whenever it turns
  // unknown later, e.g. it left this project's polled list by a move this screen did not record.
  const unknown = !local && !cached && !removed;
  useEffect(() => {
    if (!unknown) return;
    let active = true;
    setLoading(true);
    setError("");
    fetchOne(undefined)
      .catch((e) => {
        if (active) setError(accountErrorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // Only when the account turns unknown (or the id changes), not on every new fetchOne.
  }, [environmentId, unknown]);

  const model = useMemo(() => {
    if (removed) return null;
    if (local && (!cached || (cached.projectId ?? null) === (local.projectId ?? null)))
      return local;
    const view: AccountView | null = cached ?? local?.view ?? null;
    if (!view) return null;
    const mine = (view.projectId ?? null) === (current ?? null);
    return (
      buildAccountModels({
        accounts: [view],
        entries: mine ? data.entries : [],
        now,
      })[0] ?? null
    );
  }, [removed, local, cached, current, data.entries, data.reports.value, now]);
  return {
    model,
    isCurrent: !!model && (model.projectId ?? null) === (current ?? null),
    // Unknown and not failed: the fetch above is starting (its effect runs after this render),
    // so the account is loading, not gone (a moved account left the polled list a moment ago).
    loading: !removed && (loading || (unknown && !error)),
    error,
  };
}

/** The account actions shared by the detail, the assign panel, the join panel and the page. */
export function useAccountOps() {
  const data = useShellData();
  const projects = useProjects();
  const { notify } = useWorkspace();
  const { apiFor, refreshAll, accountById, forgetAccount } = data;
  const unassignedViews = data.unassigned.value;
  const projectName = useProjectName();

  /** After any change: this project's data, the project list counts, an open page. */
  const afterChange = useCallback(async () => {
    accountsDirectory.requestReload();
    await Promise.allSettled([refreshAll(), projects.refresh(), data.unassigned.refresh()]);
  }, [refreshAll, projects, data.unassigned]);

  /** Records a move another screen made with its own PATCHes (the group's 加成员, 新建群), so
   * an open member card or a delete does not act on the project she was in before. */
  const recordMove = useCallback(
    (id: string, to: string | null) => {
      const known =
        accountsDirectory.get(id) ??
        accountById.get(id)?.view ??
        unassignedViews.find((view) => view.id === id);
      accountsDirectory.move(id, to, known);
    },
    [accountById, unassignedViews],
  );

  /** Move `id` from `from` to `to` with the existing PATCHes (two when across projects). */
  const move = useCallback(
    async (
      id: string,
      from: string | null,
      to: string | null,
      /** The toast after a finished move (the join panel says 已加入). */
      done?: string,
    ): Promise<MoveOutcome> => {
      const steps = movePlan(from, to);
      // The view this screen knows: an account of this project opened from the rail is in the
      // polled list only, and leaves it with the move.
      const known =
        accountsDirectory.get(id) ??
        accountById.get(id)?.view ??
        unassignedViews.find((view) => view.id === id);
      const outcome = await runMove(
        steps,
        (step) =>
          apiFor(step.header).request<unknown>(
            environmentPath(id),
            { projectId: step.projectId },
            "PATCH",
          ),
        accountErrorText,
      );
      const landed = movedTo(outcome, to);
      if (landed !== undefined) accountsDirectory.move(id, landed, known);
      if (outcome.state === "done") {
        notify(
          done ??
            (to === null
              ? t.assign.unassigned
              : from === null
                ? t.assign.assigned(projectName(to))
                : t.assign.movedBoth(projectName(to))),
        );
        // The directory already knows where it went: the lists catch up in the background, so
        // the panel moves on with the toast instead of saying 正在移动… after it.
        void afterChange();
      } else if (outcome.state === "stuck") await afterChange();
      return outcome;
    },
    [apiFor, accountById, unassignedViews, afterChange, notify, projectName],
  );

  /** POST …/computer/start|stop — only ever on the person's click. */
  const setDesktop = useCallback(
    async (id: string, projectId: string | null, action: "start" | "stop") => {
      await apiFor(projectId).request<unknown>(
        scopeComputerPath(`/api/computer/${action}`, id),
        {},
      );
      notify(action === "start" ? t.accountDetail.started : t.accountDetail.stopped);
      try {
        const [view] = normalizeAccountViews([
          await apiFor(projectId).request<unknown>(environmentPath(id)),
        ]);
        if (view) accountsDirectory.put(view);
      } catch {
        // The list refresh below says what it can.
      }
      await afterChange();
    },
    [apiFor, afterChange, notify],
  );

  /**
   * DELETE /api/environments/:id (204). `onGone` runs as soon as the server confirms it (the open
   * detail closes then, with the toast 「账号已删除」), before the account leaves this client's
   * lists; the lists, counts and an open page catch up in the background, never in front of it.
   */
  const remove = useCallback(
    async (id: string, projectId: string | null, onGone?: () => void) => {
      await noContent(apiFor(projectId).request<unknown>(environmentPath(id), undefined, "DELETE"));
      onGone?.();
      forgetAccount(id);
      accountsDirectory.remove(id);
      notify(t.accountDetail.removed);
      void afterChange();
    },
    [apiFor, afterChange, notify, forgetAccount],
  );

  return { move, recordMove, setDesktop, remove, afterChange, projectName };
}
