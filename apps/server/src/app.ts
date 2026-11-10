import { join } from "node:path";
import { squeezed } from "./chat/squeeze.ts";
import "./config.ts";
import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { z } from "zod";
import { attachmentRetentionDays } from "../../../packages/domain/src/chat-attachments.ts";
import {
  calendarRangeSchema,
  emailDraftSchema,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { SPACE_HEADER } from "../../../packages/domain/src/me.ts";
import { PROJECT_HEADER, realOwnerOf } from "../../../packages/domain/src/projects.ts";
import { parseAccountSettings, readAccountZone, saveAccountZone } from "./account-settings.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeRuntime } from "./agent.ts";
import { appRoutes } from "./apps/routes.ts";
import { AppsService } from "./apps/service.ts";
import { createAuth, firstUserId, sampleUserId, WaitingSignIn } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { attachmentRoutes } from "./chat/attachment-routes.ts";
import { AttachmentStore, defaultAttachmentMaxGb } from "./chat/attachment-store.ts";
import { cloudThreadsFact, initMigrationMarker, readMarker } from "./chat/cloud-migration.ts";
import { createLocalChat } from "./chat/index.ts";
import { startNewMain } from "./chat/main-thread.ts";
import { replayPublicRoutes } from "./chat/replay-routes.ts";
import { ReplayShares } from "./chat/replay-shares.ts";
import type { LocalRunnerOptions } from "./chat/types.ts";
import { ComputerService, loadDesktopIdentities } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import type { Config } from "./config.ts";
import { type CredentialKey, processCredentialKey } from "./credentials/crypto.ts";
import { credentialRoutes } from "./credentials/routes.ts";
import { CredentialService } from "./credentials/service.ts";
import { CredentialStore } from "./credentials/store.ts";
import type { Store } from "./db.ts";
import { desktopOf } from "./desktop-computer.ts";
import type { UpgradeServer } from "./desktop-live.ts";
import { attachDesktopLive, desktopLiveRoutes } from "./desktop-live.ts";
import { chatReportRoutes } from "./engine/chat-reports.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { environmentRoutes } from "./environment-routes.ts";
import { EnvironmentService } from "./environments.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { escapeHtml as escapePage, GoogleAuth, googleConnectedPage } from "./google-auth.ts";
import { ImageGeneration, parseImageExtra } from "./image-generation.ts";
import { incidentRoutes } from "./incident-routes.ts";
import { backgroundFailure } from "./log.ts";
import { MailChannels } from "./mail/channels.ts";
import { memberFileRoutes } from "./member-files/routes.ts";
import { MemberFiles } from "./member-files/service.ts";
import { imageRoutes } from "./picture-tool.ts";
import { desktopListingCache } from "./project-overview.ts";
import { projectRoutes } from "./project-routes.ts";
import { ProjectService } from "./projects.ts";
import { clientKey, type RateLimitStoreOptions, rateLimit } from "./rate-limit.ts";
import { withActor } from "./request-actor.ts";
import {
  parseReviewSettings,
  readReviewSettings,
  saveReviewSettings,
} from "./review/action-review.ts";
import { skillRoutes } from "./skills-routes.ts";
import {
  type AppEnv,
  assertInSpace,
  ownerInSpace,
  singleUserTenancy,
  type TenancyFactory,
} from "./tenancy-port.ts";
import { mountWeb } from "./web-static.ts";
import { WorkspaceService } from "./workspace.ts";

/** Routes served through a signed link (files, browser previews and consoles). */
const signedRoutePattern =
  /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/;
/** A request on a signed route that carries a signature (checked by Auth.verify). Anything else
 * with a `signature` in its query is an ordinary request. */
function signedRequest(c: Context) {
  return signedRoutePattern.test(c.req.path) && Boolean(c.req.query("signature"));
}

/** The GET answers the shell polls or reads at every opening (v1.7 启动链瘦身): they get an ETag. */
const polledJson =
  /^\/api\/(agent(\/(routines|brief|model))?|workspace|chat-reports|environments(\/everyone)?|topology|projects(\/overview)?|me|billing|skills|apps|main-thread|account-settings|credentials\/(sign-ins|guides)|copilotkit\/(info|threads\/[^/]+\/(turns|superseded|feedback|speakers)))$/;

export async function createApp(
  db: Store,
  givenConfig: Config,
  options: {
    /** The credential store's key, read by the entry point from
     * CREDENTIAL_KEY_FILE; the sample workspace may leave it out (a key of this process). */
    credentialKey?: CredentialKey;
    /** The chat runner's timings (tests shorten them). */
    chatRunner?: LocalRunnerOptions;
    /** The request budget (long scripted tests lift it). */
    rateLimit?: RateLimitStoreOptions;
    /** v1.4 (docs/apps.md): the fetch Slack calls go through (tests supply a fake Slack). */
    appsFetch?: typeof fetch;
    /** The clock connected apps keep time by (tests move it). */
    appsNow?: () => number;
    /** Who is asking and which space they act in; defaults to `singleUserTenancy`. */
    tenancy?: TenancyFactory;
  } = {},
) {
  // Desktops of projects and accounts moved to
  // another space keep the sandbox they were made under. Written only by the offline move tool,
  // so reading them once at start is enough.
  const config: Config = {
    ...givenConfig,
    desktopIdentities: await loadDesktopIdentities(db),
  };
  // The entry points (index.ts, worker-entry.ts) always pass the key; live mode refuses to start
  // there without CREDENTIAL_KEY_FILE (readCredentialKey). Only tests leave it out.
  const credentialStore = new CredentialStore(db, options.credentialKey ?? processCredentialKey(), {
    sample: config.mode === "sample",
  });
  // Refuses to start when the key does not belong to the saved credentials.
  await credentialStore.open();
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    // The project's own mailbox (a credential) as the channel.
    mail = new MailChannels(credentialStore),
    workspace = new WorkspaceService(db, config, files, google, mail);
  // v1.4 (docs/apps.md): connected apps (Slack, MCP servers) belong to the space.
  const apps = new AppsService(db, config, {
    google: async (owner) => {
      const connection = await workspace.connection(owner);
      return connection ? { account: connection.account } : null;
    },
    googleConfigured: () => google.configured(),
    mailbox: async (owner) => (await mail.forOwner(owner))?.address ?? null,
    fetch: options.appsFetch,
    now: options.appsNow,
    // One owner's server (the core's single-user tenancy) may reach MCP servers on its own
    // machine or network; a shared one may not.
    privateNetwork: () => tenancy.privateNetwork === true,
  });
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      input.kind === "app.call" || input.kind === "slack.send"
        ? apps.execute(owner, input)
        : workspace.execute(owner, input, connectionId, targetVersion),
    appConnection: (owner, input) => apps.connectionFor(owner, input),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner, kind) => workspace.connectionFor(owner, kind),
  });
  const browser = new BrowserService(db, config, auth, files);
  const computer = new ComputerService(db, config);
  const environments = new EnvironmentService(db, computer, config, credentialStore);
  // History names accounts by the name they have when something happens.
  credentialStore.nameAccountsWith((scope, environmentId) =>
    environments.nameOf(scope, environmentId),
  );
  const tenancy = (options.tenancy ?? singleUserTenancy)({ db, config, auth });
  const agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    computer,
    environments,
    tenancy.plan,
    tenancy.extensions,
  );
  // Member files: on disk unless the tenancy layer keeps them elsewhere.
  const memberStore = tenancy.memberFileStore?.(db);
  if (memberStore) agent.memberFiles = new MemberFiles(memberStore, db);
  // The per-project credential store and the AI's sign-in after a login is saved.
  agent.apps = apps;
  apps.onConnected = (event) => agent.routines.appConnected(event);
  const credentials = new CredentialService(db, credentialStore, environments, computer);
  credentials.agent = agent;
  environments.onLoginSaved = (owner, environmentId, site) =>
    credentials.loginSaved(owner, { type: "account", environmentId }, site);
  environments.roomForSignIns = (owner, logins) => agent.assertRoomForSignIns(owner, logins);
  environments.onAccountMoved = (from, to, environmentId, sites, withdrawn) =>
    agent.accountMoved(from, to, environmentId, sites, withdrawn);
  // Partitions of the workspace; the chat runtime resolves owners through it.
  const projects = new ProjectService(db, config, computer, environments, browser, agent);
  // The 营销总群's assistant makes the project a request names when there is none.
  agent.createProject = (owner, name) => projects.create(owner, { name });
  auth.spaceKeyOf = (userId) => tenancy.defaultKey(userId);
  // Conversations live in this server's database; the
  // CopilotKit runtime runs in SSE mode on its own runner. The owner of a chat request is
  // resolved in one place: the session's user, then the space named in its header (v0.5 spaces),
  // then the project named in its header; the owner must belong to that space.
  const resolveFresh = async (request: Request) => {
    const user = await auth.user(request.headers.get("authorization") ?? undefined);
    const space = await tenancy.resolve(
      user.userId,
      request.headers.get(SPACE_HEADER) ?? undefined,
    );
    const owner = await projects.resolveOwner(
      space.key,
      request.headers.get(PROJECT_HEADER) ?? undefined,
    );
    assertInSpace(owner, space.key);
    return { user, space, owner };
  };
  // v1.7.2 对话快: one chat request asked "who is this" four times over (the middlewares, the
  // runtime's hook, the agent's owner, its speaker), some twenty database reads before the reply
  // could begin. Asked once per request now; nothing is kept from one request to the next.
  const resolved = new WeakMap<Request, ReturnType<typeof resolveFresh>>();
  const resolveRequest = (request: Request) => {
    let answer = resolved.get(request);
    if (!answer) {
      answer = resolveFresh(request);
      resolved.set(request, answer);
    }
    return answer;
  };
  const resolveRequestOwner = async (request: Request) => (await resolveRequest(request)).owner;
  await initMigrationMarker(db);
  // v1.6 回顾: share links, kept with the chat tables.
  const replayShares = await ReplayShares.open(db);
  // v1.6 聊天里发文件: the files sent in the chat live on disk, apart from the process.
  const attachments = new AttachmentStore(join(config.dataDir, "attachments"), {
    retentionMs: (config.attachmentRetentionDays ?? attachmentRetentionDays) * 24 * 60 * 60_000,
    maxBytes: (config.attachmentMaxGb ?? defaultAttachmentMaxGb) * 1024 ** 3,
  });
  agent.attachments = attachments;
  // v1.6 生成图片: whether the configured model can draw is found out from the gateway once
  // (in the background now, kept a day); the tool and the prompt follow the verdict.
  // On only when the config says so (loadConfig: unless IMAGE_GENERATION=off); a config built
  // by hand (the tests') leaves it off.
  const images =
    config.imageGeneration !== true
      ? undefined
      : new ImageGeneration(db, {
          model: config.imageModel,
          chatModel: config.model,
          baseUrl: config.imageBaseUrl ?? process.env.OPENAI_BASE_URL?.trim() ?? undefined,
          apiKey: config.imageApiKey ?? process.env.OPENAI_API_KEY?.trim() ?? undefined,
          extra: parseImageExtra(config.imageExtra),
        });
  agent.images = images;
  void images?.ability().catch((error) => backgroundFailure("image ability", error));
  const chat = await createLocalChat({
    db,
    owner: resolveRequestOwner,
    // Who said what in a conversation; a deleted conversation in the activity.
    threadHooks: {
      usernames: (owner) => tenancy.usernames(realOwnerOf(owner)),
      deleted: (owner, name) => tenancy.record(realOwnerOf(owner), "thread.delete", name, null),
      // v1.6: a deleted conversation takes its kept screenshots with it.
      forgetShots: (ids) => computer.forgetShots(ids),
      // v1.6 聊天里发文件: and its sent files.
      forgetAttachments: async (ids) => {
        await attachments.remove(ids);
      },
      // v1.6 回顾: share links; the page builds the link from its own address (/r/<token>).
      replayShares,
    },
    databaseUrl: config.databaseUrl,
    ...(options.chatRunner ? { runner: options.chatRunner } : {}),
    // A read-only space gets no reply.
    gate: tenancy.plan,
  });
  const runtime = makeRuntime(config, agent, resolveRequestOwner, chat, async (request) => {
    // With two or more members, the model is told who wrote the message.
    const { user, space } = await resolveRequest(request);
    return {
      userId: user.userId,
      username: user.username,
      announce: (await tenancy.memberCount(space.key)) >= 2,
    };
  });
  const app = new Hono<AppEnv>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    // A page's own files (the app, its scripts, styles and pictures) are public and change nothing:
    // they load at whatever address the site is opened at, so a wrong address (localhost for
    // 127.0.0.1, a LAN address) shows the page instead of a blank one (11-06). The API keeps the
    // check, and its refusal names the site's address for the sign-in to show (auth-errors.ts).
    const pageFile =
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      c.req.path !== "/api" &&
      !c.req.path.startsWith("/api/");
    if (origin && !origins.has(origin) && !pageFile)
      return c.json({ error: "Origin is not allowed", publicUrl: config.publicUrl }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization", PROJECT_HEADER, SPACE_HEADER],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large; PDFs must be 10 MB or smaller" }, 413),
    }),
  );
  // The members' computer's live view: its ticket in the path is the check (desktop-live.ts). It
  // comes before the rate limit: the viewer page loads a few dozen script files with no session,
  // so counted per address, the preview beside the chat and the big picture opened together (and
  // the reload of taking over) ran out the budget and the picture never connected (v1.7.3).
  app.route(
    "/api/computer/live",
    desktopLiveRoutes(() => desktopOf(computer)),
  );
  // Counted per signed-in user (every tab and device of one person share a
  // budget; members of a space behind one office address do not), per signed link, else per
  // client address (sign-in, invite links, a session that does not check out).
  app.use(
    "/api/*",
    rateLimit(Boolean(config.trustProxy), {
      ...options.rateLimit,
      identify: async (c) => {
        if (signedRequest(c)) {
          try {
            auth.verify(new URL(c.req.url));
            return `link:${c.req.query("signature")}`;
          } catch {
            return null;
          }
        }
        const authorization = c.req.header("authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const user = await auth.user(authorization).catch(() => null);
        if (!user) return null;
        c.set("user", user);
        return `user:${user.userId}`;
      },
    }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError)
      return c.json({ ...error.details, error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", async (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
      // Where conversations live, and whether the cloud copy is complete
      // (public: no counts of anyone's data; pnpm threads:migration-report has them).
      threads: "local",
      threadMigration: { status: (await readMarker(db))?.status ?? "pending" },
      // A deploy is waiting for the runs in progress; no new run starts.
      draining: agent.worker.draining,
    }),
  );
  // Fork: username + password sign-in. The live workspace has one admin account, created on
  // the setup page with the code from the server log (or from the environment on first start);
  // the sample workspace opens without credentials. Each successful sign-in provisions the owner.
  await auth.bootstrap();
  // The existing workspace is the first space (key local-user, nothing
  // rewritten) with the admin account as its first user and admin.
  await tenancy.ensureFirstSpace();
  const provision = async (key: string) => {
    await workspace.ensureSample(key, actions);
    await agent.ensure(key);
    if (config.mode === "sample") await agent.refreshIdeas(key);
  };
  tenancy.provisionWith(provision);
  const provisionUser = async (userId: string) => {
    for (const space of await tenancy.spacesOf(userId)) await provision(space.key);
  };
  app.get("/api/auth/status", async (c) => {
    const setupRequired = await auth.setupRequired();
    if (setupRequired) auth.setupCode();
    return c.json({ mode: config.mode, configured: !setupRequired, setupRequired });
  });
  app.post("/api/auth/setup", async (c) => {
    const body = z
      .object({ username: z.string(), password: z.string(), code: z.string().optional() })
      .parse(await c.req.json());
    const session = await auth.setup(body);
    await tenancy.ensureFirstSpace();
    await provisionUser(firstUserId);
    return c.json(session, 201);
  });
  app.post("/api/session", async (c) => {
    const body = z
      .object({ username: z.string().optional(), password: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const session = await auth
      .login(body, clientKey(c, Boolean(config.trustProxy)))
      .catch(async (error) => {
        // The right password of a sign-up not opened (or refused) reads its status.
        if (error instanceof WaitingSignIn)
          throw new AppError(error.message, 403, {
            registration: await tenancy.registrationStatus?.(error.userId),
          });
        throw error;
      });
    await provisionUser((await auth.user(`Bearer ${session.token}`)).userId);
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html(
        '<!doctype html><meta charset="utf-8"><h1>已取消连接 Google</h1><p>可以回到 OpenMuse 了。</p>',
        400,
      );
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    const saved = await google.callback(state, code);
    const space = (await tenancy.spaces()).find((record) => ownerInSpace(saved.owner, record.key));
    return c.html(googleConnectedPage(space?.name ?? null, saved.account));
  });
  // v1.4 (docs/apps.md): where Slack and MCP servers send the browser back after authorising.
  const appsPage = (title: string, line: string) =>
    `<!doctype html><meta charset="utf-8"><title>${escapePage(title)}</title><h1>${escapePage(title)}</h1><p>${escapePage(line)}</p><p>回到 OpenMuse 刷新页面即可使用。</p>`;
  app.get("/api/slack/callback", async (c) => {
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (c.req.query("error") || !state || !code)
      return c.html(appsPage("已取消连接 Slack", "可以回到 OpenMuse 了。"), 400);
    const saved = await apps.finishSlack(state, code);
    const space = (await tenancy.spaces()).find((record) => record.key === saved.space);
    return c.html(
      appsPage("Slack 已连接", `工作区「${saved.account}」已保存到空间「${space?.name ?? ""}」。`),
    );
  });
  app.get("/api/apps/mcp/callback", async (c) => {
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (c.req.query("error") || !state || !code)
      return c.html(appsPage("已取消连接", "可以回到 OpenMuse 了。"), 400);
    const saved = await apps.finishMcp(state, code);
    const space = (await tenancy.spaces()).find((record) => record.key === saved.space);
    return c.html(appsPage(`${saved.name} 已连接`, `已保存到空间「${space?.name ?? ""}」。`));
  });
  const core = { db, config, auth, agent, computer, environments, credentials, credentialStore };
  await tenancy.attach(core);
  tenancy.mountPublic(app, core);
  // What listens to the HTTP server's websocket upgrades (see attachServer below).
  const upgradeHooks: ((server: UpgradeServer) => void)[] = [];
  upgradeHooks.push((server) => attachDesktopLive(server, () => desktopOf(computer), origins));
  // v1.6 回顾 by link: public, the token is the whole secret (before the session check).
  app.route(
    "/api/replays",
    replayPublicRoutes(replayShares, chat.store, (id) => computer.shotPng(id)),
  );
  app.use("/api/*", async (c, next) => {
    if (signedRequest(c)) {
      const url = new URL(c.req.url);
      const owner = auth.verify(url);
      // A link made for a member works only while they are a member of the space it opens.
      const user = auth.linkUser(url);
      if (user && !(await tenancy.spacesOf(user)).some((space) => ownerInSpace(owner, space.key)))
        throw new AppError("Document link expired; refresh the workspace", 401);
      c.set("owner", owner);
      return next();
    }
    // The session's user; then, except on user-level routes, the space
    // named in the space header (one of the user's, else 404), whose key the request acts as.
    // The rate limit already checked the session (the same header) when there was one.
    const user = c.get("user") ?? (await auth.user(c.req.header("authorization")));
    c.set("user", user);
    if (tenancy.userLevelPath.test(c.req.path))
      return withActor({ userId: user.userId, spaceKey: null }, next);
    const space = await tenancy.resolve(user.userId, c.req.header(SPACE_HEADER));
    c.set("space", space);
    c.set("owner", space.key);
    return withActor({ userId: user.userId, spaceKey: space.key }, next);
  });
  // A request names its project in a header and acts as that project's
  // owner. Project management, Google connection and signed links stay on the real owner.
  app.post("/api/auth/logout", async (c) => {
    await auth.logout(c.req.header("authorization"));
    return c.body(null, 204);
  });
  app.post("/api/auth/password", async (c) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(await c.req.json());
    return c.json(await auth.changePassword(c.req.header("authorization"), body));
  });
  // The signed-in user and their spaces; the operator's spaces.
  app.get("/api/me", async (c) => c.json(await tenancy.me(c.get("user"))));
  tenancy.mountUser(app, core);
  app.use("/api/*", async (c, next) => {
    // Only a request the first middleware let in on its signature (a signed route) is signed.
    const signed = signedRequest(c);
    const unscoped = tenancy.unscopedPath.test(c.req.path) || signed;
    if (!unscoped)
      c.set("owner", await projects.resolveOwner(c.get("owner"), c.req.header(PROJECT_HEADER)));
    // Whatever owner the request acts as belongs to its space.
    const space = c.get("space");
    if (!signed && space) assertInSpace(c.get("owner"), space.key);
    await next();
  });
  tenancy.mountScoped(app, core);
  // /api/projects/overview reads tasks, reviews and saved account
  // settings of every project; the computer is handed over for its saved settings and one
  // listing of desktop states (never a start or an attach), kept 15 s per owner (§8.2 N4).
  const overviewListing = desktopListingCache();
  app.route(
    "/api/projects",
    projectRoutes(
      projects,
      {
        db,
        projects,
        environments,
        computer,
        listing: overviewListing,
      },
      (owner, action, subject, detail) => tenancy.record(owner, action, subject, detail),
    ),
  );
  // v1.7 启动链瘦身: the JSON the shell polls (the agent snapshot every 3 s, the reports, a
  // thread's turns) carries an ETag and asks the browser to revalidate, so an unchanged answer
  // costs a 304 and no body on the wire.
  const revalidated = etag({ weak: true });
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" || !polledJson.test(c.req.path)) return next();
    await revalidated(c, async () => {
      await next();
      c.header("Cache-Control", "private, no-cache");
    });
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q"), {
        light: c.req.query("full") !== "1",
      }),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // Conversations still in CopilotKit's cloud, as a fact for the members
    // of the space they belong to (the first space) and nobody else.
    const cloudThreads = await cloudThreadsFact(
      db,
      Boolean(config.intelligenceApiKey),
      c.get("space").key,
    );
    if (cloudThreads) snapshot.runtime.cloudThreads = cloudThreads;
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  // v1.4 (docs/skills.md): the space's skills.
  app.route("/api/skills", skillRoutes(agent.skills));
  app.route(
    "/api/apps",
    appRoutes(apps, {
      connect: async (owner) => {
        if (config.mode === "sample") {
          await db.put(owner, "settings", {
            id: "google",
            enabled: true,
            connectionId: randomUUID(),
          });
          return { url: null, connected: true };
        }
        return google.connect(owner, true);
      },
      disconnect: async (owner) => {
        if (config.mode === "sample")
          await db.put(owner, "settings", { id: "google", enabled: false });
        else await google.disconnect(owner);
      },
    }),
  );
  // Background task reports of this project, by conversation thread or
  // task (UI redesign, N2).
  app.route(
    "/api/chat-reports",
    chatReportRoutes(agent.reports, (owner, threadId) => chat.store.activity(owner, threadId)),
  );
  // v1.6 聊天里发文件: upload, download and the record of a file sent in the chat; a copy goes
  // to the members' computer when there is one.
  app.route(
    "/api/chat/attachments",
    attachmentRoutes(attachments, {
      receive: (owner, name, bytes) => computer.receiveFile(owner, name, bytes),
    }),
  );
  // v1.6 生成图片: the verdict, for the web and the acceptance checks.
  app.route("/api/chat/images", imageRoutes(images));
  app.route("/api/computer", computerRoutes(computer, files));
  // An incident of the request's space and its picture.
  app.route("/api/incidents", incidentRoutes(computer.incidents));
  app.route(
    "/api/environments",
    environmentRoutes(
      environments,
      computer,
      files,
      (owner, action, subject, detail) =>
        tenancy.record(realOwnerOf(owner), action, subject, detail),
      async (owner, projectId) =>
        projectId ? ((await projects.find(owner, projectId))?.name ?? null) : null,
    ),
  );
  app.route("/api/members", memberFileRoutes(agent));
  app.route(
    "/api/credentials",
    credentialRoutes(credentials, () => environments.assertAvailable()),
  );
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (query.timeMin && query.timeMax) calendarRangeSchema.parse(query);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    // The person prepared it themselves in the app: it waits for them with no expiry.
    return c.json(
      await actions.propose(c.get("owner"), input, undefined, undefined, undefined, {
        noExpiry: true,
      }),
      201,
    );
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  // 「以后总是允许」 / 「以后都先问我」 on a review card.
  app.post("/api/actions/:id/rule", async (c) => {
    const body = z.object({ mode: z.enum(["always", "ask"]) }).parse(await c.req.json());
    return c.json(await agent.setReviewRule(c.get("owner"), c.req.param("id"), body.mode));
  });
  // The space's action review and its two lists of sentences.
  app.get("/api/review-settings", async (c) =>
    c.json(await readReviewSettings(db, c.get("owner"))),
  );
  app.put("/api/review-settings", async (c) =>
    c.json(await saveReviewSettings(db, c.get("owner"), parseReviewSettings(await c.req.json()))),
  );
  // The account's time zone for routines' clock times.
  app.get("/api/account-settings", async (c) =>
    c.json({ timezone: await readAccountZone(db, c.get("owner")) }),
  );
  app.put("/api/account-settings", async (c) =>
    c.json(
      await saveAccountZone(db, c.get("owner"), parseAccountSettings(await c.req.json()).timezone),
    ),
  );
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema
      .extend({ id: z.string().uuid().optional() })
      .parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  // The project's main chat, recorded on this server (created on first use).
  app.get("/api/main-thread", async (c) =>
    c.json({ threadId: await chat.mainThread(c.get("owner")), existing: true }),
  );
  // 开新主聊天. `replacing` is the main chat the client shows; when another
  // request already replaced it, the current one comes back unchanged. `formerName` names the
  // old one when it has no name (the client words it, strings.ts).
  app.post("/api/main-thread/new", async (c) => {
    const body = z
      .object({
        replacing: z.string().trim().min(1).max(256),
        formerName: z.string().trim().min(1).max(200),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    const user = c.get("user");
    const result = await startNewMain(db, owner, {
      ...body,
      by: user.userId === sampleUserId ? null : user.userId,
    });
    if (result.formerThreadId !== null)
      await tenancy.record(realOwnerOf(owner), "thread.newMain", null, null);
    return c.json({
      threadId: result.threadId,
      existing: true,
      switched: result.formerThreadId !== null,
    });
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  // The thread menu, served from this server's database before the runtime.
  app.route("/api/copilotkit/threads", chat.routes);
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    // What the middlewares above already found out about this request.
    const [user, space, owner] = [c.get("user"), c.get("space"), c.get("owner")];
    if (user && space && owner && !tenancy.unscopedPath.test(c.req.path))
      resolved.set(c.req.raw, Promise.resolve({ user, space, owner }));
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return squeezed(
      c.req.raw,
      c.req.path,
      new Response(body, { status: response.status, headers: response.headers }),
    );
  });
  if (config.webDir) mountWeb(app, config.webDir);
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
  );
  return {
    app,
    /** Hooks the listening HTTP server: the websockets the API itself answers. */
    attachServer: (server: UpgradeServer) => {
      for (const hook of upgradeHooks) hook(server);
    },
    auth,
    files,
    actions,
    workspace,
    agent,
    computer,
    environments,
    projects,
    overviewListing,
    credentials,
    apps,
    chat,
    tenancy,
    credentialStore,
  };
}
