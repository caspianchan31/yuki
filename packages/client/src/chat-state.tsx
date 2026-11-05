/**
 * Phase C (docs/web.md): the conversation's state, from chat.tsx, free of React Native so
 * the phone's ChatScreen and the web app's draw the same conversation:
 *   workspaceTools        the frontend tools the chat registers (names and descriptions; each app
 *                         gives its own renderer)
 *   useWorkspaceModelContext  what the model sees of the project (useAgentContext)
 *   ComposerRequests      applies the shell's composer request in the active conversation
 *   useChatSession        one conversation: loading and replaying it, the outbox (queue, hold,
 *                         stop, retry), the speakers, the reports placed in the transcript, and
 *                         who says each item
 * The drawing (input, scrolling, keyboard) stays with each app.
 */
import {
  useAgent,
  useAgentContext,
  useCopilotKit,
  useRenderToolCall,
} from "@copilotkit/react-native/headless";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { taskEnvironmentId } from "../../../packages/domain/src/task-phase.ts";
import { useAgentWorkspace } from "./agent-workspace";
import {
  combineThreadReports,
  isGroupSpeech,
  mergeReports,
  normalizeReports,
  reportsForMember,
  reportsPageSize,
  simpleViewReports,
  type ThreadActivity,
  timelineReports,
} from "./chat-reports-core";
import { useChatReports } from "./chat-reports-state";
import type { JevInteraction } from "./conversation-contexts";
import { ConversationQueue, type QueuedMessage } from "./conversation-queue";
import {
  ConversationTurnError,
  chatErrorKind,
  chatErrorText,
  chatRetryDelayMs,
  replayedRunError,
  replyRetryEvent,
  runConversationTurn,
  showsRunError,
  threadLocked,
  turnErrorText,
} from "./conversation-run";
import { confirmedJevSelection, displayJevUserMessage, latestJevPanelId } from "./jev-actions";
import { connectThread, heldMayResume, lockRefusalAgent } from "./local-thread";
import {
  desktopFold,
  latestNeedReportIds,
  withoutBookkeeping,
  withoutRejectedCalls,
} from "./shell/chat/core";
import {
  conversationSpeaker,
  groupTurns,
  itemSpeaker,
  memberVoice,
  type SpeakerLookup,
} from "./shell/chat/group-core";
import { useIsHall, useOpsName } from "./shell/chat/group-state";
import { chatModelContextDescription, useChatModelContext } from "./shell/chat/ModelContext";
import { memberConversationId } from "./shell/chat/member-thread";
import { chatTurn } from "./shell/chat/turn";
import { messageMoments, normalizeTurns, type TurnTime } from "./shell/chat/turn-time";
import { useShellData } from "./shell/data";
import {
  capReportTasks,
  loadedTaskReports,
  taskIdsForMember,
  taskReportPollMs,
} from "./shell/members/member-detail";
import { groupTranscript } from "./shell/model";
import { useShellNav } from "./shell/nav";
import { useOnScreen, usePoll } from "./shell/poll";
import { t } from "./shell/strings";
import { useSpaceInfo } from "./tenancy-client";
import { useThreadEnvironment } from "./thread-environment";
import { type Selection, useMuseThread } from "./threads-state";
import { useWorkspace } from "./workspace";

export const displayParameters = z.record(z.string(), z.unknown());
/** A message of the conversation (@ag-ui/client's Message, read off the agent so the web build,
 * whose headless entry does not re-export the type, names the same one). */
export type ChatMessage = ReturnType<typeof useAgent>["agent"]["messages"][number];
export type ChatToolMessage = Extract<ChatMessage, { role: "tool" }>;
type Message = ChatMessage;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The frontend tools the chat registers, in order: each app registers these names with these
 * descriptions and its own card. */
