// every reply in the 营销总群 first says whose the request is, and the server holds it to that.
// The first model turn may only call route_request (forced by tool_choice); a request routed to a
// project leaves the reply only the tools that hand it over; one for no project gets every tool.
// v1.7.6: a project that does not exist is never made by the model: the reply only says so, and the
// person makes the group with the button under it (the 新建群 path), or not. The hall's duty is fixed by what it can call, not by its words.
import { type BaseEvent, EventType } from "@ag-ui/core";
import type { ChatMiddleware, ChatMiddlewareConfig } from "@tanstack/ai";
import { Observable } from "rxjs";
import { z } from "zod";
import { isEmptyProjectWord } from "../../../../packages/domain/src/projects.ts";

/** A model's way of saying "no project" is sometimes the word, not JSON null ("null", "none"):
 * that is no name (it once made a group called "null"). */
export const noProjectWord = (value: string | null | undefined): string | null =>
  value == null || !value.trim() || isEmptyProjectWord(value) ? null : value;

/** The hall's assistant. A model routing a request that is for no project sometimes names itself
 * as the project (with a group called Yuki in the space, Yuki's own routine went to that group). In the
 * hall, its own name is never a project: what is Yuki's is for no project. */
export const hallAssistantName = "Yuki";
export const routedProject = (value: string | null | undefined): string | null => {
  const name = noProjectWord(value);
  return name && name.trim().toLowerCase() === hallAssistantName.toLowerCase() ? null : name;
};

export const routeRequestSchema = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .nullable()
    .describe(
      "The project whose work this is, by name: the one named or @-ed, or, when none is, the one among the projects you judge it belongs to; a name not among the projects is never made by you (the person gets a button to make that group); null only when it is for no project",
    ),
  why: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "One sentence: why it is that project's (said to the person when it goes there), or why it is for no project (kept to yourself, never said)",
    ),
});

/** What a reply routed to a project may still call: make the project and hand the work over, and keep
 * a skill: skills belong to the space, shared by every project (docs/skills.md), so saving or reading
 * one is never a project's work, whatever the model judged the request to be (it routed 「保存技能」 to a
 * project and handed that over as a task, which could not save it)
 * A routine routed to a project is made in that project by create_routine (its `project`), as a task
 * is by delegate_task. */
export const handOverTools = new Set([
  "route_request",
  "delegate_task",
  "create_routine",
  "save_skill",
  "learn_skill",
  "use_skill",
]);

/** A connected app's tools (`app_<slug>__<tool>`, docs/apps.md) are the space's too: the hall line says
 * calling one is for no project, and a model that routed such a request to a project then hit
 * 「Unknown tool」 on the app's call and gave up. A read runs at once, a write is a card in this chat
 * that waits for the person (it needs no project's task). */
export const spaceOwnTool = (name: string) => handOverTools.has(name) || name.startsWith("app_");

/** Whose the reply's request is, once route_request has said so. `missing`: a group by that name
 * does not exist; nothing is made or handed over in this reply (v1.7.6). */
export interface HallGate {
  decided: null | { project: string } | { missing: string } | "none";
}

/** The project the reply's request was routed to, when it exists; null otherwise. */
export const routedName = (gate: HallGate): string | null =>
  gate.decided && gate.decided !== "none" && "project" in gate.decided
    ? gate.decided.project
    : null;

/** What every call is answered while the routed group does not exist (it did not run). */
export const missingGroupResult = (name: string) => ({
  notRun: true,
  error: `Not run: there is no group named ${name} yet, and nothing is made or handed over until the person makes it with the button under this reply. Say so in one short sentence and stop.`,
});

/** The tool_choice that forces route_request, in the request shape of the route (v1.7.6: the
 * Anthropic route takes { type: "tool", name }, passed through as it is by its adapter). */
export function forceRoute(chatCompletions: boolean, anthropic = false) {
  if (anthropic) return { type: "tool", name: "route_request" };
  return chatCompletions
    ? { type: "function", function: { name: "route_request" } }
    : { type: "function", name: "route_request" };
}
/** Whether a model spec goes through the Anthropic route. */
export const anthropicRoute = (spec: string) => /^anthropic[/:]/i.test(spec.trim());

/** What a call made before the request was routed is answered (it did not run): said so, so the model
 * makes it again after route_request. `notYet` also marks the answer for `hideUnroutedCalls`. */
