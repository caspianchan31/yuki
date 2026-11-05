/**
 * A member's account as a person: a large avatar with its state ring, its name, the one line of
 * what it is doing (members-core).
 * No react-native imports: node:test pins it (apps/mobile/test/shell-people.test.ts).
 */
import { accountLine, accountState, type MemberState } from "../members/members-core.ts";
import type { AccountModel } from "../model.ts";
import { t } from "../strings.ts";

export interface PersonRow {
  id: string;
  name: string;
  /** The account label when it says more than the name. */
  label: string | null;
  initial: string;
  state: MemberState;
  line: string;
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
    state: unknown && !account.flags.length ? "idle" : accountState(account, stalled),
    line:
      unknown && !account.flags.length
        ? t.accountsPage.nowOtherProject
        : accountLine(account, now, stalled),
    desktopOn: account.desktop === "running",
  };
}
