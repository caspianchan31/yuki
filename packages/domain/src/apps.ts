// v1.4 (docs/apps.md): the directory of apps a space can connect.
import { z } from "zod";

export type AppState = "connected" | "not_connected" | "not_configured";
export type AppType = "google" | "mailbox" | "slack" | "mcp";

export interface AppEntry {
  /** `gmail`, `google-calendar`, `mailbox`, `slack`, `mcp:<slug>`. */
  id: string;
  name: string;
  type: AppType;
  state: AppState;
  /** An MCP server from the built-in list of presets (its address is known), not a custom one. */
  preset: boolean;
  /** Why it cannot be connected from here (state `not_configured`), in words. */
  note?: string;
  /** What members can do with it. */
  abilities: string[];
  /** The address of an MCP server. */
  url?: string;
  /** The account it is connected as (Google address, Slack workspace). */
  account?: string;
  /** Tools it gives (MCP, once connected). */
  tools?: number;
  /** How a member connects it: 授权 page (oauth), a token field, or elsewhere (the project's credentials). */
  connect: "oauth" | "token" | "elsewhere";
}

export const appLimits = { name: 60, url: 2000, token: 4000 } as const;
export const customMcpSchema = z.object({
  name: z.string().trim().min(1).max(appLimits.name),
  url: z.string().trim().min(1).max(appLimits.url),
  token: z.string().trim().max(appLimits.token).optional(),
  /** The conversation that started the connection: told when it is done. */
  threadId: z.string().trim().min(1).max(200).optional(),
});
export const connectAppSchema = z.object({
  token: z.string().trim().max(appLimits.token).optional(),
  threadId: z.string().trim().min(1).max(200).optional(),
});