export const notYetResult = {
  notYet: true,
  error:
    "Not run: this reply must first say whose the request is with route_request. Call this tool again now, after it has answered.",
};

export function hallGateMiddleware(
  gate: HallGate,
  chatCompletions: boolean,
  anthropic = false,
): ChatMiddleware {
  // The tools as the reply was given them: what one iteration returns is the next one's config.
  let all: ChatMiddlewareConfig["tools"] | null = null;
  return {
    name: "hall-gate",
    onConfig: (_ctx, config) => {
      all ??= config.tools;
      const tools = all;
      const { tool_choice: _, ...options } = (config.modelOptions ?? {}) as Record<string, unknown>;
      // The routing turn declares every tool but forces route_request: a call the model makes beside
      // it is answered by onBeforeToolCall ("not run, again after routing"), not by the SDK's
      // "Unknown tool", which a model took for the tool being gone and gave up on.
      if (gate.decided === null)
        return {
          tools,
          modelOptions: { ...options, tool_choice: forceRoute(chatCompletions, anthropic) },
        };
      if (gate.decided === "none")
        return {
          tools: tools.filter((tool) => tool.name !== "route_request"),
          modelOptions: options,
        };
      return {
        tools: tools.filter((tool) => spaceOwnTool(tool.name)),
        modelOptions: options,
      };
    },
    onBeforeToolCall: (_ctx, call) => {
      // The group does not exist: nothing runs for the rest of the reply, a second routing
      // neither (the tools stay declared: a route that holds tool calls in the conversation may
      // refuse a request that declares none).
      if (gate.decided && gate.decided !== "none" && "missing" in gate.decided)
        return { type: "skip", result: missingGroupResult(gate.decided.missing) };
      if (call.toolName === "route_request") return;
      if (gate.decided === null) return { type: "skip", result: notYetResult };
      // Declared in the routing turn, but a reply routed to a project may only hand the work over.
      if (gate.decided !== "none" && !spaceOwnTool(call.toolName))
        return {
          type: "skip",
          result: {
            error: `Not run: this request is a project's, so this reply only hands it over (delegate_task); ${call.toolName} runs in that project's task.`,
          },
        };
      return;
    },
  };
}

/** What the routing turn leaves out of the conversation: a route_request that found the request
 * for no project has nothing to show (its events are kept out of the conversation's stream, the
 * model's own turn still has it; one routed to a project passes as it is, for its line under the
 * reply); and so does a call to any other tool made in that same turn, where only route_request
 * is open: the model, told to hand the work over right after routing, often asks for both at
 * once, the second is answered "Unknown tool" and made again after the routing. That answer is a
 * detail of the gate, not something for the person to see. */
export function hideUnroutedCalls(
  source: Observable<BaseEvent>,
  gate: HallGate,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const held = new Map<string, { events: BaseEvent[]; early: boolean }>();
    const id = (event: BaseEvent) => (event as { toolCallId?: string }).toolCallId;
    const subscription = source.subscribe({
      next: (event) => {
        const callId = id(event);
        if (event.type === EventType.TOOL_CALL_START && callId) {
          const name = (event as { toolCallName?: string }).toolCallName;
          const missing = !!gate.decided && gate.decided !== "none" && "missing" in gate.decided;
          if (name === "route_request" || gate.decided === null || missing) {
            held.set(callId, { events: [event], early: name !== "route_request" || missing });
            return;
          }
        }
        const waiting = callId ? held.get(callId) : undefined;
        if (!waiting) {
          subscriber.next(event);
          return;
        }
        waiting.events.push(event);
        if (event.type !== EventType.TOOL_CALL_RESULT) return;
        held.delete(callId as string);
        const content = String((event as { content?: unknown }).content ?? "");
        if (
          waiting.early
            ? /Unknown tool|"notYet":\s*true|"notRun":\s*true/.test(content)
            : /"forNoProject":\s*true/.test(content)
        )
          return;
        for (const kept of waiting.events) subscriber.next(kept);
      },
      error: (error) => subscriber.error(error),
      complete: () => {
        for (const { events } of held.values()) for (const kept of events) subscriber.next(kept);
        subscriber.complete();
      },
    });
    return () => subscription.unsubscribe();
  });
}
