// v1.5 member files: the pure rules (paths, days, first fill, prompt cuts), the disk store, the
// service over a store, and the API's permissions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { writeGoal, writePersona } from "../apps/server/src/accounts/records.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { envOwner } from "../apps/server/src/environments.ts";
import { MemberFiles, type MemberRef } from "../apps/server/src/member-files/service.ts";
import {
  DiskMemberFileStore,
  MemoryMemberFileStore,
} from "../apps/server/src/member-files/store.ts";
import { singleUserTenancy } from "../apps/server/src/tenancy-port.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import {
  appendLine,
  appendMemory,
  clipFile,
  clockIn,
  dayIn,
  dutyBody,
  filesPromptBlock,
  isMemberFileId,
  memberFileKind,
  memberFileMaxBytes,
  memberFilePromptCaps,
  noteDay,
  noteHeading,
  notePath,
  parseMemberFilePath,
  recentDays,
  runNoteLine,
  sectionOf,
  seedAgents,
  seedMemory,
  shiftDay,
  upsertSection,
} from "../packages/domain/src/member-files.ts";
import { memberTemplates } from "../packages/domain/src/member-templates.ts";
import { templateAgents } from "../packages/domain/src/template-setup.ts";

describe("member file paths", () => {
  it("allows the three kinds and nothing else", () => {
    for (const ok of ["AGENTS.md", "MEMORY.md", "notes/2026-11-05.md"])
      assert.equal(parseMemberFilePath(ok), ok);
    for (const bad of [
      "",
      "agents.md",
      "../AGENTS.md",
      "notes/../MEMORY.md",
      "/AGENTS.md",
      "notes/2026-13-01.md",
      "notes/2026-02-30.md",
      "notes/2026-11-05.txt",
      "notes/x/2026-11-05.md",
      "notes\\2026-11-05.md",
      "other.md",
      "AGENTS.md\0",
      "notes/",
    ])
      assert.equal(parseMemberFilePath(bad), null, JSON.stringify(bad));
    assert.equal(parseMemberFilePath(5), null);
  });
  it("names the kind and the day of a path", () => {
    assert.equal(memberFileKind("AGENTS.md"), "agents");
    assert.equal(memberFileKind("MEMORY.md"), "memory");
    assert.equal(memberFileKind("notes/2026-11-05.md"), "note");
    assert.equal(memberFileKind("x"), null);
    assert.equal(noteDay("notes/2026-11-05.md"), "2026-11-05");
    assert.equal(notePath("2026-11-05"), "notes/2026-11-05.md");
  });
  it("accepts only safe member ids", () => {
    for (const ok of ["yuki", randomUUID()]) assert.ok(isMemberFileId(ok));
    for (const bad of ["", "..", "a/b", "a b", ".hidden", "x".repeat(65)])
      assert.ok(!isMemberFileId(bad), bad);
  });
});

describe("member file days", () => {
  it("takes the day in the member's time zone, UTC without one", () => {
    const at = new Date("2026-11-05T20:30:00Z");
    assert.equal(dayIn(at, "Asia/Shanghai"), "2026-11-06");
    assert.equal(dayIn(at, "America/Los_Angeles"), "2026-11-05");
    assert.equal(dayIn(at, null), "2026-11-05");
    assert.equal(dayIn(at, "Not/AZone"), "2026-11-05");
    assert.equal(clockIn(at, "Asia/Shanghai"), "04:30");
    assert.equal(clockIn(at, undefined), "20:30");
  });
  it("lists the last days, newest first, across a month end", () => {
    assert.deepEqual(recentDays("2026-03-02", 4), [
      "2026-03-02",
      "2026-03-01",
      "2026-02-28",
      "2026-02-27",
    ]);
    assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  });
});

