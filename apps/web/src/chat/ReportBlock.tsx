/**
 * Phase C (docs/web.md): the reports of a background task as blocks, from
 * shell/components/ReportCardGroup.tsx. The newest report of a run is one block: who speaks (the
 * account), its label and time, the task, what was done (the rest behind 展开全文), its links and
 * 原文 as chips, and 打开任务 / 更早 N 条 as hover actions.
 * The chat draws the 营销总群's founder replies with ReportGroupBlock (the older ones open above);
 * a task's stop report is ProgressReportGroup (newest first, the task's title leading the block
 * and opening the task, the older ones open below).
 */
import { isSafeAssistantUrl } from "@m/assistant-markdown";
import { incidentShotPath } from "@m/incidents-core";
import { linkLabel, reportCardView, reportClock, reportTone } from "@m/shell/chat/core";
import type { GroupTurn } from "@m/shell/chat/group-core";
import { reportCardSource } from "@m/shell/chat/report-core";
import { useShellData } from "@m/shell/data";
import type { AccountModel, TaskEntry } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { reportLabel, t } from "@m/shell/strings";
import { ExternalLink, Quote } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { Markdown } from "../ui/Markdown";
import { Pill, type Tone } from "../ui/primitives";
import { InGroup } from "./context";
import { Block, IncidentShot } from "./parts";

/** The task of a report and its bound account, when this project has them. */
export function useTaskOf(taskId: string): {
  entry: TaskEntry | null;
  account: AccountModel | null;
} {
  const { entryById, accountById } = useShellData();
  const entry = entryById.get(taskId) ?? null;
  const account = entry?.environmentId ? (accountById.get(entry.environmentId) ?? null) : null;
  return { entry, account };
}

// v1.2: the label is a pill; every tone but neutral also gets its dot.
const pillTone: Record<string, Tone> = {
  green: "g",
  red: "r",
  amber: "a",
  neutral: "",
};

/** The report's label and time for the block's head. In the group only a failure or a question
 * keeps its label; any other report is just the speaker's message, with its time. A stop
 * report (`page`) always shows the label. */
function useReportHead(report: ChatReport, page = false): { tag: ReactNode; time: string } {
  const { now } = useShellData();
  const inGroup = useContext(InGroup) && !page;
  const tone = reportTone(report.title);
  // A founder's report in the hall says which project it is for.
  const forProject = report.project ? `${t.common.sep}${t.group.forProject(report.project)}` : "";
  const time = `${reportClock(report.createdAt, now)}${forProject}`;
  if (inGroup && tone !== "red" && tone !== "amber") return { tag: null, time };
  // A stop report is always a report: the bare label (完成, 进展, 出问题…).
  const word = reportLabel(report.title, report.action);
  return {
    tag: (
      <Pill tone={pillTone[tone]} dot={tone !== "neutral"}>
        {page ? word : t.reportCard.header(word)}
      </Pill>
    ),
    time,
  };
}

/** Outside the group the account that speaks a report leads its block (the RN card's speaker
 * line); in the group the turn already names it. */
function useReportTurn(turn: GroupTurn, from: ReturnType<typeof reportCardSource>) {
  const inGroup = useContext(InGroup);
  if (inGroup || !from.speaker) return turn;
  return {
    speaker: {
      kind: "account" as const,
      name: from.speaker.name,
      initial: from.speaker.initial,
    },
    head: true,
  };
}

export function ReportGroupBlock({
  taskId,
  reports,
  turn,
}: {
  taskId: string;
  reports: ChatReport[];
  turn: GroupTurn;
}) {
  const { entry, account } = useTaskOf(taskId);
  const [open, setOpen] = useState(false);
  const latest = reports.at(-1);
  if (!latest) return null;
  const older = reports.slice(0, -1);
  return (
    <>
      {open
        ? older.map((report, index) => (
            <ReportBlock
              key={report.id}
              report={report}
              entry={entry}
              account={account}
              turn={index === 0 ? turn : { ...turn, head: false }}
            />
          ))
        : null}
      <ReportBlock
        report={latest}
        entry={entry}
        account={account}
        turn={open && older.length ? { ...turn, head: false } : turn}
        older={
          older.length
            ? {
                label: open ? t.chat.hideEarlier : t.chat.earlier(older.length),
                full: open ? t.reportCard.collapseOlder : t.reportCard.older(older.length),
                toggle: () => setOpen(!open),
              }
            : undefined
        }
      />
    </>
  );
}

/**
 * One task's reports in a row, newest first. The newest leads with the task's title (opens the
 * task), its label and time; 更早 N 条 opens the older ones below it, each with its label and
 * time.
 */
