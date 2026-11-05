// v1.5 (R10): Slack's pure parts (addresses, the not-configured words, compact reads with caps,
// draft data) and the calls against a small local Slack made with node:http.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  channelView,
  compactMessages,
  findChannel,
  plainSlackText,
  readLimits,
  SlackError,
  slackAuthorizeUrl,
  slackChannels,
  slackDefaults,
  slackDraftData,
  slackEndpoints,
  slackErrorText,
  slackHistory,
  slackNotice,
  slackParent,
  slackPermalink,
  slackPost,
  slackSentLink,
  slackThread,
  slackTime,
} from "../apps/server/src/apps/slack.ts";

test("the addresses are Slack's own unless the config says otherwise", () => {
  assert.deepEqual(slackEndpoints({}), slackDefaults);
  assert.deepEqual(slackEndpoints({ slackApiUrl: "  ", slackAuthorizeUrl: "" }), slackDefaults);
  assert.deepEqual(
    slackEndpoints({
      slackApiUrl: "http://127.0.0.1:9/api/",
      slackAuthorizeUrl: "http://127.0.0.1:9/authorize",
    }),
    { api: "http://127.0.0.1:9/api", authorize: "http://127.0.0.1:9/authorize" },
  );
  const url = new URL(
    slackAuthorizeUrl("cid", "http://x/cb", "st", "http://127.0.0.1:9/authorize"),
  );
  assert.equal(url.origin, "http://127.0.0.1:9");
  assert.match(url.searchParams.get("scope") ?? "", /users:read/);
  assert.equal(new URL(slackAuthorizeUrl("cid", "http://x/cb", "st")).host, "slack.com");
});

test("the directory says why Slack cannot be connected", () => {
  const base = { readmeUrl: "https://example.test/readme#connect-slack" };
  const ready = { clientId: "a", clientSecret: "b", encryptionKey: "k" };
  assert.equal(slackNotice({ ...base, ...ready, open: true }), undefined);
  assert.equal(slackNotice({ ...base, ...ready, open: false }), undefined);
  assert.equal(slackNotice({ ...base, open: false }), "暂不可用");
  const open = slackNotice({ ...base, encryptionKey: "k", open: true }) ?? "";
  assert.match(open, /SLACK_CLIENT_ID 和 SLACK_CLIENT_SECRET/);
  assert.match(open, /\.env/);
  assert.ok(open.endsWith(base.readmeUrl));
  const keyOnly = slackNotice({ ...base, clientId: "a", clientSecret: "b", open: true }) ?? "";
  assert.match(keyOnly, /TOKEN_ENCRYPTION_KEY/);
  assert.doesNotMatch(keyOnly, /SLACK_CLIENT_ID/);
});

test("Slack's markup becomes plain words, times and links", () => {
  const names = new Map([["U1", "Ann"]]);
  assert.equal(
    plainSlackText("<@U1> see <https://a.test/x|the doc> in <#C9|dev> &amp; <!here>", names),
    "@Ann see the doc (https://a.test/x) in #dev & @here",
  );
  assert.equal(plainSlackText("<@U2>", names), "@U2", "an unknown id stays");
  assert.equal(slackTime("1700000000.000100"), "2023-11-14 22:13Z");
  assert.equal(
    slackPermalink("https://acme.slack.com/", "C1", "1700000000.000100"),
    "https://acme.slack.com/archives/C1/p1700000000000100",
  );
  assert.equal(
    slackPermalink("https://acme.slack.com", "C1", "2.5", "1.1"),
    "https://acme.slack.com/archives/C1/p25?thread_ts=1.1&cid=C1",
  );
  assert.equal(slackPermalink("", "C1", "1.1"), undefined);
});

