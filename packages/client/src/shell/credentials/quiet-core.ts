/**
 * The credentials page in the members-bar manner. A
 * card only where the owner has to judge: what a task asked for (待补) and a credential whose
 * last use failed or that cannot be read any more. Everything else is a quiet row (what it is,
 * one line under it); the times and the actions show when the row is opened. Site logins sit
 * under the account that uses them, with its face; empty groups are not shown, nothing counts.
 * No react-native imports: node:test pins it (apps/mobile/test/shell-people.test.ts).
 */
import type { CredentialView } from "../../../../../packages/domain/src/credentials.ts";
import { t } from "../strings.ts";
import {
  type CredentialList,
  credentialSections,
  entryWhat,
  lastResultLine,
  usedByLine,
} from "./credentials-core.ts";

/** The owner has to look at it: its last use failed, or it cannot be read with the current key. */
export function needsJudgment(entry: Pick<CredentialView, "lastResult" | "unreadable">): boolean {
  return !!entry.unreadable || (!!entry.lastResult && !entry.lastResult.ok);
}

/** The judgment card's line: what it is, then what went wrong. */
export function judgmentLine(entry: CredentialView): string {
  return `${entryWhat(entry)}${t.common.sep}${
    entry.unreadable ? t.credentials.unreadable : lastResultLine(entry)
  }`;
}

/** The quiet line under a row: where a mailbox is used; how a login went the last time
 * (its group already names the account). */
export function quietLine(entry: CredentialView): string {
  if (entry.kind === "site_login")
    return entry.lastResult ? lastResultLine(entry) : usedByLine(entry);
  return usedByLine(entry);
}

export interface QuietGroup {
  key: string;
  title: string;
  /** A login group of one account: its face. */
  account: { name: string; initial: string } | null;
  entries: CredentialView[];
}

/** The quiet groups: 发信邮箱, then each account's logins (by name) and 本项目用;
 * entries that have a judgment card are not repeated here, and empty groups are left out. */
export function quietGroups(list: CredentialList): QuietGroup[] {
  const c = t.credentials;
  return credentialSections(list)
    .map((section) => {
      const accountKey = section.key.startsWith("logins:account:");
      const prefix = `${c.groups.logins} · `;
      const name = section.title.startsWith(prefix)
        ? section.title.slice(prefix.length)
        : section.title;
      return {
        key: section.key,
        title: section.key.startsWith("logins:") ? name : section.title,
        account: accountKey ? { name, initial: name.trim().charAt(0).toUpperCase() } : null,
        entries: section.entries.filter((entry) => !needsJudgment(entry)),
      };
    })
    .filter((group) => group.entries.length > 0);
}

/** The entries that get a judgment card, by what they are. */
export function judgedEntries(list: CredentialList): CredentialView[] {
  return list.entries
    .filter(needsJudgment)
    .sort((a, b) => entryWhat(a).localeCompare(entryWhat(b)));
}
