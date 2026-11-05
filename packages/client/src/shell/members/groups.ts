// v1.2: a group is a project. A member is in one group at a time, so putting her in a group from
// another one is two moves (out to 未分配 in her group, then into the new one). The picking rules,
// the checks and the move loop live here so node:test pins them.
import {
  groupMembersMax,
  isReservedProjectName,
  projectNameMax,
} from "../../../../../packages/domain/src/projects.ts";
import { type MoveOutcome, type MoveStep, movePlan, runMove } from "../accounts/accounts-core.ts";
import { refusalText, t } from "../strings.ts";

export { groupMembersMax };

/** A new group needs at least this many members. */
export const newGroupMembersMin = 2;

const n = t.newGroup;

export interface GroupMember {
  id: string;
  name: string;
  projectId: string | null;
  founder: boolean;
  /** The face she was made with; absent: the one her name picks. */
  face?: unknown;
}

/** Every member the space knows: this project's own list first, then the rest of the topology. */
export function allMembers(input: {
  accounts: readonly { id: string; name: string; projectId: string | null; face?: unknown }[];
  environments: readonly { id: string; name: string; projectId: string | null; face?: unknown }[];
  founderId: string | null;
}): GroupMember[] {
  const seen = new Set<string>();
  const list: GroupMember[] = [];
  for (const item of [...input.accounts, ...input.environments]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    list.push({
      id: item.id,
      name: item.name,
      projectId: item.projectId ?? null,
      founder: input.founderId === item.id,
      face: item.face,
    });
  }
  return list;
}

export interface GroupChoice extends GroupMember {
  /** The name of the group she is in now; null: in no group. */
  group: string | null;
}

/** The members a group can take: not the founder, those in no group first, then by name. */
export function groupChoices(
  members: readonly GroupMember[],
  groupName: (projectId: string) => string,
): GroupChoice[] {
  return members
    .filter((member) => !member.founder)
    .map((member) => ({
      ...member,
      group: member.projectId === null ? null : groupName(member.projectId),
    }))
    .sort(
      (a, b) =>
        Number(a.group !== null) - Number(b.group !== null) || a.name.localeCompare(b.name, "zh"),
    );
}

/** Adds the member to the picks, or takes her out; a full list refuses a new one. */
export function togglePick(picked: readonly string[], id: string, max = groupMembersMax): string[] {
  if (picked.includes(id)) return picked.filter((item) => item !== id);
  return picked.length >= max ? [...picked] : [...picked, id];
}

/** Whether the member can still be ticked: she already is, or there is room. */
export function canPick(picked: readonly string[], id: string, max = groupMembersMax): boolean {
  return picked.includes(id) || picked.length < max;
}

/** What is wrong with the typed group name before it is sent; null when nothing is. */
export function groupNameProblem(name: string): string | null {
  const text = name.trim();
  if (!text) return n.nameRequired;
  if ([...text].length > projectNameMax) return n.nameTooLong(projectNameMax);
  if (isReservedProjectName(text)) return n.nameReserved(text);
  return null;
}

/** What is wrong with the form as a whole (the name, then the number of members). */
export function newGroupProblem(name: string, picked: readonly string[]): string | null {
  const problem = groupNameProblem(name);
  if (problem) return problem;
  if (picked.length < newGroupMembersMin) return n.tooFew(newGroupMembersMin);
  if (picked.length > groupMembersMax) return n.tooMany(groupMembersMax);
  return null;
}

/** A refusal of the group requests, in Chinese; the server's own Chinese passes through. */
export function groupError(message: string): string {
  let match = /^A project named "(.*)" already exists$/.exec(message);
  if (match) return n.exists(match[1]);
  match = /^Projects are limited to (\d+)$/.exec(message);
  if (match) return n.limit(Number(match[1]));
  if (message === "Name is required") return n.nameRequired;
  match = /^Name must be (?:at most )?(\d+) characters/.exec(message);
  if (match) return n.nameTooLong(Number(match[1]));
  match = /^Name "(.*)" is reserved/.exec(message);
  if (match) return n.nameReserved(match[1]);
  if (message === "Project not found") return t.projects.gone;
  return refusalText(message);
}

export interface MemberMove {
  id: string;
  name: string;
  /** The group she is in now; null: in none. */
  from: string | null;
}

export interface MembersMoved {
  moved: string[];
  failed: { id: string; name: string; error: string; stuck: boolean; from: string | null }[];
}

/**
 * Puts each member in the group, one after another so the server's size check sees the real
 * count. A move out of another group is two requests; when the second fails she is left in no
 * group (`stuck`), and a retry starts from there.
 */
export async function moveMembersInto(
  groupId: string,
  members: readonly MemberMove[],
  send: (id: string, step: MoveStep) => Promise<unknown>,
  errorText: (error: unknown) => string,
): Promise<MembersMoved> {
  const result: MembersMoved = { moved: [], failed: [] };
  for (const member of members) {
    const outcome: MoveOutcome = await runMove(
      movePlan(member.from, groupId),
      (step) => send(member.id, step),
      errorText,
    );
    if (outcome.state === "done") result.moved.push(member.id);
    else
      result.failed.push({
        id: member.id,
        name: member.name,
        error: outcome.error,
        stuck: outcome.state === "stuck",
        from: outcome.state === "stuck" ? null : member.from,
      });
  }
  return result;
}

/** The lines that tell the person which members did not get in, and why. */
export function failureLines(result: MembersMoved): string[] {
  return result.failed.map((item) =>
    item.stuck ? n.memberStuck(item.name, item.error) : n.memberFailed(item.name, item.error),
  );
}
