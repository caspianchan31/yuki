/**
 * Phase C (docs/web.md): the cards the conversation shows inside a block besides messages,
 * from shell/chat/ChatCards.tsx, shell/components/TaskCard.tsx (the chat's task card) and
 * Group.tsx (OpsRequest):
 *   DelegatedTaskCard  delegate_task: the live task card, once, at the delegation, with its
 *                      results below (in the group: the 运营专员's request to the account)
 *   ServerToolCard     agent_status, task_events, create_goal, watch_page, remember_fact
 *   RedirectCard       redirect_task: which task got the instruction and its state word
 *   NoticeBlock        a job declined, taken, done, a persona changed, a founder's request
 *   JobToolCard        create_job / assign_job / update_job / close_job in the capybara's words
 *   ProjectToolCard    create_project (the hall): the project made, and the way to it
 */
import { useAgentWorkspace } from "@m/agent-workspace";
import { useProjects } from "@m/projects-state";
import { type ControlAction, useTaskActions } from "@m/shell/actions";
import {
  redirectView,
  reportClock,
  type ServerToolName,
  serverToolView,
  type TaskControlKind,
  taskCardLines,
  taskControlWords,
  toolResultRef,
} from "@m/shell/chat/core";
import { type GroupTurn, noticeSays, opsRequest, projectRef } from "@m/shell/chat/group-core";
import { useOpsName } from "@m/shell/chat/group-state";
import { groupTaskLine, handoffLine } from "@m/shell/chat/handoff";
import { useShellData } from "@m/shell/data";
import { useFounderRef } from "@m/shell/founder/useFounder";
import {
  accountGuide,
  declinedSayings,
  isFounder,
  type JobToolName,
  jobToolLine,
  jobToolView,
  noticeText,
} from "@m/shell/jobs/jobs-core";
import { type AccountModel, phaseActions, type TaskAction, type TaskEntry } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { phaseWords, t } from "@m/shell/strings";
import { useContext, useEffect, useState } from "react";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { peekAccount, setFrame } from "../shell/state";
import { Btn, ErrorLine, Spinner } from "../ui/primitives";
import { InGroup } from "./context";
import { Block, LinkBtn, StatusPill, TaskAccount } from "./parts";
import { TaskResults } from "./results";

/** 「@创始人 Ann @Bob 请：发一帖」: the mentions bold, then what is asked. */
export function OpsRequest({ mentions, text }: { mentions: readonly string[]; text: string }) {
  return (
    <div>
      {mentions.map((name) => (
        <b key={name}>{`@${name} `}</b>
      ))}
      {text}
    </div>
  );
}

/** The task card in chat, shown once at the moment of delegation, with
 * a live state (「现在：」): 「任务 · 委派于 12:50」, the title (opens the task), the account chip
 * (or 「跑在默认桌面」), the status pill, the meta and sub lines, the phase's compact inline actions
 * (暂停 / 立即继续 / 立即运行 / 恢复 / 重试) and 详情 ›. */
export function TaskCard({
  entry,
  account,
  delegatedAt,
}: {
  entry: TaskEntry;
  account: AccountModel | null;
  delegatedAt?: string;
}) {
  const { now, accounts } = useShellData();
  const actions = useTaskActions();
  const { task, phase } = entry;
  const { meta, sub } = taskCardLines(entry, now);
  const inline = phaseActions(phase, true, !!task.repeatMinutes).filter(
    (action): action is TaskAction & { op: ControlAction } =>
      action.op !== "interval" && action.op !== "stopRepeat",
  );
  const busy = actions.busy?.taskId === task.id ? actions.busy.action : null;
  return (
    <article className="tcard" aria-label={task.title}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="hint">
          {t.taskCard.header(clockLabel(delegatedAt ?? task.createdAt, now, phaseWords))}
        </span>
        <span className="hint">{t.taskCard.now}</span>
      </div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{task.title}</div>
      <div className="row">
        <TaskAccount
          environmentId={entry.environmentId}
          account={account}
          accountsLoading={accounts.loading}
        />
        <StatusPill phase={phase} />
      </div>
      {meta ? <div className="hint">{meta}</div> : null}
      {sub ? <div style={{ fontSize: 13 }}>{sub}</div> : null}
      <div className="acts-row">
        {inline.map((action) => (
          <Btn
            key={action.op}
            className="sm"
            busy={busy === action.op}
            disabled={!!busy}
            onClick={() =>
              void actions.control(task.id, action.op, { inWait: phase.key === "wait" })
            }
          >
            {action.label}
          </Btn>
        ))}
      </div>
      <ErrorLine error={actions.error?.taskId === task.id ? actions.error.message : ""} />
    </article>
  );
}