export const workspaceTools = [
  { name: "search_mail", description: "Show the agent checking the mailbox" },
  { name: "read_mail_thread", description: "Show the email the agent read" },
  { name: "search_web", description: "Show public web search progress and sources" },
  { name: "browse_web", description: "Follow the agent as it reads a webpage" },
  { name: "use_desktop", description: "Show the agent working on the computer's desktop" },
  // A command that opens the desktop browser is a step of the desktop run.
  { name: "run_computer_command", description: "Show the desktop browser a command opened" },
  { name: "present_choices", description: "Show prepared choices for the conversation" },
  // The card the owner types a credential into, never the chat.
  { name: "request_credential", description: "Show the card where the owner gives a credential" },
  // The task card, once, at the moment of delegation, with a live state.
  { name: "delegate_task", description: "Display delegated work" },
  // The project the 营销总群 made for a request.
  { name: "create_project", description: "Display a project made in the hall" },
  // Whose a hall request is, and why.
  { name: "route_request", description: "Display whose the request is" },
  // The redirected task by its title and state word, never its id.
  { name: "redirect_task", description: "Display which task got the person's new instruction" },
  // The task the person paused or resumed in the chat.
  { name: "pause_task", description: "Display which task the person paused" },
  { name: "resume_task", description: "Display which task the person resumed" },
  { name: "agent_status", description: "Display saved agent progress" },
  { name: "task_events", description: "Display a background task's recent activity" },
  { name: "create_goal", description: "Display a saved goal" },
  { name: "watch_page", description: "Display a saved page watch" },
  { name: "remember_fact", description: "Display saved personal context" },
] as const;
export type WorkspaceToolName = (typeof workspaceTools)[number]["name"];
/** One of the chat's tools: its name and description, for useRenderTool. */
export function workspaceTool(name: WorkspaceToolName): { name: string; description: string } {
  const tool = workspaceTools.find((item) => item.name === name);
  return { name, description: tool?.description ?? "" };
}

/** The model sees the current project, its accounts and a short
 * task summary (no longer the screen name: the workbench is the only page). */
export function useWorkspaceModelContext() {
  const { workspace } = useWorkspace();
  useAgentContext({
    description: chatModelContextDescription,
    value: useChatModelContext(workspace.mode),
  });
}

/** Applies the shell's composer request (「在聊天里派活…」, the
 * empty state) in the active conversation: the text goes into the input (not sent), the
 * operating account switches when one is given, and the input takes focus. */
export function ComposerRequests({
  active,
  onText,
  onSay,
}: {
  active: boolean;
  onText: (text: string) => void;
  onSay: (text: string) => void;
}) {
  const { composer, consumeComposer } = useShellNav();
  const { select } = useThreadEnvironment();
  useEffect(() => {
    if (!active || !composer) return;
    consumeComposer(composer.id);
    // A card's quick saying is said at once, as the person's message.
    if (composer.send) onSay(composer.text);
    else onText(composer.text);
    if (composer.environmentId !== undefined) void select(composer.environmentId).catch(() => {});
  }, [active, composer, consumeComposer, onText, onSay, select]);
  return null;
}