describe("member file text", () => {
  it("replaces, adds and removes a section and leaves the rest", () => {
    const text = "# Mia\n\n## 职责\n- 是谁：x\n\n## 备注\n手写的\n";
    assert.equal(sectionOf(text, "职责"), "- 是谁：x");
    const changed = upsertSection(text, "职责", "- 是谁：y");
    assert.equal(changed, "# Mia\n\n## 职责\n- 是谁：y\n\n## 备注\n手写的\n");
    assert.equal(upsertSection(text, "长期目标", "涨粉"), `${text}\n## 长期目标\n涨粉\n`);
    assert.equal(upsertSection(text, "职责", ""), "# Mia\n\n## 备注\n手写的\n");
    assert.equal(upsertSection("# Mia\n", "长期目标", ""), "# Mia\n");
  });
  it("fills AGENTS.md from the persona and the goal, and MEMORY.md from the facts", () => {
    const agents = seedAgents({
      name: "Mia",
      persona: { who: { value: "晨报" }, voice: "短句", background: null, boundaries: " " },
      goal: "每天出一页",
    });
    assert.equal(
      agents,
      "# Mia\n\n## 职责\n- 是谁：晨报\n- 说话方式：短句\n\n## 长期目标\n每天出一页\n",
    );
    assert.match(seedAgents({ name: "Mia" }), /还没有写/);
    assert.equal(dutyBody(null), "");
    assert.equal(
      seedMemory("Mia", [
        { text: "后写的", createdAt: "2026-02-01" },
        { text: "先写的", createdAt: "2026-01-01" },
      ]),
      "# Mia 的记忆\n\n- 先写的\n- 后写的\n",
    );
    assert.equal(seedMemory("Mia", []), "# Mia 的记忆\n");
  });
  it("adds a fact once and a line to the end", () => {
    const once = appendMemory("# 记忆\n", "喜欢短句");
    assert.equal(once, "# 记忆\n- 喜欢短句\n");
    assert.equal(appendMemory(once, "喜欢短句"), once);
    assert.equal(
      appendLine("", "- 08:00 a", noteHeading("2026-11-05")),
      "# 2026-11-05\n- 08:00 a\n",
    );
    assert.equal(appendLine("# d\n- x\n", "- y"), "# d\n- x\n- y\n");
  });
  it("cuts a long file and says how to read the rest", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const cut = clipFile(long, 500, "MEMORY.md");
    assert.ok(cut.length < 700);
    assert.match(
      cut,
      /\[… cut: \d+ more characters in MEMORY\.md; read the whole file with read_member_file\]/,
    );
    assert.equal(clipFile("short", 500, "MEMORY.md"), "short");
  });
  it("builds the block a run reads, with caps and no empty files", () => {
    assert.equal(
      filesPromptBlock({
        agents: " ",
        memory: null,
        today: { day: "2026-11-05", text: null },
        yesterday: { day: "2026-11-04", text: "" },
      }),
      "",
    );
    const block = filesPromptBlock({
      agents: "# Mia\n职责",
      memory: "x".repeat(memberFilePromptCaps.memory + 500),
      today: { day: "2026-11-05", text: "- 08:00 a" },
      yesterday: { day: "2026-11-04", text: "- 09:00 b" },
    });
    assert.match(block, /AGENTS\.md: your duties/);
    assert.match(block, /notes\/2026-11-05\.md/);
    assert.match(block, /notes\/2026-11-04\.md/);
    assert.match(block, /cut: 500 more characters in MEMORY\.md/);
    assert.match(block, /remember_fact/);
  });
  it("makes one line for a finished run", () => {
    assert.equal(
      runNoteLine("07:30", "出晨报", "finished", "发了\n三条"),
      "- 07:30 [出晨报] done: 发了 三条",
    );
    assert.equal(runNoteLine("07:30", "出晨报", "failed", ""), "- 07:30 [出晨报] failed");
    assert.ok(runNoteLine("07:30", "t", "finished", "x".repeat(900)).length < 260);
  });
  it("starts a template member's AGENTS.md with her duties, routines and apps", () => {
    const template = memberTemplates[0];
    assert.ok(template);
    const text = templateAgents(template, "小晨");
    assert.match(text, /^# 小晨\n/);
    assert.match(text, /## 职责\n/);
    assert.ok(text.includes(template.persona));
    assert.match(text, /## 例行\n- 每天 7:30 出一页晨报：/);
    assert.match(text, /## 要连接的应用\n/);
  });
});

describe("the disk store", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "member-files-disk-"));
  });
  after(async () => rm(root, { recursive: true, force: true }));

  it("keeps plain .md files and says who changed them", async () => {
    const store = new DiskMemberFileStore(root);
    assert.deepEqual(await store.list("s", "mia"), []);
    assert.equal(await store.read("s", mia, "AGENTS.md"), null);
    const meta = await store.write("s", "mia", "AGENTS.md", "# Mia\n", "caspian");
    assert.equal(meta.updatedBy, "caspian");
    assert.equal(await readFile(join(root, "mia", "AGENTS.md"), "utf8"), "# Mia\n");
    await store.write("s", "mia", "notes/2026-11-05.md", "# d\n", "Mia");
    const listed = await store.list("s", "mia");
    assert.deepEqual(listed.map((file) => file.path).sort(), ["AGENTS.md", "notes/2026-11-05.md"]);
    assert.equal((await store.read("s", "mia", "notes/2026-11-05.md"))?.updatedBy, "Mia");
  });
  it("reads a file changed by hand as the editor's", async () => {
    const store = new DiskMemberFileStore(root);
    await store.write("s", "bo", "MEMORY.md", "a", "caspian");
    const file = join(root, "bo", "MEMORY.md");
    await writeFile(file, "b by hand", "utf8");
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    const read = await store.read("s", "bo", "MEMORY.md");
    assert.equal(read?.content, "b by hand");
    assert.equal(read?.updatedBy, "editor");
  });
  it("refuses a path or member outside the three kinds and the member's own folder", async () => {
    const store = new DiskMemberFileStore(root);
    await assert.rejects(store.write("s", "mia", "../x.md", "x", "u"), /not available/);
    await assert.rejects(store.write("s", "mia", "notes/../../x.md", "x", "u"), /not available/);
    await assert.rejects(store.write("s", "..", "AGENTS.md", "x", "u"), /not available/);
    await assert.rejects(store.read("s", "a/b", "AGENTS.md"), /not available/);
    await assert.rejects(store.list("s", ".."), /Bad member id/);
    await assert.rejects(
      store.write("s", "mia", "MEMORY.md", "x".repeat(memberFileMaxBytes + 1), "u"),
      /at most 64 KB/,
    );
    await assert.rejects(stat(join(root, "x.md")));
    await mkdir(join(root, "keep"), { recursive: true });
  });
});

