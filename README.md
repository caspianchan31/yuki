<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img alt="Yuki — AI teammates in your chat" src="assets/banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="https://yukilab.si"><b>Try it at yukilab.si</b></a> ·
  <a href="#what-yuki-does"><b>What it does</b></a> ·
  <a href="#open-source"><b>Open source</b></a> ·
  <a href="README.zh-CN.md"><b>中文</b></a>
</p>

<p align="center">
  <img alt="Hosted: live" src="https://img.shields.io/badge/hosted-live-111111?style=flat-square">
  <img alt="Open source: coming soon" src="https://img.shields.io/badge/open%20source-coming%20soon-111111?style=flat-square">
</p>

Yuki is an AI teammate that lives in a chat. Open it and Yuki is already there: tell it what you need in one sentence. Add more teammates when you want help, put them in a group, and they hand work to each other in the open. When something needs a sign-in or a decision, they come to you; nothing goes out in your name until you say so.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/chat-dark.svg">
  <img alt="A Yuki conversation: a routine made from one sentence, and an email draft waiting for Send" src="assets/chat-light.svg" width="100%">
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
Gmail, Google Calendar, your own mailbox, Slack, and any MCP server. Connect once; every teammate can use it.

</td>
<td valign="top">

**You approve what matters**<br>
Allow once, always allow, or deny. Email and Slack messages are drafts until you press Send. Action review checks each step against your own rules.

</td>
</tr>
<tr>
<td valign="top">

**A computer to work on**<br>
Teammates use a cloud desktop with a real browser. Watch the live preview, take over when a site needs you, hand it back when you're done.

</td>
<td valign="top">

**Your data, your server**<br>
Conversations live in your own Postgres (or embedded PGlite). Secrets are sealed with your own key and never shown to the model.

</td>
</tr>
</table>

## Open source

The single-user core of Yuki (everything in the grid above, for one person on their own server) is being prepared for release in this repository under the MIT license. Star or watch the repo to hear when it lands.

|  | Open-source core (coming here) | [Hosted](https://yukilab.si) |
|:--|:--|:--|
| Chat, teammates, groups, routines, skills, apps, approvals | ✓ | ✓ |
| Cloud desktop | Bring your own provider | Included |
| Teams, shared spaces, billing | — | ✓ |

## Built on

Yuki started as a fork of [OpenMuse](https://github.com/CopilotKit/openmuse) by CopilotKit (MIT).
