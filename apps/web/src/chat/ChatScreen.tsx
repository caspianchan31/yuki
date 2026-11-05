/**
 * Phase C (docs/web.md): one conversation drawn as the prototype's block timeline, from
 * chat.tsx's ChatScreen. Its state is chat-state.tsx's useChatSession (shared with the phone):
 * loading and replaying, the outbox, stop and retry, and who says each item. Here: the member
 * needs, day dividers, a block per item (the person's own messages on the right), the guide
 * cards, the running line, the errors with their retries, 回到最新, and the composer pinned at
 * the bottom. Reports, questions and failures of the tasks stay in the timeline.
 */

import { isHandoffNotice } from "@m/chat-reports-core";
import { ReportsModelContext } from "@m/chat-reports-state";
import {
  type ChatSession,
  ComposerRequests,
  type ChatMessage as Message,
  type ChatToolMessage as ToolMessage,
  useChatSession,
} from "@m/chat-state";
import { useProjects } from "@m/projects-state";
import { normalizeAccountOperating } from "@m/shell/accounts/operating-core";
import { latestNeedReportIds } from "@m/shell/chat/core";
import { type GroupTurn, inGroupChat } from "@m/shell/chat/group-core";
import { routineCreatedLine } from "@m/shell/chat/handoff";
import {
  desktopForOpenMember,
  memberDesktopReady,
  shouldPinMemberDesktop,
} from "@m/shell/chat/member-desktop";
import { memberConversationId } from "@m/shell/chat/member-thread";
import { splitToolCalls } from "@m/shell/chat/reply-core";
import { useShellData } from "@m/shell/data";
import {
  appsToConnect,
  clockNeedsZone,
  dropGuidedAccountNeeds,
  goalRoutines,
  memberRoutines,
  needsForMember,
  newestReportSentence,
  queuedClockWake,
  usageDayLabel,
} from "@m/shell/members/member-detail";
import { phaseWords, t } from "@m/shell/strings";
import { ThreadEnvironmentProvider, useThreadEnvironment } from "@m/thread-environment";
import type { Selection } from "@m/threads-state";
import { useWorkspace } from "@m/workspace";
import { ArrowDown, RotateCcw } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { useFrame } from "../shell/state";
import { Markdown } from "../ui/Markdown";
import { Btn, ErrorLine, Skeleton } from "../ui/primitives";
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
  const routineReports = chat.grouped.flatMap((item) =>
    item.type === "reports" ? item.reports.filter((report) => !isHandoffNotice(report)) : [],
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
  const routineLines =
    memberName && frame.peek
      ? memberRoutines(member?.tasks.map((entry) => entry.task) ?? [])
          .filter((routine) => routine.when.length > 0)
          .map((routine) => {
            const task = member?.tasks.find((entry) => entry.task.id === routine.id)?.task;
            const wake = task ? queuedClockWake(task, member?.timezone, new Date(now)) : null;
            return {
              id: routine.id,
              text: `${routineCreatedLine(memberName, routine.when, routine.title)}${
                clockNeedsZone(routine.when, member?.timezone) ? "（填了时区才按这个钟点）" : ""
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
      if (active && hasItems && followLatest.current) scroller.scrollTop = scroller.scrollHeight;
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
            const el = e.currentTarget;
            const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            followLatest.current = nearEnd;
            setAwayFromLatest(transcript.length > 0 && !nearEnd);
          }}
        >
          <div className="col" ref={column}>
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
                      <TranscriptItem
                        chat={chat}
                        item={item}
                        turn={turn}
                        latest={item.type === "need" && latestNeeds.has(item.report.id)}
                      />
                    </Fragment>
                  );
                })}
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
  const toolCalls = "toolCalls" in message ? message.toolCalls || [] : [];
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
    : splitToolCalls(toolCalls);
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
    return (
      <article className="blk mine" aria-label={speaker ?? t.chat.you}>
        <div
          style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
        >
          {speaker ? <div className="who-line">{t.spaces.speaker(speaker)}</div> : null}
          {text ? <div className="body me">{text}</div> : null}
          {tools}
        </div>
      </article>
    );
  }
  if (turn.speaker.kind === "silent") return null;
  return (
    <Block turn={turn}>
      {text ? (
        <div className="body">
          <Markdown text={text} />
        </div>
      ) : null}
      {tools}
    </Block>
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
