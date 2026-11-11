/**
 * Phase C (docs/web.md): one conversation drawn as the prototype's block timeline, from
 * chat.tsx's ChatScreen. Its state is chat-state.tsx's useChatSession (shared with the phone):
 * loading and replaying, the outbox, stop and retry, and who says each item. Here: the member
 * needs, day dividers, a block per item (the person's own messages on the right), the guide
 * cards, the running line, the errors with their retries, 回到最新, and the composer pinned at
 * the bottom. Reports, questions and failures of the tasks stay in the timeline.
 */

import { assistantMarkdown } from "@m/assistant-markdown";
import { useAuth } from "@m/auth-state";
import { isHandoffNotice } from "@m/chat-reports-core";
import { ReportsModelContext } from "@m/chat-reports-state";
import {
  type ChatSession,
  ComposerRequests,
  type ChatMessage as Message,
  type ChatToolMessage as ToolMessage,
  useChatSession,
} from "@m/chat-state";
import { localTime } from "@m/conversation-run";
import { isComposingKey } from "@m/ime";
import { useModelState } from "@m/model-state";
import { useProjects } from "@m/projects-state";
import { normalizeAccountOperating } from "@m/shell/accounts/operating-core";
import { latestNeedReportIds } from "@m/shell/chat/core";
import { scrollIntent } from "@m/shell/chat/follow-latest";
import { type GroupTurn, inGroupChat, missingGroupRef } from "@m/shell/chat/group-core";
import { routineCreatedLine } from "@m/shell/chat/handoff";
import {
  desktopForOpenMember,
  memberDesktopReady,
  shouldPinMemberDesktop,
} from "@m/shell/chat/member-desktop";
import { memberConversationId } from "@m/shell/chat/member-thread";
import { isResultTool, splitToolCalls } from "@m/shell/chat/reply-core";
import type { SupersededSegment } from "@m/shell/chat/superseded-core";
import { useShellData } from "@m/shell/data";
import {
  appsToConnect,
  clockZoneNote,
  dropGuidedAccountNeeds,
  goalRoutines,
  memberRoutines,
  needsForMember,
  newestReportSentence,
  queuedClockWake,
  usageDayLabel,
} from "@m/shell/members/member-detail";
import { needReportLabels } from "@m/shell/model";
import { phaseWords, t } from "@m/shell/strings";
import { ThreadEnvironmentProvider, useThreadEnvironment } from "@m/thread-environment";
import type { Selection } from "@m/threads-state";
import { useWorkspace } from "@m/workspace";
import {
  ArrowDown,
  Check,
  Copy,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  attachmentsOf,
  deliveredPaths,
  generatedImages,
  messageText as rawMessageText,
} from "../../../../packages/domain/src/chat-attachments";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { useAccountZone } from "../account-zone";
import { setFrame, useFrame } from "../shell/state";
import { copyToClipboard } from "../ui/clipboard";
import { Markdown } from "../ui/Markdown";
import { Btn, ErrorLine, Skeleton } from "../ui/primitives";
import { AttachmentCard, DeliveredCard } from "./AttachmentCards";
import { NoticeBlock } from "./ChatCards";
import { Composer } from "./Composer";
import { BrowserRunContext, DesktopFoldContext, InGroup, JevInteractionContext } from "./context";
import { ChatEmptyState } from "./EmptyState";
import { MemberNeeds, needEnvironment } from "./MemberNeeds";
import { NeedBlock } from "./NeedBlock";
import { Block } from "./parts";
import { ReportGroupBlock } from "./ReportBlock";
import { ArtifactCard, BrowserThreadCard, FileThreadCard } from "./results";

