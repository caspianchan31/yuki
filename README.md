<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/yuki/banner-dark.svg">
  <img alt="Yuki — AI teammates in your chat" src="assets/yuki/banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-yuki-does"><b>What it does</b></a> ·
  <a href="https://yukilab.si"><b>Hosted version</b></a> ·
  <a href="README.zh-CN.md"><b>中文</b></a>
</p>

Yuki is an AI teammate that lives in a chat. Open it and Yuki is already there: tell it what you need in one sentence. Add more teammates when you want help, put them in a group, and they hand work to each other in the open. When something needs a decision, they come to you; nothing goes out in your name until you say so.

This repository is the open-source core: single-user, running on your own machine, MIT licensed.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/yuki/chat-dark.svg">
  <img alt="A Yuki conversation: a routine made from one sentence, and an email draft waiting for Send" src="assets/yuki/chat-light.svg" width="100%">
</picture>

## What Yuki does

<table>
<tr>
<td width="50%" valign="top">

**Talk, don't configure**<br>
No setup forms. The first thing you say becomes the teammate's job; to change it, just say so.

</td>
<td width="50%" valign="top">

**Teammates and groups**<br>
Groups of 2 to 6. `@` a teammate, a group, a routine or an app. Handoffs happen in the conversation, where you can see them.

</td>
</tr>
<tr>
<td valign="top">

**Routines**<br>
"Every weekday at 9…" or "when an email arrives…". Pause, test and edit them on the teammate's card. A run with nothing new stays quiet.

</td>
<td valign="top">

**Skills**<br>
Save a way of working in one sentence, or have Yuki learn it from something it just did with you.

</td>
</tr>
<tr>
<td valign="top">

**Apps and MCP**<br>
Gmail, Google Calendar, your own mailbox, Slack, and any MCP server, including one running on your own machine. Connect once; every teammate can use it.

</td>
<td valign="top">

**You approve what matters**<br>
Allow once, always allow, or deny. Email and Slack messages are drafts until you press Send. Action review checks each step against your own rules.

</td>
</tr>
</table>

Conversations live in your own database (embedded PGlite, or your Postgres). Secrets are sealed with your own key and never shown to the model.

## Quick start

Needs Node 22+ and pnpm 11, and an API key of a model provider (OpenAI, Anthropic or Google).

```sh
git clone https://github.com/caspianchan31/yuki.git
cd yuki
pnpm install
pnpm --dir apps/web install
cp .env.example .env
```

Two keys of your own, kept out of the repository:

```sh
mkdir -p ~/.yuki
openssl rand -base64 32 > ~/.yuki/credential.key && chmod 600 ~/.yuki/credential.key
openssl rand -base64 32   # paste it as TOKEN_ENCRYPTION_KEY below
```

In `.env`, set:

```sh
WORKSPACE_MODE=live
AGENT_BACKEND=model
MODEL=openai/gpt-5            # or anthropic/<model> or google/<model>
OPENAI_API_KEY=sk-...         # the key of that provider (ANTHROPIC_API_KEY, GOOGLE_API_KEY)
TOKEN_ENCRYPTION_KEY=...      # the value printed above
CREDENTIAL_KEY_FILE=/Users/you/.yuki/credential.key   # its full path
```

Start the API and the app, in two terminals:

```sh
pnpm dev                      # API on http://localhost:8787
pnpm --dir apps/web dev       # app on http://localhost:5173
```

Open http://localhost:5173. The first time, create your account with a username, a password and the setup code the API printed in its terminal. Then say hello to Yuki.

Without a model key, `cp .env.example .env` alone starts a sample workspace with made-up data and a scripted Yuki.

### Connect apps

- **MCP servers**: 设置 (Settings) → 连接的应用 → 添加自定义 MCP 服务, with the server's address and, if it needs one, its access token. A server on your own machine or network (`http://localhost:…`) works too.
- **Your own mailbox**: ⌘K → 凭据 (Credentials) → 添加发信邮箱 (SMTP, and IMAP to read).
- **Gmail and Google Calendar**: create a Google OAuth web client, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and register `http://localhost:8787/api/google/callback` as its redirect URI.
- **Slack**: set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` of your Slack app.

## Open source and hosted

|  | Open-source core (this repository) | [Hosted](https://yukilab.si) |
|:--|:--|:--|
| Chat, teammates, groups, routines, skills, apps, approvals | ✓ | ✓ |
| A computer for teammates to work on | — | Cloud computer |
| Teams, shared spaces, billing | — | ✓ |

The open core has no computer: teammates work through chat, your apps and routines.
The engine still holds some code from an earlier design (desktop accounts and proxies) that the app no longer reaches; a coming release removes it.

## Built on

Yuki started as a fork of [OpenMuse](https://github.com/CopilotKit/openmuse) by CopilotKit (MIT).

## License

MIT