/** delegate_task's card: the live task card; while the task list catches up it reads
 * 「正在建任务…」, and only once a task-list read that started after the card first missed the
 * task still lacks it, 「这个任务已经不在了」. The card never reads the list itself. */
export function DelegatedTaskCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { entryById, accountById } = useShellData();
  const { fetchedAt } = useAgentWorkspace();
  const ref = toolResultRef(result);
  const entry = ref.id ? entryById.get(ref.id) : undefined;
  // When this card first looked for its task and did not find it.
  const [missingSince, setMissingSince] = useState<{ id: string; at: number } | null>(null);
  const taskId = ref.id;
  useEffect(() => {
    if (loading || !taskId || entry) return;
    setMissingSince((current) =>
      current?.id === taskId ? current : { id: taskId, at: Date.now() },
    );
  }, [loading, taskId, entry]);
  const checked =
    !!ref.id && missingSince?.id === ref.id && fetchedAt !== null && fetchedAt >= missingSince.at;
  const inGroup = useContext(InGroup);
  const opsName = useOpsName();
  const founder = useFounderRef();
  // The 运营专员 asks the task's account by name, the task's state word
  // small beside it, instead of a task card in the middle of the conversation.
  if (entry && inGroup) {
    const account = entry.environmentId ? (accountById.get(entry.environmentId) ?? null) : null;
    const mentions = account
      ? [
          isFounder(founder, account.name, account.id)
            ? `${t.group.founderTag} ${account.name}`
            : account.name,
        ]
      : [];
    return <div className="receipt">{groupTaskLine(opsName, entry.task.title, mentions)}</div>;
  }
  if (entry)
    return (
      <div className="stack">
        <TaskCard
          entry={entry}
          account={entry.environmentId ? (accountById.get(entry.environmentId) ?? null) : null}
        />
        <TaskResults task={entry.task} />
      </div>
    );
  // The hall handed the task to a project, where it runs and reports; the hall
  // never lists it, so the card asks that project's 运营专员 and leads there.
  const handed = loading ? null : projectRef(result);
  if (handed && !ref.error) {
    if (inGroup)
      return (
        <div className="receipt">
          {groupTaskLine(opsName, handed.title ?? "", [handed.account ?? handed.name])}
        </div>
      );
    return (
      <div className="stack">
        <OpsRequest
          mentions={[handed.account ?? t.group.ops(handed.name)]}
          text={t.group.requestFor(handed.title ?? "", handed.name)}
        />
        <ToProject projectId={handed.id} name={handed.name} />
      </div>
    );
  }
  const waiting = loading || (!!ref.id && !checked);
  return (
    <div className="tcard">
      {waiting ? (
        <Spinner label={t.taskCard.saving} />
      ) : ref.error ? (
        <ErrorLine error={ref.error} />
      ) : (
        <span className="muted">{t.taskCard.missing}</span>
      )}
    </div>
  );
}

/** 「归 acmegame：…」 under a hall reply routed to a project (the project
 * made for it reads as create_project's card does); nothing for a request for no project. */
export function RouteLine({
  args,
  result,
  loading,
}: {
  args: Record<string, unknown>;
  result: unknown;
  loading: boolean;
}) {
  const made = loading ? null : projectRef(result);
  const why = typeof args.why === "string" ? args.why : "";
  if (!made) return null;
  return (
    <div className="stack">
      {made.created ? <div>{t.group.projectMade(made.name)}</div> : null}
      <div className="hint">{t.group.routedTo(made.name, why)}</div>
    </div>
  );
}

/** 「去 acmegame ›」, switching to a project the hall named. */
function ToProject({ projectId, name }: { projectId: string | null; name: string }) {
  const projects = useProjects();
  const id = projectId ?? projects.projects.find((item) => item.name === name)?.id ?? null;
  if (!id) return null;
  return (
    <div className="acts-row">
      <LinkBtn onClick={() => projects.select(id)}>{t.group.toProject(name)}</LinkBtn>
    </div>
  );
}

