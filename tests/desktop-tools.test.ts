// What a member can do on the members' computer from a conversation (desktop-tools.ts), the
// service's client of the computer container (desktop-agent.ts), and the config that connects
// them. The tools keep the names the product already uses, leave a receipt for a command, wait
// while the person drives, and start no approval flow of their own.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopAgent } from "../apps/server/src/desktop-agent.ts";
import { DesktopComputer, personDrivesNote } from "../apps/server/src/desktop-computer.ts";
import { desktopScreenshotRoutes } from "../apps/server/src/desktop-screenshots.ts";
import {
  browserActionOf,
  desktopInstructions,
  desktopTools,
} from "../apps/server/src/desktop-tools.ts";
import { desktopConfig, FakeAgent } from "./helpers/desktop.ts";

async function setup() {
  const agent = new FakeAgent();
  const computer = new DesktopComputer(await createStore(), desktopConfig, agent.asAgent(), {
    sweepMs: null,
  });
  const tools = desktopTools(computer, { scope: "chat:t1", owner: () => "owner" });
  const call = async (name: string, args: object = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool?.execute, name);
    return (await tool.execute(args as never)) as never as Record<string, unknown>;
  };
  return { agent, computer, tools, call };
}

test("the tools keep the product's computer tool names, and add the browser and the screen", async () => {
  const { tools } = await setup();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "computer_browser",
    "computer_screenshot",
    "computer_status",
    "list_computer_files",
    "mkdir_computer",
    "read_computer_file",
    "run_computer_command",
    "start_computer",
    "stop_computer",
    "write_computer_file",
  ]);
  // Nothing in them asks for an approval of their own.
  assert.ok(!tools.some((tool) => /approv|proposal/i.test(tool.name)));
  assert.match(desktopInstructions, /never send, post, submit a form, sign in, buy or upload/i);
  assert.match(desktopInstructions, /reviewed prepare tools/);
});

test("a command runs once per operation ID and comes back as its receipt", async () => {
  const { agent, call } = await setup();
  const first = (await call("run_computer_command", {
    command: "echo ok",
    operationId: "op-1",
  })) as { status: string; stdout: string; exitCode: number };
  assert.deepEqual([first.status, first.stdout, first.exitCode], ["succeeded", "ok\n", 0]);
  await call("run_computer_command", { command: "echo ok", operationId: "op-1" });
  assert.equal(agent.execs.length, 1);
  const clash = await call("run_computer_command", { command: "echo no", operationId: "op-1" });
  assert.match(String(clash.error), /different command/);
  const bad = await call("run_computer_command", { command: "ls", cwd: "/etc", operationId: "x" });
  assert.match(String(bad.error), /inside \/workspace/);
  const invalid = await call("run_computer_command", { command: "ls" });
  assert.ok(invalid.error, "an operation ID is required");
});

test("the other conversation's operation ID is its own", async () => {
  const { agent, computer } = await setup();
  const one = desktopTools(computer, { scope: "chat:a", owner: () => "owner" });
  const two = desktopTools(computer, { scope: "chat:b", owner: () => "owner" });
  const run = (tools: typeof one) =>
    tools
      .find((tool) => tool.name === "run_computer_command")
      ?.execute?.({
        command: "echo ok",
        operationId: "same",
      } as never);
  await run(one);
  await run(two);
  assert.equal(agent.execs.length, 2);
});

