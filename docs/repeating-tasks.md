# Repeating tasks on an account's desktop (fork feature)

A background task of kind `agent` or `plan` can repeat every N minutes (1 to 10080) and run on one account's desktop. Upstream, only URL monitors recur; an agent task ran once.

## Model

- `AgentTask.repeatMinutes: number | null` (null or absent = once) and `AgentTask.runs` (completed runs). `createTaskSchema` accepts `repeatMinutes`; other kinds with a value are 422.
- The account is the existing binding `input.environmentId` (see `environments.md`): the run acts as the derived owner `${real}#env:${id}`, so it uses that account's desktop, proxy and sign-ins. No value means the project's default desktop.

## Lifecycle

`AgentService.execute` routes a repeating task to `executeRepeating`:

1. A run that starts fresh (`state.runOpen` unset) resets the plan, evidence, error, action and question, keeps the failure counters, sets `runOpen`, and logs `Run N started`. A run resumed after `waiting_input` / `waiting_approval` continues instead.
2. A result of `succeeded` becomes `scheduled` with `nextRunAt = now + repeatMinutes`, `runs + 1`, `runOpen` cleared, `failures` reset, and a `state.notice` (`task-run:<id>:<n>`) so each run notifies once. The worker's existing `scheduled && nextRunAt <= now` pick-up starts the next run; nothing is enqueued separately.
3. A thrown run (not a lost lease or abort) is `scheduled` again at the next interval with the error, `failures + 1` and one alert per failure streak (`task-run-error:<id>:<streak>:retry`); the fifth failure in a row makes it `paused` (`…:paused`; a stop of the system's own, pending the owner's decision, `report-back.md` The report line). Resume queues a fresh attempt.
4. `waiting_input` and `waiting_approval` are returned unchanged; the run finishes on the next claim. One exception: a model run that stops without calling a completion tool (the "reached the end of this run without confirming completion" question) counts as a finished run, with the model's last update as the result, so an unattended schedule never stalls on it.

5. A run that ends with `wait_until` (see `wait-until.md`) stays open: `scheduled` at now + the wait's minutes instead of the interval, once; the resumed execution continues the same run with its note, and the interval starts when that run finishes. A one-off task's waiting run is left open too, so a task made to repeat during that run (even while it is still running) or its wait continues it as run 1 instead of starting fresh.

Controls: `pause` works on `scheduled`; `resume` queues a run now; `run` (new) queues a `scheduled` repeating task now (409 otherwise; a one-off task in a `wait_until` wait too); `cancel` as before.

## One-off tasks: automatic continuation

A one-off task (no `repeatMinutes`) whose model run ends without a completion call (the run hit `AGENT_MAX_STEPS`, or the model replied without calling a tool) used to wait for the user with the "reached the end of this run without confirming completion" question, so a long desktop task (60 steps, about eight minutes per run) stopped after every run. Now:

- `AgentService.continueUnfinished` (the one-off branch of `execute` in `service.ts`) turns that outcome into `queued` with `state.autoContinued + 1`, clears the question and logs the status event `Continuing automatically` (before the report line: `Continuing automatically (n/N)`). The worker applies it through its usual lease-guarded final checkpoint, and its next tick claims the task like any queued one, the same way an answer resumes a task.
- The next run's task message gets a note (`continuationNote` in `model.ts`): the previous run ended before the work was complete, pick up where it left off from `priorState.lastUpdate`, the evidence and the artifacts, do not redo finished steps, and call `finish_task` when done (or `wait_until` when the task's rules require waiting before the next step). A saved answer stays in the message.
- There is no limit: a run that ends without `finish_task`, `ask_user` or `wait_until` continues, every time, and never asks the person; the person can pause or cancel the task. `AGENT_AUTO_CONTINUE_RUNS` is gone like `AGENT_MAX_WAITS` (a value still set in an old `.env` is not read), and so are the `Waiting for you after N automatic continuations` stop and the client's 「自动续跑 n/3」 and 「自动续跑已用完」. The count stays in `state.autoContinued` only for the next run's message (「continuation n」); an answer, a wait, an action recorded on the account and a completion reset it. A real question (`ask_user`) and approvals wait as always; an aborted run (`Task interrupted`) is queued again by the worker without counting. A task that stopped on the old question before the deploy keeps it until the person answers (立即继续); it reads 「上一轮没确认做完」, without a count.
- Repeating runs are unchanged: such a run counts as finished (lifecycle step 4).

## HTTP

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/api/agent/tasks` | `createTaskSchema` + `repeatMinutes` | 201 task |
| POST | `/api/agent/tasks/:id/control` | `{ action: "run" }` | task now `queued` |
| PATCH | `/api/agent/tasks/:id` | `{ repeatMinutes: number \| null }` | task. `null` on a `scheduled` task completes it with its last result; a number on a `succeeded` task schedules it again; on a `scheduled` task it moves `nextRunAt`. 422 for other kinds or out-of-range values; 409 when cancelled. |

Chat: `delegate_task` takes `repeatMinutes` and `input.environmentId`; the system prompt says so.

## Client

Delegate form (`DelegateSheet`): for General task and Plan, "Repeat every (minutes)" and a "Run on" row (Default desktop or one of the project's accounts; hidden when environments are unavailable). Task cards show "Repeats every … · n runs so far · next …". Task detail shows the bound account and the schedule with Run now, Change interval / Repeat this task, and Stop repeating.

## Verification log

