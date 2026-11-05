// v1.4 (docs/apps.md): Slack through OAuth v2. The bot token reads channel lists and recent
// messages; a message goes out only as a `slack.send` draft the person sends.
// v1.5 (R10): compact reads (names, times, links, capped), threads, drafts that name the channel.
import { AppError } from "../errors.ts";

export const slackScopes = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "users:read",
  "chat:write",
  "chat:write.public",
];
type Fetch = typeof fetch;

/** The addresses Slack is reached at: the official ones, unless a test or a local fake says so. */
export const slackDefaults = {
  api: "https://slack.com/api",
  authorize: "https://slack.com/oauth/v2/authorize",
} as const;
export interface SlackCtx {
  fetcher: Fetch;
  api: string;
}
export function slackEndpoints(config: { slackApiUrl?: string; slackAuthorizeUrl?: string }) {
  const trim = (value: string | undefined, fallback: string) =>
    value?.trim().replace(/\/+$/, "") || fallback;
  return {
    api: trim(config.slackApiUrl, slackDefaults.api),
    authorize: trim(config.slackAuthorizeUrl, slackDefaults.authorize),
  };
}

/** What a read gives the model: bounded so one busy channel cannot fill the context. */
export const readLimits = {
  messageChars: 600,
  totalChars: 8000,
  channels: 100,
  users: 25,
  messages: 50,
  pages: 3,
} as const;

/** A Slack answer with `ok: false`; `code` is Slack's own error name. */
export class SlackError extends AppError {
  constructor(public readonly code: string) {
    super(`Slack：${code}`, 502);
  }
}

export function slackAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  base: string = slackDefaults.authorize,
) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: slackScopes.join(","),
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

/** Why Slack cannot be connected from the directory, in the reader's words; undefined when it can. */
export function slackNotice(input: {
  clientId?: string;
  clientSecret?: string;
  encryptionKey?: string;
  /** One owner's own install, not the hosted service. */
  open: boolean;
  readmeUrl: string;
}): string | undefined {
  const app = !!(input.clientId && input.clientSecret);
  if (app && input.encryptionKey) return undefined;
  if (!input.open) return "暂不可用";
  const missing = [
    ...(app ? [] : ["Slack 应用的 SLACK_CLIENT_ID 和 SLACK_CLIENT_SECRET"]),
    ...(input.encryptionKey ? [] : ["TOKEN_ENCRYPTION_KEY"]),
  ];
  return `要先在 .env 里填 ${missing.join("、")}，步骤见 ${input.readmeUrl}`;
}