const mia = randomUUID();

describe("the memory store", () => {
  it("keeps files by member and refuses what the disk store refuses", async () => {
    const store = new MemoryMemberFileStore();
    await store.write("s", "yuki", "MEMORY.md", "a", "u");
    assert.equal((await store.read("s", "yuki", "MEMORY.md"))?.content, "a");
    assert.deepEqual(
      (await store.list("s", "yuki")).map((file) => file.path),
      ["MEMORY.md"],
    );
    assert.deepEqual(await store.list("s", "mia"), []);
    await assert.rejects(store.write("s", "yuki", "x.md", "a", "u"), /not available/);
  });
});

describe("the member files service", () => {
  let db: Store;
  let root: string;
  before(async () => {
    db = await createStore();
    root = await mkdtemp(join(tmpdir(), "member-files-service-"));
  });
  after(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  const clock = (iso: string) => () => new Date(iso);

  it("fills the first AGENTS.md and MEMORY.md from the older records, once", async () => {
    const id = randomUUID();
    const owner = "local-owner";
    const ledger = envOwner(owner, id);
    await writePersona(db, ledger, {
      fields: { who: "晨报", voice: "短句" },
      source: "owner",
      by: { userId: null },
      reason: null,
    });
    await writeGoal(db, ledger, "每天出一页", { userId: null });
    await db.put(owner, "memories", {
      id: "m1",
      text: "她的",
      accountId: id,
      createdAt: "2026-01-01",
    });
    await db.put(owner, "memories", { id: "m2", text: "别人的", accountId: randomUUID() });
    await db.put(owner, "memories", { id: "m3", text: "Yuki 的" });
    const files = new MemberFiles(new DiskMemberFileStore(join(root, "a")), db);
    const ref: MemberRef = { space: owner, owner, id, name: "Mia", timezone: null };
    const agents = await files.read(ref, "AGENTS.md");
    assert.match(agents?.content ?? "", /- 是谁：晨报/);
    assert.match(agents?.content ?? "", /## 长期目标\n每天出一页/);
    const memory = await files.read(ref, "MEMORY.md");
    assert.equal(memory?.content, "# Mia 的记忆\n\n- 她的\n");
    // Filled once: a later change to the old records does not reach the file, and the old
    // records stay as they were.
    await writeGoal(db, ledger, "改了", { userId: null });
    assert.match((await files.read(ref, "AGENTS.md"))?.content ?? "", /每天出一页/);
    assert.equal((await db.list(owner, "memories")).length, 3);
    const yuki: MemberRef = { space: owner, owner, id: "yuki", name: "Yuki", timezone: null };
    assert.match((await files.read(yuki, "MEMORY.md"))?.content ?? "", /- Yuki 的/);
    assert.doesNotMatch((await files.read(yuki, "MEMORY.md"))?.content ?? "", /她的/);
  });

  it("keeps what she learns: a fact once, a note line by her day, a section", async () => {
    const files = new MemberFiles(
      new DiskMemberFileStore(join(root, "b")),
      db,
      clock("2026-11-05T20:30:00Z"),
    );
    const ref: MemberRef = {
      space: "o",
      owner: "o",
      id: mia,
      name: "Mia",
      timezone: "Asia/Shanghai",
    };
    await files.remember(ref, "喜欢短句", "Mia");
    await files.remember(ref, "喜欢短句", "Mia");
    assert.equal(((await files.read(ref, "MEMORY.md"))?.content ?? "").split("喜欢短句").length, 2);
    await files.noteToday(ref, "读了\n三封邮件", "Mia");
    const note = await files.read(ref, "notes/2026-11-06.md");
    assert.equal(note?.content, "# 2026-11-06\n- 04:30 读了 三封邮件\n");
    await files.setSection(ref, "长期目标", "涨粉", "caspian");
    assert.match((await files.read(ref, "AGENTS.md"))?.content ?? "", /## 长期目标\n涨粉\n/);
    await assert.rejects(files.read(ref, "../x"), /not available/);
  });

  it("does not lose appends that arrive together", async () => {
    const files = new MemberFiles(new DiskMemberFileStore(join(root, "c")), db);
    const ref: MemberRef = { space: "o", owner: "o", id: mia, name: "Mia", timezone: null };
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => files.remember(ref, `fact ${i}`, "Mia")),
    );
    const text = (await files.read(ref, "MEMORY.md"))?.content ?? "";
    for (let i = 0; i < 12; i++) assert.ok(text.includes(`- fact ${i}\n`), `fact ${i}`);
  });

  it("gives a run today's and yesterday's notes, cut to their caps", async () => {
    const files = new MemberFiles(
      new DiskMemberFileStore(join(root, "d")),
      db,
      clock("2026-11-05T10:00:00Z"),
    );
    const ref: MemberRef = { space: "o", owner: "o", id: mia, name: "Mia", timezone: null };
    await files.write(ref, "notes/2026-11-04.md", "# 2026-11-04\n- 昨天的事\n", "Mia");
    await files.write(ref, "notes/2026-11-03.md", "# 2026-11-03\n- 前天的事\n", "Mia");
    await files.write(ref, "AGENTS.md", `# Mia\n${"长".repeat(7000)}`, "caspian");
    const block = await files.promptBlock(ref);
    assert.match(block, /昨天的事/);
    assert.doesNotMatch(block, /前天的事/);
    assert.match(block, /cut: \d+ more characters in AGENTS\.md/);
  });

  it("notes a settled run for the member, and ignores a status that ends nothing", async () => {
    const files = new MemberFiles(
      new DiskMemberFileStore(join(root, "e")),
      db,
      clock("2026-11-05T07:30:00Z"),
    );
    const ref: MemberRef = { space: "o", owner: "o", id: mia, name: "Mia", timezone: null };
    const task = (patch: Partial<AgentTask>) =>
      ({ id: "t", title: "出晨报", status: "succeeded", ...patch }) as AgentTask;
    await files.noteSettledRun(ref, task({ result: "发了三条" }));
    await files.noteSettledRun(ref, task({ status: "failed", error: "mail down" }));
    await files.noteSettledRun(ref, task({ status: "running" }));
    await files.noteSettledRun(ref, task({ status: "cancelled" }));
    const note = (await files.read(ref, "notes/2026-11-05.md"))?.content;
    assert.equal(
      note,
      "# 2026-11-05\n- 07:30 [出晨报] done: 发了三条\n- 07:30 [出晨报] failed: mail down\n",
    );
    assert.equal(
      MemberFiles.settledLine({ title: "x", status: "paused" }, "01:00"),
      "- 01:00 [x] paused",
    );
  });
});

describe("the member files API", () => {
  let db: Store;
  let directory: string;
  let server: Awaited<ReturnType<typeof createApp>>;
  let token: string;
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "member-files-api-"));
    db = await createStore();
    const config: Config = {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
    };
    server = await createApp(db, config, { tenancy: singleUserTenancy });
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    token = ((await session.json()) as { token: string }).token;
  });
  after(async () => {
    await server.chat.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) =>
    server.app.request(`/api/members${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.auth === false ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  test("needs a session", async () => {
    assert.equal((await call("/yuki/files", { auth: false })).status, 401);
  });
  test("lists, reads and saves Yuki's files, on disk under the data directory", async () => {
    const listed = (await (await call("/yuki/files")).json()) as {
      files: { path: string }[];
    };
    assert.deepEqual(listed.files.map((file) => file.path).sort(), ["AGENTS.md", "MEMORY.md"]);
    const put = await call("/yuki/files/AGENTS.md", {
      method: "PUT",
      body: { content: "# Yuki\n回答末尾写 OK\n" },
    });
    assert.equal(put.status, 200, await put.clone().text());
    const read = (await (await call("/yuki/files/AGENTS.md")).json()) as {
      content: string;
      updatedBy: string;
    };
    assert.equal(read.content, "# Yuki\n回答末尾写 OK\n");
    assert.ok(read.updatedBy.length > 0 && read.updatedBy !== "system");
    assert.equal(
      await readFile(join(directory, "members", "yuki", "AGENTS.md"), "utf8"),
      read.content,
    );
    assert.equal((await call("/yuki/files/notes/2026-11-05.md")).status, 404);
  });
  test("refuses other paths, other members, and too large a file", async () => {
    assert.equal((await call("/yuki/files/secret.md")).status, 400);
    assert.equal((await call("/yuki/files/..%2F..%2Fetc%2Fpasswd")).status, 400);
    assert.equal(
      (await call("/yuki/files/notes/2026-02-30.md", { method: "PUT", body: { content: "x" } }))
        .status,
      400,
    );
    assert.equal((await call(`/${randomUUID()}/files`)).status, 404);
    assert.equal((await call("/someone-else/files")).status, 404);
    assert.equal((await call("/..%2Fyuki/files")).status, 404);
    const big = await call("/yuki/files/MEMORY.md", {
      method: "PUT",
      body: { content: "x".repeat(memberFileMaxBytes + 1) },
    });
    assert.ok(big.status >= 400 && big.status < 500);
  });
});

test("a card's preview leaves every heading out, the section names it already", async () => {
  const { filePreview } = await import("../packages/client/src/shell/members/member-files.ts");
  const agents = "# Mia\n\n## 职责\n（还没有写。）\n\n## 长期目标\n做成一件事\n### 细节\n- 第一条";
  assert.equal(filePreview(agents), "（还没有写。）\n做成一件事\n- 第一条");
  assert.equal(filePreview("#话题 不是标题\n正文"), "#话题 不是标题\n正文");
});
