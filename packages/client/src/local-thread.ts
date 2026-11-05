// Connecting to a conversation stored on this server.

/** What connectThread needs from the agent (an @ag-ui/client AbstractAgent). */
export interface ResettableAgent {
  setMessages(messages: []): void;
  setState(state: Record<string, never>): void;
}

/**
 * Connects the agent to its thread, as `copilotkit.connectAgent({ agent })`. The server replays
 * the whole thread on every connect (there is no replay cursor), while CopilotKit clears the agent
 * only on the first connect to a thread. A second connect (Retry after a failed load, opening the
 * thread again, or loading what another member just said) would append the replay to the messages
 * already shown, doubling them, so the agent is cleared first.
 */
export function connectThread<A extends ResettableAgent, R>(
  copilotkit: { connectAgent(input: { agent: A }): Promise<R> },
  agent: A,
): Promise<R> {
  agent.setMessages([]);
  agent.setState({});
  return copilotkit.connectAgent({ agent });
}

/**
 * The agent whose thread-lock refusal a turn claims (runConversationTurn's holdOnLock): only for
 * a queued message, which goes back on hold when another reply holds the thread.
 */
export function lockRefusalAgent<A>(agent: A, queued: boolean) {
  return queued ? agent : undefined;
}

/** A conversation's latest run as the report poll last read it (chat-reports-core's
 * ThreadActivity). */
export interface RunActivity {
  lastRunId: string | null;
  running: boolean;
}

/**
 * Whether a message held by the thread lock may be sent again now. `since` is the poll's reading
 * when it was held: that reading may predate the reply that holds the thread, so the message waits
 * for a reading taken after it (another run, or the same run now over) that shows nothing running.
 * Sending again on the old reading is refused at once and held again, over and over.
 */
export function heldMayResume(since: RunActivity | null, now: RunActivity | null): boolean {
  if (!now || now.running) return false;
  return !since || since.running || since.lastRunId !== now.lastRunId;
}

/** A conversation the page shows or has shown (ThreadsProvider). */
export interface ThreadSelection {
  id: string;
  existing: boolean;
}

/**
 * The project's main chat moved from `former` to `next` (this page's 开新主聊天, or another
 * member's, read by the main-chat poll). The conversation on screen follows the main chat when it
 * was the former one, so nobody keeps talking into the archived chat; an open side chat stays.
 */
export function followMainSelection(
  selection: ThreadSelection,
  former: string,
  next: string,
): ThreadSelection {
  return selection.id === former ? { id: next, existing: true } : selection;
}
/** The visited conversations after the main chat moved to `next`: it leads; the former main chat
 * stays (an archived side chat now). */
export function followMainVisited(visited: ThreadSelection[], next: string): ThreadSelection[] {
  return [{ id: next, existing: true }, ...visited.filter((item) => item.id !== next)];
}
