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
import { useAgentFetchedAt } from "@m/agent-workspace";
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
import { type GroupTurn, missingGroupRef, noticeText, projectRef } from "@m/shell/chat/group-core";
import { useOpsName } from "@m/shell/chat/group-state";
import { groupTaskLine } from "@m/shell/chat/handoff";
import { useShellData } from "@m/shell/data";
import { groupError, groupNameProblem } from "@m/shell/members/groups";
import { type AccountModel, phaseActions, type TaskAction, type TaskEntry } from "@m/shell/model";
import { phaseWords, t } from "@m/shell/strings";
import { cardNeedsRead, cardTask, readTaskOnce, type TaskRead } from "@m/shell/task/detail-core";
import { useWorkspace } from "@m/workspace";
import { useContext, useEffect, useRef, useState } from "react";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { peekAccount } from "../shell/state";
import { Btn, ErrorLine, Spinner } from "../ui/primitives";
import { InGroup, JevInteractionContext } from "./context";
import { Block, LinkBtn, StatusPill, TaskAccount } from "./parts";
import { TaskResults } from "./results";

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

/** A card's task, by id. The task list carries only the live tasks and the recent past, the
 * finished ones without their steps, so a task it lacks (or, with `whole`, carries trimmed) is
 * read by itself, once. `missing` only when that read says there is no such task and a list read
 * that started after the card first missed it lacks it too; until then the card does not know. */
