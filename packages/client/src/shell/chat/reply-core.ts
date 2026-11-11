/**
 * Which of a reply's tool calls are its result, shown as they are, and which are its
 * steps (reading mail or a page, searching, the desktop, reading status), folded into one line the
 * person opens when they want to see how it got there.
 */

/** Tools whose card is what the reply did or asks: the work handed on, a job, a project, a card the
 * person answers, something saved. Every other tool is a step. */
const resultTools = new Set([
  // The picture a member took for the person (open build): shown, not folded into the steps.
  "computer_screenshot",
  "delegate_task",
  "redirect_task",
  "pause_task",
  "resume_task",
  "create_job",
  "assign_job",
  "update_job",
  "close_job",
  "create_project",
  "request_credential",
  "present_choices",
  "create_goal",
  "watch_page",
  "remember_fact",
]);

export function isResultTool(name: string): boolean {
  return resultTools.has(name);
}

/** A reply's tool calls in their order, split into its result and its steps. `isResult` decides
 * by the call itself when given (v1.7.6: a routing that found no such group shows its button). */
export function splitToolCalls<T extends { function: { name: string } }>(
  calls: readonly T[],
  isResult: (call: T) => boolean = (call) => isResultTool(call.function.name),
): { result: T[]; steps: T[] } {
  const result: T[] = [];
  const steps: T[] = [];
  for (const call of calls) (isResult(call) ? result : steps).push(call);
  return { result, steps };
}