test("messages are short, named, and capped as a whole", () => {
  const long = "x".repeat(readLimits.messageChars + 100);
  const raw = Array.from({ length: 40 }, (_, index) => ({
    ts: `${1700000000 + index}.000000`,
    user: "U1",
    text: long,
  }));
  const newest = compactMessages(raw, new Map([["U1", "Ann"]]), () => undefined);
  assert.equal(newest.truncated, true);
  assert.ok(newest.messages.length < raw.length);
  assert.ok(JSON.stringify(newest.messages).length <= readLimits.totalChars + 200);
  assert.equal(newest.messages.at(-1)?.ts, raw.at(-1)?.ts, "the newest are kept");
  assert.equal(newest.messages[0].from, "Ann");
  assert.ok(newest.messages[0].text.endsWith("…"));
  assert.ok(newest.messages[0].text.length <= readLimits.messageChars + 1);
  const oldest = compactMessages(raw, new Map(), () => undefined, "oldest");
  assert.equal(oldest.messages[0].ts, raw[0].ts, "a thread keeps its first message");
  const small = compactMessages(
    [{ ts: "1.0", bot_profile: { name: "Deploy" }, text: "ok", reply_count: 2 }],
    new Map(),
    (message) => `https://s.test/${message.ts}`,
  );
  assert.deepEqual(small.messages[0], {
    ts: "1.0",
    time: "1970-01-01 00:00Z",
    from: "Deploy",
    text: "ok",
    link: "https://s.test/1.0",
    replies: 2,
  });
  assert.equal(small.truncated, false);
});

test("the channel list is bounded and says which channels the app can read", () => {
  const channels = Array.from({ length: readLimits.channels + 5 }, (_, index) => ({
    id: `C${index}`,
    name: `ch-${index}`,
    member: index === 0,
    private: index === 1,
  }));
  const view = channelView(channels);
  assert.equal(view.channels.length, readLimits.channels);
  assert.equal(view.omitted, 5);
  assert.deepEqual(view.channels[0], { id: "C0", name: "ch-0", readable: true });
  assert.deepEqual(view.channels[1], { id: "C1", name: "ch-1", private: true, readable: false });
  assert.equal(findChannel(channels, "#CH-3")?.id, "C3");
  assert.equal(findChannel(channels, "C4")?.name, "ch-4");
  assert.equal(findChannel(channels, "nope"), undefined);
  assert.match(slackErrorText("not_in_channel", "#private-x"), /No permission to read #private-x/);
  assert.match(slackErrorText("missing_scope", ""), /reconnect/);
});

test("a draft names the channel and, in a thread, the message it answers", () => {
  const channel = { id: "C1", name: "general" };
  assert.deepEqual(slackDraftData({ channel, text: "Hi" }), {
    channel: "C1",
    channelName: "general",
    text: "Hi",
  });
  assert.deepEqual(
    slackDraftData({
      channel,
      text: "Hi",
      threadTs: "1.1",
      parent: { from: "Ann", text: "Lunch at noon?" },
    }),
    {
      channel: "C1",
      channelName: "general",
      text: "Hi",
      threadTs: "1.1",
      threadPreview: "Ann：Lunch at noon?",
    },
  );
  assert.equal(
    slackDraftData({ channel, text: "Hi", threadTs: "1.1", parent: null }).threadPreview,
    undefined,
  );
});

/** A small Slack on node:http: forms in, JSON out; every call is kept. */
async function localSlack(options: { users?: boolean } = {}) {
  const calls: { method: string; type: string; body: Record<string, string> }[] = [];
  const posted: Record<string, unknown>[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const type = String(req.headers["content-type"] ?? "");
    const method = (req.url ?? "").split("/").pop() ?? "";
    const body = type.includes("json")
      ? (JSON.parse(raw) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, type, body });
    const answer = (value: object) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, ...value }));
    };
    const fail = (error: string) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error }));
    };
    if (method === "auth.test") return answer({ url: "https://acme.slack.com/" });
    if (method === "conversations.list")
      return answer({
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "C2", name: "secret", is_member: false, is_private: true },
        ],
      });
    if (method === "conversations.history") {
      if (body.channel === "C2") return fail("not_in_channel");
      return answer({
        messages: [
          {
            ts: "1700000200.000000",
            user: "U2",
            text: "<@U1> yes, noon",
            thread_ts: "1700000100.000000",
          },
          { ts: "1700000100.000000", user: "U1", text: "Lunch at noon?", reply_count: 1 },
        ],
      });
    }
    if (method === "conversations.replies")
      return answer({
        messages: [
          { ts: "1700000100.000000", user: "U1", text: "Lunch at noon?" },
          { ts: "1700000200.000000", user: "U2", text: "yes, noon" },
        ],
      });
    if (method === "users.info") {
      if (options.users === false) return fail("missing_scope");
      const names: Record<string, string> = { U1: "Ann", U2: "Bo" };
      return answer({ user: { name: body.user, profile: { display_name: names[body.user] } } });
    }
    if (method === "chat.postMessage") {
      posted.push(body);
      return answer({ ts: "1700000300.000000", channel: body.channel });
    }
    if (method === "chat.getPermalink")
      return answer({
        permalink: `https://acme.slack.com/archives/${body.channel}/p1700000300000000`,
      });
    return fail("unknown_method");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ctx = {
    fetcher: fetch,
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
  };
  return { ctx, calls, posted, close: () => server.close() };
}