export function useCardTask(
  taskId: string | null,
  options: { enabled: boolean; whole?: boolean },
): { entry: TaskEntry | null; missing: boolean; error: string } {
  const { entryById, now, stalled } = useShellData();
  const { api } = useWorkspace();
  const fetchedAt = useAgentFetchedAt();
  const live = taskId ? entryById.get(taskId) : undefined;
  // A task the list lacks is read by itself only once the list has been read: on a page that
  // has just opened every card's task is "not in the list" for a moment.
  const wanted =
    options.enabled &&
    !!taskId &&
    (!!live || fetchedAt !== null) &&
    cardNeedsRead(live, options.whole === true);
  const version = live?.task.updatedAt ?? "";
  // When this card first looked for its task and did not find it.
  const [missingSince, setMissingSince] = useState<{ id: string; at: number } | null>(null);
  const [read, setRead] = useState<{ id: string; value: TaskRead } | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    if (!options.enabled || !taskId || live) return;
    setMissingSince((current) =>
      current?.id === taskId ? current : { id: taskId, at: Date.now() },
    );
  }, [options.enabled, taskId, live]);
  const failedAt = failed?.id === taskId ? fetchedAt : null;
  useEffect(() => {
    if (!wanted || !taskId) return;
    let active = true;
    readTaskOnce(api, taskId, version)
      .then((value) => {
        if (!active) return;
        setRead({ id: taskId, value });
        setFailed(null);
      })
      .catch((e) => {
        if (active) setFailed({ id: taskId, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      active = false;
    };
    // A read that failed is asked again when the list is next read.
  }, [api, taskId, wanted, version, failedAt]);
  const listChecked =
    !!taskId && missingSince?.id === taskId && fetchedAt !== null && fetchedAt >= missingSince.at;
  const found = cardTask({
    live,
    read: read?.id === taskId ? read.value : null,
    listChecked,
    now,
    stalled,
  });
  return { ...found, error: !found.entry && failed?.id === taskId ? failed.message : "" };
}

/** delegate_task's card: the live task card; while its task is not known yet it reads
 * 「正在建任务…」. A task the list does not carry (it finished long ago) is read by itself and
 * shown as any other; 「这个任务已经不在了」 only once the project really has no such task
 * (`useCardTask`). */
export function DelegatedTaskCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { accountById } = useShellData();
  const ref = toolResultRef(result);
  const inGroup = useContext(InGroup);
  const opsName = useOpsName();
  // The hall handed the task to a project, where it runs and reports; the hall
  // never lists it, so the card asks that project's 运营专员 and leads there.
  const handed = loading ? null : projectRef(result);
  const {
    entry,
    missing,
    error: readError,
  } = useCardTask(ref.id, {
    enabled: !loading && !(handed && !ref.error),
    whole: !inGroup,
  });
  // The 运营专员 asks the task's account by name, the task's state word
  // small beside it, instead of a task card in the middle of the conversation.
  if (entry && inGroup) {
    const account = entry.environmentId ? (accountById.get(entry.environmentId) ?? null) : null;
    const mentions = account ? [account.name] : [];
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
  // Not known yet (the task is being made, or its read is on the way) is never "gone".
  const error = ref.error ?? readError;
  const waiting = loading || (!!ref.id && !missing && !error);
  return (
    <div className="tcard">
      {waiting ? (
        <Spinner label={loading ? t.taskCard.saving : t.tools.waiting} />
      ) : error ? (
        <ErrorLine error={error} />
      ) : (
        <span className="muted">{t.taskCard.missing}</span>
      )}
    </div>
  );
}

/** 「归 acmegame：…」 under a hall reply routed to a project (an older reply's project made for
 * it reads as create_project's card does); for a group that does not exist (v1.7.6), the button
 * that makes it; nothing for a request for no project. */
export function RouteLine({
  args,
  result,
  loading,
}: {
  args: Record<string, unknown>;
  result: unknown;
  loading: boolean;
}) {
  const missing = loading ? null : missingGroupRef(result);
  const made = loading ? null : projectRef(result);
  const why = typeof args.why === "string" ? args.why : "";
  if (missing) return <MakeGroupOffer name={missing} />;
  if (!made) return null;
  return (
    <div className="stack">
      {made.created ? <div>{t.group.projectMade(made.name)}</div> : null}
      <div className="hint">{t.group.routedTo(made.name, why)}</div>
    </div>
  );
}

/** v1.7.6: a group the hall's reply was routed to does not exist. Only the person makes it: the
 * button goes through their own 新建群 (POST /api/projects), then tells the conversation with a
 * fixed line so the reply that waited goes on and hands the work over. */
function MakeGroupOffer({ name }: { name: string }) {
  const projects = useProjects();
  const chat = useContext(JevInteractionContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The group this card made, and why the conversation was not told (so it can be told again).
  const [told, setTold] = useState<{ name: string; error: string } | null>(null);
  // This card made the group (so it says 建好了, not 已经有了).
  const [madeHere, setMadeHere] = useState(false);
  const pressed = useRef(false);
  const tell = (made: string) =>
    chat
      .send(t.group.madeNote(made))
      .then(() => setTold(null))
      .catch((failure: unknown) =>
        setTold({
          name: made,
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
  if (told?.error)
    return (
      <div className="tcard">
        <div className="stack">
          <div>{t.group.projectMade(told.name)}</div>
          <ErrorLine error={t.group.noteFailed(told.error)} />
          <div className="acts-row">
            <Btn className="sm" onClick={() => void tell(told.name)}>
              {t.group.tellAgain}
            </Btn>
          </div>
        </div>
      </div>
    );
  const there = projects.projects.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (there)
    return (
      <div className="stack">
        <div className="hint">
          {madeHere ? t.group.projectMade(there.name) : t.group.projectThere(there.name)}
        </div>
        <ToProject projectId={there.id} name={there.name} />
      </div>
    );
  // A name the person's own 新建群 would refuse: say why, offer nothing.
  const problem = groupNameProblem(name);
  if (problem)
    return (
      <div className="tcard">
        <div className="stack">
          <div>{t.group.noGroup(name)}</div>
          <div className="hint">{problem}</div>
        </div>
      </div>
    );
  const make = async () => {
    if (pressed.current) return;
    pressed.current = true;
    setBusy(true);
    setError("");
    try {
      const made = await projects.create(name);
      setMadeHere(true);
      await tell(made.name);
    } catch (failure) {
      pressed.current = false;
      setError(groupError(failure instanceof Error ? failure.message : String(failure)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tcard">
      <div className="stack">
        <div>{t.group.noGroup(name)}</div>
        <div className="acts-row">
          <Btn className="sm" disabled={busy} onClick={() => void make()}>
            {busy ? t.group.makingGroup : t.group.makeGroup(name)}
          </Btn>
        </div>
        <ErrorLine error={error} />
      </div>
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
  // v1.7.6: create_project is gone; only an older conversation's made project shows. A call that
  // failed (a model copying an old one gets "Unknown tool") shows nothing.
  if (!made) return null;
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
  const view = redirectView(args, result, kind);
  const words = taskControlWords(kind);
  // The title is all this card shows of the task, so a trimmed copy is enough.
  const { entry } = useCardTask(view.taskId ?? null, { enabled: !loading });
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

/** 「@Bob 请：发一帖」: the mentions bold, then what is asked. */
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

/** A block of its own about an account's persona (or, in older conversations, a notice whose
 * words were recorded with it), in the capybara's words. Nothing here is an approval. */
export function NoticeBlock({ report, turn }: { report: ChatReport; turn: GroupTurn }) {
  const { now } = useShellData();
  const notice = report.notice;
  if (!notice) return null;
  const said = noticeText(report);
  return (
    <Block
      turn={turn}
      time={reportClock(report.createdAt, now)}
      label={said}
      acts={
        notice.kind === "persona" && notice.environmentId ? (
          <button type="button" onClick={() => peekAccount(notice.environmentId as string)}>
            {t.jobs.cards.look}
          </button>
        ) : undefined
      }
    >
      <div className="body">{said}</div>
    </Block>
  );
}
