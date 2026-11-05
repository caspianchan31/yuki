// v1.4 (docs/apps.md): connected apps. The directory and its states, an MCP
// server connected by token against a local fake server (streamable HTTP, the SDK's own server
// classes), its tools given to chat and task runs as app_<slug>__<tool>, a read-only tool run
// directly, any other call a reviewed `app.call` proposal that runs on approval, disconnect
// removing the tokens, Slack hidden without its config, and a Slack message that is a draft.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import { appToolName, checkMcpUrl, slugOf } from "../apps/server/src/apps/mcp.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { AppEntry } from "../packages/domain/src/apps.ts";
import { type ActionProposal, isMessageToPeople } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";

/** A fake MCP server: `lookup` is read-only, `create_note` is not. Calls are recorded. */
async function fakeMcp(token: string | null = "secret-token", oauth = false) {
  const calls: { tool: string; args: unknown }[] = [];
  let origin = "";
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const json = (value: object, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    const path = new URL(request.url ?? "/", origin || "http://x").pathname;
    if (oauth && path.startsWith("/.well-known/oauth-protected-resource"))
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (oauth && path.startsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (oauth && path === "/register")
      return json({ ...JSON.parse(text), client_id: "client-1" }, 201);
    if (oauth && path === "/token")
      return json({ access_token: token, token_type: "Bearer", refresh_token: "refresh-1" });
    if (token && request.headers.authorization !== `Bearer ${token}`)
      return json(
        { error: "unauthorized" },
        401,
        oauth
          ? {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            }
          : {},
      );
    const mcp = new McpServer({ name: "fake", version: "1.0.0" });
    mcp.registerTool(
      "lookup",
      {
        description: "Look something up",
        inputSchema: { q: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        calls.push({ tool: "lookup", args });
        return { content: [{ type: "text", text: `found ${args.q}` }] };
      },
    );
    mcp.registerTool(
      "create_note",
      { description: "Create a note", inputSchema: { title: z.string() } },
      async (args) => {
        calls.push({ tool: "create_note", args });
        return { content: [{ type: "text", text: `note ${args.title} created` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, text ? JSON.parse(text) : undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function setup(
  t: TestContext,
  config: { slack?: boolean; encryptionKey?: boolean; fetch?: typeof fetch } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-apps-"));
  const db = await createStore();
  const given = {
    mode: "sample" as const,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model" as const,
    model: "openai/fixture",
    ...(config.encryptionKey === false
      ? {}
      : { encryptionKey: randomBytes(32).toString("base64") }),
    ...(config.slack ? { slackClientId: "slack-client", slackClientSecret: "slack-secret" } : {}),
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, given, { appsFetch: config.fetch });
  t.after(async () => {
    await server.chat.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = (await session.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (path: string, body?: unknown) =>
    server.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, server, config: given, api };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const directory = async (s: Setup) => (await (await s.api("/api/apps")).json()) as AppEntry[];
const entry = async (s: Setup, id: string) => (await directory(s)).find((item) => item.id === id);
const connectFake = async (s: Setup, url: string, token = "secret-token") =>
  s.api("/api/apps/mcp", { name: "Fake", url, token });

async function chatTurn(s: Setup, messages: RunAgentInput["messages"]) {
  const conversation = new ConversationAgent(s.config as never, s.server.agent, "local-user");
  const input: RunAgentInput = {
    threadId: `apps-${randomUUID()}`,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  return events.flatMap((event) =>
    event.type === EventType.TOOL_CALL_RESULT ? [JSON.parse(event.content)] : [],
  );
}
const say = (content: string) => [{ id: randomUUID(), role: "user" as const, content }];
const toolNames = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name: string }; name?: string }[] }).tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? "")
    .filter(Boolean);
const proposalOf = async (s: Setup) => {
  const found = (await s.db.list<ActionProposal>("local-user", "actions")).filter(
    (action) => action.kind === "app.call" || action.kind === "slack.send",
  );
  assert.equal(found.length, 1);
  return found[0];
};
const noReview = (s: Setup) =>
  s.db.put("local-user", "review-settings", {
    id: "default",
    actionReview: false,
    askFirst: [],
    autoAllow: [],
  });

test("the directory names every app with its state", async (t) => {
  const s = await setup(t);
  const list = await directory(s);
  assert.deepEqual(
    list.slice(0, 4).map((item) => item.id),
    ["gmail", "google-calendar", "mailbox", "slack"],
  );
  assert.equal((await entry(s, "gmail"))?.state, "connected", "the sample workspace has Google");
  assert.equal((await entry(s, "mailbox"))?.state, "not_connected");
  assert.equal((await entry(s, "slack"))?.state, "not_configured", "no SLACK_CLIENT_ID");
  const presets = list.filter((item) => item.type === "mcp");
  assert.ok(presets.length >= 3);
  assert.ok(presets.every((item) => item.preset && item.state === "not_connected" && item.url));
  assert.ok(presets.every((item) => item.url?.startsWith("https://")));
  const withSlack = await setup(t, { slack: true });
  assert.equal((await entry(withSlack, "slack"))?.state, "not_connected");
  const noKey = await setup(t, { encryptionKey: false });
  assert.equal((await entry(noKey, "slack"))?.state, "not_configured");
  assert.equal(
    (await directory(noKey)).find((item) => item.type === "mcp")?.state,
    "not_configured",
    "tokens cannot be sealed without a key",
  );
});

test("one owner's live server reaches MCP servers on its own machine and network", () => {
  const own = { live: true, privateNetwork: true };
  assert.equal(checkMcpUrl("http://127.0.0.1:8799/mcp", own).port, "8799");
  assert.equal(checkMcpUrl("http://localhost:8799/mcp", own).hostname, "localhost");
  assert.equal(checkMcpUrl("http://192.168.1.20/mcp", own).hostname, "192.168.1.20");
  assert.equal(checkMcpUrl("https://10.0.0.5/mcp", own).hostname, "10.0.0.5");
  assert.equal(checkMcpUrl("https://mcp.example.com/mcp", own).hostname, "mcp.example.com");
  // Plain http stays off the public internet, and an address never carries a login.
  assert.throws(() => checkMcpUrl("http://mcp.example.com/mcp", own));
  assert.throws(() => checkMcpUrl("http://user:pw@127.0.0.1:1/mcp", own));
  // A server many people share keeps them to the public internet.
  assert.throws(() => checkMcpUrl("http://127.0.0.1:8799/mcp", { live: true }));
  assert.throws(() => checkMcpUrl("https://10.0.0.5/mcp", { live: true, privateNetwork: false }));
});

test("an address must be https, or this machine's on a non-live server", () => {
  assert.equal(checkMcpUrl("https://mcp.example.com/mcp", true).hostname, "mcp.example.com");
  assert.throws(() => checkMcpUrl("http://mcp.example.com/mcp", false));
  assert.throws(() => checkMcpUrl("http://127.0.0.1:9/mcp", true), "not on a live server");
  assert.equal(checkMcpUrl("http://127.0.0.1:9/mcp", false).port, "9");
  assert.throws(() => checkMcpUrl("https://10.0.0.5/mcp", true), "a private address");
  assert.throws(() => checkMcpUrl("https://user:pw@example.com/mcp", true));
  assert.equal(slugOf("My Tools!"), "my-tools");
  assert.equal(appToolName("fake", "create note"), "app_fake__create_note");
  assert.ok(appToolName("a".repeat(24), "t".repeat(100)).length <= 64);
});

test("an MCP server connects with a token, sealed, and disconnect removes it", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  const s = await setup(t);
  const wrong = await connectFake(s, mcp.url, "not-the-token");
  assert.equal(wrong.status, 422, "the server refused the token");
  assert.equal(await entry(s, "mcp:fake"), undefined);
  const noToken = await s.api("/api/apps/mcp", { name: "Fake", url: mcp.url });
  assert.equal(
    noToken.status,
    422,
    `401 without OAuth metadata asks for a token: ${await noToken.clone().text()}`,
  );
  assert.equal((await connectFake(s, mcp.url)).status, 200);
  const connected = await entry(s, "mcp:fake");
  assert.equal(connected?.state, "connected");
  assert.equal(connected?.preset, false);
  const stored = await s.db.list<{ id: string; secret: string | null }>("local-user", "apps");
  assert.equal(stored.length, 1);
  assert.ok(stored[0].secret && !stored[0].secret.includes("secret-token"), "sealed");
  assert.ok(!JSON.stringify(await directory(s)).includes("secret-token"), "never shown");
  assert.equal((await s.api("/api/apps/mcp:fake/disconnect", {})).status, 200);
  assert.deepEqual(await s.db.list("local-user", "apps"), [], "the tokens are gone");
  assert.equal(await entry(s, "mcp:fake"), undefined);
  assert.equal((await s.api("/api/apps/mcp:fake/disconnect", {})).status, 404);
});

test("an MCP server that supports OAuth is registered and authorised, tokens sealed", async (t) => {
  const mcp = await fakeMcp("oauth-access", true);
  t.after(mcp.close);
  const s = await setup(t);
  const started = await s.api("/api/apps/mcp", { name: "Fake", url: mcp.url });
  assert.equal(started.status, 200);
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "client-1", "dynamic registration");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    "http://localhost:8787/api/apps/mcp/callback",
  );
  assert.equal(await entry(s, "mcp:fake"), undefined, "not connected until authorised");
  const state = authorize.searchParams.get("state") ?? "";
  const back = await s.server.app.request(`/api/apps/mcp/callback?state=${state}&code=granted`);
  assert.equal(back.status, 200);
  assert.equal((await entry(s, "mcp:fake"))?.state, "connected");
  const [saved] = await s.db.list<{ auth: string; secret: string }>("local-user", "apps");
  assert.equal(saved.auth, "oauth");
  assert.ok(!saved.secret.includes("oauth-access"), "sealed");
  const tools = await s.server.apps.runTools("local-user", {
    propose: async () => ({}),
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "app_fake__create_note",
    "app_fake__lookup",
  ]);
  const looked = (await tools
    .find((tool) => tool.name === "app_fake__lookup")
    ?.execute({ q: "x" })) as {
    result: string;
  };
  assert.equal(looked.result, "found x");
});

const connectedReports = async (s: Setup) =>
  (await s.db.list<{ text: string; threadId: string }>("local-user", "chat-reports")).filter(
    (report) => report.text.includes("连好了"),
  );

test("when OAuth finishes, the conversation that started it is told the app is connected", async (t) => {
  const mcp = await fakeMcp("oauth-access", true);
  t.after(mcp.close);
  const s = await setup(t);
  const started = await s.api("/api/apps/mcp", {
    name: "Fake",
    url: mcp.url,
    threadId: "side-thread-1",
  });
  const { url } = (await started.json()) as { url: string };
  assert.deepEqual(await connectedReports(s), [], "nothing is said before it is authorised");
  const state = new URL(url).searchParams.get("state") ?? "";
  await s.server.app.request(`/api/apps/mcp/callback?state=${state}&code=granted`);
  const told = await connectedReports(s);
  assert.equal(told.length, 1);
  assert.equal(told[0].text, "Fake 连好了");
  assert.equal(told[0].threadId, "side-thread-1");
});

test("connecting by token tells the thread and resumes a routine paused for that app", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  const s = await setup(t);
  const routine = await s.server.agent.routines.create("local-user", {
    name: "笔记整理",
    instruction: "整理笔记",
    trigger: { type: "every", minutes: 60 },
  });
  const other = await s.server.agent.routines.create("local-user", {
    name: "别的",
    instruction: "别的事",
    trigger: { type: "every", minutes: 60 },
  });
  const block = (app: string) => ({
    routine: { ...routine.routine, authBlock: { app, name: app, at: "2026-11-03", paused: true } },
    status: "paused" as const,
    error: "401",
  });
  await s.db.compareAndSwap("local-user", "tasks", routine.id, {}, block("mcp:fake"));
  await s.db.compareAndSwap("local-user", "tasks", other.id, {}, block("mcp:elsewhere"));
  const response = await s.api("/api/apps/mcp", {
    name: "Fake",
    url: mcp.url,
    token: "secret-token",
    threadId: "side-thread-2",
  });
  assert.equal(response.status, 200);
  const woken = await s.server.agent.getTask("local-user", routine.id);
  assert.equal(woken.status, "scheduled");
  assert.equal(woken.routine?.authBlock, null);
  assert.equal(woken.error, null);
  assert.equal(
    (await s.server.agent.getTask("local-user", other.id)).status,
    "paused",
    "another app's routine stays paused",
  );
  const told = (await connectedReports(s)).map((report) => report.text).sort();
  assert.deepEqual(told, ["Fake 连好了", "Fake 连好了，「笔记整理」接着跑"]);
});

test("a connected server's tools reach chat as app_<slug>__<tool>; read-only runs directly", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "app_fake__lookup", arguments: { q: "docs" } } : undefined,
  );
  const s = await setup(t);
  await connectFake(s, mcp.url);
  const [result] = await chatTurn(s, say("look up docs"));
  const names = toolNames(requests[0].body);
  assert.ok(names.includes("app_fake__lookup"));
  assert.ok(names.includes("app_fake__create_note"));
  assert.ok(!names.includes("slack_read"), "Slack is not configured: no tools");
  assert.equal(result.result, "found docs");
  assert.match(result.note, /untrusted/);
  assert.deepEqual(mcp.calls, [{ tool: "lookup", args: { q: "docs" } }]);
  const proposals = await s.db.list<ActionProposal>("local-user", "actions");
  assert.deepEqual(
    proposals.filter((action) => action.kind === "app.call"),
    [],
    "no proposal for a read",
  );
  assert.ok(requests[0].body.includes("connected apps"), "the prompt names the apps");
});

test("a write call in chat is an app.call proposal that runs on approval", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  await modelFixture(t, (index) =>
    index === 0 ? { name: "app_fake__create_note", arguments: { title: "Plan" } } : undefined,
  );
  const s = await setup(t);
  await noReview(s);
  await connectFake(s, mcp.url);
  const [result] = await chatTurn(s, say("note it"));
  assert.equal(result.status, "awaiting_review");
  assert.deepEqual(mcp.calls, [], "nothing ran before the person decided");
  const action = await proposalOf(s);
  assert.equal(action.kind, "app.call");
  assert.equal(action.status, "awaiting_review");
  assert.equal(action.noExpiry, true, "a chat's proposal waits until decided");
  assert.equal(action.draft, undefined, "an app call is not a message to people");
  assert.equal(action.title, "Fake: create_note");
  const decided = await s.api(`/api/actions/${action.id}/decide`, {
    hash: action.hash,
    decision: "approve",
  });
  assert.equal(((await decided.json()) as ActionProposal).status, "succeeded");
  assert.deepEqual(mcp.calls, [{ tool: "create_note", args: { title: "Plan" } }]);
});

