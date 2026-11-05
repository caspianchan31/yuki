# A reply says its result (v1.1)

The bar: Meta Muse and Grok Bot, one sentence and it is done, nothing but the facts, quietly fast. The requirement: a round says only its result: it speaks with a link when it made something; its steps fold into a card; when it is stuck it says in plain words where. Acceptance adds: a missing source is told as a failure, never filled in with older data.

Background tasks already report this way (`report-back.md`: an action is reported with its own address or marked 未确认; routine progress needs no report; infrastructure is never a report, the server shows the incident in words; a wait is never a card). What was left was the chat's own reply.

- **The words** (`resultOnlyRule`, in every chat after `chatReportRule`): the reply says the result briefly: what is done now, with the address of what was made or changed on a site when there is one; when it could not be done, where it stopped, in plain words. The steps show on their own cards and are not retold. A source the answer needs (a page, a task's activity, an account's data) that cannot be read now is said to be unreadable; it is never answered from older data.
- **The steps fold** (web, `MessageBlock`; `packages/client/src/shell/chat/reply-core.ts`): a reply's tool calls are split into its result (the work handed on, a job, a project, a card the person answers, something saved: `isResultTool`) and its steps (reading mail or a page, searching, the desktop, reading status; any tool the client does not know). The result's cards stand as before, under the text; the steps fold into one line, 「过程 · 5 步 ▸」, open while the reply is still under way so the desktop can be watched, closed once it has answered. The person's own messages keep their cards.

Tests: `apps/mobile/test/shell-reply.test.ts` (the split), `tests/hall-one-sentence.test.ts` (the rule is in the chat once), `tests/prompt-lint.test.ts` (the rule is linted). Whether a real model keeps to it is checked in production acceptance.