export function useChatSession({
  prompt,
  thread,
  active = true,
  inView = true,
  conversationOnly = false,
  memberId = null,
  roster = false,
}: {
  prompt?: { id: number; text: string };
  thread?: Selection;
  active?: boolean;
  /** The conversation is drawn: false while a page of the web app (进度汇报, 平台管理, 账号…)
   * covers the chat, which stays mounted under it, or at its phone width the properties pane or a
   * panel (they take the whole screen there). Only what is drawn and on screen
   * (`useOnScreen`) is recorded as seen; the rest of the chat goes on as `active` says. */
  inView?: boolean;
  /** The web app's chat places no task
   * report, only the group's speech in the hall (`timelineReports`), and records only those as
   * seen; the 进度汇报 page shows and records the rest. The phone keeps the reports in its chat. */
  conversationOnly?: boolean;
  /** v1.2: when set, the timeline shows this member's task reports. */
  memberId?: string | null;
  /** v1.2 simple view: reports live in the open member's chat, not on a separate page. */
  roster?: boolean;
}) {
  const { api, workspace: w, refresh } = useWorkspace();
  const { data: agentWorkspace, refresh: refreshAgent } = useAgentWorkspace();
  const { enabled: richThreads, claimPrompt, mainId } = useMuseThread();
  const selection = thread || { id: "local", existing: false };
  // v1.2: a member's chat is her own thread. The group's main thread stays where it is.
  const memberThreadId =
    richThreads && roster && memberId && active ? memberConversationId(memberId) : "";
  const threadId = richThreads ? memberThreadId || selection.id : "local-main";
  const knownThread = memberThreadId !== "" || selection.existing;
  const agentId = `openmuse-${threadId}`;
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: "default",
    threadId,
    // v1.2: show each text chunk as it arrives. 0 turns off any provider batching.
    throttleMs: 0,
  });
  const { copilotkit } = useCopilotKit();
  const renderToolCall = useRenderToolCall();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Replayed messages show before connectAgent returns; new turns wait until it does.
  const [syncing, setSyncing] = useState(false);
  const [queue] = useState(() => new ConversationQueue());
  const choiceCompletions = useRef(
    new Map<string, { resolve: () => void; reject: (error: unknown) => void }>(),
  );
  const outbox = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const runLock = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  // A load that failed on the way to the chat service is tried again by itself (`pending` while
  // the next try is scheduled or running, `attempt` for its wait); the line stays meanwhile.
  const loadRetry = useRef({ pending: false, attempt: 0 });
  // Loads still replaying history. A count, so an old load finishing does not end a newer one.
  const replaying = useRef(0);
  // Set while a queued message is being sent, so a lock refusal holds it instead of failing.
  const queuedTurn = useRef(false);
  // A queued message went back on hold because another reply held the
  // conversation (another member's, or one from another device); `since` is the conversation's
  // latest run as the poll had read it then (heldMayResume).
  const heldByLock = useRef<{ since: ThreadActivity | null } | null>(null);
  const latestActivity = useRef<ThreadActivity | null>(null);

  useEffect(() => {
    if (!isReady) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retrying = loadRetry.current.pending;
    loadRetry.current.pending = false;
    if (!retrying) {
      setHistoryError("");
      loadRetry.current.attempt = 0;
    }
    setLoaded(false);
    setSyncing(false);
    const replay = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (active && richThreads && messages.length) setLoaded(true);
      },
    });
    async function hydrate() {
      try {
        if (richThreads) {
          if (knownThread) {
            // Replaying history re-emits past RUN_ERROR events; only connection failures block loading.
            // connectAgent returns once the thread is idle, so it also waits for a reply still
            // running from before a reload. Sending earlier fails with a thread lock.
            replaying.current += 1;
            setSyncing(true);
            try {
              await runConversationTurn(
                agentId,
                // The server replays the whole thread on every connect.
                () => connectThread(copilotkit, agent),
                (onError) => copilotkit.subscribe({ onError }),
                [replayedRunError],
              );
            } finally {
              replaying.current -= 1;
              if (active) setSyncing(false);
            }
          }
        } else {
          const { messages } = await api.request<{ messages: Message[] }>("/api/conversation");
          if (active) agent.setMessages(messages);
        }
        if (active) {
          loadRetry.current.attempt = 0;
          setHistoryError("");
          setLoaded(true);
        }
      } catch (e) {
        if (active) {
          setLoaded(false);
          if (
            e instanceof ConversationTurnError &&
            chatErrorKind({ error: e, code: e.code }) === "transport"
          ) {
            // The chat service did not answer; nothing was lost, so load again after a moment.
            setHistoryError(t.chat.transportRetrying);
            loadRetry.current.pending = true;
            retryTimer = setTimeout(
              () => {
                retryTimer = undefined;
                setHistoryAttempt((attempt) => attempt + 1);
              },
              chatRetryDelayMs(loadRetry.current.attempt++),
            );
          } else setHistoryError(t.chat.loadError(errorText(e)));
        }
      }
    }
    void hydrate();
    return () => {
      active = false;
      // Torn down for another reason (another thread, 重新加载对话) before the next try.
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        loadRetry.current.pending = false;
      }
      replay.unsubscribe();
      if (richThreads) void agent.detachActiveRun().catch(() => {});
    };
  }, [agent, agentId, api, copilotkit, isReady, historyAttempt, richThreads, knownThread]);
  const saveHistory = useCallback(async () => {
    if (!richThreads) await api.request("/api/conversation", { messages: agent.messages }, "PUT");
    setSaveError("");
  }, [agent, api, richThreads]);
  /** Runs one turn; "held" means a queued message was refused by a lock and put back on hold. */
  const run = useCallback(
    async (message?: QueuedMessage): Promise<"held" | undefined> => {
      if (runLock.current || agent.isRunning || !isReady || !loaded || syncing)
        throw new Error(t.chat.notReady);
      runLock.current = true;
      queuedTurn.current = Boolean(message);
      setBusy(true);
      setError("");
      if (message) agent.addMessage({ id: message.id, role: "user", content: message.text });
      try {
        await runConversationTurn(
          agentId,
          () => copilotkit.runAgent({ agent }),
          (onError) => copilotkit.subscribe({ onError }),
          [],
          // A queued message refused by the thread lock (a 409 before the
          // stream) is held below, not reported.
          lockRefusalAgent(agent, Boolean(message)),
        );
        await Promise.all([refresh(), refreshAgent()]);
      } catch (e) {
        if (message && e instanceof ConversationTurnError && e.code === threadLocked) {
          // The server refused the turn before running it (another reply holds the thread),
          // so keep the message unsent and on hold instead of reporting a failed turn.
          agent.setMessages(agent.messages.filter((m) => m.id !== message.id));
          queue.restore(message);
          queue.pause();
          return "held";
        }
        throw e;
      } finally {
        queuedTurn.current = false;
        try {
          await saveHistory();
        } catch (e) {
          queue.pause();
          setSaveError(t.chat.saveError(errorText(e)));
        } finally {
          runLock.current = false;
          setBusy(false);
        }
      }
    },
    [
      agent,
      agentId,
      copilotkit,
      isReady,
      loaded,
      syncing,
      refresh,
      refreshAgent,
      saveHistory,
      queue,
    ],
  );
  const runQueued = useCallback(
    async (message: QueuedMessage) => {
      let held = false;
      try {
        held = (await run(message)) === "held";
        // Sent again by itself once the conversation is free (below).
        if (held) heldByLock.current = { since: latestActivity.current };
        if (!held) choiceCompletions.current.get(message.id)?.resolve();
      } catch (error) {
        choiceCompletions.current.get(message.id)?.reject(error);
        throw error;
      } finally {
        // A held message is sent again later; its choice settles then.
        if (!held) choiceCompletions.current.delete(message.id);
      }
    },
    [run],
  );
  const flush = useCallback(() => {
    if (!loaded || syncing || !isReady || runLock.current || agent.isRunning) return;
    void queue.flush(runQueued).catch((e) => setError(turnErrorText(e)));
  }, [agent, isReady, loaded, syncing, queue, runQueued]);
  const enqueue = useCallback(
    (text: string) => {
      queue.enqueue({ id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
      followLatest.current = true;
      setAwayFromLatest(false);
      flush();
    },
    [queue, flush],
  );
  const sendChoice = useCallback(
    (text: string, retry = false): Promise<void> => {
      const snapshot = queue.getSnapshot();
      if (!loaded || !isReady || saveError || (!retry && snapshot.paused))
        return Promise.reject(new Error(t.chat.choiceNotReady));
      if (retry) {
        if (runLock.current || agent.isRunning || snapshot.running || snapshot.pending.length)
          return Promise.reject(new Error(t.chat.waitForReply));
        if (snapshot.paused) queue.resume();
      }
      const id = `choice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const completion = new Promise<void>((resolve, reject) => {
        choiceCompletions.current.set(id, { resolve, reject });
      });
      queue.enqueue({ id, text });
      followLatest.current = true;
      setAwayFromLatest(false);
      flush();
      return completion;
    },
    [agent.isRunning, flush, isReady, loaded, queue, saveError],
  );
  useEffect(() => {
    if (!busy && !agent.isRunning && outbox.pending.length) flush();
  }, [busy, agent.isRunning, outbox.pending.length, flush]);
  useEffect(() => {
    if (active && prompt && isReady && loaded && claimPrompt(prompt.id) && prompt.text.trim())
      enqueue(prompt.text);
  }, [active, prompt, isReady, loaded, enqueue, claimPrompt]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: (event) => {
        if (event.context?.agentId && event.context.agentId !== agentId) return;
        const during = { replaying: replaying.current > 0, queuedTurn: queuedTurn.current };
        if (!showsRunError(event, during)) return;
        setError(chatErrorText(event));
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, agentId]);
  // The server's one retry of a reply the model service failed mid-way
  // (reply-retry.ts): its CUSTOM event turns the line on, the retry's first event (or the reply's
  // end) turns it off. A replayed history passes through it in one go.
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        const custom = event as { type: string; name?: string };
        setRetrying(custom.type === "CUSTOM" && custom.name === replyRetryEvent);
      },
      onRunFinalized: () => setRetrying(false),
      onRunFailed: () => setRetrying(false),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  async function stop() {
    queue.pause();
    try {
      await copilotkit.stopAgent({ agent });
    } catch (e) {
      setError(t.chat.stopError(errorText(e)));
    }
  }
  /** Sends what the person typed; false when the conversation cannot take it yet (the input
   * keeps the text). */
  function submit(raw: string): boolean {
    const text = raw.trim();
    if (!text || !isReady || !loaded) return false;
    const replyingNow = busy || agent.isRunning;
    const turn = chatTurn(text, replyingNow);
    // v1.2: 停 ends the turn and is not sent. Any other message cuts the running reply off,
    // then takes the next turn once that run has actually stopped.
    if (turn === "stop") {
      void stop();
      return true;
    }
    if (turn === "interrupt") {
      void stop().then(() => {
        queue.resume();
        enqueue(text);
      });
      return true;
    }
    // A new submission can continue after 停. Held messages already waiting still need the
    // explicit resume; a message sent while the stopped run is still winding down is resumed
    // now so it goes out once that run has actually stopped.
    if (!saveError && !queue.getSnapshot().pending.length) queue.resume();
    enqueue(text);
    return true;
  }
  /** Says `text` for the person (a card's quick saying), like a typed message. */
  const say = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (!saveError && !queue.getSnapshot().pending.length) queue.resume();
      enqueue(text);
    },
    [saveError, queue, enqueue],
  );
  /** 重新回复: runs the last turn again, then sends what waits unless it is on hold. */
  function retryResponse() {
    void run()
      .then(() => {
        if (!queue.getSnapshot().paused) flush();
      })
      .catch((e) => setError(turnErrorText(e)));
  }
  function retrySave() {
    void saveHistory().catch((e) => setSaveError(t.chat.saveError(errorText(e))));
  }
  function retryLoad() {
    setHistoryAttempt((attempt) => attempt + 1);
  }
  function removeQueued(id: string) {
    queue.remove(id);
    choiceCompletions.current.get(id)?.reject(new Error(t.chat.choiceRemoved));
    choiceCompletions.current.delete(id);
  }
  function sendQueued() {
    queue.resume();
    flush();
  }
  const messages = agent.messages || [];
  const latestPanelId = latestJevPanelId(messages, threadId);
  const latestUserIndex = messages.reduce(
    (last, message, index) => (message.role === "user" ? index : last),
    -1,
  );
  const latestUserText =
    latestUserIndex >= 0 && typeof messages[latestUserIndex]?.content === "string"
      ? messages[latestUserIndex].content
      : null;
  // The conversation shows no bookkeeping tool card (core.ts
  // `bookkeepingTools`), and no card for a call the runtime refused before running it (the
  // model's arguments did not fit the tool: it reads the refusal and calls again, core.ts
  // `withoutRejectedCalls`); a reply that was only that is silent.
  const resultOf = (callId: string) =>
    messages.find((m) => m.role === "tool" && m.toolCallId === callId)?.content;
  const visible = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => withoutRejectedCalls(withoutBookkeeping(m), resultOf));
  // In a space of two or more members, each message shows who sent it; the
  // names are read again whenever the conversation settles with another message in it.
  // The member count this page read at sign-in can be old (someone joined since), so a
  // conversation with two or more speakers shows them too.
  const spaces = useSpaceInfo();
  const [speakers, setSpeakers] = useState<Record<string, string>>({});
  const severalMembers = spaces.members >= 2 || new Set(Object.values(speakers)).size >= 2;
  const userMessages = messages.filter((m) => m.role === "user").length;
  const settling = busy || agent.isRunning;
  const sharedSpace = spaces.shared;
  useEffect(() => {
    if (!sharedSpace || !richThreads || !loaded || settling || !userMessages) return;
    let live = true;
    api
      .request<{ speakers: Record<string, string> }>(
        `/api/copilotkit/threads/${encodeURIComponent(threadId)}/speakers`,
      )
      .then((result) => {
        if (live) setSpeakers(result.speakers);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sharedSpace, richThreads, loaded, settling, userMessages, threadId, api]);
  // When each turn was had, read from the server so a
  // need's card stands by the moment it was raised, the same on every device and after a reload
  // (guide-core `guidePlacement`). Read again whenever a turn begins or ends, and while one of
  // the person's messages is not recorded yet (just sent, before its run began). Null (no times:
  // every card at the end) without the local thread server or when the read fails.
  const [turnTimes, setTurnTimes] = useState<{
    thread: string;
    turns: TurnTime[] | null;
  } | null>(null);
  const turnsHere = turnTimes?.thread === threadId ? turnTimes : null;
  const unrecorded = useMemo(() => {
    if (!turnsHere?.turns) return false;
    const recorded = new Set(turnsHere.turns.flatMap((turn) => turn.messages));
    return messages.some((m) => m.role === "user" && !recorded.has(m.id));
  }, [turnsHere, messages]);
  const turnsKey = unrecorded ? messages.length : 0;
  useEffect(() => {
    if (!loaded) return;
    if (!richThreads || !userMessages) {
      setTurnTimes({ thread: threadId, turns: null });
      return;
    }
    let live = true;
    api
      .request<unknown>(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/turns`)
      .then((result) => {
        if (live) setTurnTimes({ thread: threadId, turns: normalizeTurns(result) });
      })
      .catch(() => {
        if (live)
          setTurnTimes((held) =>
            held?.thread === threadId ? held : { thread: threadId, turns: null },
          );
      });
    return () => {
      live = false;
    };
  }, [richThreads, loaded, settling, userMessages, turnsKey, threadId, api]);
  const moments = useMemo(
    () => (turnsHere ? messageMoments(messages, turnsHere.turns) : null),
    [turnsHere, messages],
  );
  // A reply's consecutive desktop steps are
  // one block (core.ts `desktopFold`), live while the reply still adds to it.
  const replying = busy || agent.isRunning;
  const fold = useMemo(() => desktopFold(messages), [messages]);
  const replyRetrying = replying && retrying;
  // Background task reports for this thread, placed in the transcript
  // (chat-reports-core.ts). "Show background updates in chat" off hides the cards and keeps
  // them from the model. Reports are recorded as seen only while this thread is on screen and
  // idle (`ThreadReports.markShown`): selected, drawn (no page over it) and on the person's
  // screen (the browser tab shown, the app in the foreground); this effect runs after every
  // render, the store sends the reports due in one request at a time and backs off after a
  // failure.
  const { reports: ownReports, store: reportStore, activity } = useChatReports(threadId, active);
  // Her routine results were filed on the group thread. Read them here without marking them seen,
  // so their place in the group stays put.
  const pullShared = memberThreadId !== "" && mainId !== "" && mainId !== threadId;
  const shared = useChatReports(pullShared ? mainId : threadId, active && pullShared);
  const reports = useMemo(
    () => (pullShared ? combineThreadReports(ownReports, shared.reports) : ownReports),
    [pullShared, ownReports, shared.reports],
  );
  const onScreen = useOnScreen();
  const shellData = useShellData();
  // A result filed on a side chat is not on the group thread. Read her tasks' reports from
  // wherever they were written, and do not mark them seen from here.
  const herTaskIds = useMemo(
    () =>
      memberId
        ? capReportTasks(taskIdsForMember(shellData.tasks, memberId, taskEnvironmentId))
        : [],
    [memberId, shellData.tasks],
  );
  const herTaskKey = herTaskIds.join("\n");
  const [byTask, setByTask] = useState<ReturnType<typeof normalizeReports>>([]);
  const taskReportTicket = useRef(0);
  useEffect(() => {
    taskReportTicket.current += 1;
    if (!memberThreadId || !herTaskKey) setByTask([]);
  }, [memberThreadId, herTaskKey]);
  usePoll(
    async () => {
      const ids = herTaskKey.split("\n").filter(Boolean);
      const mine = ++taskReportTicket.current;
      const pages = await Promise.all(
        ids.map((id) =>
          api
            .request<unknown>(
              `/api/chat-reports?taskId=${encodeURIComponent(id)}&limit=${reportsPageSize}`,
            )
            .then((page) => normalizeReports(page))
            .catch(() => null),
        ),
      );
      if (mine !== taskReportTicket.current) return;
      const loaded = loadedTaskReports(pages);
      if (loaded) setByTask(loaded);
    },
    taskReportPollMs(herTaskIds.length, 5000),
    memberThreadId !== "" && herTaskKey.length > 0,
    herTaskKey,
  );
  const opsName = useOpsName();
  const hall = useIsHall();
  latestActivity.current = activity;
  // A conversation is shared by everyone in the project. The report poll
  // carries its latest run; a run this screen has not seen (another member spoke, or a reply that
  // began elsewhere) is loaded once the conversation is idle, by connecting again.
  const seenRuns = useRef(new Set<string>());
  useEffect(() => {
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event }) => {
        if (event.runId) seenRuns.current.add(event.runId);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  useEffect(() => {
    if (!activity || activity.running) return;
    if (!richThreads || !knownThread || !loaded || syncing || busy || agent.isRunning) return;
    if (outbox.running) return;
    const lastRunId = activity.lastRunId;
    if (lastRunId && !seenRuns.current.has(lastRunId)) {
      seenRuns.current.add(lastRunId);
      setHistoryAttempt((attempt) => attempt + 1);
      return;
    }
    // The reply that held the conversation is over and loaded: send what was held.
    if (
      heldByLock.current &&
      heldMayResume(heldByLock.current.since, activity) &&
      outbox.paused &&
      outbox.pending.length
    ) {
      heldByLock.current = null;
      queue.resume();
      flush();
    }
  }, [
    activity,
    agent.isRunning,
    busy,
    flush,
    loaded,
    outbox.paused,
    outbox.pending.length,
    outbox.running,
    queue,
    richThreads,
    knownThread,
    syncing,
  ]);
  // Off until the agent settings have loaded, so a person who turned the cards off never has
  // reports marked as seen or handed to the model in the moment before. A conversation-only chat
  // has no cards to turn off: the model still gets the reports, the timeline only the group's
  // speech.
  const showReports =
    !!agentWorkspace &&
    (conversationOnly || roster || agentWorkspace.identity.showChatUpdates !== false);
  const placed = useMemo(() => {
    const environmentByTask = new Map(
      shellData.tasks.map((task) => [task.id, taskEnvironmentId(task)]),
    );
    const environmentOf = (taskId: string) => environmentByTask.get(taskId) ?? null;
    const source = byTask.length ? combineThreadReports(reports, byTask) : reports;
    if (roster)
      return simpleViewReports(source, memberId, hall, environmentOf, memberThreadId || null);
    const base = conversationOnly ? timelineReports(source, hall) : source;
    return reportsForMember(base, memberId, environmentOf);
  }, [byTask, conversationOnly, reports, hall, memberId, memberThreadId, roster, shellData.tasks]);
  const shownReports = showReports ? placed : [];
  const transcript = mergeReports(visible, shownReports);
  // Consecutive reports of one task merge into one group; a stop
  // report (a question, a review, a failure) stands alone as a need card.
  const grouped = groupTranscript(transcript);
  // Each item's moment for the need cards placed among them (null for a report); null until the
  // conversation and its times are loaded.
  const timeline =
    loaded && moments
      ? grouped.map((item) =>
          item.type === "message" ? (moments.get(item.message.id) ?? null) : null,
        )
      : null;
  const speakerLookup: SpeakerLookup = {
    ops: opsName,
    accountOfTask: (taskId) => {
      const entry = shellData.entryById.get(taskId);
      return entry?.environmentId ? (shellData.accountById.get(entry.environmentId) ?? null) : null;
    },
  };
  // Who says each item (the person, the
  // project's 运营专员, an account or the founder); the avatar and name on a run's first item.
  // Only the hall reads as a group; a project's own conversation stays the
  // plain chat (its assistant says everything that is not the person's). One
  // name for the assistant everywhere it speaks: 总群助理 in the hall, the project's 运营专员 in a
  // project (`useOpsName`), never the product's name.
  const turns = groupTurns(
    grouped.map((item) => {
      const speaker = itemSpeaker(item, speakerLookup);
      // v1.2 simple view: a project is a group, so each member keeps their own voice.
      // In her own chat, the assistant's words are said by her, not by the group assistant.
      if (roster && memberId) {
        const member = shellData.accountById.get(memberId);
        return memberVoice(speaker, member ? { id: member.id, name: member.name } : null);
      }
      if (roster)
        return speaker.kind === "ops" && !speaker.name ? { kind: "ops", name: opsName } : speaker;
      return conversationSpeaker(speaker, hall, opsName);
    }),
  );
  const latestNeeds = latestNeedReportIds(
    grouped.flatMap((item) => (item.type === "need" ? [item.report] : [])),
  );
  useEffect(() => {
    reportStore.markShown(
      visible,
      { active: active && inView, onScreen, loaded, syncing, replying, shown: showReports },
      conversationOnly ? (report) => hall && isGroupSpeech(report) : undefined,
    );
  });
  const canSend = loaded && isReady;
  /** What a present_choices (or guide) card may do in this conversation now. */
  const jevInteraction: JevInteraction = {
    threadId,
    busy:
      busy ||
      agent.isRunning ||
      !loaded ||
      !isReady ||
      !!outbox.pending.length ||
      outbox.paused ||
      !!saveError,
    latestPanelId,
    latestUserText,
    send: sendChoice,
    retry: (text) => sendChoice(text, true),
    canRetry:
      loaded &&
      isReady &&
      !busy &&
      !agent.isRunning &&
      !outbox.running &&
      !outbox.pending.length &&
      !saveError,
    confirmedSelection: (panelId) => confirmedJevSelection(messages, panelId),
  };
  /** Whether a reply is running, and whether it is the one after the person's latest message
   * (the cards of an earlier turn do not spin). */
  const browserRun = (message: Message) => ({
    running: busy || agent.isRunning,
    active: (busy || agent.isRunning) && messages.indexOf(message) > latestUserIndex,
  });
  /** A message's text as the person reads it (a choice he made reads as his words). */
  const messageText = (message: Message) => {
    const user = message.role === "user";
    return typeof message.content === "string"
      ? user
        ? displayJevUserMessage(
            message.content,
            messages.slice(0, messages.indexOf(message)),
            t.choices,
          )
        : message.content
      : "";
  };
  const queuedText = (text: string) => displayJevUserMessage(text, messages, t.choices);
  /** Recent results (without rich threads): the newest file, live browser and artifacts. */
  const recentResults = {
    any:
      w.files.some((file) => file.parentId) ||
      w.browsers.some((browser) => browser.status === "active") ||
      !!agentWorkspace?.artifacts.length,
    files: w.files
      .filter((file) => file.parentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 1),
    browsers: w.browsers
      .filter((browser) => browser.status === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 1),
    artifacts: [...(agentWorkspace?.artifacts || [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter(
        (artifact, index, items) =>
          items.findIndex((item) => item.kind === artifact.kind) === index,
      )
      .slice(0, 2)
      .reverse(),
  };
  return {
    agent,
    agentId,
    isReady,
    threadId,
    mainId,
    richThreads,
    renderToolCall,
    messages,
    loaded,
    syncing,
    busy,
    replying,
    /** The server is trying the running reply once more (reply-retry.ts): 「服务暂时出错，正在重试…」. */
    retrying: replyRetrying,
    canSend,
    error,
    historyError,
    saveError,
    outbox,
    followLatest,
    awayFromLatest,
    setAwayFromLatest,
    submit,
    say,
    stop,
    retryResponse,
    retrySave,
    retryLoad,
    removeQueued,
    sendQueued,
    transcript,
    grouped,
    turns,
    /** Each item's moment, for the need cards placed among them (guide-state `usePendingGuides`). */
    timeline,
    latestNeeds,
    /** The conversation's desktop steps folded into runs (ChatCards `DesktopStepCard`). */
    fold,
    speakers,
    severalMembers,
    hall,
    /** Who the assistant is in this conversation (总群助理, or the project's 运营专员). */
    assistantName:
      roster && memberId ? (shellData.accountById.get(memberId)?.name ?? opsName) : opsName,
    // Her chat's model sees the same reports as the timeline. The pro view still gets the
    // full list, including cards the timeline folds away.
    reports: roster ? placed : reports,
    showReports,
    jevInteraction,
    browserRun,
    messageText,
    queuedText,
    recentResults,
  };
}
export type ChatSession = ReturnType<typeof useChatSession>;
