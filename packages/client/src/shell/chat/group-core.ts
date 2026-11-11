/**
 * Who says each item of the project
 * conversation. The person is on the right; the project's AI is its 运营专员; a report, a stop
 * report and a job's taken/declined notice are said by the account they are about (the founder
 * marked as such); a request the 运营专员 makes reads 「@创始人 Ann 请：…」. Words only: what the
 * server records and decides is unchanged.
 */
import type { ChatReport } from "../../../../../packages/domain/src/agent.ts";
import { t } from "../strings.ts";
import { speakerInitial } from "./report-core.ts";

export type GroupSpeaker =
  | { kind: "owner" }
  | { kind: "ops"; name: string }
  | { kind: "account"; name: string; initial: string; environmentId?: string }
  | { kind: "silent" };

/** An account as the chat knows it. */
export interface SpeakerAccount {
  id?: string | null;
  name: string;
}

export interface SpeakerLookup {
  ops: string;
  /** The account a task runs on, when this project has the task and it is bound to one. */
  accountOfTask: (taskId: string) => SpeakerAccount | null;
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
  environmentId?: string | null,
): Extract<GroupSpeaker, { kind: "account" }> => ({
  kind: "account",
  name,
  initial: speakerInitial(name),
  ...(environmentId ? { environmentId } : {}),
});

/** The account that speaks a report: the task's account, else the account the report names
 * itself (the founder's copy in the project that gave the job), else the 运营专员. */
export function reportSpeakerIn(report: ChatReport, lookup: SpeakerLookup): GroupSpeaker {
  const account = lookup.accountOfTask(report.taskId);
  const name = account?.name.trim();
  if (account && name) return accountSpeaker(name, account.id);
  const own = report.speaker?.name?.trim();
  if (own) return accountSpeaker(own);
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
  const account = item.report.notice?.account?.trim();
  if (account) return accountSpeaker(account, item.report.notice?.environmentId);
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

/** What a notice card (a report with `notice`) says: an account's persona change in the owner's
 * words; any other notice (older conversations) says the words recorded with it. */
export function noticeText(report: Pick<ChatReport, "text" | "notice">): string {
  const notice = report.notice;
  if (notice?.kind !== "persona") return report.text;
  return t.jobs.cards.persona(
    notice.account ?? "",
    notice.version ?? 0,
    (notice.changed ?? [])
      .map((part) => t.persona.fields[part as keyof typeof t.persona.fields] ?? part)
      .join(t.jobs.nameSep),
    notice.reason ?? "",
  );
}

/** v1.7.6: the group a hall reply was routed to that does not exist (route_request's
 * `missingGroup`); null for anything else. The model never makes it: the person may, with a button. */
export function missingGroupRef(result: unknown): string | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const name = (value as Record<string, unknown>).missingGroup;
  return typeof name === "string" && name.trim() ? name.trim() : null;
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
    environmentId: member.id,
  };
}

/** v1.2: her own chat is not the group, even when she belongs to the hall. The group chat is. */
export function inGroupChat(input: { hall: boolean; pro: boolean; memberOpen: boolean }): boolean {
  if (!input.pro && input.memberOpen) return false;
  return input.hall || !input.pro;
}
