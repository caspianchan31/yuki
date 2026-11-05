// v1.4 (docs/apps.md): connected apps in 设置 (the directory's rows) and in the @ list.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appCallLines, appRows, mentionApps } from "../../../packages/client/src/shell/apps.ts";
import { reviewCardView } from "../../../packages/client/src/shell/chat/core.ts";
import { filterMentions, mentionOptions } from "../../../packages/client/src/shell/chat/mention.ts";
import { t } from "../../../packages/client/src/shell/strings.ts";
import type { AppEntry } from "../../../packages/domain/src/apps.ts";

const entry = (patch: Partial<AppEntry> & Pick<AppEntry, "id" | "name">): AppEntry => ({
  type: "mcp",
  state: "not_connected",
  preset: true,
  abilities: [],
  connect: "oauth",
  ...patch,
});
const directory: AppEntry[] = [
  entry({
    id: "gmail",
    name: "Gmail",
    type: "google",
    state: "connected",
    preset: false,
    account: "a@x.com",
  }),
  entry({ id: "mailbox", name: "邮箱", type: "mailbox", preset: false, connect: "elsewhere" }),
  entry({ id: "slack", name: "Slack", type: "slack", state: "not_configured", preset: false }),
  entry({ id: "mcp:notion", name: "Notion", url: "https://mcp.notion.com/mcp" }),
  entry({
    id: "mcp:fake",
    name: "Fake",
    state: "connected",
    preset: false,
    connect: "token",
    url: "https://x.example/mcp",
    tools: 2,
  }),
];

describe("appRows", () => {
  const rows = appRows(directory);
  const row = (id: string) => rows.find((item) => item.id === id);

  it("gives every app its state in words", () => {
    assert.equal(row("gmail")?.stateLabel, "已连接");
    assert.equal(row("mailbox")?.stateLabel, "没连接");
    assert.equal(row("slack")?.stateLabel, "服务器没配置");
  });

  it("offers 连接 only where it can be connected from here, 断开 only where connected", () => {
    assert.equal(row("mcp:notion")?.connect, "连接");
    assert.equal(row("mcp:notion")?.disconnect, null);
    assert.equal(row("slack")?.connect, null, "not configured on the server");
    assert.equal(
      row("mailbox")?.connect,
      null,
      "the mailbox is added in the project's credentials",
    );
    assert.match(row("mailbox")?.line ?? "", /凭据/);
    assert.equal(row("gmail")?.connect, null, "Google keeps its own row");
    assert.equal(row("mcp:fake")?.disconnect, "断开");
    assert.equal(row("mcp:fake")?.connect, null, "a custom server is removed and added again");
  });

  it("marks MCP servers as presets or custom, and shows the address and tools", () => {
    assert.equal(row("mcp:notion")?.tag, "预设");
    assert.equal(row("mcp:fake")?.tag, "自定义");
    assert.equal(row("gmail")?.tag, "");
    assert.match(row("mcp:notion")?.line ?? "", /mcp\.notion\.com/);
    assert.match(row("mcp:fake")?.line ?? "", /2 个工具/);
  });
});

describe("apps in the @ list", () => {
  const source = {
    main: { id: "main", name: "Yuki" },
    members: [],
    groups: [],
    tasks: [],
    groupId: null,
    groupName: (id: string) => id,
  };

  it("names the connected apps only, as 应用, after everything else", () => {
    assert.deepEqual(mentionApps(directory), [
      { id: "gmail", name: "Gmail" },
      { id: "mcp:fake", name: "Fake" },
    ]);
    const options = mentionOptions({ ...source, apps: mentionApps(directory) });
    assert.deepEqual(
      options.map((option) => `${option.kind}:${option.name}`),
      ["member:Yuki", "app:Gmail", "app:Fake"],
    );
    assert.equal(t.mention.kinds.app, "应用");
    assert.deepEqual(
      filterMentions(options, "fa").map((option) => option.name),
      ["Fake"],
    );
  });
});

describe("the review card of an app's action", () => {
  it("lists the tool's own arguments, key and value, not a calendar's fields", () => {
    assert.deepEqual(
      appCallLines({
        app: "mcp:fakenotes",
        tool: "create_note",
        arguments: { title: "买牛奶", pinned: true, tags: ["a", "b"] },
      }),
      [
        { label: "title", value: "买牛奶" },
        { label: "pinned", value: "true" },
        { label: "tags", value: '["a","b"]' },
      ],
    );
    assert.deepEqual(appCallLines({ tool: "ping" }), []);
  });
  it("names the kinds; a Slack message is a draft with 发送 and 不发", () => {
    assert.equal(t.review.kinds["app.call"], "调用应用");
    assert.equal(t.review.kinds["slack.send"], "发送 Slack 消息");
    const slack = reviewCardView({
      status: "awaiting_review",
      expiresAt: "9999-12-31",
      noExpiry: true,
      draft: true,
    });
    assert.equal(slack.approve, t.review.sendDraft);
    assert.equal(slack.deny, t.review.noSend);
    const call = reviewCardView({
      status: "awaiting_review",
      expiresAt: "9999-12-31",
      noExpiry: true,
    });
    assert.equal(call.approve, t.review.allowOnce);
  });
});
