/**
 * The report-back state of chat-reports.tsx without React Native:
 * useChatReports polls a thread's reports, ReportsModelContext hands them to the chat model. The
 * single report card stays in chat-reports.tsx.
 */
import { useCopilotKit } from "@copilotkit/react-native/headless";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { ChatReport } from "../../../packages/domain/src/agent";
import { reportsContext, ThreadReports } from "./chat-reports-core";
import { withoutWaitCards } from "./shell/chat/core";
import { usePoll } from "./shell/poll";
import { useWorkspace } from "./workspace";

const pollMs = 5000;

/** The reports of one conversation thread: loaded on mount (newest `reportsKept`), then polled
 * every few seconds while `active` and the app is visible. `store.markShown` records where
 * reports are first shown. The cards a wait wrote before waits stopped being reports are left
 * out of what the chat shows and hands its model (fork, report line). */
export function useChatReports(threadId: string, active: boolean) {
  const { api } = useWorkspace();
  const store = useMemo(
    () => new ThreadReports(threadId, (path, body) => api.request(path, body)),
    [api, threadId],
  );
  const held = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // The conversation's latest run, carried by the same poll.
  const activity = useSyncExternalStore(store.subscribe, store.getActivity, store.getActivity);
  const reports = useMemo(() => withoutWaitCards(held), [held]);
  // The shared poller (shell/poll.ts) while the thread is on screen.
  usePoll(() => store.refresh(), pollMs, active, store);
  return { reports, store, activity };
}

/** Gives this conversation's chat model runs its latest reports. The entry is scoped to the
 * conversation's agent (`reportsContext`), because agent context is otherwise shared by every
 * conversation the app keeps mounted. */
export function ReportsModelContext({
  agentId,
  reports,
  shown,
}: {
  agentId: string;
  reports: ChatReport[];
  shown: boolean;
}) {
  const { copilotkit } = useCopilotKit();
  const context = useMemo(() => reportsContext(agentId, reports, shown), [agentId, reports, shown]);
  useLayoutEffect(() => {
    if (!copilotkit || !context) return;
    const id = copilotkit.addContext(context);
    return () => copilotkit.removeContext(id);
  }, [copilotkit, context]);
  return null;
}
