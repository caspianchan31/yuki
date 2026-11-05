/**
 * The project's jobs (「活」) as the live panel, the job
 * detail, the account detail and the chat's cards read them. Pure functions: the server's job
 * (`JobView`) read defensively, and the owner's lines in strings.ts words. Nothing here decides
 * anything: who works on a job and how is the accounts' own business.
 */
import type { ChatReport, ChatReportNotice } from "../../../../../packages/domain/src/agent";
import type {
  JobAction,
  JobAssigneeStatus,
  JobDropReason,
  JobView,
} from "../../../../../packages/domain/src/jobs";
import { t } from "../strings";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const statuses: readonly JobAssigneeStatus[] = ["assigned", "taken", "declined", "done", "dropped"];
const drops: readonly JobDropReason[] = ["owner", "stopped", "moved", "removed"];

/** One job from the server, or null when it is unusable. */
export function normalizeJob(value: unknown): JobView | null {
  const job = record(value);
  const id = str(job.id);
  const title = str(job.title);
  if (!id || !title) return null;
  const due = record(job.due);
  return {
    id,
    title,
    brief: str(job.brief) ?? "",
    due: str(due.text) ? { text: str(due.text) as string, at: str(due.at) } : null,
    everyone: job.everyone === true,
    assignees: (Array.isArray(job.assignees) ? job.assignees : []).flatMap((item) => {
      const entry = record(item);
      const envId = str(entry.envId);
      const status = str(entry.status) as JobAssigneeStatus | null;
      if (!envId || !status || !statuses.includes(status)) return [];
      const dropped = str(entry.dropped) as JobDropReason | null;
      return [
        {
          envId,
          name: str(entry.name) ?? "",
          status,
          reason: str(entry.reason),
          note: str(entry.note),
          ownerInsisted: entry.ownerInsisted === true,
          ...(dropped && drops.includes(dropped) ? { dropped } : {}),
          at: str(entry.at) ?? "",
          live: entry.live !== false,
        },
      ];
    }),
    status: job.status === "done" ? "done" : "open",
    origin: null,
    createdAt: str(job.createdAt) ?? "",
    updatedAt: str(job.updatedAt) ?? "",
    doneAt: str(job.doneAt),
    archivedAt: str(job.archivedAt),
    closedReason: str(job.closedReason),
    version: typeof job.version === "number" ? job.version : 0,
  };
}
export function normalizeJobs(value: unknown): JobView[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const job = normalizeJob(item);
    return job ? [job] : [];
  });
}
/** The job panel while it has no job to show: still reading, the job gone (the server's 404, or
 * an answer without a job), or a read that failed otherwise. The title names the panel and the
 * one line says what happened once: gone reads 「这件活已经不在了。」 alone, a failed read only why
 * (the job may still be there). */
export function jobPanelEmpty(input: { loading: boolean; gone: boolean; error: string }): {
  title: string;
  line: string;
  error: string;
} {
  const words = t.jobs.panel;
  if (input.loading) return { title: words.loading, line: "", error: "" };
  if (input.gone || !input.error) return { title: words.title, line: words.gone, error: "" };
  return { title: words.title, line: "", error: input.error };
}

/** GET /api/agent/jobs/:id: the job and what its accounts did for it, newest first. */
export function normalizeJobDetail(
  payload: unknown,
): { job: JobView; actions: JobAction[] } | null {
  const value = record(payload);
  const job = normalizeJob(value.job);
  if (!job) return null;
  const actions = (Array.isArray(value.actions) ? value.actions : []).flatMap((item) => {
    const entry = record(item);
    const action = str(entry.action);
    const at = str(entry.at);
    if (!action || !at) return [];
    return [
      {
        account: str(entry.account) ?? "",
        environmentId: str(entry.environmentId) ?? "",
        site: str(entry.site),
        action,
        permalink: str(entry.permalink),
        target: str(entry.target),
        at,
      },
    ];
  });
  return { job, actions };
}

/** The live panel's 「活」 group (open jobs, oldest first) and 已归档的活 (newest first). */
export function railJobs(jobs: readonly JobView[]) {
  const open = jobs.filter((job) => !job.archivedAt);
  const archived = jobs
    .filter((job) => !!job.archivedAt)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  return { open, archived };
}

