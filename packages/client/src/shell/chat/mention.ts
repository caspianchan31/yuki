// v1.2: the @ list under the chat box. Pure parts: where an @ opens the list, which names it
// offers and how they are filtered, and what choosing one writes. The sent text is plain: the
// server finds a mention by its words, so nothing but "@name " is added to the box.
import type { AgentTask } from "../../../../../packages/domain/src/agent.ts";

export type MentionKind = "member" | "group" | "routine" | "skill" | "app";

export interface MentionOption {
  /** Unique within the list: kind plus the thing's id. */
  key: string;
  kind: MentionKind;
  name: string;
  /** A second line: the group a member is in. */
  hint: string;
  /** A member of the group the chat is in. */
  here: boolean;
}

/** An @ that opens the list: `start` is the index of the @, `query` what follows it up to the caret. */
export interface MentionTrigger {
  start: number;
  query: string;
}

/** A name is not longer than this; past it a typed @ is not a mention. */
const queryMax = 40;

/**
 * The @ the caret sits in, or null. The @ must open the text or follow whitespace (an email
 * address is not a mention), and the text after it may hold spaces (a name can) but no line break.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(before[start - 1] ?? "")) return null;
  const query = before.slice(start + 1);
  if (query.includes("\n") || query.length > queryMax) return null;
  return { start, query };
}

const sectionOf = (option: MentionOption) =>
  option.kind === "member"
    ? option.here
      ? 0
      : 1
    : option.kind === "group"
      ? 2
      : option.kind === "routine"
        ? 3
        : option.kind === "skill"
          ? 4
          : 5;

/** Options the query keeps: its words are in the name. They stay in the order of the list (this
 * group's members, other members, groups, routines, skills, apps); within one of those, names that start
 * with the query come first. */
export function filterMentions(options: readonly MentionOption[], query: string): MentionOption[] {
  const needle = query.toLowerCase();
  if (!needle) return [...options];
  const rank = (option: MentionOption) => {
    const name = option.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    return name.includes(needle) ? 1 : 2;
  };
  return options
    .map((option, index) => ({ option, index }))
    .filter((item) => rank(item.option) < 2)
    .sort(
      (a, b) =>
        sectionOf(a.option) - sectionOf(b.option) ||
        rank(a.option) - rank(b.option) ||
        a.index - b.index,
    )
    .map((item) => item.option);
}

/** Writes "@name " over the typed @ and its words; the caret goes after it. */
export function applyMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  const end = Math.max(trigger.start + 1, Math.min(caret, text.length));
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(end),
    caret: trigger.start + inserted.length,
  };
}

/** The next highlighted row for an arrow key; it wraps around. */
export function moveMentionIndex(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

export interface MentionSource {
  /** The main member, Yuki. */
  main: { id: string; name: string };
  members: readonly { id: string; name: string; projectId: string | null }[];
  groups: readonly { id: string; name: string }[];
  /** The tasks in the current scope. */
  tasks: readonly Pick<AgentTask, "id" | "title" | "repeatMinutes" | "status">[];
  /** The group the chat is in; null in the main chat. */
  groupId: string | null;
  /** Names a group by its id, for the line under a member. */
  groupName: (id: string) => string;
  /** The space's skills (v1.4). */
  skills?: readonly { id: string; name: string }[];
  /** The space's connected apps (v1.4, shell/apps.ts `mentionApps`). */
  apps?: readonly { id: string; name: string }[];
}

const ended = new Set(["succeeded", "cancelled"]);

/**
 * Everything an @ can name. In a group: its members first, then Yuki and the other members, then
 * the groups, then the routines of this scope, then the skills, then apps. In a one-on-one (or the main chat) the same list
 * with nobody ahead of the others. Names are written as they are, spaces included.
 */
export function mentionOptions(source: MentionSource): MentionOption[] {
  const member = (item: { id: string; name: string; projectId: string | null }) => ({
    key: `member:${item.id}`,
    kind: "member" as const,
    name: item.name,
    hint: item.projectId ? source.groupName(item.projectId) : "",
    here: !!source.groupId && item.projectId === source.groupId,
  });
  const inGroup = source.groupId
    ? source.members.filter((item) => item.projectId === source.groupId)
    : [];
  const others = source.members.filter((item) => !inGroup.includes(item));
  const options: MentionOption[] = [
    ...inGroup.map(member),
    {
      key: `member:${source.main.id}`,
      kind: "member",
      name: source.main.name,
      hint: "",
      here: false,
    },
    ...others.map(member),
    ...source.groups.map((group) => ({
      key: `group:${group.id}`,
      kind: "group" as const,
      name: group.name,
      hint: "",
      here: false,
    })),
    ...source.tasks
      .filter(
        (task) =>
          !ended.has(task.status) &&
          typeof task.repeatMinutes === "number" &&
          task.repeatMinutes > 0 &&
          task.title.trim(),
      )
      .map((task) => ({
        key: `routine:${task.id}`,
        kind: "routine" as const,
        name: task.title.trim(),
        hint: "",
        here: false,
      })),
    ...(source.skills ?? [])
      .filter((skill) => skill.name.trim())
      .map((skill) => ({
        key: `skill:${skill.id}`,
        kind: "skill" as const,
        name: skill.name.trim(),
        hint: "",
        here: false,
      })),
    ...(source.apps ?? []).map((app) => ({
      key: `app:${app.id}`,
      kind: "app" as const,
      name: app.name,
      hint: "",
      here: false,
    })),
  ];
  const seen = new Set<string>();
  return options.filter((option) => !seen.has(option.key) && !!seen.add(option.key));
}
