// v1.4 (docs/apps.md): Slack through OAuth v2. The bot token reads channel lists and recent
// messages; a message goes out only as a `slack.send` draft the person sends.
import { AppError } from "../errors.ts";

export const slackScopes = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "chat:write",
  "chat:write.public",
];
const api = "https://slack.com/api";
type Fetch = typeof fetch;

export function slackAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: slackScopes.join(","),
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

async function call(
  fetcher: Fetch,
  method: string,
  token: string | null,
  body: URLSearchParams | Record<string, unknown>,
) {
  const form = body instanceof URLSearchParams;
  const response = await fetcher(`${api}/${method}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": form
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
    },
    body: form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AppError(`Slack 没有回应（${response.status}）`, 502);
  const data = (await response.json()) as { ok?: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!data.ok) throw new AppError(`Slack：${data.error ?? "失败"}`, 502);
  return data;
}

export async function slackExchange(
  fetcher: Fetch,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
) {
  const data = await call(
    fetcher,
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

export async function slackChannels(fetcher: Fetch, token: string) {
  const data = await call(fetcher, "conversations.list", token, {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
  });
  return ((data.channels as { id: string; name: string; is_member?: boolean }[]) ?? []).map(
    (channel) => ({ id: channel.id, name: channel.name, member: channel.is_member === true }),
  );
}

export async function slackHistory(fetcher: Fetch, token: string, channel: string, limit: number) {
  const data = await call(fetcher, "conversations.history", token, { channel, limit });
  return (
    (data.messages as { user?: string; text?: string; ts: string; bot_id?: string }[]) ?? []
  ).map((message) => ({
    ts: message.ts,
    user: message.user ?? message.bot_id ?? "",
    text: (message.text ?? "").slice(0, 2000),
  }));
}

export async function slackPost(
  fetcher: Fetch,
  token: string,
  message: { channel: string; text: string; threadTs?: string },
) {
  const data = await call(fetcher, "chat.postMessage", token, {
    channel: message.channel,
    text: message.text,
    ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
  });
  return String(data.ts ?? "");
}

export async function slackRevoke(fetcher: Fetch, token: string) {
  await call(fetcher, "auth.revoke", token, new URLSearchParams()).catch(() => {});
}