test("while the person drives, tools that change anything wait and say why; looking still works", async () => {
  const { agent, computer, call } = await setup();
  await computer.start();
  await computer.setControl("owner", { by: "person" });
  for (const [name, args] of [
    ["run_computer_command", { command: "touch x", operationId: "o" }],
    ["write_computer_file", { path: "a.txt", text: "x" }],
    ["mkdir_computer", { path: "d" }],
    ["stop_computer", {}],
    ["computer_browser", { action: "open", url: "https://example.com" }],
  ] as const) {
    const result = await call(name, args);
    assert.equal(result.error, personDrivesNote, name);
  }
  assert.deepEqual(agent.execs, []);
  assert.equal(agent.running, true, "stop_computer did not stop it");
  assert.equal(((await call("computer_status")) as { control?: string }).control, "person");
  await call("list_computer_files", {});
  await call("read_computer_file", { path: "a.txt" });
  assert.equal(((await call("computer_screenshot")) as unknown as unknown[]).length, 2);
  await computer.setControl("owner", { by: "member" });
  assert.equal((await call("mkdir_computer", { path: "d" })).error, undefined);
});

test("a tool starts a paused computer by itself, and start_computer / stop_computer report the state", async () => {
  const { agent, call } = await setup();
  assert.equal(agent.running, false);
  await call("read_computer_file", { path: "/workspace/a.txt" });
  assert.equal(agent.running, true);
  assert.equal(((await call("stop_computer")) as { status: string }).status, "stopped");
  assert.equal(((await call("start_computer")) as { status: string }).status, "running");
});

test("the browser tool turns a call into one action and checks what that action needs", () => {
  assert.deepEqual(browserActionOf({ action: "open", url: " https://example.com " }), {
    action: "open",
    url: "https://example.com",
  });
  assert.deepEqual(browserActionOf({ action: "click", text: "Sign up", url: "ignored" }), {
    action: "click",
    text: "Sign up",
  });
  assert.deepEqual(browserActionOf({ action: "type", text: "hi", field: "q" }), {
    action: "type",
    text: "hi",
    field: "q",
  });
  assert.deepEqual(browserActionOf({ action: "press", key: "Enter" }), {
    action: "press",
    key: "Enter",
  });
  assert.deepEqual(browserActionOf({ action: "read", text: "x" }), { action: "read" });
  assert.deepEqual(browserActionOf({ action: "back" }), { action: "back" });
  for (const bad of [
    { action: "open" },
    { action: "click" },
    { action: "type" },
    { action: "press" },
  ])
    assert.throws(() => browserActionOf(bad as never), bad.action);
});

test("the browser tool reads the page the desktop's browser shows", async () => {
  const { agent, call } = await setup();
  const page = (await call("computer_browser", { action: "open", url: "https://example.com" })) as {
    title: string;
    text: string;
  };
  assert.deepEqual([page.title, page.text], ["Example", "Example Domain"]);
  assert.deepEqual(agent.browserActions, [{ action: "open", url: "https://example.com" }]);
  assert.equal(agent.running, true, "the browser step started the paused computer");
});

test("a screenshot comes back as text plus an image, and the chat can show the person the same picture", async () => {
  const { call, computer } = await setup();
  const parts = (await call("computer_screenshot")) as unknown as {
    type: string;
    content?: string;
    source?: { mimeType: string; value: string };
  }[];
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "image"],
  );
  assert.deepEqual([parts[1].source?.mimeType, parts[1].source?.value], ["image/png", "UE5H"]);
  const { shotId } = JSON.parse(parts[0].content ?? "{}") as { shotId?: string };
  assert.match(shotId ?? "", /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(computer.shotOf(shotId ?? ""), Buffer.from("UE5H", "base64"));
});

test("GET /api/computer/screenshots/:id answers the kept picture as PNG, an unknown one 404", async () => {
  const { computer } = await setup();
  const app = desktopScreenshotRoutes(() => computer);
  const id = computer.keepShot(Buffer.from("png-bytes").toString("base64"));
  const reply = await app.request(`/${id}`);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("content-type"), "image/png");
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await reply.arrayBuffer()).toString(), "png-bytes");
  assert.equal((await app.request("/no-such-picture-0000")).status, 404);
});

// ---- the client of the computer container -----------------------------------------------------