test("a declined or disconnected app.call does not run", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  await modelFixture(t, (index) =>
    index === 0 ? { name: "app_fake__create_note", arguments: { title: "Plan" } } : undefined,
  );
  const s = await setup(t);
  await noReview(s);
  await connectFake(s, mcp.url);
  await chatTurn(s, say("note it"));
  const action = await proposalOf(s);
  await s.api("/api/apps/mcp:fake/disconnect", {});
  const approve = await s.api(`/api/actions/${action.id}/decide`, {
    hash: action.hash,
    decision: "approve",
  });
  assert.equal(approve.status, 409, "the app was disconnected");
  assert.deepEqual(mcp.calls, []);
});

test("a task run gets the tools too; its write call waits for approval and then runs", async (t) => {
  const mcp = await fakeMcp();
  t.after(mcp.close);
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "app_fake__create_note", arguments: { title: "From task" } } : undefined,
  );
  const s = await setup(t);
  await noReview(s);
  await connectFake(s, mcp.url);
  const created = await s.server.agent.createTask("local-user", { prompt: "Write a note" });
  await s.server.agent.worker.tick();
  assert.ok(toolNames(requests[0].body).includes("app_fake__create_note"));
  const task = (await s.server.agent.getTask("local-user", created.id)) as AgentTask;
  assert.equal(task.status, "waiting_approval", task.error ?? undefined);
  const action = await proposalOf(s);
  assert.equal(action.kind, "app.call");
  assert.deepEqual(mcp.calls, []);
  const done = await s.server.actions.decide("local-user", action.id, action.hash, "approve");
  assert.equal(done.status, "succeeded");
  assert.deepEqual(mcp.calls, [{ tool: "create_note", args: { title: "From task" } }]);
});

