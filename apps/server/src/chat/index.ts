// The conversations on this server, built once per app.
// The CopilotKit runtime runs in SSE mode on LocalAgentRunner; the thread menu, the main chat and
// 开新主聊天 are served from the chat_* tables. There is no CopilotKit cloud (Intelligence).
import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { Hono } from "hono";
import type { Store } from "../db.ts";
import type { PlanGate } from "../gate.ts";
import { ChatStore } from "./chat-store.ts";
import { chatAgentId, currentMainThreadId, mainThreadId } from "./main-thread.ts";
import { LocalAgentRunner } from "./runner.ts";
import { chatRuntimeHooks, type RequestOwner } from "./runtime-hooks.ts";
import { type ThreadRouteHooks, threadRoutes } from "./thread-routes.ts";
import type { LocalRunnerOptions } from "./types.ts";

export interface LocalChat {
  store: ChatStore;
  runner: LocalAgentRunner;
  hooks: CopilotRuntimeHooks;
  routes: Hono<{ Variables: { owner: string } }>;
  /** The owner's main thread, created on first use and recorded as a thread of the owner. */
  mainThread(owner: string): Promise<string>;
  /** Saves in-flight replies as interrupted and stops timers. Call before closing the database. */
  close(): Promise<void>;
}

export async function createLocalChat(input: {
  db: Store;
  /** The owner a request acts as (session, then project header). */
  owner: RequestOwner;
  /** Usernames and activity for the thread routes. */
  threadHooks?: ThreadRouteHooks;
  databaseUrl?: string;
  runner?: LocalRunnerOptions;
  /** Why the owner's space may not run now; null while it may. */
  gate?: Pick<PlanGate, "refusal">;
}): Promise<LocalChat> {
  const store = await ChatStore.open(input.db);
  const runner = new LocalAgentRunner(store, {
    // Embedded PGlite (no DATABASE_URL) runs inside this process only, so a lock found at startup
    // is a reply the previous process left unfinished: it is recovered at once.
    exclusive: !input.databaseUrl,
    ...input.runner,
  });
  await runner.start();
  return {
    store,
    runner,
    hooks: chatRuntimeHooks({
      owner: input.owner,
      threads: store,
      runs: runner,
      ...(input.gate ? { gate: input.gate } : {}),
    }),
    routes: threadRoutes(
      store,
      undefined,
      (owner) => currentMainThreadId(input.db, owner),
      input.threadHooks,
    ),
    async mainThread(owner) {
      const threadId = await mainThreadId(input.db, owner);
      // Another owner's id would be a broken record, never a thread to hand out.
      if ((await store.ensureThread(owner, threadId, chatAgentId)) === "forbidden")
        throw new Error("The main thread belongs to another owner");
      return threadId;
    },
    close: () => runner.close(),
  };
}
