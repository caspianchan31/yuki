/**
 * The task actions every surface shares (rail rows, chat task and need
 * cards, task detail). Existing endpoints only; nothing here adds an approval step:
 *   POST  /api/agent/tasks/:id/control  { action: pause | resume | cancel | retry | run }
 *   POST  /api/agent/tasks/:id/input    { answer, fields? }
 *   PATCH /api/agent/tasks/:id          { repeatMinutes: number | null }
 * Acting on a need (answer, retry, continue now) records a one-line receipt in the shell
 * navigation, so the chat card and the rail collapse together (design §5.4).
 */
import { useCallback, useState } from "react";
import { useAgentWorkspace } from "../agent-workspace";
import { useWorkspace } from "../workspace";
import { useShellNav } from "./nav";
import { t } from "./strings";

export type ControlAction = "pause" | "resume" | "cancel" | "retry" | "run";

export interface TaskActions {
  /** The task id and action in flight, if any. */
  busy: { taskId: string; action: string } | null;
  error: { taskId: string; message: string } | null;
  control: (
    taskId: string,
    action: ControlAction,
    options?: { inWait?: boolean },
  ) => Promise<boolean>;
  answer: (
    taskId: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) => Promise<boolean>;
  setRepeat: (taskId: string, repeatMinutes: number | null) => Promise<boolean>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The task's `updatedAt` in the server's answer to an act (the receipt's `since`). */
const serverStamp = (result: unknown): string | undefined => {
  const value =
    result && typeof result === "object" ? (result as { updatedAt?: unknown }).updatedAt : null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
};

export function useTaskActions(): TaskActions {
  const { mutate, refresh } = useAgentWorkspace();
  const { api } = useWorkspace();
  const nav = useShellNav();
  const [busy, setBusy] = useState<TaskActions["busy"]>(null);
  const [error, setError] = useState<TaskActions["error"]>(null);
  const run = useCallback(
    async (taskId: string, action: string, work: () => Promise<unknown>, receipt?: string) => {
      setBusy({ taskId, action });
      setError(null);
      try {
        const result = await work();
        if (receipt) nav.addReceipt(taskId, receipt, serverStamp(result));
        return true;
      } catch (e) {
        setError({ taskId, message: message(e) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [nav],
  );
  const control = useCallback(
    (taskId: string, action: ControlAction, options: { inWait?: boolean } = {}) =>
      run(
        taskId,
        action,
        () => mutate(`/tasks/${encodeURIComponent(taskId)}/control`, { action }),
        action === "retry"
          ? t.needs.receiptRetried
          : action === "run" && options.inWait
            ? t.needs.receiptContinued
            : undefined,
      ),
    [mutate, run],
  );
  const answer = useCallback(
    (taskId: string, text: string, fields?: Record<string, string | boolean>) =>
      run(
        taskId,
        "input",
        () =>
          mutate(`/tasks/${encodeURIComponent(taskId)}/input`, {
            answer: text,
            ...(fields && Object.keys(fields).length ? { fields } : {}),
          }),
        t.needs.receiptAnswered,
      ),
    [mutate, run],
  );
  const setRepeat = useCallback(
    (taskId: string, repeatMinutes: number | null) =>
      run(taskId, "repeat", async () => {
        await api.request(
          `/api/agent/tasks/${encodeURIComponent(taskId)}`,
          { repeatMinutes },
          "PATCH",
        );
        await refresh().catch(() => {});
      }),
    [api, refresh, run],
  );
  return { busy, error, control, answer, setRepeat };
}