test("without Slack's config its tools are absent and it cannot be connected", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const s = await setup(t);
  await chatTurn(s, say("hi"));
  const names = toolNames(requests[0].body);
  assert.ok(!names.includes("slack_read") && !names.includes("prepare_slack_message"));
  assert.equal((await s.api("/api/apps/slack/connect", {})).status, 503);
});

/** A Slack that answers the four calls the server makes. */
function fakeSlack() {
  const posted: unknown[] = [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").pop() ?? "";
    calls.push(method);
    const json = (value: object) => Response.json({ ok: true, ...value });
    if (method === "oauth.v2.access")
      return json({ access_token: "xoxb-fake", team: { id: "T1", name: "Acme" } });
    if (method === "conversations.list")
      return json({ channels: [{ id: "C1", name: "general", is_member: true }] });
    if (method === "conversations.history")
      return json({ messages: [{ ts: "1.1", user: "U1", text: "hello team" }] });
    if (method === "chat.postMessage") {
      posted.push(JSON.parse(String(init?.body)));
      return json({ ts: "2.2" });
    }
    return json({});
  };
  return { fetcher, posted, calls };
}

test("Slack: OAuth connects, slack_read reads, and a message is a draft sent on approval", async (t) => {
  const slack = fakeSlack();
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "slack_read", arguments: { channel: "general" } }
      : index === 2
        ? { name: "prepare_slack_message", arguments: { channel: "general", text: "Hi all" } }
        : undefined,
  );
  const s = await setup(t, { slack: true, fetch: slack.fetcher });
  await noReview(s);
  const started = (await (await s.api("/api/apps/slack/connect", {})).json()) as { url: string };
  const authorize = new URL(started.url);
  assert.equal(authorize.host, "slack.com");
  assert.equal(authorize.searchParams.get("client_id"), "slack-client");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    "http://localhost:8787/api/slack/callback",
  );
  const state = authorize.searchParams.get("state") ?? "";
  const back = await s.server.app.request(`/api/slack/callback?state=${state}&code=abc`);
  assert.equal(back.status, 200);
  assert.equal((await entry(s, "slack"))?.state, "connected");
  assert.equal((await entry(s, "slack"))?.account, "Acme");
  const stored = await s.db.get<{ secret: string }>("local-user", "apps", "slack");
  assert.ok(!stored?.secret.includes("xoxb-fake"), "the token is sealed");
  // Reusing the state fails.
  assert.equal(
    (await s.server.app.request(`/api/slack/callback?state=${state}&code=abc`)).status,
    400,
  );

  const [read] = await chatTurn(s, say("what is in general"));
  assert.ok(toolNames(requests[0].body).includes("slack_read"));
  assert.ok(toolNames(requests[0].body).includes("prepare_slack_message"));
  assert.equal(read.messages[0].text, "hello team");
  assert.match(read.note, /untrusted/);

  const [draft] = await chatTurn(s, say("tell them hi"));
  assert.equal(draft.status, "awaiting_review");
  assert.deepEqual(slack.posted, [], "nothing posted before approval");
  const action = await proposalOf(s);
  assert.equal(action.kind, "slack.send");
  assert.equal(action.draft, true, "a Slack message is a draft");
  assert.equal(isMessageToPeople("slack.send"), true);
  assert.deepEqual(action.data, { channel: "C1", channelName: "general", text: "Hi all" });
  const sent = await s.server.actions.decide("local-user", action.id, action.hash, "approve");
  assert.equal(sent.status, "succeeded");
  assert.deepEqual(slack.posted, [{ channel: "C1", text: "Hi all" }]);

  assert.equal((await s.api("/api/apps/slack/disconnect", {})).status, 200);
  assert.equal(await s.db.get("local-user", "apps", "slack"), null);
  assert.ok(slack.calls.includes("auth.revoke"));
});

test("the review does not let a Slack draft through on its own judgment", async (t) => {
  const slack = fakeSlack();
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "prepare_slack_message", arguments: { channel: "general", text: "Hi all" } }
      : undefined,
  );
  const s = await setup(t, { slack: true, fetch: slack.fetcher });
  const started = (await (await s.api("/api/apps/slack/connect", {})).json()) as { url: string };
  const state = new URL(started.url).searchParams.get("state") ?? "";
  await s.server.app.request(`/api/slack/callback?state=${state}&code=abc`);
  // Review on, no 自动放行 sentence: the reviewer is not even asked.
  const [draft] = await chatTurn(s, say("tell them hi"));
  assert.equal(draft.status, "awaiting_review");
  assert.deepEqual(slack.posted, []);
});
