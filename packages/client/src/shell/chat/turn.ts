// v1.2: while a reply is running, a new message cuts it off and takes the turn. The single
// word 停 only stops; it is not sent on as a message.

export type ChatTurn = "ignore" | "stop" | "interrupt" | "send";

export function chatTurn(text: string, replying: boolean): ChatTurn {
  const trimmed = text.trim();
  if (!trimmed) return "ignore";
  if (replying && trimmed === "停") return "stop";
  if (replying) return "interrupt";
  return "send";
}
