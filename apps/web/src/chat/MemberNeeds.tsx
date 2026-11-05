/**
 * v1.2: questions, reviews and account needs that used to live on 需要你, drawn in the
 * member's own conversation (or in the group when they have no member).
 */
import type { NeedItem } from "@m/shell/model";
import { NeedRow } from "../rail/NeedRow";

export function needEnvironment(item: NeedItem): string | null {
  if (item.kind === "task") return item.entry.environmentId ?? null;
  if (item.kind === "review") return item.entry?.environmentId ?? null;
  if (item.kind === "account") return item.account.id;
  return null;
}

export function MemberNeeds({ items }: { items: readonly NeedItem[] }) {
  if (!items.length) return null;
  return (
    <div className="member-needs">
      {items.map((item) => (
        <NeedRow key={item.key} item={item} />
      ))}
    </div>
  );
}
