/** The line above the chat while conversations from before v0.5 are still
 * in CopilotKit's cloud (workspace runtime.cloudThreads); null when there is nothing to say. */
import type { Workspace } from "../../../../../packages/domain/src";
import { t } from "../strings";

export function cloudThreadsText(fact: Workspace["runtime"]["cloudThreads"]): string | null {
  if (!fact) return null;
  return fact.state === "no-key"
    ? t.cloudThreads.noKey
    : t.cloudThreads.failed(fact.pending, fact.reason);
}