/** Create_project's card in the hall: the project made (or
 * already there) and the way to it; the project column reads the new list at once. */
export function ProjectToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const projects = useProjects();
  const made = loading ? null : projectRef(result);
  const error = toolResultRef(result).error;
  const { refresh } = projects;
  const madeId = made?.id ?? null;
  useEffect(() => {
    if (madeId) void refresh().catch(() => {});
  }, [madeId, refresh]);
  if (loading)
    return (
      <div className="tcard">
        <Spinner label={t.tools.waiting} />
      </div>
    );
  if (!made)
    return (
      <div className="tcard">
        <ErrorLine error={error ?? ""} />
      </div>
    );
  return (
    <div className="tcard">
      <div>{made.created ? t.group.projectMade(made.name) : t.group.projectThere(made.name)}</div>
      <ToProject projectId={made.id} name={made.name} />
    </div>
  );
}

export function ServerToolCard({
  name,
  result,
  loading,
}: {
  name: ServerToolName;
  result: unknown;
  loading: boolean;
}) {
  const { entryById } = useShellData();
  const view = serverToolView(name);
  const ref = toolResultRef(result);
  const entry = ref.id ? entryById.get(ref.id) : undefined;
  if (entry && !loading)
    return (
      <div className="tcard">
        <span className="hint">{view.title}</span>
        <div className="row">
          <StatusPill phase={entry.phase} />
          <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {entry.task.title}
          </b>
        </div>
        {entry.phase.sub ? <span className="muted">{entry.phase.sub}</span> : null}
      </div>
    );
  return (
    <div className="tcard">
      <b>{loading ? t.tools.saving(view.title) : view.title}</b>
      {ref.error && !loading ? (
        <ErrorLine error={ref.error} />
      ) : (
        <span className="muted">{loading ? t.tools.waiting : t.tools.savedInRail}</span>
      )}
    </div>
  );
}

/** redirect_task's card (fork, report line): 「已转告任务」, the task's title and its state word
 * (never the id or a status name), 查看任务 › while this project has the task. */
export function RedirectCard({
  args,
  result,
  loading,
  kind = "redirect",
}: {
  args: unknown;
  result: unknown;
  loading: boolean;
  /** Pause_task and resume_task use this card too. */
  kind?: TaskControlKind;
}) {
  const { entryById } = useShellData();
  const view = redirectView(args, result, kind);
  const words = taskControlWords(kind);
  const entry = view.taskId ? entryById.get(view.taskId) : undefined;
  // A step of the conversation, not news: one grey line.
  const inGroup = useContext(InGroup);
  if (inGroup && !loading && !view.failed)
    return (
      <div className="row sub-line">
        <span style={{ minWidth: 0 }}>{words.group(entry?.task.title ?? view.line ?? "")}</span>
      </div>
    );
  return (
    <div className="tcard">
      <b>{loading ? words.loading : view.failed ? words.failed : words.done}</b>
      {!loading && view.reason ? <ErrorLine error={view.reason} /> : null}
      {!loading && !view.failed && view.line ? <span className="muted">{view.line}</span> : null}
    </div>
  );
}

/** A block of its own about the project's jobs or an
 * account's persona, in the capybara's words. A declined job's block offers three sayings:
 * 「换个号」 and 「还是让它接」 are said in the chat for the person, 「改人设」 starts the sentence
 * for him to finish. Nothing here is an approval, and nothing waits for it. */
