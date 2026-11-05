# Connected apps and MCP (v1.4 C)

Connected apps belong to the space: connect once, every member and every project uses them. Actions on them go through B's review (`docs/review-window.md`).

## Directory

`GET /api/apps` (`apps/server/src/apps/service.ts` `directory`): one entry per app, `{ id, name, type, state, preset, abilities, url?, account?, tools?, connect }`.

- `state`: `connected`, `not_connected`, `not_configured` (the server lacks what it needs: Google client for Google, `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `TOKEN_ENCRYPTION_KEY` for Slack, the key for MCP).
- `gmail`, `google-calendar`: the existing Google connection (`mail.md`); its own 谷歌 row in 设置 connects and disconnects it.
- `mailbox` (邮箱): the project's own mailbox (`mail.md`, `credentials.md`); added in the project's credentials.
- `slack`: OAuth v2, redirect `<PUBLIC_API_URL>/api/slack/callback`. Scopes: channels/groups read and history, `users:read` (names), `chat:write`, `chat:write.public`. The API and authorize addresses are Slack's own; `SLACK_API_URL` / `SLACK_AUTHORIZE_URL` replace them for tests and local fakes only.
- MCP presets (`mcpPresets`, `apps/server/src/apps/mcp.ts`): Notion `https://mcp.notion.com/mcp`, Linear `https://mcp.linear.app/mcp`, GitHub `https://api.githubcopilot.com/mcp/`. Addresses written from memory, not checked against the services from here; marked 预设. Connecting one is the same as adding it as a custom server.
- 自定义 MCP: name, address, optional bearer token (`POST /api/apps/mcp`).

## Connecting

`POST /api/apps/:id/connect`, `POST /api/apps/:id/disconnect`, `POST /api/apps/mcp`.

- Slack and Google answer `{ url }` to authorise at. Callbacks (no session, like Google's): `/api/slack/callback`, `/api/apps/mcp/callback`; the state is single use, 10 minutes.
- MCP with a token: connects with `Authorization: Bearer`, lists the tools to prove it, saves. A server that refuses: 422.
- MCP without a token: tried as it is (no auth), else MCP OAuth by the SDK (discovery, dynamic client registration, PKCE; `StoredOAuthProvider`) and the answer is `{ url }`; the callback finishes it. A 401 with no usable OAuth metadata: 422, 「需要访问令牌」, and the form asks for one.
- Connected: when an MCP server finishes authorising (the callback) or a token connect succeeds, and when Slack finishes, `AppsService.onConnected` runs (`Routines.appConnected`): the conversation that started the connection (`threadId` in the connect body, kept with the pending authorisation) gets 「<应用> 连好了」, and every routine paused for that app (`routine.authBlock`, docs/routines.md) goes back to waiting for its trigger, its own conversation told 「<应用> 连好了，『例行』接着跑」. With no `threadId` only the woken routines' conversations hear it. Google's own callback is not hooked.
- Addresses: https, public; plain http only to this machine and not on a live server (`checkMcpUrl`).
- Tokens (bearer, Slack bot token, MCP OAuth tokens and client registration) are one sealed envelope in the app's record of the space (`apps` records, key `TOKEN_ENCRYPTION_KEY`, the same sealing as Google's tokens). Never in an API response, a log, an event or the model's sight. Refreshed MCP tokens are sealed back into the record. Disconnect deletes the record (Slack's token is revoked at Slack too).

## Tools for runs

`AppsService.runTools` gives chat (`conversation.ts`) and task runs (`engine/model.ts`) the tools of every connected app; nothing for one that is not connected.

- MCP: `app_<slug>__<tool>` (non-name characters become `_`, at most 64 characters), described as `[App] description`. At most 30 tools per server and 60 in all; a server that does not answer gives none for that run. The tool list is cached 60 seconds per server; every request ends within 30 seconds.
- A tool whose `readOnlyHint` is true runs at once and its result comes back as data with a note that it is untrusted. Any other tool (including one with no annotation) is not run: it becomes a proposal `app.call` `{ app, appName, tool, arguments }`, reviewed like B's others (rule, action review, card, 允许一次 · 总是允许 · 拒绝). In a task it pauses the run like `prepare_email` (`waiting_approval`; routines get `draft_waiting` only for messages). In chat (`AgentService.proposeFromChat`) there is no task: the card waits with no expiry and runs from the card. The rule for 总是允许 is per kind (`app.call` for every app).
- In the hall, a reply routed to a project keeps the connected apps' tools (`app_*`, `spaceOwnTool` in `hall-gate.ts`): the hall line calls them the space's own, and without them a model that routed such a request to a project met 「Unknown tool」.
- The prompts name the connected apps (`promptLine`) and say results are untrusted and writes wait for review.
- Approval re-checks that the app is still the same connection (disconnecting or reconnecting refuses it, 409).

## Slack

- `slack_read`: no channel lists channels (name, id, `readable`); a channel (id or name) reads its latest messages (at most 50); with `threadTs` it reads that message and its replies. Each message is name, time, text, link, `ts`; text is cut at 600 characters and one answer at 8000, the newest kept. A channel the Slack app is not in answers that there is no permission and the person must `/invite` it.
- `prepare_slack_message { channel, text, threadTs? }` → proposal `slack.send`, a message to people (`messageKinds`), so a draft: 发送 · 不发, never let through by the action review's judgment alone. Posted with `chat.postMessage` when sent.
- Not configured (no client id/secret) or not connected: the tools are absent, `POST /api/apps/slack/connect` answers 503. The directory entry carries `note`, the reason: hosted 「暂不可用」; open, which `.env` values are missing and the README steps (「连接 Slack」).
- The draft card names the channel (`#general`), the message a thread reply answers (`threadPreview`), and the whole text. After 发送 the card shows 已发到 Slack #channel and the message's link (`chat.getPermalink`).

## UI

- 设置 › 连接的应用 (`apps/web/src/panels/task/AppsSection.tsx`, rows from `packages/client/src/shell/apps.ts`): each app with its state, 连接 / 断开, a token field when a server wants one, a form for a custom MCP server.
- The @ list names the connected apps (kind 应用); picking one writes `@name`, and the prompt tells the member that app's tools are theirs to use.
- The review sheet shows an app call (app, operation, arguments) or a Slack message (channel, text).

## Tests

`tests/apps.test.ts` (the conversation told when OAuth or a token connect finishes, a routine paused for the app resumed, directory states, address check, token connect with a local fake MCP server over streamable HTTP, MCP OAuth with registration, tool naming in chat and tasks, read-only direct, write call as `app.call` and run on approval, disconnect removing tokens, Slack hidden without config, Slack draft sent on approval), `apps/mobile/test/shell-apps.test.ts` (rows, @ entries, card words).
