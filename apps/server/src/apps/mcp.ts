// v1.4 (docs/apps.md): the MCP side of connected apps: the presets, the address check, the
// client (streamable HTTP, like search.ts), OAuth state, tool naming and results.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import project from "../../../../package.json" with { type: "json" };
import { AppError } from "../errors.ts";

/** Remote MCP servers with a well-known public address. A preset is only a shortcut for the
 * address: connecting one is the same as adding it as a custom server. */
export const mcpPresets: readonly {
  slug: string;
  name: string;
  url: string;
  abilities: string[];
}[] = [
  {
    slug: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    abilities: ["搜索与读取页面", "创建与更新页面"],
  },
  {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    abilities: ["查看与搜索任务", "创建与更新任务"],
  },
  {
    slug: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    abilities: ["查看仓库与议题", "创建议题与评论"],
  },
];

export const toolTimeoutMs = 30_000;
export const connectTimeoutMs = 15_000;
export const toolListTtlMs = 60_000;
/** Most tools one server gives to a run, and all servers together. */
export const toolsPerServer = 30;
export const toolsInTotal = 60;
export const resultMax = 20_000;

/** A name that can be a tool name or an id part: letters, digits, `_` and `-`. */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

/** `app_<slug>__<tool>`, at most 64 characters (what the model providers take). */
export function appToolName(slug: string, tool: string) {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  return `app_${slug}__${clean}`.slice(0, 64);
}

const privateHost =
  /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** Where an MCP server may be. `live`: a live workspace (sample mode is this machine only).
 * `privateNetwork`: the deployment belongs to one owner, who may connect a server on this machine
 * or on the owner's own network (a self-hosted core); a server many people share keeps them to
 * the public internet, so nobody reaches its own network through it. */
export interface McpNetwork {
  live: boolean;
  privateNetwork?: boolean;
}

/** The server's address: https; plain http only to this machine, and not on a live server
 * shared by many. On a private network (one owner), any https address, and http to a private
 * one. */
export function checkMcpUrl(raw: string, network: boolean | McpNetwork): URL {
  const { live, privateNetwork = false } =
    typeof network === "boolean" ? { live: network } : network;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("地址不对，要是 https:// 开头的完整地址", 400);
  }
  if (url.username || url.password) throw new AppError("地址里不要带账号密码", 400);
  const local = loopback.test(url.hostname);
  if (privateNetwork) {
    if (url.protocol === "https:" || (url.protocol === "http:" && privateHost.test(url.hostname)))
      return url;
    throw new AppError("地址要是 https:// 地址，或本机、内网的 http:// 地址", 400);
  }
  if (
    url.protocol === "https:"
      ? live && privateHost.test(url.hostname)
      : !(url.protocol === "http:" && local && !live)
  )
    throw new AppError("地址要是公网的 https:// 地址", 400);
  return url;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

/** OAuth state of one server: what the SDK asks the provider to keep. */
export interface OAuthStore {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  redirected: URL | null = null;
  constructor(
    private readonly redirect: string,
    readonly store: OAuthStore,
    private readonly persist: () => Promise<void>,
    private readonly stateValue?: string,
  ) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Yuki",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return this.stateValue ?? "";
  }
  clientInformation() {
    return this.store.clientInformation;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    this.store.clientInformation = info;
    await this.persist();
  }
  tokens() {
    return this.store.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.store.tokens = tokens;
    await this.persist();
  }
  redirectToAuthorization(url: URL) {
    this.redirected = url;
  }
  saveCodeVerifier(verifier: string) {
    this.store.verifier = verifier;
  }
  codeVerifier() {
    if (!this.store.verifier) throw new Error("No code verifier saved");
    return this.store.verifier;
  }
}

export interface McpTarget {
  url: string;
  token?: string;
  provider?: OAuthClientProvider;
}

/** One connection: connects, runs `work`, closes. Every request ends within the timeout. */
export async function withMcp<T>(
  target: McpTarget,
  work: (client: Client) => Promise<T>,
  signal?: AbortSignal,
  network: boolean | McpNetwork = true,
): Promise<T> {
  checkMcpUrl(target.url, network);
  const client = new Client({ name: project.name, version: project.version });
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    authProvider: target.provider,
    requestInit: {
      headers: {
        "User-Agent": `${project.name}/${project.version}`,
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
      },
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(
          [AbortSignal.timeout(toolTimeoutMs), init?.signal, signal].filter(
            (item): item is AbortSignal => !!item,
          ),
        ),
      }),
  });
  try {
    await client.connect(transport, { timeout: connectTimeoutMs, signal });
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(client: Client, signal?: AbortSignal): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: toolTimeoutMs,
      signal,
    });
    for (const tool of result.tools)
      tools.push({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1000),
        inputSchema:
          tool.inputSchema && tool.inputSchema.type === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
        // Only a tool that says it is read-only runs without the person's review.
        readOnly: tool.annotations?.readOnlyHint === true,
      });
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** A tool's result as text for the model: text blocks, a note for anything else; bounded. */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): {
  text: string;
  truncated: boolean;
} {
  const parts: string[] = [];
  if (Array.isArray(result.content))
    for (const block of result.content as { type?: string; text?: string }[]) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type) parts.push(`[${block.type}]`);
    }
  if (!parts.length && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n");
  return { text: text.slice(0, resultMax), truncated: text.length > resultMax };
}

/** A 401 the server's OAuth could not answer (no metadata, no registration): it wants a token. */
export const looksUnauthorized = (error: unknown) =>
  error instanceof OAuthError ||
  (error instanceof Error && /401|unauthori[sz]ed|invalid_token/i.test(error.message));
