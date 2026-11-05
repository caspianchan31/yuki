# Routines (例行) (v1.4 A)

A routine is a repeating `agent` task (`repeating-tasks.md`) that carries a `routine` field: a trigger, the last runs, and for a mail trigger a cursor. The task's title is the routine's name and its prompt is the instruction. Everything repeating tasks do (clean plan per run, failure retries, pause after five, notices) still holds; a routine changes only when the next run is and what is recorded about each run.

## Model

`AgentTask.routine?: { trigger, history, mail?, sourceError? }` (`packages/domain/src/routines.ts`).

- `trigger`: `{ type: "every", minutes }` (1 to 10080), `{ type: "daily", at: "HH:MM" }`, `{ type: "weekly", at, days }` (0 = Sunday), `{ type: "mail", from?, subjectHas? }`.
- `history`: the last 20 runs, newest first: `{ startedAt, endedAt, status: succeeded | failed, summary, cause }`. `cause` is `schedule`, `test`, or `mail:<message id>`. The summary is the run's finish_task summary (or the error), cut to 300 characters.
- The repeating task still needs an interval: `every` uses its minutes, `daily` 1440, `weekly` and `mail` 10080. It is only the task's heartbeat; the next run always comes from the trigger.

## Time zone

Clock times (`daily`, `weekly`) are in the member's time zone: the account's desktop setting (`computer-settings`, the one 成员 gets when it is made), else the project's default desktop setting, else `Asia/Shanghai` (`defaultRoutineZone`). There is no separate "space owner" zone in the data, so the project's default desktop is the nearest thing; the last fallback is written here so a routine never waits on a missing zone. The member card says 「没填时区，先按北京时间」 for a clock routine of an account with no zone. `nextRoutineRun` finds the instant for the local clock time (a time that does not exist on a daylight-saving day is skipped that day).

## Lifecycle

- **Make**: `POST /api/agent/routines` `{ name, instruction, trigger, input? }` (`input.environmentId` = the account) or the chat tool `create_routine`. `every` runs at once, like a repeating task, then every N minutes; `daily` and `weekly` are `scheduled` for the next clock time; `mail` is `scheduled` with no `nextRunAt` (the worker never starts it by the clock).
- **Limit**: at most 50 routines per member that are not cancelled (an account's, or the main member's: tasks without an environment in the scope). The 51st is refused (409) with 「一个成员最多 50 个例行，已经满了；先删掉不用的再加。」 Deleted ones do not count.
- **After a run**: `scheduled` at the trigger's next time (`mail`: no time), `runs + 1`, a history entry. A thrown run is recorded `failed` with the error and retried at the trigger's next time; five in a row pause it, as for any repeating task.
- **Pause / resume**: pause stops it; resume puts it back to waiting for its next trigger (a plain repeating task runs at once on resume; a routine does not, so a 09:00 routine paused over lunch does not run at 14:00).
- **Test**: `control run` on a routine queues it now with cause `test`; the clock is kept.
- **Edit**: `PATCH /api/agent/routines/:id` with any of `name`, `instruction`, `trigger`; the chat tool `update_routine`. Allowed between runs only (`scheduled`, `paused`, `failed`, `succeeded`); a queued or running routine answers 409 「这个例行正在跑，等这一轮结束再改」. A new trigger moves the next run; changing to a mail trigger starts its cursor now, changing only the filters of a mail trigger keeps the cursor. The plain `PATCH /api/agent/tasks/:id` interval change is refused for a routine.
- **Delete**: `control cancel`.
- **Chat**: `create_routine`, `update_routine`, `list_routines`, in a group's chat and in Yuki's own chat (the hall, below). The instruction is written to the routine's future self as an intent (what to get done and when to speak up), not a frozen list of tool calls; a skill is mentioned as `@Skill name` and is read when the routine fires.

## Yuki's own routines (2026-11-05)

On a fresh install there is no member and no group, and the first 「每天早上 9 点跟我说一句早安」 is said in Yuki's own chat (the hall). There the routine tools used to be missing: the hall made a one-off task and its reply said it was scheduled.

- **Owner.** A routine asked for in Yuki's chat is the main member Yuki's: a routine task in the space's own scope with no account (`input.environmentId` null), so it counts toward Yuki's 50 there. It reports in the chat it was asked in (`originThreadId`). Clock times use the space's default desktop zone, else 北京时间.
- **Routing.** A routine for the person themself (a greeting, a reminder, a digest for them) is for no project (`route_request` null). One the hall routes to a group is made in that group by `create_routine` with `project` (and `account` for a member of it), as `delegate_task` hands over a task; it reports in that group. `create_routine` is one of the tools a routed reply keeps (`handOverTools`). The assistant's own name is never a project in the hall (`routedProject`): a model that routes Yuki's own request to 「Yuki」 means no project, even when a group is called Yuki (staging had one).
- **Never a false 已安排.** Every chat prompt says nothing is told as scheduled, repeating or coming later unless `create_routine` / `update_routine` (or a repeating `delegate_task`) answered it in that reply (`scheduleClaimRule`); `delegate_task`'s answer for a task that runs once carries `runsOnce: true` and a note that it is not scheduled (`onceNote`).
- **Controls.** The hall's top bar has 详情 (Yuki 的资料): Yuki's card (`YukiDetail`) lists her routines (`yukiRoutines`: routine tasks with a trigger and no account) with the same cards as a member's (`RoutineCards`: 暂停/恢复 · 测试 · 修改 · 删除, 最近运行).

