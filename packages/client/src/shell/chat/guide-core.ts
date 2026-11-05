/**
 * The chat's guidance cards with no computer: there are none. No site login, code or step on a
 * desktop is ever asked of the owner, so no need has a card and no desktop has a step to do.
 */
import type { AccountFlag, NeedItem, OwnerSiteStatus } from "../model.ts";

/** A step finished on a member's desktop; never with no computer. */
export interface DesktopNeed {
  site: string;
  status: OwnerSiteStatus;
  shot: string | null;
}
export function desktopNeed(
  _flags: readonly AccountFlag[],
  _shotOf: (site: string) => string | null,
): DesktopNeed | null {
  return null;
}
export function desktopNeedTitle(need: Pick<DesktopNeed, "site" | "status">): string {
  return need.site;
}
export function desktopStep(_status: string): string | null {
  return null;
}
/** The keys of the chat cards for `item`: none. */
export function needGuideKeys(_item: NeedItem): string[] {
  return [];
}
/** Which of a need's flags the chat asks with a card (none) and which stand as they are. */
export function needInChat(item: NeedItem): { asked: AccountFlag[]; other: AccountFlag[] } {
  if (item.kind !== "account" && item.kind !== "project") return { asked: [], other: [] };
  return { asked: [], other: [...item.flags] };
}
/** The chat cards for these needs: none. */
export function needGuides(_needs: readonly NeedItem[]): { key: string }[] {
  return [];
}