export function ChatScreen({
  prompt,
  thread,
  active = true,
  inView,
}: {
  prompt?: { id: number; text: string };
  thread?: Selection;
  active?: boolean;
  /** Nothing covers the chat: no page, and at the phone layout's width no pane or panel
   * (ChatArea's `inView`). */
  inView: boolean;
}) {
  const frame = useFrame();
  // Reports, questions and reviews stay in the chat. With a member open, only that member's
  // task reports stay.
  const [pinFailed, setPinFailed] = useState(false);
  useEffect(() => {
    setPinFailed(false);
  }, [frame.peek]);
  const chat = useChatSession({
    prompt,
    thread,
    active,
    inView,
    memberId: frame.peek,
    roster: true,
  });
  // Which desktop this thread's computer tools use; the 「操作账号」 chip
  // above the input shows and changes it, and hides itself when the server has no environments.
  return (
    <ThreadEnvironmentProvider
      threadId={chat.threadId}
      messages={chat.messages}
      running={chat.replying}
    >
      <PinMemberDesktop
        accountId={
          frame.peek && chat.threadId === memberConversationId(frame.peek) ? frame.peek : null
        }
        onFailed={setPinFailed}
      />
      <ReportsModelContext agentId={chat.agentId} reports={chat.reports} shown={chat.showReports} />
      <Conversation chat={chat} active={active} pinFailed={pinFailed} />
    </ThreadEnvironmentProvider>
  );
}

