// A server with no computer and a fake model, wired as the app wires the credential, member and
// agent services, for tests that follow an owner's journey through members, groups and tasks.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { ActionService } from "../../apps/server/src/actions.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import { BrowserService } from "../../apps/server/src/browser.ts";
import { ComputerService } from "../../apps/server/src/computer.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { randomCredentialKey } from "../../apps/server/src/credentials/crypto.ts";
import { credentialRoutes } from "../../apps/server/src/credentials/routes.ts";
import { CredentialService } from "../../apps/server/src/credentials/service.ts";
import { CredentialStore } from "../../apps/server/src/credentials/store.ts";
import { createStore, type Store } from "../../apps/server/src/db.ts";
import { AgentService } from "../../apps/server/src/engine/service.ts";
import { environmentRoutes } from "../../apps/server/src/environment-routes.ts";
import { EnvironmentService, envOwner } from "../../apps/server/src/environments.ts";
import { AppError } from "../../apps/server/src/errors.ts";
import { Files } from "../../apps/server/src/files.ts";
import { allowAllGate } from "../../apps/server/src/gate.ts";
import { GoogleAuth } from "../../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../../apps/server/src/workspace.ts";
import type { EnvironmentView } from "../../packages/domain/src/environments.ts";
import { config as base } from "./computer.ts";
import { modelFixture } from "./model.ts";

/** A proxy address some older journeys still pass along; with no computer it is ignored. */
const proxy = "socks5://proxyuser:pass@203.0.113.90:1080";
type Call = { name: string; arguments: object };

let owners = 0;
async function harness(t: TestContext, ownerArg?: string) {
  const logged: string[] = [];
  for (const method of ["log", "warn", "error", "info"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  const queue: (Call | undefined)[] = [];
  const { requests } = await modelFixture(t, async () => queue.shift());
  const directory = await mkdtemp(join(tmpdir(), "openmuse-members-"));
  const db: Store = await createStore();
  const config: Config = {
    ...base,
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const store = new CredentialStore(db, randomCredentialKey());
  await store.open();
  const auth = await createAuth(db, config);
  const files = new Files(db, config, auth);
  const workspace = new WorkspaceService(db, config, files, new GoogleAuth(db, config));
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const computer = new ComputerService(db, config);
  const environments = new EnvironmentService(db, computer, config, store);
  store.nameAccountsWith((scope, id) => environments.nameOf(scope, id));
  const billing = { ...allowAllGate };
  const agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    computer,
    environments,
    billing,
  );
  const credentials = new CredentialService(db, store, environments, computer);
  credentials.agent = agent;
  environments.onLoginSaved = (owner, environmentId, site) =>
    credentials.loginSaved(owner, { type: "account", environmentId }, site);
  environments.roomForSignIns = (owner, logins) => agent.assertRoomForSignIns(owner, logins);
  environments.onAccountMoved = (from, to, environmentId, sites, withdrawn) =>
    agent.accountMoved(from, to, environmentId, sites, withdrawn);
  t.after(async () => {
    await agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = ownerArg ?? `member-owner-${++owners}`;
  const app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.message }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    return c.json({ error: String(error) }, 502);
  });
  const requestAs = { owner };
  app.use("*", async (c, next) => {
    c.set("owner", requestAs.owner);
    await next();
  });
  app.route("/api/environments", environmentRoutes(environments, computer, files));
  app.route(
    "/api/credentials",
    credentialRoutes(credentials, () => {}),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  const account = async (name: string, _siteLogins: object[] = []) => {
    const created = await api("POST", "/api/environments", { name });
    assert.equal(created.status, 201, created.text);
    return { ...(created.body as EnvironmentView), derived: envOwner(owner, created.body.id) };
  };
  const context = (computerOwner: string, taskId = "task-x") => ({
    owner,
    computerOwner: () => computerOwner,
    actor: { type: "task" as const, taskId, title: "t", run: 1 },
    by: { taskId, title: "t" },
  });
  return {
    config,
    db,
    store,
    computer,
    environments,
    agent,
    billing,
    credentials,
    owner,
    requestAs,
    api,
    account,
    context,
    queue,
    requests,
    logged,
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
export { harness, proxy };
