<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/yuki-banner-dark.svg">
  <img alt="Yuki. AI teammates, each with its own computer. Live at xman.ink." src="assets/yuki-banner-light.svg" width="100%">
</picture>

**Yuki** gives you a team of AI teammates. Each one has a name, a job and its own cloud computer. You hand out work in a chat or a group, the way you would with coworkers; they pick it up, finish it on their own and bring the results back to the conversation. They only come to you when something needs your decision.

**Yuki** 给你一队 AI 成员。每个成员有名字、有分工、有自己的一台云电脑。你像跟同事一样在聊天或群里派活；它们自己接、自己做完，把结果带回对话里，只有要你拍板的事才来找你。

### How it works

- **One teammate, one computer.** Every teammate has its own cloud desktop, browser and logins. Nothing is shared between teammates.
- **A team, not a single bot.** Put teammates in a group, @ one to make the job its own, and watch them hand work to each other in the open.
- **Results come back to the chat.** Every action comes back with something you can check: a link, a file or a screenshot.
- **You keep the keys.** Passwords, 2FA codes and passkeys are typed by you, in the teammate's desktop. The AI never sees them.
- **It acts on its own.** Teammates pick up work and finish it, and only come to you when there is a real decision to make.

### What's in Yuki

| Part | What it is | Status |
|:---|:---|:---|
| Yuki hosted | Everything below, run for you at [xman.ink](https://xman.ink). | Live, by invitation |
| Yuki client | Chat, teammates, groups, routines, reports and the agent engine. Open source and self-hostable. | Coming to this repo |
| Yuki desktop service | A cloud computer, browser and saved logins for each teammate. | Coming for self-hosters |

Star or watch this repo to hear when the client lands.

### Built on

Yuki started as a fork of [OpenMuse](https://github.com/CopilotKit/openmuse) by CopilotKit (MIT). It has since grown multi-tenant workspaces, a cloud desktop per account and its own operations loop. The single-user, self-hosted version lives on as [openmuse-standalone](https://github.com/caspianchan31/openmuse-standalone).
