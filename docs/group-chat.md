# 营销总群与群聊（v0.8）

## 营销总群

The space's own conversation (the default project, formerly shown as 未分组) is the **营销总群**: named so everywhere the default project is named (`t.projects.defaultName`) and first in the project column (`projectRows`). Unassigned accounts still live there (账号与代理's 未分配).

- **Only the hall reads as a group** (`useIsHall`, `InGroupChat` true): avatar + name per speaker, the members bar, @-requests. A project's own conversation stays the plain chat: the capybara says everything that is not the person's, cards as before (with their speaker line).
- **Who is in it** (`hallMembers`): its assistant **总群助理**, the founder, and each project's **运营专员**.
- **Giving the founder a job happens here.** The hall's chat is told so (`hallChatLine`); its `create_job` takes `project` (the project's name): the job is made and kept in that project (`projectScopeByName`), and its card reads 「@创始人 Ann 请（为 acmegame）：…」. In a project, `project` is refused.
- **A project's request to the founder is seen in the hall.** When a project's job is made for or given to the founder (`ProjectJobs.create` / `assign`), the hall gets a `founder_request` notice from that project's 运营专员: 「acmeskills 运营专员：@创始人 Ann 请：…」 (not for a job made in the hall itself, whose card already asks).
- **The founder answers in the hall.** Its report of a project's job stays in its own conversation (the hall) with `project` set, shown as 「为 acmeskills」; the project that gave the job gets one `in_hall` line, said by the founder: 「创始人 Ann 汇报了「…」，详情在营销总群。 去营销总群 ›」.

## The group look (in the hall)

- **Who speaks** (`packages/client/src/shell/chat/group-core.ts`, `itemSpeaker`): the person on the right; the hall's assistant; a project's 运营专员 for its request; an account or the founder for its reports, stop reports and taken/declined notices. Two 运营专员 are two speakers; the avatar and the name show on the first item of one speaker's run (`groupTurns`).
- **Requests**: create_job / assign_job read 「@创始人 Ann @Bob 请：<活>」 (所有号 for everyone); delegate_task 「@<号> 请：<任务>」 with the state word; redirect_task one grey line; the account answers 「接了 / 没接「…」：理由 / 发好了」.
- **Quieter cards**: no second speaker line, a report shows only its time (and 「为 <项目>」) unless it is a failure or a question.

The account detail's 设为创始人 / 取消创始人 publishes the founder it saved, so the project column's 创始人 row changes without a reload.

## One sentence, done (v1.1)

The bar is Meta Muse and Grok Bot: one sentence and it is done; @ someone and the work is theirs; nothing is made through a form.

- **The hall finishes a request in its reply** (`hallChatLine`, in the space's own conversation whether or not it has a founder; not in a store's, which has no projects: `isHall`). It is told the space's projects and the accounts in each (`hallProjectsLine`, data), that a project the person names and that is not among them is made at once, that work for a project goes to it by name, that a page the person points at it reads itself, and that it asks at most one question, only for what no tool can tell it, never handing part of the work back.
- **`create_project`** (hall only): makes the project by the person's name, or returns the one already there by that name (`created: false`); the app wires it to `ProjectService.create` (`AgentService.createProject`). The card reads 「建好了项目「acmegame」」 or 「项目「acmegame」已经有了」 with 「去 acmegame ›」, and the project column reads the new list at once (`ProjectToolCard`).
- **`delegate_task` with `project`** (hall only, `hallDelegateSchema`): the task is made in that project, on the account named (`account`, one of that project's: another project's is refused) or on its default desktop, and it runs and reports in the project's own conversation, the 运营专员's (`delegateToProject`). The hall's card asks in the group's way, 「@acmegame 运营专员 请（为 acmegame）：…」 (or @ the account), with 「去 acmegame ›」 (`DelegatedTaskCard`, `projectRef`). `create_job` with `project` stays the way to give a project's accounts or the founder a job for a stretch.
- **@ decides whose it is; no @, the hall decides**: @-ing a project, its 运营专员 or one of its accounts gives the work to that project; with no @ the hall's assistant decides who takes it by what each project is for and the accounts' and the founder's personas, and says in one sentence why, never asking the person whom to give it (the hall's form of `founderChatLine`).
- **Handed over, never done here** (the project was made, but every request, @ or not, was then done in the hall itself): work for a project is that project's and never the hall's to do, however small; it is handed over in the reply by the project's name, and with no @ the hall chooses whose it is the same way and says why. The hall does itself only what is for no project.
- **Whose it is comes first, held by the server** (`hall-gate.ts`; @ handed work over, but a project named without @, and work naming no project, were still done in the hall; words did not move the model, so the hall's duty is fixed by what it can call): every hall reply's first model turn may only call `route_request` (`project` by name, the one named or @-ed or the one it judges the work belongs to, a new name made; or `null` for no project; `why`, one sentence), forced by `tool_choice`. Routed to a project, the rest of the reply has only the tools that hand it over (`create_project`, `delegate_task`, `create_job`, `assign_job`; the routed project fills in `project` when left out), so the work can only go there; text is still allowed (the one-line confirmation, or the one question). For no project the reply gets every tool. The web shows 「归 acmegame：…」 under the reply (`RouteLine`). A store's own conversation is no hall and has no gate.
- **The founder hands work back** (`request_project`, `founder.md`): the founder's request to a project's 运营专员 shows here as 「创始人 Ann：@acmegame 运营专员 请：…」 (`project_request`, said by the founder, `isGroupSpeech`).
- What stays as it was: a project's own conversation has neither `create_project` nor `project` on `delegate_task`; nothing here decides how an account posts.

Tests: `tests/hall-one-sentence.test.ts` (a project made and the work handed there in one reply; an account named; one already there kept; a project's conversation and a store's have none of it), `apps/mobile/test/shell-group.test.ts` (`projectRef`), `tests/prompt-lint.test.ts` (the hall line and `create_project` are linted). Whether a real model takes these paths is checked in production acceptance.

Tests: `apps/mobile/test/shell-group.test.ts`, `apps/mobile/test/shell-frame.test.ts` (the hall first), `tests/founder-v08.test.ts` (the hall's report, request and the project's line). A local walk-through server lives in `artifacts/group-fixture/` (ignored).