export function NoticeBlock({ report, turn }: { report: ChatReport; turn: GroupTurn }) {
  const nav = useShellNav();
  const projects = useProjects();
  const { now, jobs } = useShellData();
  const inGroup = useContext(InGroup);
  const notice = report.notice;
  if (!notice) return null;
  const words = t.jobs.cards;
  const time = reportClock(report.createdAt, now);
  // The account that took or declined it says so itself.
  const said = (inGroup ? noticeSays(report) : null) ?? noticeText(report);
  // A project asks the founder (in the hall, as an @-request); a project's
  // line that the founder reported in the hall (grey, with the way there).
  if (notice.kind === "founder_request" && inGroup)
    return (
      <Block turn={turn} time={time}>
        <div className="body">
          <OpsRequest
            mentions={[`${t.group.founderTag} ${notice.account ?? ""}`]}
            text={t.group.request(notice.jobTitle ?? "")}
          />
          {report.text && report.text !== notice.jobTitle ? (
            <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
              {report.text}
            </div>
          ) : null}
        </div>
      </Block>
    );
  // The founder asks a project's 运营专员 to carry its work on (in the hall).
  if (notice.kind === "project_request")
    return (
      <Block turn={turn} time={time}>
        <div className="body">
          <OpsRequest
            mentions={[t.group.ops(notice.project ?? null)]}
            text={t.group.request(notice.jobTitle ?? "")}
          />
          {report.text && report.text !== notice.jobTitle ? (
            <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
              {report.text}
            </div>
          ) : null}
        </div>
      </Block>
    );
  if (inGroup && (notice.kind === "job_taken" || notice.kind === "job_done")) {
    const line = handoffLine(notice);
    const who = notice.account?.trim();
    if (line)
      return (
        <div className="receipt">
          <span>{line}</span>
          {notice.kind === "job_taken" && notice.environmentId && who ? (
            <button
              type="button"
              className="member-jump"
              onClick={() => peekAccount(notice.environmentId as string)}
            >
              {t.chat.openMember(who)}
            </button>
          ) : null}
        </div>
      );
  }
  if (notice.kind === "in_hall")
    return (
      <Block turn={turn} tone="sys">
        <div className="body">
          {said} <LinkBtn onClick={() => projects.select(null)}>{t.group.toHall}</LinkBtn>
        </div>
      </Block>
    );
  const sayings = notice.kind === "job_declined" ? declinedSayings(notice, jobs) : [];
  return (
    <Block
      turn={turn}
      time={time}
      label={said}
      acts={
        notice.kind === "persona" && notice.environmentId ? (
          <button type="button" onClick={() => peekAccount(notice.environmentId as string)}>
            {words.look}
          </button>
        ) : undefined
      }
    >
      <div className="body">
        {said}
        {sayings.length ? (
          <span className="inline-act">
            {sayings.map((saying, index) => (
              <button
                key={saying.label}
                type="button"
                className={index ? "ghost" : undefined}
                onClick={() => (saying.send ? nav.say(saying.text) : nav.prefill(saying.text))}
              >
                {saying.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
    </Block>
  );
}

/** The chat's job tools: 新活「…」派给了 …。, the chat's reason for its choice, 查看 ›. */
export function JobToolCard({
  name,
  result,
  loading,
}: {
  name: JobToolName;
  result: unknown;
  loading: boolean;
}) {
  const nav = useShellNav();
  const { accounts } = useShellData();
  const view = jobToolView(result);
  const words = t.jobs.cards;
  const guide = accountGuide(name, view, accounts.value, accounts.loading);
  const founder = useFounderRef();
  // In the group the 运营专员 asks by name: 「@创始人 Ann 请：…」.
  const inGroup = useContext(InGroup);
  const opsName = useOpsName();
  const request = opsRequest(name, view, founder ?? null);
  if (loading)
    return (
      <div className="tcard">
        <Spinner label={words.saving} />
      </div>
    );
  if (view.error || !view.jobId)
    return (
      <div className="tcard">
        <b>{words.failed}</b>
        <ErrorLine error={view.error} />
      </div>
    );
  // The group keeps one line even when nobody was named.
  if (inGroup)
    return <div className="receipt">{groupTaskLine(opsName, view.title, request.mentions)}</div>;
  return (
    <div className="tcard">
      <div>{jobToolLine(name, view, founder)}</div>
      {name === "create_job" && view.reason ? <span className="muted">{view.reason}</span> : null}
      {guide.stage === "add" ? (
        <div className="stack">
          <div>{t.jobs.guide.none}</div>
          <div className="acts-row start">
            <Btn className="sm" onClick={() => nav.openPanel({ kind: "join" })}>
              {t.jobs.guide.join}
            </Btn>
            <Btn className="sm" onClick={() => setFrame({ newMember: true })}>
              {t.jobs.guide.create}
            </Btn>
          </div>
        </div>
      ) : guide.stage === "ready" ? (
        <div className="row">
          <span>{t.jobs.guide.ready(guide.names.join(t.jobs.nameSep))}</span>
          <Btn className="sm" onClick={() => nav.say(guide.say)}>
            {t.jobs.guide.start}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
