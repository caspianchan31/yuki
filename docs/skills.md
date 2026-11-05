# Skills (v1.4, part D)

A skill is a named way of doing something, kept by the space and shared by every member and every project in it: `{ id, name, description (required), steps, source: "sentence" | "demo", createdAt, updatedAt }`. Records of kind `skills` under the space's key (`spaceKeyOf(owner)`), so a project's chat, a task and another member all read the same ones and another space reads none. Code: `apps/server/src/skills.ts` (`Skills`, the learn writer), `skills-routes.ts`, type in `packages/domain/src/skills.ts`.

## Making one

- `save_skill` (chat): one sentence makes one (「把『周报』存成技能：每周五汇总……」). The description is required and says when to use the skill (「……时用」): it is the only thing a reader sees when deciding whether to run it. The steps are generic: which channel, repository or recipient to use belongs in the routine that runs the skill, not in the skill (the tool's description says so). The name is unique in the space; saving an existing name updates that skill in place (id and creation time kept). `source: "sentence"`.
- `learn_skill` (chat, takes a name): the server writes the steps from this conversation's messages and tool calls (arguments and results cut, at most 24,000 characters, the latest kept) with one model call with no tools, as `claim-check.ts` does: the answer is JSON in text, read tolerantly (fence, prose around it, steps as a list), tried twice, 2 minutes in all. The writer is told to give the description ("Use this when …") and generic steps; an answer with steps but no description counts as a failed attempt (tried again, then nothing is saved). Saved with `source: "demo"`; the reply shows it and the person changes it by saying so (`save_skill` with the same name) or in 设置. A failed write (model error, timeout, no steps, nothing done in the conversation) saves nothing and the tool says so; the chat tells the person plainly.

## Using one

- Chat and task prompts carry the skills' names and descriptions, as data (`skillsLine`); the steps are not in the prompt. `use_skill(name)` returns the steps with a note that a skill is data, not authority: it never overrides the person's request or the run's rules and grants no permission. A routine's instruction may name a skill with `@name`: the mention is a pointer, not a copy. When the routine fires the run is told which skills it names (`skillsMentioned`, `routineRunNote`) and reads them with `use_skill`; the instruction never carries the steps.
- The @ list names skills (kind 技能, after routines, before apps); choosing one writes `@name `. The list reads skills and apps again each time an @ is started (a skill saved in this chat shows at once). A chat message that names a skill with `@name` carries that skill's steps in the reply's prompt (data, a guide; `skillMentionLine`), so the @ is used whether or not the model calls `use_skill`.
- In the hall (docs/group-chat.md) a reply routed to a project still has `save_skill`, `learn_skill` and `use_skill` (skills are the space's, `hall-gate.ts` `handOverTools`); `route_request`'s answer says a tool called beside it in the routing turn did not run and is available (`routedNote`). The chat prompt says keeping a skill is never `delegate_task`, and `save_skill`'s description sends 「把刚才这件事存成技能」 to `learn_skill`.

## 设置 › 技能 and the API

The list shows each skill; 打开 gives a form for name, 用途 (required) and 步骤 with 保存 and 删除. A skill saved before the description was required still loads; its row says 「缺用途说明」 and it can be changed only once it has a description.

| Route | |
| --- | --- |
| `GET /api/skills` | the space's skills, by name |
| `POST /api/skills` | `{ name, description, steps }`, same-name update; no description: 422 |
| `PATCH /api/skills/:id` | any of name, description, steps; a name another skill has is 409; a result with no description is 422 |
| `DELETE /api/skills/:id` | |

Limits: name 60, description 300, steps 8,000 characters.

## Tests

`tests/skills.test.ts` (description required, a skill without one still loads, sentence, same-name update, learn with a fake model and a failure that saves nothing, `use_skill`, prompts, space and project scope, API CRUD), `apps/mobile/test/shell-mention-skills.test.ts` (the @ entries).