export function ProgressReportGroup({ reports }: { reports: ChatReport[] }) {
  const latest = reports[0];
  const { entry, account } = useTaskOf(latest?.taskId ?? "");
  const [open, setOpen] = useState(false);
  if (!latest) return null;
  const older = reports.slice(1);
  const from = reportCardSource(latest, entry, account);
  const speaker: GroupTurn["speaker"] = from.speaker
    ? { kind: "account", ...from.speaker }
    : { kind: "ops", name: "" };
  return (
    <>
      <ReportBlock
        report={latest}
        entry={entry}
        account={account}
        turn={{ speaker, head: true }}
        page
        older={
          older.length
            ? {
                label: open ? t.chat.hideEarlier : t.chat.earlier(older.length),
                full: open ? t.reportCard.collapseOlder : t.reportCard.older(older.length),
                toggle: () => setOpen(!open),
              }
            : undefined
        }
      />
      {open
        ? older.map((report) => (
            <ReportBlock
              key={report.id}
              report={report}
              entry={entry}
              account={account}
              turn={{ speaker, head: false }}
              page
            />
          ))
        : null}
    </>
  );
}

/** The head of a stop report: the task's title, opening the task. */
function TaskTitle({ report, entry }: { report: ChatReport; entry: TaskEntry | null }) {
  const nav = useShellNav();
  return (
    <button
      type="button"
      className="who task-title"
      onClick={() => nav.openPanel({ kind: "task", taskId: report.taskId })}
    >
      {entry?.task.title ?? report.taskTitle}
    </button>
  );
}

export function ReportBlock({
  report,
  entry,
  account,
  turn,
  older,
  page = false,
}: {
  report: ChatReport;
  entry: TaskEntry | null;
  account: AccountModel | null;
  turn: GroupTurn;
  older?: { label: string; full: string; toggle: () => void };
  /** A stop report: the task's title leads (`turn.head`), the account that speaks is the line
   * under it, and the label always shows. */
  page?: boolean;
}) {
  const nav = useShellNav();
  const [textOpen, setTextOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteAll, setQuoteAll] = useState(false);
  const view = reportCardView(report);
  const from = reportCardSource(report, entry, account);
  const head = useReportHead(report, page);
  const turned = useReportTurn(turn, from);
  const shown = page ? turn : turned;
  const label = t.reportCard.header(reportLabel(report.title, report.action));
  const subLine = page ? (
    turn.head && from.speaker ? (
      <div className="sub-line">{from.speaker.name}</div>
    ) : null
  ) : from.source ? (
    <div className="sub-line">{from.source}</div>
  ) : null;
  return (
    <Block
      turn={shown}
      time={head.time}
      tag={head.tag}
      open={quoteOpen}
      label={page ? `${label}${t.common.sep}${entry?.task.title ?? report.taskTitle}` : label}
      who={page ? <TaskTitle report={report} entry={entry} /> : undefined}
      acts={
        older || page ? (
          <>
            {older ? (
              <button type="button" onClick={older.toggle} title={older.full}>
                {older.label}
              </button>
            ) : null}
            {page ? (
              <button
                type="button"
                onClick={() => nav.openPanel({ kind: "task", taskId: report.taskId })}
              >
                {t.chat.openTask}
              </button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {subLine}
      {/* not confirmed comes before what the run says it did. */}
      {view.unconfirmed ? (
        <div className="sub-line">
          <Pill tone="a" dot>
            {view.unconfirmed}
          </Pill>
        </div>
      ) : null}
      {view.summary ? (
        <div className="body">
          {textOpen || !view.more ? (
            <Markdown text={view.summary} />
          ) : view.leadPlain ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{view.lead}</div>
          ) : (
            <Markdown text={view.lead} />
          )}
        </div>
      ) : null}
      {view.more ? (
        <button type="button" className="fold" onClick={() => setTextOpen(!textOpen)}>
          {textOpen ? t.reportCard.collapse : t.reportCard.expand}
        </button>
      ) : null}
      {/* the desktop as the run looked at what it did. */}
      {report.shot ? (
        <IncidentShot path={incidentShotPath(report.shot)} site={report.action?.site} />
      ) : null}
      {report.links.length || view.quote ? (
        <div className="chips">
          {report.links.map((link) =>
            isSafeAssistantUrl(link) ? (
              <a
                key={link}
                className="chip"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t.reportCard.openLink(link)}
              >
                <ExternalLink size={12} />
                <span className="t">{linkLabel(link)}</span>
              </a>
            ) : (
              <span key={link} className="chip">
                <ExternalLink size={12} />
                <span className="t">{linkLabel(link)}</span>
              </span>
            ),
          )}
          {view.quote ? (
            <button
              type="button"
              className="chip"
              aria-expanded={quoteOpen}
              onClick={() => setQuoteOpen(!quoteOpen)}
            >
              <Quote size={12} />
              <span className="t">{t.chat.quote}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {view.quote ? (
        <>
          <div className={view.quoteLong ? (quoteAll ? "quote long all" : "quote long") : "quote"}>
            {view.quote}
          </div>
          {quoteOpen && view.quoteLong ? (
            <button type="button" className="fold" onClick={() => setQuoteAll(!quoteAll)}>
              {quoteAll ? t.reportCard.collapse : t.reportCard.expand}
            </button>
          ) : null}
        </>
      ) : null}
    </Block>
  );
}