## Quiet runs, skills, and a refused app

- **Quiet by default.** A run that has nothing new to tell ends with `finish_task` `quiet: true`: the server (`executeRepeating`) then sends no 第 N 轮完成 card and no notification, and writes no report artifact; the summary is still the run's history entry. The flag counts only on a routine's run (ignored on any other task). When there is something worth surfacing the run says so casually, not as 「例行某某跑完了」, and it does not write 「没有变化」 filler (`routineRunNote`). A failure that needs the owner and a draft waiting in the chat reach them as before.
- **@skill.** The run's message names the skills the instruction mentions (`@name`, whole names, case aside) and says to read them with `use_skill`; the mention is a pointer, not a copy.
- **A refused app pauses the routine.** A run fails for an app when an error says it is not connected or its sign-in was refused (`authBlockOf`: Google, the project's mailbox, Slack; an app's own tool names its app, `mcp:<slug>`). The first time, `routine.authBlock` records `{ app, name, at, paused: false }` and the run is a failed history entry as any failure. When the next run (or, for a mail trigger, the next look at the inbox) fails for the same app, the routine is paused (`status: paused`, `authBlock.paused`) and one message says 「例行『…』连着两轮都用不了『App』，先暂停了。去设置里重新连接……」. A run that did not meet the app clears the record. A different reason in between does not count.
- **Connected again.** When an app finishes connecting (docs/apps.md) every routine of that space paused for it goes back to waiting for its next trigger, and its conversation is told 「App 连好了，『例行』接着跑」.

## Mail trigger

Every two minutes (`mailPollMs`, a timer in `AgentService.start`, not run while a deploy drains) `Routines.pollMail` reads the inbox once per space (`workspace.searchMail(owner, "")`: the project's mailbox over IMAP, else Gmail when Google is connected) and looks at each idle (`scheduled`) mail routine:

- The cursor `routine.mail` is `{ at, ids }`, starting at the moment the routine was made, so mail that arrived before never fires. A message is new when its date is after `at`, or equal to it and not in `ids`.
- The oldest new message that matches the filters (`from` against the address and the sender's name, `subjectHas` against the subject, case-insensitive) queues one run: status `queued`, cursor moved to that message, `input.run = { cause: "mail:<id>", mail: { id, from, subject, date, snippet } }`. The run's message carries these facts, labelled as data (`routineRunNote`).
- A message that arrives while a run is open waits: only idle routines are looked at, and the next look picks the next message. One run per message.
- A source that is missing or fails (no mailbox and no Google, the IMAP server refuses) fires nothing: the routine gets a `failed` history entry with the reason and `error` set, once per distinct reason (a reason that repeats every two minutes is not written again). When the source reads again, the error is cleared. The routine never works from old mail instead.
- A tool of a connected app answers a refused sign-in as an error result, not a throw: `model.ts` reads the result's `error` for `authBlockOf` / `looksUnauthorized` too, so two refusals pause the routine for an MCP app as for Google.
- Every routine run's message also says: when a source the run needs cannot be read, say why and end the run; never use what an earlier run left.

## Member card

The page reads each of the member's tasks' reports one by one (`taskReportPollMs`, `capReportTasks`, `taskIdsForMember` in `member-detail.ts`): cancelled tasks are skipped, at most the newest 20 are read, and the round slows down with their number; it once made 11 requests a second for a member with many routines and the server's 120 a minute per address locked the person out.

`MemberDetail` 例行: name, the Chinese line for when (`每 30 分钟`, `每天 09:00`, `每周一、三 08:30`, `收到新邮件时（发件人含「x」）`) with 开着/停着, then 最近运行 (three, 展开 to twenty: when, 按时/测试/新邮件 · 成功/失败, summary), then 暂停/恢复 · 测试 · 修改 · 删除. 修改 opens a small form (名称, 要做什么, 什么时候 with its fields); it sends only what changed. Logic: `packages/client/src/shell/members/member-detail.ts` (`routineRunRows`, `routineDraftBody`, …); form: `apps/web/src/shell/RoutineEditor.tsx`.

## Tests

`tests/hall-routines.test.ts` (Yuki's own routine from the hall with no group, a routed one made in its group, a one-off task answered as running once), `tests/routines.test.ts` (next-run for every/daily/weekly across zones and a daylight-saving day; when-line and mail filters; a clock routine in the account's zone with test cause, schedule cause, pause/resume; the 50 limit; history capped at 20; edit; mail trigger once per new matching message and never for old mail; an unreadable inbox fails once with its reason and fires nothing; a quiet run posts nothing and `quiet` counts only for a routine; an @skill is named to the run; the same refused app twice in a row pauses and names the app once, a different reason does not, a refused inbox at two looks pauses; HTTP), `apps/mobile/test/shell-routines.test.ts` (when-line, on/off/test/edit state, 最近运行 3 and 20, cause words, what 修改 sends).