/** The member's own thread drives her desktop, not the group's. */
function PinMemberDesktop({
  accountId,
  onFailed,
}: {
  accountId: string | null;
  onFailed: (failed: boolean) => void;
}) {
  const env = useThreadEnvironment();
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (
      !accountId ||
      !shouldPinMemberDesktop({
        accountId,
        environmentId: env.environment?.id ?? null,
        loading: env.loading,
        unavailable: env.unavailable,
        stale: env.stale,
        tried: tried.current,
      })
    )
      return;
    tried.current = accountId;
    void env.select(accountId).then(
      () => onFailed(false),
      () => onFailed(true),
    );
  }, [
    accountId,
    env.environment?.id,
    env.loading,
    env.select,
    env.stale,
    env.unavailable,
    onFailed,
  ]);
  return null;
}

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
/** 今天 / 昨天 / 10月16日 for the divider above a day's first dated block. */
function dayLabel(iso: string, now: Date | number): { key: string; label: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const today = new Date(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = dayKey(at);
  const label =
    key === dayKey(today)
      ? t.chat.day.today
      : key === dayKey(yesterday)
        ? t.chat.day.yesterday
        : t.chat.day.date(at.getMonth() + 1, at.getDate());
  return { key, label };
}

function Conversation({
  chat,
  active,
  pinFailed,
}: {
  chat: ChatSession;
  active: boolean;
  pinFailed: boolean;
}) {
  const { current } = useProjects();
  const frame = useFrame();
  const threadEnv = useThreadEnvironment();
  // With no computer there is no desktop to wait for: her conversation is hers by its thread.
  const computer = useWorkspace().workspace.runtime.computer !== false;
  const { now, accountById, needs, apiFor } = useShellData();
  const memberName = frame.peek ? (accountById.get(frame.peek)?.name ?? "这个成员") : null;
  const openNeeds = needsForMember(needs, frame.peek, needEnvironment);
  // Questions, reviews and handoffs stay as their own cards. The line under a routine is a result.
  // From the member's reports, not from what is drawn: a card waiting for an older page (v1.7.6)
  // still gives its routine its result.
  const routineReports = (chat.showReports ? chat.reports : []).filter(
    (report) =>
      !isHandoffNotice(report) &&
      !report.notice &&
      !(report.kind === "outcome" && needReportLabels.includes(report.title)),
  );
  const member = frame.peek ? accountById.get(frame.peek) : undefined;
  const [goalText, setGoalText] = useState("");
  const [goalFor, setGoalFor] = useState<string | null>(null);
  const [usageLine, setUsageLine] = useState("");
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const openMemberId = frame.peek;
  const goalHere = goalFor === openMemberId ? goalText : "";
  const usageHere = usageFor === openMemberId ? usageLine : "";
  useEffect(() => {
    if (!openMemberId) return;
    let gone = false;
    let timer = 0;
    let usageTimer = 0;
    const api = apiFor(member?.projectId ?? null);
    const load = () => {
      void api
        .request<unknown>(`/api/agent/accounts/${encodeURIComponent(openMemberId)}`)
        .then((payload) => {
          if (gone) return;
          setGoalText(normalizeAccountOperating(payload).goal?.text ?? "");
          setGoalFor(openMemberId);
        })
        .catch(() => {
          if (!gone) timer = window.setTimeout(load, 5_000);
        });
    };
    const loadUsage = () => {
      void api
        .request<{
          day?: string;
          input?: number;
          output?: number;
          turns?: number;
          costUsd?: number | null;
        }>(`/api/agent/accounts/${encodeURIComponent(openMemberId)}/usage`)
        .then((row) => {
          if (gone) return;
          const tokens = (row.input ?? 0) + (row.output ?? 0);
          const cost =
            typeof row.costUsd === "number"
              ? `约 $${row.costUsd.toFixed(4)}`
              : "金额还没按模型定价";
          const day = typeof row.day === "string" && row.day ? `${usageDayLabel(row.day)} · ` : "";
          setUsageLine(`${day}${tokens} token · ${row.turns ?? 0} 轮 · ${cost}`);
          setUsageFor(openMemberId);
        })
        .catch(() => {
          if (!gone) usageTimer = window.setTimeout(loadUsage, 5_000);
        });
    };
    load();
    loadUsage();
    return () => {
      gone = true;
      window.clearTimeout(timer);
      window.clearTimeout(usageTimer);
    };
  }, [apiFor, member?.projectId, openMemberId]);
  const { zone: accountZone } = useAccountZone();
  const routineLines =
    memberName && frame.peek
      ? memberRoutines(member?.tasks.map((entry) => entry.task) ?? [])
          .filter((routine) => routine.when.length > 0)
          .map((routine) => {
            const task = member?.tasks.find((entry) => entry.task.id === routine.id)?.task;
            const wake = task ? queuedClockWake(task, accountZone, new Date(now)) : null;
            return {
              id: routine.id,
              text: `${routineCreatedLine(memberName, routine.when, routine.title)}${
                clockZoneNote(routine.when, accountZone)
                  ? `（${clockZoneNote(routine.when, accountZone)}）`
                  : ""
              }${wake ? ` · 下次 ${clockLabel(wake, now, phaseWords)}` : ""}`,
              result: newestReportSentence(routineReports, routine.id),
            };
          })
          .filter((line) => line.text.length > 0)
          .concat(
            goalRoutines(goalHere).map((routine) => ({
              id: `goal:${routine.title}\n${routine.when}`,
              text: `${routineCreatedLine(memberName, routine.when, routine.title)}（记在目标里）`,
              result: "",
            })),
            appsToConnect(goalHere)
              ? [
                  {
                    id: "apps",
                    text: `${memberName} 要连接 ${appsToConnect(goalHere)}`,
                    result: "",
                  },
                ]
              : [],
            usageHere ? [{ id: "usage", text: `${memberName} ${usageHere}`, result: "" }] : [],
          )
      : [];
  const placedNeeds = new Set(
    chat.grouped.flatMap((item) => (item.type === "need" ? [item.report.taskId] : [])),
  );
  const latestNeeds = latestNeedReportIds(
    chat.grouped.flatMap((item) => (item.type === "need" ? [item.report] : [])),
  );
  const [draft, setDraft] = useState("");
  const [showResults, setShowResults] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // v1.6.1: where the follower last put the scroll, so its own scroll event is not read as the
  // person leaving the end (the content keeps growing during a history replay).
  const programmaticTop = useRef<number | null>(null);
  // Only a gesture of the person's (wheel, touch, a scrollbar drag, a paging key) may stop the
  // following: the browser moves the scroll by itself too (scroll anchoring while a block above
  // changes height), and that is nobody leaving.
  const gesture = useRef(false);
  const dragging = useRef(false);
  const gestureTimer = useRef<number | undefined>(undefined);
  const noteGesture = useCallback(() => {
    gesture.current = true;
    window.clearTimeout(gestureTimer.current);
    gestureTimer.current = window.setTimeout(() => {
      gesture.current = false;
    }, 400);
  }, []);
  useEffect(() => {
    const scroller = list.current;
    if (!scroller) return;
    const down = () => {
      dragging.current = true;
    };
    const up = () => {
      dragging.current = false;
    };
    const keys = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
        noteGesture();
    };
    scroller.addEventListener("wheel", noteGesture, { passive: true });
    scroller.addEventListener("touchmove", noteGesture, { passive: true });
    scroller.addEventListener("pointerdown", down);
    scroller.addEventListener("keydown", keys);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      scroller.removeEventListener("wheel", noteGesture);
      scroller.removeEventListener("touchmove", noteGesture);
      scroller.removeEventListener("pointerdown", down);
      scroller.removeEventListener("keydown", keys);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.clearTimeout(gestureTimer.current);
    };
  }, [noteGesture]);
  const {
    agent,
    isReady,
    loaded,
    syncing,
    busy,
    replying,
    error,
    historyError,
    transcript,
    grouped,
    turns,
    followLatest,
    awayFromLatest,
    setAwayFromLatest,
  } = chat;
  // v1.7 打开对话不重放整条历史: older messages go in front; the view keeps its place (the distance
  // from the bottom is restored once they are drawn), and the top line loads the next page by
  // itself once the person has scrolled up there.
  const older = chat.older;
  // v1.7 模型兜底: the backup in force shows above the composer; read again after a failed reply.
  const { state: model, refresh: refreshModel } = useModelState(active);
  // Read again when a reply ends (the switch happens during one) and when one fails.
  const failedReplies = error ? 1 : 0;
  useEffect(() => {
    if (failedReplies || !replying) void refreshModel();
  }, [failedReplies, replying, refreshModel]);
  const olderLine = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const loadOlderKeepingPlace = useCallback(async () => {
    const el = list.current;
    if (!el || older.loading || !older.more) return;
    followLatest.current = false;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    const added = await older.load();
    if (!added) keepFromBottom.current = null;
  }, [older, followLatest]);
  useLayoutEffect(() => {
    const el = list.current;
    if (keepFromBottom.current === null || !el) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
    programmaticTop.current = el.scrollTop;
    keepFromBottom.current = null;
  }, [transcript.length]);
  useEffect(() => {
    const line = olderLine.current;
    const root = list.current;
    if (!line || !root || !older.more) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !followLatest.current)
          void loadOlderKeepingPlace();
      },
      { root },
    );
    watcher.observe(line);
    return () => watcher.disconnect();
  }, [older.more, loadOlderKeepingPlace, followLatest]);
  // v1.2: opening a member uses that member's desktop for the next reply. Not during a reply.
  useEffect(() => {
    const next = desktopForOpenMember(false, frame.peek, threadEnv.environment?.id ?? null);
    if (!next || threadEnv.loading || replying) return;
    void threadEnv.select(next).catch(() => {});
  }, [frame.peek, threadEnv.environment?.id, threadEnv.loading, threadEnv.select, replying]);
  const guidedAccounts = new Set<string>();
  const topNeeds = dropGuidedAccountNeeds(
    openNeeds.filter((item) => {
      if (item.kind === "task") return !placedNeeds.has(item.entry.task.id);
      if (item.kind === "review" && item.entry) return !placedNeeds.has(item.entry.task.id);
      return true;
    }),
    guidedAccounts,
    (item) => (item.kind === "account" ? item.account.id : null),
  );
  const stopFollowing = useCallback(() => {
    followLatest.current = false;
  }, [followLatest]);
  // v1.6 搜对话内容: a message picked in ⌘K. Once this conversation is loaded and the message is
  // drawn, scroll to it and light it up for a moment; a message that never shows (deleted
  // meanwhile) is given up on after a while, with a word.
  const { notify } = useWorkspace();
  const jump = frame.jump;
  const drawn = transcript.length;
  useEffect(() => {
    if (!jump || jump.threadId !== chat.threadId || !loaded) return;
    const target = list.current?.querySelector<HTMLElement>(
      `[data-message="${CSS.escape(jump.messageId)}"]`,
    );
    if (!target) {
      // v1.7: the message may be in the part of the history not loaded yet: load back to it.
      if (older.more && !older.loading) {
        followLatest.current = false;
        void older.load(jump.messageId).then((added) => {
          if (!added) {
            setFrame({ jump: null });
            notify(t.chat.search.notFound);
          }
        });
        return;
      }
      if (older.loading) return;
      const giveUp = window.setTimeout(() => {
        setFrame({ jump: null });
        notify(t.chat.search.notFound);
      }, 8000);
      return () => window.clearTimeout(giveUp);
    }
    followLatest.current = false;
    setAwayFromLatest(true);
    target.scrollIntoView({ block: "center" });
    target.classList.add("hit");
    // Not cleared by this effect's cleanup: clearing the jump below re-runs it at once.
    window.setTimeout(() => target.classList.remove("hit"), 3000);
    setFrame({ jump: null });
  }, [jump, chat.threadId, loaded, drawn, followLatest, setAwayFromLatest, notify, older]);
  /** Puts text in the input without sending it (prefills), and focuses it. */
  const prefill = useCallback((text: string) => {
    setDraft(text);
    setTimeout(() => input.current?.focus(), 0);
  }, []);
  // Follow the newest block while the person is at the end (also when a picture loads late).
  const hasItems = transcript.length > 0;
  useEffect(() => {
    const scroller = list.current;
    const content = column.current;
    if (!scroller || !content) return;
    const follow = () => {
      if (!active || !hasItems || !followLatest.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      programmaticTop.current = scroller.scrollTop;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, hasItems, followLatest]);
  const toLatest = () => {
    followLatest.current = true;
    setAwayFromLatest(false);
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  };
  let lastDay: string | null = null;
  let firstDated = true;
  return (
    <InGroup.Provider
      value={inGroupChat({ hall: chat.hall, pro: false, memberOpen: !!frame.peek })}
    >
      <div className="chat-screen">
        <ComposerRequests active={active} onText={prefill} onSay={chat.say} />
        <div
          className="content"
          ref={list}
          onScroll={(e) => {
            const intent = scrollIntent(e.currentTarget, programmaticTop.current);
            if (intent === "near") {
              followLatest.current = true;
              setAwayFromLatest(false);
            } else if (intent === "away" && (gesture.current || dragging.current)) {
              followLatest.current = false;
              setAwayFromLatest(transcript.length > 0);
            }
          }}
        >
          <div className="col" ref={column}>
            {older.more && transcript.length ? (
              <div className="older" ref={olderLine}>
                <Btn className="sm" onClick={loadOlderKeepingPlace} disabled={older.loading}>
                  {older.loading ? t.chat.loadingOlder : t.chat.loadOlder}
                </Btn>
              </div>
            ) : null}
            <MemberNeeds items={topNeeds} />
            {routineLines.map((line) => (
              <div key={line.id} className={line.result ? "receipt stack" : "receipt"}>
                <span>{line.text}</span>
                {line.result ? <span>{line.result}</span> : null}
              </div>
            ))}
            {historyError ? (
              <div className="stack" style={{ margin: "8px 0" }}>
                <ErrorLine error={historyError} />
                <div>
                  <Btn className="sm" icon={RotateCcw} onClick={chat.retryLoad}>
                    {t.chat.retryLoad}
                  </Btn>
                </div>
              </div>
            ) : null}
            {!transcript.length && openNeeds.length === 0 && routineLines.length === 0 ? (
              loaded ? (
                <ChatEmptyState member={memberName} />
              ) : historyError ? null : (
                <div
                  className="chat-loading"
                  role="status"
                  aria-label={isReady ? t.chat.loadingConversation : t.chat.connecting}
                >
                  <Skeleton lines={5} />
                </div>
              )
            ) : (
              <DesktopFoldContext.Provider value={{ fold: chat.fold, replying }}>
                {grouped.map((item, index) => {
                  const turn = turns[index] ?? {
                    speaker: { kind: "silent" as const },
                    head: false,
                  };
                  const dated =
                    item.type === "reports"
                      ? item.reports.at(-1)?.createdAt
                      : item.type === "message"
                        ? undefined
                        : item.report.createdAt;
                  const day = dated ? dayLabel(dated, now) : null;
                  let divider: ReactNode = null;
                  if (day && day.key !== lastDay) {
                    const today = day.label === t.chat.day.today;
                    if (!(firstDated && today)) divider = <div className="day">{day.label}</div>;
                    lastDay = day.key;
                    firstDated = false;
                  }
                  return (
                    <Fragment key={item.key}>
                      {divider}
                      {/* v1.6 聊天基础动作: a stretch the person went back on, folded where it stood */}
                      {item.type === "message"
                        ? chat.superseded.before
                            .get(item.message.id)
                            ?.map((segment) => (
                              <SupersededFold key={`gone-${segment.at}`} segment={segment} />
                            ))
                        : null}
                      <TranscriptItem
                        chat={chat}
                        item={item}
                        turn={turn}
                        latest={item.type === "need" && latestNeeds.has(item.report.id)}
                      />
                    </Fragment>
                  );
                })}
                {chat.superseded.atEnd.map((segment) => (
                  <SupersededFold key={`gone-${segment.at}`} segment={segment} />
                ))}
              </DesktopFoldContext.Provider>
            )}
            {!chat.richThreads ? (
              <RecentResults
                chat={chat}
                open={showResults}
                onToggle={() => setShowResults(!showResults)}
              />
            ) : null}
            {replying ? (
              <div className="running" role="status">
                <span className="spin" />
                {chat.retrying ? t.chat.retrying : t.chat.working(chat.assistantName)}
              </div>
            ) : null}
            {error ? (
              <div className="stack" style={{ margin: "8px 0 0 38px" }}>
                <ErrorLine error={error} />
                <div>
                  <Btn
                    className="sm"
                    icon={RotateCcw}
                    disabled={busy || agent.isRunning || !loaded || syncing || !isReady}
                    onClick={chat.retryResponse}
                  >
                    {t.chat.retryResponse}
                  </Btn>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div style={{ position: "relative" }}>
          {awayFromLatest ? (
            <Btn className="sm to-latest" icon={ArrowDown} onClick={toLatest}>
              {t.chat.latest}
            </Btn>
          ) : null}
        </div>
        {model.backup.active && model.backup.reason ? (
          <div className="receipt model-banner" role="status">
            <span>
              {t.chat.backupBanner(
                model.backup.reason,
                model.fallback ?? "",
                localTime(model.backup.until),
              )}
            </span>
          </div>
        ) : null}
        <Composer
          chat={chat}
          draft={draft}
          setDraft={setDraft}
          onSent={() => setShowResults(false)}
          input={input}
          address={memberName ?? (current === null ? t.app.name : null)}
          hold={
            computer &&
            !memberDesktopReady({
              memberId: frame.peek,
              environmentId: threadEnv.environment?.id ?? null,
              loading: threadEnv.loading,
              unavailable: threadEnv.unavailable,
              failed: pinFailed,
            })
          }
        />
      </div>
    </InGroup.Provider>
  );
}

function TranscriptItem({
  chat,
  item,
  turn,
  latest,
}: {
  chat: ChatSession;
  item: ChatSession["grouped"][number];
  turn: GroupTurn;
  latest: boolean;
}) {
  if (item.type === "reports")
    return <ReportGroupBlock taskId={item.taskId} reports={item.reports} turn={turn} />;
  if (item.type === "notice") return <NoticeBlock report={item.report} turn={turn} />;
  if (item.type === "need") return <NeedBlock report={item.report} latest={latest} turn={turn} />;
  return <MessageBlock chat={chat} message={item.message} turn={turn} />;
}

function MessageBlock({
  chat,
  message,
  turn,
}: {
  chat: ChatSession;
  message: Message;
  turn: GroupTurn;
}) {
  const { messages, renderToolCall } = chat;
  const user = message.role === "user";
  const text = chat.messageText(message);
  // v1.6 聊天基础动作: one's own message can be edited and sent again (in a group, only one's own).
  const [editing, setEditing] = useState(false);
  const me = useAuth().session?.username ?? null;
  const toolCalls = "toolCalls" in message ? message.toolCalls || [] : [];
  // v1.6 聊天里发文件: the files the person sent with this message; the files a reply saved
  // under /workspace/成品.
  const files = chat.messageAttachments(message);
  const delivered = user
    ? []
    : deliveredPaths(
        toolCalls,
        (callId) =>
          messages.find(
            (candidate): candidate is ToolMessage =>
              candidate.role === "tool" && candidate.toolCallId === callId,
          )?.content,
      );
  // v1.6 生成图片: the pictures this reply made, shown as picture cards.
  const resultOf = (callId: string) =>
    messages.find(
      (candidate): candidate is ToolMessage =>
        candidate.role === "tool" && candidate.toolCallId === callId,
    )?.content;
  const made = user ? [] : generatedImages(toolCalls, resultOf);
  const card = (toolCall: (typeof toolCalls)[number]) => {
    const toolMessage = messages.find(
      (candidate): candidate is ToolMessage =>
        candidate.role === "tool" && candidate.toolCallId === toolCall.id,
    );
    return <Fragment key={toolCall.id}>{renderToolCall({ toolCall, toolMessage })}</Fragment>;
  };
  // The person's own message keeps its cards; a reply shows
  // what it did, and its steps fold into one line (open while the reply is still under way).
  const { result, steps } = user
    ? { result: toolCalls, steps: [] as typeof toolCalls }
    : splitToolCalls(
        toolCalls,
        (call) =>
          isResultTool(call.function.name) ||
          (call.function.name === "route_request" && missingGroupRef(resultOf(call.id)) !== null),
      );
  const live =
    chat.replying && messages.filter((item) => item.role === "assistant").at(-1)?.id === message.id;
  const tools = toolCalls.length ? (
    <JevInteractionContext.Provider value={chat.jevInteraction}>
      <BrowserRunContext.Provider value={chat.browserRun(message)}>
        <div className="stack">
          {steps.length ? (
            <details className="reply-steps" open={live}>
              <summary className="hint">{t.chat.replySteps(steps.length)}</summary>
              <div className="stack">{steps.map(card)}</div>
            </details>
          ) : null}
          {result.map(card)}
        </div>
      </BrowserRunContext.Provider>
    </JevInteractionContext.Provider>
  ) : null;
  if (user) {
    const speaker = chat.severalMembers ? chat.speakers[message.id] : undefined;
    const canEdit = chat.canGoBack && (!speaker || speaker === me);
    return (
      <article className="blk mine" aria-label={speaker ?? t.chat.you} data-message={message.id}>
        <div
          style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
        >
          {speaker ? <div className="who-line">{t.spaces.speaker(speaker)}</div> : null}
          {editing ? (
            <MessageEditor
              initial={rawMessageText(message.content)}
              onCancel={() => setEditing(false)}
              onSend={(words) => {
                if (chat.editMessage(message.id, words)) setEditing(false);
              }}
            />
          ) : (
            <>
              {text ? <div className="body me">{text}</div> : null}
              {files.length ? (
                <div className="attach-row">
                  {files.map((file) => (
                    <AttachmentCard key={file.id} file={file} />
                  ))}
                </div>
              ) : null}
              {tools}
              {canEdit ? (
                <div className="mine-acts">
                  <button
                    type="button"
                    title={t.chat.actions.editHint}
                    aria-label={t.chat.actions.edit}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil size={13} />
                    <span>{t.chat.actions.edit}</span>
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </article>
    );
  }
  if (turn.speaker.kind === "silent") return null;
  return (
    <Block turn={turn}>
      {text ? (
        <div className="body" data-message={message.id}>
          <Markdown text={text} />
        </div>
      ) : null}
      {tools}
      {made.length ? (
        <div className="attach-row">
          {made.map((file) => (
            <AttachmentCard key={file.id} file={file} />
          ))}
        </div>
      ) : null}
      {delivered.length ? (
        <div className="attach-row">
          {delivered.map((path) => (
            <DeliveredCard key={path} path={path} />
          ))}
        </div>
      ) : null}
      {text && !live ? <ReplyActions chat={chat} message={message} text={text} /> : null}
    </Block>
  );
}

/** v1.6 聊天基础动作: under a reply — copy it, ask for it again (the latest one), 有用 / 没用. */
function ReplyActions({
  chat,
  message,
  text,
}: {
  chat: ChatSession;
  message: Message;
  text: string;
}) {
  const words = t.chat.actions;
  const [copied, setCopied] = useState(false);
  const verdict = chat.feedback[message.id];
  const copy = async () => {
    // The Markdown as written, and the rendered HTML (without the code blocks' copy buttons)
    // for a rich editor.
    const html = assistantMarkdown
      .render(text)
      .replace(/<div class="code-head">[\s\S]*?<\/div>/g, "");
    if (!(await copyToClipboard(text, html))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="reply-acts" data-reply-actions={message.id}>
      <button
        type="button"
        title={words.copyReply}
        aria-label={words.copyReply}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? words.copied : words.copy}</span>
      </button>
      {chat.latestReplyId === message.id && chat.canGoBack ? (
        <button
          type="button"
          title={words.regenerateHint}
          aria-label={words.regenerate}
          onClick={chat.regenerate}
        >
          <RotateCcw size={13} />
          <span>{words.regenerate}</span>
        </button>
      ) : null}
      <button
        type="button"
        title={words.good}
        aria-label={words.good}
        aria-pressed={verdict === "up"}
        onClick={() => chat.giveFeedback(message.id, verdict === "up" ? null : "up")}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        type="button"
        title={words.bad}
        aria-label={words.bad}
        aria-pressed={verdict === "down"}
        onClick={() => chat.giveFeedback(message.id, verdict === "down" ? null : "down")}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  );
}

/** v1.6 聊天基础动作: the person's message, open for a change before it goes again. */
function MessageEditor({
  initial,
  onSend,
  onCancel,
}: {
  initial: string;
  onSend: (words: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const words = t.chat.actions;
  return (
    <div className="edit-box" data-edit-box>
      <textarea
        ref={box}
        value={value}
        aria-label={words.edit}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e.nativeEvent)) {
            e.preventDefault();
            if (value.trim()) onSend(value);
          }
        }}
      />
      <div className="row">
        <Btn className="sm ghost" onClick={onCancel}>
          {t.common.cancel}
        </Btn>
        <Btn
          className="sm"
          variant="pri"
          icon={Send}
          disabled={!value.trim()}
          onClick={() => onSend(value)}
        >
          {words.resend}
        </Btn>
      </div>
    </div>
  );
}

/** v1.6 聊天基础动作: a stretch the person went back on, folded; open to read it. */
function SupersededFold({ segment }: { segment: SupersededSegment }) {
  const words = t.chat.actions;
  const at = Date.parse(segment.at);
  const time = Number.isNaN(at)
    ? ""
    : new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return (
    <details className="superseded" data-superseded>
      <summary>
        {words.supersededFold(segment.messages.length)}
        {time ? <span className="tm"> · {time}</span> : null}
      </summary>
      <p className="hint">{words.supersededHint}</p>
      {segment.messages.map((message) => {
        const text = rawMessageText(message.content);
        if (message.role === "user") {
          const files = attachmentsOf(message.content);
          return (
            <div key={message.id} className="old mine">
              {text ? <div className="body me">{text}</div> : null}
              {files.length ? (
                <div className="attach-row">
                  {files.map((file) => (
                    <AttachmentCard key={file.id} file={file} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        }
        return text ? (
          <div key={message.id} className="old">
            <div className="body">
              <Markdown text={text} />
            </div>
          </div>
        ) : null;
      })}
    </details>
  );
}

/** Without rich threads (no conversation list): 最近结果 under the chat, on demand. */
function RecentResults({
  chat,
  open,
  onToggle,
}: {
  chat: ChatSession;
  open: boolean;
  onToggle: () => void;
}) {
  const results = chat.recentResults;
  if (!results.any) return null;
  return (
    <div className="stack" style={{ marginLeft: 38 }}>
      <div>
        <Btn className="sm" onClick={onToggle}>
          {open ? t.chat.hideRecentResults : t.chat.recentResults}
        </Btn>
      </div>
      {open ? (
        <>
          {results.files.map((file) => (
            <FileThreadCard key={file.id} file={file} />
          ))}
          {results.browsers.map((browser) => (
            <BrowserThreadCard key={browser.id} browser={browser} />
          ))}
          {results.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </>
      ) : null}
    </div>
  );
}
