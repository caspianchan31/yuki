/**
 * When each turn of a conversation happened, and so when each of its messages was said: what the
 * chat's timeline places things by.
 */
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** One turn of the conversation in time, as GET
 * /api/copilotkit/threads/:id/turns gives it: when the person's message was sent (`at`), when
 * the reply ended (`end`, null while it runs) and the messages the turn brought (the person's
 * first). */
export interface TurnTime {
  /** The run (v1.6 聊天基础动作: a superseded stretch folds before its anchor run's first message). */
  runId: string | null;
  at: string;
  end: string | null;
  messages: string[];
}
/** GET …/turns, read defensively (a turn without a readable time is left out). */
export function normalizeTurns(payload: unknown): TurnTime[] {
  const list = record(payload).turns;
  return (Array.isArray(list) ? list : []).flatMap((raw): TurnTime[] => {
    const item = record(raw);
    const at = text(item.at);
    if (!at || Number.isNaN(Date.parse(at))) return [];
    const messages = Array.isArray(item.messages)
      ? item.messages.filter((id): id is string => typeof id === "string")
      : [];
    return [{ runId: text(item.runId), at, end: text(item.end), messages }];
  });
}
/**
 * When each of `messages` was said, as the start of its turn (ms): a reply shares its turn's
 * time, so nothing can stand between a question and its answer. A message the server has not
 * recorded yet (just sent, or the reply streaming now) takes the time of the message before it,
 * except a person's message, which was said after everything recorded (`Infinity`). `turns`
 * null (the server keeps no times): no message has a moment, so every card stands at the end.
 */
export function messageMoments(
  messages: readonly { id: string; role: string }[],
  turns: readonly TurnTime[] | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!turns) return out;
  const startOf = new Map<string, number>();
  for (const turn of turns) {
    const at = Date.parse(turn.at);
    for (const id of turn.messages) if (!startOf.has(id)) startOf.set(id, at);
  }
  let last = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const known = startOf.get(message.id);
    last = known !== undefined ? known : message.role === "user" ? Number.POSITIVE_INFINITY : last;
    out.set(message.id, last);
  }
  return out;
}