test("channels, recent messages and threads come back named, timed and linked", async (t) => {
  const slack = await localSlack();
  t.after(slack.close);
  const channels = await slackChannels(slack.ctx, "tok");
  assert.deepEqual(channels, [
    { id: "C1", name: "general", member: true, private: false },
    { id: "C2", name: "secret", member: false, private: true },
  ]);
  const history = await slackHistory(slack.ctx, "tok", "C1", 10);
  assert.deepEqual(
    history.messages.map((message) => [message.from, message.text, message.time]),
    [
      ["Ann", "Lunch at noon?", "2023-11-14 22:15Z"],
      ["Bo", "@Ann yes, noon", "2023-11-14 22:16Z"],
    ],
    "oldest first, names for ids and mentions",
  );
  assert.equal(history.messages[0].link, "https://acme.slack.com/archives/C1/p1700000100000000");
  assert.equal(history.messages[0].replies, 1);
  const thread = await slackThread(slack.ctx, "tok", "C1", "1700000100.000000", 20);
  assert.equal(thread.messages.length, 2);
  assert.match(thread.messages[1].link ?? "", /\?thread_ts=1700000100\.000000&cid=C1$/);
  assert.deepEqual(await slackParent(slack.ctx, "tok", "C1", "1700000100.000000"), {
    from: "Ann",
    text: "Lunch at noon?",
  });
  const read = slack.calls.find((call) => call.method === "conversations.history");
  assert.match(read?.type ?? "", /x-www-form-urlencoded/, "read methods take forms");
  assert.equal(read?.body.limit, "10");
  await assert.rejects(
    () => slackHistory(slack.ctx, "tok", "C2", 5),
    (error) => error instanceof SlackError && error.code === "not_in_channel",
  );
});

test("without the user-names permission the ids stand in", async (t) => {
  const slack = await localSlack({ users: false });
  t.after(slack.close);
  const history = await slackHistory(slack.ctx, "tok", "C1", 10);
  assert.deepEqual(
    history.messages.map((message) => message.from),
    ["U1", "U2"],
  );
});

test("a message posts as JSON and its link is asked for", async (t) => {
  const slack = await localSlack();
  t.after(slack.close);
  const sent = await slackPost(slack.ctx, "tok", { channel: "C1", text: "Hi", threadTs: "1.1" });
  assert.deepEqual(slack.posted, [{ channel: "C1", text: "Hi", thread_ts: "1.1" }]);
  assert.equal(
    await slackSentLink(slack.ctx, "tok", sent.channel, sent.ts),
    "https://acme.slack.com/archives/C1/p1700000300000000",
  );
  const down = { fetcher: fetch, api: "http://127.0.0.1:1/api" };
  assert.equal(await slackSentLink(down, "tok", "C1", "1.1"), "", "no link is not a failure");
});