/** An account's state on a job in the owner's words: 已派 / 在做 / 没接 / 做完了 / 不做了. */
export function assigneeWord(item: JobView["assignees"][number]): string {
  if (item.status === "dropped") return t.jobs.dropped[item.dropped ?? "owner"];
  return t.jobs.status[item.status];
}
/** The space's founder, so a job given to it says so: 「派给了创始人 Ann」. */
export interface FounderRef {
  environmentId: string | null;
  name: string;
}
/** Whether an assignee (by its account id when known, else by name) is the founder. */
export function isFounder(
  founder: FounderRef | null | undefined,
  name: string,
  environmentId?: string | null,
): boolean {
  if (!founder) return false;
  if (environmentId && founder.environmentId) return environmentId === founder.environmentId;
  return !!name.trim() && name.trim().toLowerCase() === founder.name.trim().toLowerCase();
}
/** An assignee's name as the cards say it: 「创始人 Ann」 for the founder. */
export function assigneeName(
  founder: FounderRef | null | undefined,
  name: string,
  environmentId?: string | null,
): string {
  return isFounder(founder, name, environmentId) ? t.jobs.founderName(name) : name;
}
/** 「派给 Nova、Pop」 or 「派给所有号」 (an everyone job also lists who has it now); the
 * founder named as 「创始人 Ann」. */
export function jobToLine(job: JobView, founder?: FounderRef | null): string {
  const names = job.assignees
    .filter((item) => item.status !== "dropped")
    .map((item) => assigneeName(founder, item.name, item.envId))
    .join(t.jobs.nameSep);
  return job.everyone ? t.jobs.toEveryone(names) : t.jobs.to(names || t.jobs.nobody);
}
/** 「2 个在做 / 1 个没接 / 1 个做完了」: only the counts that are not zero. */
export function jobCountsLine(job: JobView): string {
  const count = (wanted: JobAssigneeStatus[]) =>
    job.assignees.filter((item) => wanted.includes(item.status)).length;
  const parts = [
    [count(["assigned", "taken"]), t.jobs.counts.working],
    [count(["declined"]), t.jobs.counts.declined],
    [count(["done"]), t.jobs.counts.done],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => word(n))
    .join(t.jobs.countSep);
}
/** One row of the 活 group: 「活名 · 期限 · 派给 … · 2 个在做 / 1 个没接」. */
export function jobRowLine(
  job: JobView,
  founder?: FounderRef | null,
): { title: string; detail: string } {
  const parts = [job.due ? job.due.text : "", jobToLine(job, founder), jobCountsLine(job)].filter(
    Boolean,
  );
  return { title: job.title, detail: parts.join(t.common.sep) };
}
/** The account detail's 手上的活: each job given to the account here, open first. */
export function accountJobLines(jobs: readonly JobView[], environmentId: string) {
  return jobs
    .flatMap((job) => {
      const own = job.assignees.find((item) => item.envId === environmentId);
      if (!own || (job.archivedAt && own.status !== "done")) return [];
      const state =
        own.status === "declined" && own.reason
          ? t.jobs.declinedWith(own.reason)
          : assigneeWord(own);
      return [
        {
          jobId: job.id,
          archived: !!job.archivedAt,
          line: [job.title, job.due?.text ?? "", state].filter(Boolean).join(t.common.sep),
        },
      ];
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived));
}

/** What a notice card (a report with `notice`) says, in the owner's words. */
export function noticeText(report: Pick<ChatReport, "text" | "notice">): string {
  const notice = report.notice as ChatReportNotice;
  const words = t.jobs.cards;
  switch (notice.kind) {
    case "job_declined":
      return words.declined(
        notice.account ?? "",
        notice.jobTitle ?? "",
        notice.reason || report.text,
      );
    case "job_taken":
      return words.taken(notice.account ?? "", notice.jobTitle ?? "");
    case "job_done":
      return words.done(notice.jobTitle ?? "");
    // A project's request in the hall; a project's line pointing there.
    case "founder_request":
      return `${t.group.ops(notice.project ?? null)}：@${t.group.founderTag} ${notice.account ?? ""} ${t.group.request(notice.jobTitle ?? "")}`;
    case "in_hall":
      return t.group.inHallNamed(notice.account ?? "", notice.jobTitle ?? "");
    // The owner has been away: the question, then the pause, in the hall's words.
    case "owner_away":
      return report.text;
    // The founder asks a project's 运营专员 to carry its work on.
    case "project_request":
      return `${t.group.founderTag} ${notice.account ?? ""}：@${t.group.ops(notice.project ?? null)} ${t.group.request(notice.jobTitle ?? "")}`;
    case "persona":
      return words.persona(
        notice.account ?? "",
        notice.version ?? 0,
        (notice.changed ?? [])
          .map((part) => t.persona.fields[part as keyof typeof t.persona.fields] ?? part)
          .join(t.jobs.nameSep),
        notice.reason ?? "",
      );
  }
}
/** The three things the owner may say to a declined job's card (said in the chat for him, not an
 * approval): another account, change its persona (left for him to finish), or have it take the
 * job anyway. */