test("the client sends the token, follows no redirect and reads the token file again after a refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yuki-token-"));
  try {
    const file = join(dir, "token");
    await writeFile(file, `${"a".repeat(40)}\n`);
    const seen: { url: string; auth: string | null; redirect?: string }[] = [];
    let status = 200;
    const agent = new DesktopAgent({
      url: "http://computer:7070/",
      tokenFile: file,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          auth: new Headers(init.headers).get("authorization"),
          redirect: init.redirect,
        });
        return Response.json(
          status === 200 ? { desktop: "stopped", live: null } : { error: "no" },
          {
            status,
          },
        );
      }) as typeof fetch,
    });
    await agent.state();
    assert.deepEqual(seen[0], {
      url: "http://computer:7070/state",
      auth: `Bearer ${"a".repeat(40)}`,
      redirect: "error",
    });
    status = 401;
    await assert.rejects(() => agent.state(), /does not answer/);
    await writeFile(file, `${"b".repeat(40)}\n`);
    status = 200;
    await agent.state();
    assert.equal(seen.at(-1)?.auth, `Bearer ${"b".repeat(40)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the client says the computer does not answer when it is unreachable or has no token yet", async () => {
  const none = new DesktopAgent({ url: "http://computer:7070", tokenFile: "/nonexistent/token" });
  await assert.rejects(() => none.state(), /does not answer/);
  const down = new DesktopAgent({
    url: "http://computer:7070",
    token: "t".repeat(40),
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(() => down.start(), /docker compose ps/);
  const refused = new DesktopAgent({
    url: "http://computer:7070",
    token: "t".repeat(40),
    fetch: (async () =>
      Response.json({ error: "Give a command" }, { status: 400 })) as typeof fetch,
  });
  await assert.rejects(() => refused.exec("", "/workspace", 5), /Give a command/);
  const files = new DesktopAgent({
    url: "http://computer:7070",
    token: "t".repeat(40),
    fetch: (async () => Response.json({ error: "Path must be inside /workspace" })) as typeof fetch,
  });
  await assert.rejects(
    () => files.files({ operation: "read", path: "/etc" }),
    /inside \/workspace/,
  );
});

// ---- the configuration ------------------------------------------------------------------------

test("DESKTOP_URL connects a computer, needs its token, and nothing is connected without it", () => {
  const names = ["DESKTOP_URL", "DESKTOP_TOKEN", "DESKTOP_TOKEN_FILE", "DESKTOP_IDLE_MINUTES"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const set = (values: Record<string, string>) => {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
  };
  try {
    set({});
    assert.equal(readConfig().desktop, undefined);
    set({ DESKTOP_URL: "http://computer:7070", DESKTOP_TOKEN_FILE: "/secrets/token" });
    assert.deepEqual(readConfig().desktop, {
      url: "http://computer:7070",
      token: undefined,
      tokenFile: "/secrets/token",
      idleMinutes: 15,
    });
    set({
      DESKTOP_URL: "http://localhost:7070/",
      DESKTOP_TOKEN: "t".repeat(40),
      DESKTOP_IDLE_MINUTES: "3",
    });
    assert.equal(readConfig().desktop?.url, "http://localhost:7070");
    assert.equal(readConfig().desktop?.idleMinutes, 3);
    set({ DESKTOP_URL: "http://computer:7070" });
    assert.throws(() => readConfig(), /DESKTOP_TOKEN_FILE/);
    for (const url of [
      "computer:7070",
      "ftp://computer",
      "http://computer:7070/path",
      "http://a b",
    ]) {
      set({ DESKTOP_URL: url, DESKTOP_TOKEN: "t".repeat(40) });
      assert.throws(() => readConfig(), /DESKTOP_URL/, url);
    }
    set({
      DESKTOP_URL: "http://computer:7070",
      DESKTOP_TOKEN: "t".repeat(40),
      DESKTOP_IDLE_MINUTES: "0",
    });
    assert.throws(() => readConfig(), /DESKTOP_IDLE_MINUTES/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
