/** Phase C: a member's state (members-core.ts) as the class of its dot or ring in app.css. */
import type { MemberState } from "@m/shell/members/members-core";

export const dotOf: Record<MemberState, "need" | "block" | "run" | "wait" | "idle"> = {
  needs: "need",
  blocked: "block",
  running: "run",
  waiting: "wait",
  idle: "idle",
};