async function call(
  ctx: SlackCtx,
  method: string,
  token: string | null,
  body: URLSearchParams | Record<string, unknown>,
  json = false,
) {
  // Slack's read methods take forms only; chat.postMessage takes JSON.
  const form =
    body instanceof URLSearchParams
      ? body
      : json
        ? null
        : new URLSearchParams(
            Object.entries(body)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          );
  const response = await ctx.fetcher(`${ctx.api}/${method}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": form
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
    },
    body: form ?? JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AppError(`Slack 没有回应（${response.status}）`, 502);
  const data = (await response.json()) as { ok?: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!data.ok) throw new SlackError(data.error ?? "failed");
  return data;
}

export async function slackExchange(
  ctx: SlackCtx,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
) {
  const data = await call(
    ctx,
    "oauth.v2.access",
    null,
    new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  );
  const team = (data.team ?? {}) as { id?: string; name?: string };
  if (typeof data.access_token !== "string") throw new AppError("Slack 没有给出令牌", 502);
  return { token: data.access_token, teamId: team.id ?? "", team: team.name ?? "Slack" };
}

export interface SlackChannel {
  id: string;
  name: string;
  member: boolean;
  private: boolean;
}

export async function slackChannels(ctx: SlackCtx, token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < readLimits.pages; page++) {
    const data = await call(ctx, "conversations.list", token, {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined,
    });
    const channels =
      (data.channels as
        | { id: string; name: string; is_member?: boolean; is_private?: boolean }[]
        | undefined) ?? [];
    for (const channel of channels)
      out.push({
        id: channel.id,
        name: channel.name,
        member: channel.is_member === true,
        private: channel.is_private === true,
      });
    const meta = data.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

/** The channel list as the model sees it: bounded, with what the app can read marked. */
export function channelView(channels: readonly SlackChannel[]) {
  const shown = channels.slice(0, readLimits.channels).map((channel) => ({
    id: channel.id,
    name: channel.name,
    ...(channel.private ? { private: true } : {}),
    readable: channel.member,
  }));
  return {
    channels: shown,
    ...(channels.length > shown.length ? { omitted: channels.length - shown.length } : {}),
    note: "readable: false means the Slack app is not in that channel and cannot read it.",
  };
}

export function findChannel(channels: readonly SlackChannel[], wanted: string) {
  const name = wanted.trim().replace(/^#/, "");
  return channels.find((item) => item.id === name || item.name === name.toLowerCase());
}

export interface RawMessage {
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts: string;
  reply_count?: number;
}
export interface SlackMessage {
  ts: string;
  time: string;
  from: string;
  text: string;
  link?: string;
  replies?: number;
}

/** `1700000000.000100` → `2023-11-14 22:13Z`. */
export function slackTime(ts: string) {
  const ms = Number.parseFloat(ts) * 1000;
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z` : ts;
}

/** A message's address: `<workspace>/archives/<channel>/p<ts>`, in its thread when it is a reply. */
export function slackPermalink(base: string, channel: string, ts: string, threadTs?: string) {
  if (!base) return undefined;
  const link = `${base.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${link}?thread_ts=${threadTs}&cid=${channel}` : link;
}

/** Slack's markup (`<@U1>`, `<#C1|name>`, `<https://x|label>`, `&amp;`) as plain words. */
export function plainSlackText(text: string, names: ReadonlyMap<string, string>) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Messages (oldest first) as the model sees them: each short, the whole under a cap. When the
 * cap bites, a channel keeps its newest messages and a thread keeps its first. */
export function compactMessages(
  raw: readonly RawMessage[],
  names: ReadonlyMap<string, string>,
  link: (message: RawMessage) => string | undefined,
  keep: "newest" | "oldest" = "newest",
): { messages: SlackMessage[]; truncated: boolean } {
  const order = keep === "newest" ? raw.slice().reverse() : raw;
  const messages: SlackMessage[] = [];
  let used = 0;
  for (const message of order) {
    const full = plainSlackText(message.text ?? "", names);
    const text =
      full.length > readLimits.messageChars ? `${full.slice(0, readLimits.messageChars)}…` : full;
    const from =
      (message.user && (names.get(message.user) ?? message.user)) ||
      message.bot_profile?.name ||
      message.username ||
      message.bot_id ||
      "";
    const url = link(message);
    const view: SlackMessage = {
      ts: message.ts,
      time: slackTime(message.ts),
      from,
      text,
      ...(url ? { link: url } : {}),
      ...(message.reply_count ? { replies: message.reply_count } : {}),
    };
    const size = JSON.stringify(view).length;
    if (used + size > readLimits.totalChars) break;
    used += size;
    messages.push(view);
  }
  if (keep === "newest") messages.reverse();
  return { messages, truncated: messages.length < raw.length };
}

/** The tool's words for a refused read; the person's next step in it. */
export function slackErrorText(code: string, channel: string) {
  const label = channel ? `#${channel.replace(/^#/, "")}` : "that channel";
  if (code === "not_in_channel" || code === "channel_not_found")
    return `No permission to read ${label}: the Slack app is not in that channel. Tell the person to invite it there (/invite).`;
  if (code === "missing_scope")
    return "The Slack app lacks a permission for this; the person should reconnect Slack.";
  if (code === "thread_not_found") return "No such thread in that channel.";
  if (code === "invalid_auth" || code === "token_revoked" || code === "account_inactive")
    return "The Slack connection no longer works; the person should reconnect Slack.";
  if (code === "ratelimited") return "Slack asked to slow down; try again in a minute.";
  return `Slack: ${code}`;
}

export async function slackWorkspaceUrl(ctx: SlackCtx, token: string) {
  try {
    const data = await call(ctx, "auth.test", token, new URLSearchParams());
    return typeof data.url === "string" ? data.url : "";
  } catch {
    return "";
  }
}

/** Display names of the given user ids; one that cannot be looked up stays out of the map. */
export async function slackUserNames(ctx: SlackCtx, token: string, ids: Iterable<string>) {
  const names = new Map<string, string>();
  const wanted = [...new Set(ids)].slice(0, readLimits.users);
  await Promise.all(
    wanted.map(async (id) => {
      try {
        const data = await call(ctx, "users.info", token, { user: id });
        const user = data.user as
          | { name?: string; real_name?: string; profile?: { display_name?: string } }
          | undefined;
        const name = user?.profile?.display_name || user?.real_name || user?.name;
        if (name) names.set(id, name);
      } catch {
        // No users:read (an older connection) or a deleted user: the id stands.
      }
    }),
  );
  return names;
}

function mentioned(raw: readonly RawMessage[]) {
  const ids = new Set<string>();
  for (const message of raw) {
    if (message.user) ids.add(message.user);
    for (const match of (message.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(match[1]);
  }
  return ids;
}

async function readable(
  ctx: SlackCtx,
  token: string,
  channel: string,
  raw: readonly RawMessage[],
  thread?: string,
) {
  const [names, base] = await Promise.all([
    slackUserNames(ctx, token, mentioned(raw)),
    slackWorkspaceUrl(ctx, token),
  ]);
  return compactMessages(
    raw,
    names,
    (message) => slackPermalink(base, channel, message.ts, thread),
    thread ? "oldest" : "newest",
  );
}

/** The latest `limit` messages of a channel, oldest first. */
export async function slackHistory(ctx: SlackCtx, token: string, channel: string, limit: number) {
  const data = await call(ctx, "conversations.history", token, {
    channel,
    limit: Math.min(Math.max(limit, 1), readLimits.messages),
  });
  const raw = ((data.messages as RawMessage[] | undefined) ?? []).slice().reverse();
  return readable(ctx, token, channel, raw);
}

/** The thread under one message (the message itself first). */
export async function slackThread(
  ctx: SlackCtx,
  token: string,
  channel: string,
  threadTs: string,
  limit: number,
) {
  const data = await call(ctx, "conversations.replies", token, {
    channel,
    ts: threadTs,
    limit: Math.min(Math.max(limit, 1), readLimits.messages),
  });
  return readable(ctx, token, channel, (data.messages as RawMessage[] | undefined) ?? [], threadTs);
}

/** Who wrote a thread's first message and the start of it, for the draft card. */
export async function slackParent(ctx: SlackCtx, token: string, channel: string, ts: string) {
  try {
    const { messages } = await slackThread(ctx, token, channel, ts, 1);
    const first = messages[0];
    return first ? { from: first.from, text: first.text.slice(0, 160) } : null;
  } catch {
    return null;
  }
}

/** The data of a `slack.send` draft: the channel by name, the message replied to, the whole text. */
export function slackDraftData(input: {
  channel: Pick<SlackChannel, "id" | "name">;
  text: string;
  threadTs?: string;
  parent?: { from: string; text: string } | null;
}) {
  return {
    channel: input.channel.id,
    channelName: input.channel.name,
    text: input.text,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    ...(input.threadTs && input.parent
      ? { threadPreview: `${input.parent.from}：${input.parent.text}`.slice(0, 200) }
      : {}),
  };
}

export async function slackPost(
  ctx: SlackCtx,
  token: string,
  message: { channel: string; text: string; threadTs?: string },
) {
  const data = await call(
    ctx,
    "chat.postMessage",
    token,
    {
      channel: message.channel,
      text: message.text,
      ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
    },
    true,
  );
  return { ts: String(data.ts ?? ""), channel: String(data.channel ?? message.channel) };
}

/** The link of a message that was sent; empty when Slack will not say. */
export async function slackSentLink(ctx: SlackCtx, token: string, channel: string, ts: string) {
  try {
    const data = await call(ctx, "chat.getPermalink", token, { channel, message_ts: ts });
    return typeof data.permalink === "string" ? data.permalink : "";
  } catch {
    return "";
  }
}

export async function slackRevoke(ctx: SlackCtx, token: string) {
  await call(ctx, "auth.revoke", token, new URLSearchParams()).catch(() => {});
}
