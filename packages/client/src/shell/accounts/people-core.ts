/**
 * The 账号与代理 page in the members-bar manner. Each
 * account is a person: a large avatar with its state ring, its name, the one line of what it is
 * doing and its 经营循环 (members-core); no table, no columns, no counts. A card only where the
 * owner has to judge something (an account flag only the owner can act on); everything else is
 * a quiet row. Group headings are names only (「acmeskills」, 「未分配」), never 「(3)」.
 * No react-native imports: node:test pins it (apps/mobile/test/shell-people.test.ts).
 */
import {
  accountLine,
  accountRoutine,
  accountState,
  type MemberState,
} from "../members/members-core.ts";
import { type AccountModel, needText } from "../model.ts";
import { t } from "../strings.ts";
import type { AccountGroup } from "./accounts-core.ts";

export interface PersonRow {
  id: string;
  name: string;
  /** The account label when it says more than the name. */
  label: string | null;
  initial: string;
  founder: boolean;
  state: MemberState;
  line: string;
  routine: string | null;
  desktopOn: boolean;
}

/** One account as a person on the page. `unknown`: another project's account, whose tasks this
 * page does not read: its line says where to look instead of 「停着」. `stalled`: the worker has
 * no heartbeat (ShellData.stalled), so nothing reads as running. */
export function personRow(
  account: AccountModel,
  now: number,
  { unknown = false, stalled }: { unknown?: boolean; stalled: boolean },
): PersonRow {
  return {
    id: account.id,
    name: account.name,
    label: account.label,
    initial: account.name.trim().charAt(0).toUpperCase(),
    founder: account.view.founder === true,
    state: unknown && !account.flags.length ? "idle" : accountState(account, stalled),
    line:
      unknown && !account.flags.length
        ? t.accountsPage.nowOtherProject
        : accountLine(account, now, stalled),
    routine: accountRoutine(account, now),
    desktopOn: account.desktop === "running",
  };
}

/** A card for a judgment only the owner can make: the account and what it needs, in words. */
export interface JudgmentCard {
  id: string;
  name: string;
  text: string;
}
/** The cards at the top of the page: one per account with a flag (its first, the most urgent),
 * by name. Nothing else gets a card. */
export function judgmentCards(accounts: readonly AccountModel[]): JudgmentCard[] {
  return accounts
    .filter((account) => account.flags.length > 0)
    .map((account) => ({
      id: account.id,
      name: account.name,
      text: needText(account.flags[0] as AccountModel["flags"][number], account.view),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A group's heading without its count: the project (or 未分配), the exit with its project, or
 * 代理读不出 / 没设代理. */
export function plainGroupTitle(
  group: AccountGroup,
  names: { projectName: (projectId: string | null) => string; exitLabel: (exit: string) => string },
): string {
  const p = t.accountsPage;
  switch (group.kind) {
    case "project":
      return names.projectName(group.projectId ?? null);
    case "founder":
      return p.founderPlace;
    case "unassigned":
      return p.unassigned;
    case "exit":
      return p.exitPlain(
        names.exitLabel(group.exit ?? ""),
        group.place ?? names.projectName(group.projectId ?? null),
      );
    case "unreadable":
      return p.unreadableGroup;
    case "noProxy":
      return p.noProxyGroup;
  }
}
