/**
 * Who says each item of the project
 * conversation. The person is on the right; the project's AI is its 运营专员; a report, a stop
 * report and a job's taken/declined notice are said by the account they are about (the founder
 * marked as such); a request the 运营专员 makes reads 「@创始人 Ann 请：…」. Words only: what the
 * server records and decides is unchanged.
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import { speakerInitial } from "../founder/founder-core.ts";
import {
  type FounderRef,
  isFounder,
  type JobToolName,
  type JobToolView,
} from "../jobs/jobs-core.ts";
import { t } from "../strings.ts";

export type GroupSpeaker =
  | { kind: "owner" }
  | { kind: "ops"; name: string }
  | { kind: "account"; name: string; initial: string; founder: boolean; environmentId?: string }
  | { kind: "silent" };

/** An account as the chat knows it: its name and whether it is the space's founder. */
export interface SpeakerAccount {
  id?: string | null;
  name: string;
  view?: { founder?: boolean };
}

export interface SpeakerLookup {
  ops: string;
  /** The account a task runs on, when this project has the task and it is bound to one. */
  accountOfTask: (taskId: string) => SpeakerAccount | null;
  founder: FounderRef | null;
}

type Item =
  | {
      type: "message";
      message: { role: string; content?: unknown; toolCalls?: readonly unknown[] };
    }
  | { type: "reports"; reports: readonly ChatReport[] }
  | { type: "need"; report: ChatReport }
  | { type: "notice"; report: ChatReport };

const accountSpeaker = (
  name: string,
  founder: boolean,
  environmentId?: string | null,
): Extract<GroupSpeaker, { kind: "account" }> => ({
  kind: "account",
  name,
  initial: speakerInitial(name),
  founder,
  ...(environmentId ? { environmentId } : {}),
});

/** The account that speaks a report: the task's account, else the account the report names
 * itself (the founder's copy in the project that gave the job), else the 运营专员. */
export function reportSpeakerIn(report: ChatReport, lookup: SpeakerLookup): GroupSpeaker {
  const account = lookup.accountOfTask(report.taskId);
  const name = account?.name.trim();
  if (account && name)
    return accountSpeaker(
      name,
      account.view?.founder === true || isFounder(lookup.founder, name, account.id ?? null),
      account.id,
    );
  const own = report.speaker?.name?.trim();
  if (own) return accountSpeaker(own, report.speaker?.founder === true);
  return { kind: "ops", name: lookup.ops };
}

/** Who says one transcript item (see the file comment). */
export function itemSpeaker(item: Item, lookup: SpeakerLookup): GroupSpeaker {
  if (item.type === "message") {
    const { message } = item;
    if (message.role === "user") return { kind: "owner" };
    const says =
      (typeof message.content === "string" && message.content.trim() !== "") ||
      (Array.isArray(message.toolCalls) && message.toolCalls.length > 0);
    return says ? { kind: "ops", name: lookup.ops } : { kind: "silent" };
  }
  if (item.type === "reports") {
    const latest = item.reports.at(-1);
    return latest ? reportSpeakerIn(latest, lookup) : { kind: "ops", name: lookup.ops };
  }
  if (item.type === "need") return reportSpeakerIn(item.report, lookup);
  const notice = item.report.notice;
  const account = notice?.account?.trim();
  if ((notice?.kind === "job_taken" || notice?.kind === "job_declined") && account)
    return accountSpeaker(
      account,
      isFounder(lookup.founder, account, notice.environmentId ?? null),
      notice.environmentId,
    );
  // In the hall a project's request is said by that project's 运营专员;
  // in a project the line pointing to the hall is the founder's.
  if (notice?.kind === "founder_request" && notice.project)
    return { kind: "ops", name: t.group.ops(notice.project) };
  if (notice?.kind === "in_hall" && account) return accountSpeaker(account, true);
  // The founder asks a project's 运营专员 to carry its work on.
  if (notice?.kind === "project_request" && account) return accountSpeaker(account, true);
  if (notice?.kind === "owner_away" && account) return accountSpeaker(account, true);
  return { kind: "ops", name: lookup.ops };
}

/** One rule for who speaks in a conversation.
 * In the 营销总群 each item keeps its speaker (总群助理, a project's 运营专员, an account); a
 * project's own conversation is the plain chat, so all that is not the person's is said by its
 * assistant, `ops` (the project's 运营专员). Never the product's name, never nameless. */
export function conversationSpeaker(
  speaker: GroupSpeaker,
  hall: boolean,
  ops: string,
): GroupSpeaker {
  if (speaker.kind === "owner" || speaker.kind === "silent") return speaker;
  if (hall) return speaker.kind === "ops" && !speaker.name ? { kind: "ops", name: ops } : speaker;
  return { kind: "ops", name: ops };
}

export interface GroupTurn {
  speaker: GroupSpeaker;
  /** The avatar and the name show on the first of one speaker's consecutive items only. */
  head: boolean;
}
// Two 运营专员 (the hall's assistant and a project's) are two speakers.
const speakerKey = (speaker: GroupSpeaker) =>
  speaker.kind === "account" || speaker.kind === "ops"
    ? `${speaker.kind}:${speaker.name}`
    : speaker.kind;

/** Each item's speaker and whether it starts that speaker's run; a silent item neither takes
 * nor breaks a run. */
export function groupTurns(speakers: readonly GroupSpeaker[]): GroupTurn[] {
  let previous: string | null = null;
  return speakers.map((speaker) => {
    if (speaker.kind === "silent") return { speaker, head: false };
    const key = speakerKey(speaker);
    const head = key !== previous;
    previous = key;
    return { speaker, head };
  });
}

