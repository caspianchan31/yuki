// What a layer above the core can add to the agent, without the core knowing the layer: chat
// tools for a conversation, task runs of its own kinds (their tools and prompt words), and the
// services it owns. The multi-tenant layer's store registers one (store/extension.ts) through
// createApp; the core's default is none.
import type { defineTool } from "@copilotkit/runtime/v2";
import type { z } from "zod";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { AgentService } from "./engine/service.ts";

export type AgentTool = ReturnType<typeof defineTool>;

/** What a conversation hands a layer to build its chat tools. */
export interface ChatToolContext {
  service: AgentService;
  owner: string;
  /** Runs `what` and answers with its result, or the error as `{ error }` (`failed` if none). */
  run: (what: () => Promise<unknown>, failed: string) => Promise<unknown>;
}

/** The core's tool maker for a run: guarded, serialized and reported like every other tool. */
export type RunToolFactory = <T extends z.ZodType>(
  name: string,
  description: string,
  parameters: T,
  execute: (args: z.output<T>) => Promise<unknown>,
  options?: { afterOutcome?: boolean; step?: boolean; label?: string; infrastructure?: boolean },
) => AgentTool;

/** What a run of the layer's kind hands it to build its tools. */
export interface RunToolContext {
  service: AgentService;
  owner: string;
  /** The task as it is now (it is replaced when the run takes a pending answer). */
  task: () => AgentTask;
  tool: RunToolFactory;
}

export interface AgentExtension {
  /** Chat tools added to every conversation. */
  chatTools?(context: ChatToolContext): AgentTool[];
  /** Whether the task is a run of one of this layer's kinds (on the default desktop only). */
  ownsRun?(task: AgentTask): boolean;
  /** The tools of a run `ownsRun` claimed. */
  runTools?(context: RunToolContext): AgentTool[];
  /** The words added to the prompt of a run `ownsRun` claimed (each piece led by a space). */
  runInstructions?(task: AgentTask): string;
}
