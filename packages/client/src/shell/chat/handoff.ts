// v1.2: in a group, a handoff is one small line — who took it, and when it is done, that it
// came back here. A one-to-one chat keeps the full card.
import type { ChatReportNotice } from "../../../../../packages/domain/src/agent.ts";

export function handoffLine(
  notice: Pick<ChatReportNotice, "kind" | "jobTitle" | "account">,
): string | null {
  const title = notice.jobTitle?.trim() ? `「${notice.jobTitle.trim()}」` : "";
  const who = notice.account?.trim() ?? "";
  if (notice.kind === "job_taken") return `${who || "成员"} 接了${title}`;
  if (notice.kind === "job_done") return `${who ? `${who} 做完了` : "做完了"}${title}，回到这里`;
  return null;
}

/** v1.2 design: one line in her conversation when a routine is created. */
export function routineCreatedLine(name: string, when: string, title: string): string {
  const job = title.trim();
  if (!job) return "";
  const who = name.trim() || "成员";
  const schedule = when.trim();
  return schedule ? `${who} 新建了例行 · ${schedule} ${job}` : `${who} 新建了例行 · ${job}`;
}

/** v1.2 design: a group handoff is one line, who gave the work to whom. */
export function assignedLine(
  giver: string,
  title: string,
  receivers: readonly string[],
): string | null {
  const who = receivers.map((name) => name.trim()).filter((name) => name.length > 0);
  const job = title.trim();
  const from = giver.trim();
  if (!from || !job || who.length === 0) return null;
  return `${from} 把「${job}」交给了 ${who.join("、")}`;
}

/** One line for a task in the simple-view group, even when nobody was named. */
export function groupTaskLine(giver: string, title: string, receivers: readonly string[]): string {
  const named = assignedLine(giver, title, receivers);
  if (named) return named;
  const from = giver.trim() || "Yuki";
  const job = title.trim() || "这件事";
  return `${from} 安排了「${job}」`;
}

/** The simple-view group keeps this one line. The pro view keeps its card. */
export function groupKeepsOneLine(
  pro: boolean,
  inGroup: boolean,
  line: string | null,
): string | null {
  if (pro || !inGroup) return null;
  const text = line?.trim() ?? "";
  return text || null;
}