/** A job tool in the 运营专员's words: the accounts it asks (「创始人 Ann」 for the founder,
 * 「所有号」 for everyone) and what it asks for. */
export function opsRequest(
  name: JobToolName,
  view: Pick<JobToolView, "title" | "names" | "everyone" | "insisted"> & {
    project?: string | null;
  },
  founder: FounderRef | null,
): { mentions: string[]; text: string } {
  const words = t.group;
  const said = (names: readonly string[]) =>
    names.map((item) => (isFounder(founder, item) ? `${t.group.founderTag} ${item}` : item));
  switch (name) {
    case "create_job":
    case "assign_job": {
      const names = name === "assign_job" && view.insisted.length ? view.insisted : view.names;
      const mentions = view.everyone && name === "create_job" ? [words.everyone] : said(names);
      // A job made in the hall names the project it is for.
      return {
        mentions,
        text: view.project ? words.requestFor(view.title, view.project) : words.request(view.title),
      };
    }
    case "update_job":
      return { mentions: said(view.names), text: words.updated(view.title) };
    case "close_job":
      return { mentions: [], text: words.closed(view.title) };
  }
}

/** A job notice in the voice of who says it: the account that took or declined it, the
 * 运营专员 for a job done. Null for a notice this does not word (a persona change). */
export function noticeSays(report: Pick<ChatReport, "text" | "notice">): string | null {
  const notice = report.notice;
  if (!notice) return null;
  const title = notice.jobTitle ?? "";
  switch (notice.kind) {
    case "job_taken":
      return t.group.taken(title);
    case "job_declined":
      return t.group.declined(title, notice.reason || report.text);
    case "job_done":
      return t.group.done(title);
    case "in_hall":
      return t.group.inHall(title);
    default:
      return null;
  }
}

export interface GroupMember {
  key: string;
  name: string;
  initial: string;
  kind: "ops" | "account";
  founder: boolean;
  /** The account's id, to open its detail; none for the 运营专员. */
  environmentId?: string;
}
/** The hall's members: its assistant, the founder, each project's 运营专员. */
export function hallMembers(
  founder: FounderRef | null,
  projects: readonly { id: string; name: string }[],
): GroupMember[] {
  return [
    { key: "ops", name: t.group.hallOps, initial: "", kind: "ops", founder: false },
    ...(founder
      ? [
          {
            key: `founder:${founder.environmentId ?? founder.name}`,
            name: founder.name,
            initial: speakerInitial(founder.name),
            kind: "account" as const,
            founder: true,
            ...(founder.environmentId ? { environmentId: founder.environmentId } : {}),
          },
        ]
      : []),
    ...projects.map((project) => ({
      key: `project:${project.id}`,
      name: t.group.ops(project.name),
      initial: "",
      kind: "ops" as const,
      founder: false,
    })),
  ];
}
/** The members bar: the 运营专员 first, then the founder, then the project's accounts. */
export function groupMembers(
  ops: string,
  accounts: readonly { id: string; name: string; view?: { founder?: boolean } }[],
  founder: FounderRef | null,
): GroupMember[] {
  const own = accounts.map((account) => ({
    key: `account:${account.id}`,
    name: account.name,
    initial: speakerInitial(account.name),
    kind: "account" as const,
    founder: account.view?.founder === true || isFounder(founder, account.name, account.id),
    environmentId: account.id,
  }));
  const founderHere = own.some((member) => member.founder);
  const founderMember: GroupMember[] =
    founder && !founderHere
      ? [
          {
            key: `founder:${founder.environmentId ?? founder.name}`,
            name: founder.name,
            initial: speakerInitial(founder.name),
            kind: "account",
            founder: true,
            ...(founder.environmentId ? { environmentId: founder.environmentId } : {}),
          },
        ]
      : [];
  const ordered = [...own.filter((m) => m.founder), ...own.filter((m) => !m.founder)];
  return [
    { key: "ops", name: ops, initial: "", kind: "ops", founder: false },
    ...founderMember,
    ...ordered,
  ];
}

/** What the hall's tool result says it handed to a project
 * (delegate_task with project) or made (create_project); null for anything else. */
export function projectRef(result: unknown): {
  id: string | null;
  name: string;
  created: boolean | null;
  title: string | null;
  account: string | null;
} | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof item[key] === "string" && item[key] ? (item[key] as string) : null;
  // create_project: { project: { id, name }, created }
  if (item.project && typeof item.project === "object") {
    const made = item.project as Record<string, unknown>;
    if (typeof made.name !== "string" || !made.name) return null;
    return {
      id: typeof made.id === "string" ? made.id : null,
      name: made.name,
      created: item.created === true,
      title: null,
      account: null,
    };
  }
  // delegate_task with project: the task, with project, projectId and account.
  const name = text("project");
  if (!name) return null;
  return {
    id: text("projectId"),
    name,
    created: null,
    title: text("title"),
    account: text("account"),
  };
}

/** v1.2: in her own chat the assistant's words are hers, not the group's. */
export function memberVoice(
  speaker: GroupSpeaker,
  member: { id: string; name: string } | null,
): GroupSpeaker {
  if (!member || speaker.kind !== "ops") return speaker;
  const name = member.name.trim();
  if (!name) return speaker;
  return {
    kind: "account",
    name,
    initial: name.slice(0, 1),
    founder: false,
    environmentId: member.id,
  };
}

/** v1.2: her own chat is not the group, even when she belongs to the hall. The group chat is. */
export function inGroupChat(input: { hall: boolean; pro: boolean; memberOpen: boolean }): boolean {
  if (!input.pro && input.memberOpen) return false;
  return input.hall || !input.pro;
}