export function declinedSayings(notice: ChatReportNotice, jobs?: readonly JobView[]) {
  // Against the project's jobs: only while the job is open and the account still has it
  // declined; once it is done, archived, given again or taken off, there is nothing to say.
  if (jobs) {
    const job = jobs.find((item) => item.id === notice.jobId);
    const own = job?.assignees.find((item) => item.envId === notice.environmentId);
    if (!job || job.archivedAt || job.status !== "open" || own?.status !== "declined") return [];
  }
  const say = t.jobs.cards.say;
  const account = notice.account ?? "";
  const title = notice.jobTitle ?? "";
  return [
    { label: t.jobs.cards.quick.otherAccount, text: say.otherAccount(title, account), send: true },
    { label: t.jobs.cards.quick.editPersona, text: say.editPersona(account), send: false },
    { label: t.jobs.cards.quick.insist, text: say.insist(title, account), send: true },
  ];
}

/** The chat's job tools' result (create_job, assign_job, update_job, close_job): the job as the
 * server says it is now, or the error. */
export interface JobToolView {
  jobId: string | null;
  title: string;
  names: string[];
  everyone: boolean;
  reason: string;
  insisted: string[];
  status: "open" | "done" | null;
  error: string;
  /** create_job made a job for everyone in a project with no account yet. */
  waitsForFirstAccount: boolean;
  /** The project a job made in the hall is for. */
  project: string | null;
}
export function jobToolView(result: unknown): JobToolView {
  let value: unknown = result;
  if (typeof value === "string")
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  const job = record(value);
  const accounts = Array.isArray(job.accounts) ? job.accounts : [];
  return {
    jobId: str(job.jobId),
    title: str(job.title) ?? "",
    names: accounts.flatMap((item) => {
      const entry = record(item);
      const name = str(entry.name);
      return name && entry.status !== "dropped" ? [name] : [];
    }),
    everyone: job.everyone === true,
    reason: str(job.reason) ?? "",
    insisted: Array.isArray(job.insisted)
      ? job.insisted.filter((item): item is string => typeof item === "string")
      : [],
    status: job.status === "done" ? "done" : job.status === "open" ? "open" : null,
    error: str(job.error) ?? "",
    waitsForFirstAccount: job.waitsForFirstAccount === true,
    project: str(job.project) ?? null,
  };
}
/** Under a job made while the project had no account, the card first
 * offers to add one (an unassigned account, or a new one); once the project has accounts it
 * offers one saying that hands them the job and asks the chat for the sign-ins it needs. */
export type AccountGuide =
  | { stage: "none" }
  | { stage: "add" }
  | { stage: "ready"; names: string[]; say: string };
export function accountGuide(
  name: JobToolName,
  view: JobToolView,
  accounts: { name: string }[],
  loading: boolean,
): AccountGuide {
  if (name !== "create_job" || !view.waitsForFirstAccount || !view.jobId || view.status === "done")
    return { stage: "none" };
  if (loading && !accounts.length) return { stage: "none" };
  if (!accounts.length) return { stage: "add" };
  const names = accounts.map((item) => item.name);
  return { stage: "ready", names, say: t.jobs.guide.say(view.title, names.join(t.jobs.nameSep)) };
}
/** The card line of a chat job tool: 新活「…」派给了 …。 / 「…」又派给了 … / 「…」结束了。 The
 * founder reads as 「派给了创始人 Ann」 (the tool's result names accounts only by name). */
export function jobToolLine(
  name: JobToolName,
  view: JobToolView,
  founder?: FounderRef | null,
): string {
  const words = t.jobs.cards;
  const said = (list: string[]) =>
    list.map((item) => assigneeName(founder, item)).join(t.jobs.nameSep);
  const names = said(view.names);
  switch (name) {
    case "create_job":
      return view.everyone ? words.newJobEveryone(view.title) : words.newJob(view.title, names);
    case "assign_job":
      return view.insisted.length
        ? words.insisted(view.title, said(view.insisted))
        : words.assigned(view.title, names || t.jobs.nobody);
    case "update_job":
      return words.updated(view.title);
    case "close_job":
      return words.closed(view.title);
  }
}
export type JobToolName = "create_job" | "assign_job" | "update_job" | "close_job";
