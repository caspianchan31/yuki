import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { LocalChat } from "./chat/index.ts";
import type { RequestOwner } from "./chat/runtime-hooks.ts";
import type { Config } from "./config.ts";
import type { Speaker } from "./engine/conversation.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
/**
 * The CopilotKit runtime in SSE mode on this server's own runner (Fork v0.5 threads): no
 * CopilotKit cloud. `owner` is the one owner resolver (session, then project header), so every
 * conversation and tool call is partitioned like the rest of the API.
 */
export function makeRuntime(
  config: Config,
  service: AgentService,
  owner: RequestOwner,
  chat: Pick<LocalChat, "runner" | "hooks">,
  /** The member who sent the request's message. */
  speaker: (request: Request) => Promise<Speaker | null> = async () => null,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const agents: AgentsFactory = async ({ request }) => {
    if (config.agentBackend === "agui")
      return {
        default: new HttpAgent({
          url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
          headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
        }),
      };
    // Together: neither waits for the other.
    const [who, said] = await Promise.all([owner(request), speaker(request)]);
    return { default: new ConversationAgent(config, service, who, sharedJevAdapter(), said) };
  };
  const runtime = new CopilotRuntime({
    agents,
    runner: chat.runner,
    // The shared CopilotKit sink carries this tag onto existing PostHog events.
    telemetryProperties: { accessibility_title: "OpenMuse" },
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit", hooks: chat.hooks });
}
