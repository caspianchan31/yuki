# Conversations on our own server (v0.5)

Since v0.5 Yuki keeps every conversation in its own database. CopilotKit's cloud
(Intelligence) is no longer used for chat; the CopilotKit libraries and the chat interface are
unchanged. Design: `design-20261012-v05.md` §A. Code: `apps/server/src/chat/` (ported from the
open-source standalone build, `docs/STANDALONE-THREADS.md` there).

## How it runs

- The CopilotKit runtime runs in SSE mode on `LocalAgentRunner` (`chat/runner.ts`): the thread
  lock, a journal of the reply in progress, crash recovery and replay live in three tables,
  `chat_threads`, `chat_runs`, `chat_events` (`chat/chat-store.ts`), in the same Postgres or
  embedded PGlite as everything else.
- The owner of a chat request is resolved in one place (`resolveRequestOwner` in `app.ts`): the
  session, then the project header. Threads belong to the project owner; another project's thread
  id is answered exactly like a missing one (404).
- Runtime hooks (`chat/runtime-hooks.ts`) answer before any SSE byte: a busy thread 409
  `agent_thread_locked`, another owner's thread 404, unusable ids 400, a database failure 503
  「对话记录暂时读不到，稍后再试」. `/info` points the client at the local thread routes; the
  runtime's debug event stream is 404.
- The model's history is the stored conversation plus the messages the request brings that are
  not stored yet, not the client's copy (in a shared conversation a client can lack another
  member's turn).
- History is kept until a conversation is deleted. There is no retention setting.
- `chat-retry.ts` (resending CopilotKit cloud 502s) is gone with the cloud.

## Routes

| Route | What |
|---|---|
| `GET /api/copilotkit/threads?agentId&includeArchived&limit&cursor` | the project's conversations, newest first |
| `GET /api/copilotkit/threads/:id/messages` · `/events` · `/state` | one conversation |
| `PATCH /api/copilotkit/threads/:id` `{ agentId, name?, archived? }` | rename, archive, restore |
| `POST /api/copilotkit/threads/:id/archive` | archive |
| `DELETE /api/copilotkit/threads/:id` | delete (409 while replying) |
| `GET /api/main-thread` | the project's main chat, created on first use |
| `POST /api/main-thread/new` `{ replacing, formerName }` | 开新主聊天 |
| `GET /api/chat-reports?threadId=…` | that conversation's reports, plus `thread: { lastRunId, running }` |

The current main chat cannot be archived or deleted on its own (409 「主聊天要换就点开新主聊天」).

## 开新主聊天

`conversation-settings/main` holds `{ threadId, formerIds, switchedAt, switchedBy }`. In one
transaction the old main chat is archived (named 「旧主聊天 · 到 <day>」 when it has no name), a new
empty thread is created and becomes the main chat. `replacing` is the main chat the client shows:
when two people click at once, the second gets the already-switched main chat. While the main chat
is replying: 409 「主聊天正在回话，说完再开新的」. A replaced main chat is found under 已归档;
restored, it is an ordinary side chat. No confirmation: nothing is lost.

Reports (`engine/chat-reports.ts` `threadOf`): a task delegated from a side chat reports there; a
task delegated from the main chat or from a main chat since replaced, or from no conversation,
reports to the current main chat. Reports already written stay where they are. The live panel's
「汇报 · 最新 5 条」 reads the current main chat's reports only.

Every page reads which chat is the main one at the pace of the rail's main-chat reports (15 s,
`GET /api/main-thread`): after another member's 开新主聊天 a page that showed the old main chat
opens the new one (「主聊天换成了新的一条，旧的在「已归档」里」), so nobody keeps writing into the
archived chat; an open side chat stays open. The rail shows reports only for the main chat they
were read for, so right after a switch it is empty until the new one's are read.

A conversation is shared by everyone in the project. The 5-second report poll of the open
conversation carries its latest run; when that run is one the screen has not seen and the
conversation is idle, the client connects again and shows it. A message held because another reply
had the conversation (409) is sent by itself once that reply is over.

## Copying the old conversations from the cloud

Once, by the API process after it starts (`chat/cloud-migration.ts`), in the background, while
`CPK_INTELLIGENCE_API_KEY` is still configured and the copy is not complete:

- every owner (each real owner and each project not being deleted; a deleted project's cloud
  threads are not copied) is listed in the cloud with every page and archived threads; the ids the
  server knows that the list lacks (main chat and those it replaced, tasks' origin threads, reports'
  threads) are fetched one by one;
- each thread becomes a local thread (name, archived flag, times) with one import run
  `cloud-import:<threadId>`: `RUN_STARTED` → `MESSAGES_SNAPSHOT` (every message, cloud order,
  ids unchanged, so report cards keep their place) → `RUN_FINISHED`. A thread someone chatted on
  meanwhile gets the import run ahead of the local runs;
- each thread is checked right after: the stored message ids must equal the cloud's one by one;
- `chat_migration` keeps one row per thread: done, missing in the cloud (known here, not there),
  or failed with the reason. Done threads are skipped next time; the import run is inserted with
  `ON CONFLICT DO NOTHING`. Nothing in the cloud is changed or deleted.
- When nothing is left, `system/chat-migration/cloud` is `done` with the totals and the key is
  never used again (the log says it can be removed from the config).

A database with no conversation at its first v0.5 start (a new install) is marked done at once.
While the copy is not complete, a line above the chat says how many conversations are not copied
yet and why (「以前的对话至少还有 N 个没搬回来：<原因>。下次启动会再搬。」), or that the config has no key
(「以前的对话还在 CopilotKit 云上，没搬回来：配置里没有云 key」). N is a lower bound: for a project
whose cloud list could not be read, only the conversations this server knows of are counted. Only the first space (key
`local-user`, v0.5b) ever had conversations in the cloud: only its projects are listed there (no
other space's key is ever sent to the cloud), and only its members see that line. `/api/health`
(public) has `threads: "local"` and `threadMigration: { status }` (`done` or `pending`, no
counts); the counts are in `pnpm threads:migration-report`.

Deploy check: `pnpm threads:migration-report <copy of DATA_DIR/postgres>` (or with
`DATABASE_URL`) prints each owner's threads with the cloud and local message counts.

## Rolling back

Back up first: the database (`pg_dump` with `DATABASE_URL`, or a copy of `DATA_DIR/postgres`),
`.env` and `dist/web`. Then run the previous code on the same data:

- **To the code before v0.5a** (63ed4cd): put `CPK_INTELLIGENCE_API_KEY` back in the config. The
  cloud still has every conversation it had (the copy deletes nothing there); what was said on
  this server since v0.5a stays in the database, unseen by the old code, and is there again after
  upgrading. A project whose main chat was replaced by 开新主聊天 now points at a conversation the
  cloud does not have: the old code starts it as a new empty conversation, and the main
  chat it replaced shows up as an ordinary side chat.

## Tests

`tests/chat-*.test.ts` (store, runner, hooks and routes, the real runtime over HTTP without a key
and without any CopilotKit cloud request, the app's CopilotKit client including the replay of a
copied conversation), `tests/threads-main.test.ts` (project scoping, 开新主聊天, reports following
the current main chat, restart), `tests/cloud-migration.test.ts` (a fake cloud through the real
Intelligence client: pages, archived, unlisted ids, partial failure, ordering, idempotence,
counts, the start-up decision).

## Opening a long conversation (v1.7 打开对话不重放整条历史)

A connect used to replay every event of the thread, so a conversation used for months took as
long to open as it was long (a 25 000-event thread: a 3.3 MB stream and 30 seconds, then every
message drawn). Now `LocalAgentRunner` replays only the newest `replayRuns` closed runs (24 by
default; `CHAT_REPLAY_RUNS`, 0 for everything): `ChatStore.connectHistory(threadId, excludeRunId,
{ lastRuns })` reads them in one statement, newest first and limited, then in order. The older
runs come through `GET /api/copilotkit/threads/:id/older?before=<messageId>&limit=<runs>`: the
closed runs before the one whose `message_ids` holds `before`, oldest first, `limit` of them (20
by default) as the agent's messages (`messagesFromEvents`), with `more` saying whether older runs
remain; `&until=<messageId>` instead returns every run back to the one that brought that message
in, for a jump from the search to a message not loaded yet. The client (`chat-state`'s `older`)
asks once after the replay whether anything older exists (`limit=1`), the chat shows 加载更早的对话
at the top, loads the next page when the person has scrolled up to it, and keeps the view where
it was (the distance from the bottom is restored once the earlier messages are drawn). The model's
history is the server's as before (`ChatStore.history`), never the client's partial copy. Tests:
`tests/chat-store.test.ts` (the limited replay, the pages, `until`, the anchors), and the staging
check `workflows/acceptance/history-e2e.mjs`.

## Going back on a conversation (v1.6 聊天基础动作)

The journal is append-only, so 编辑再发 and 重答 never delete a run. `POST
/api/copilotkit/threads/:id/supersede { messageId }` marks the closed run that brought that
message in, and every closed run after it, as superseded (`chat_runs.superseded_at`); the next
run to begin on the thread is recorded as the one that took their place (`superseded_by`).
Everything that reads the conversation — the model's history (`ChatStore.history`), the connect
replay (`connectHistory`), `threadEvents` (回顾, reports), `turns` — reads only the live runs,
so the person's message, sent again with the same id, is new to the conversation and the model
never sees what was gone back on. `GET /:id/superseded` gives the superseded stretches as
messages, each with the live run its fold stands before (followed through runs that were
superseded in their turn); the chat folds them with `packages/client/src/shell/chat/superseded-core.ts`.
Deleting the thread removes the superseded runs' screenshots and files too (`threadEvents(…,
{ superseded: true })`).

点赞 / 点踩 is one verdict per reply in `chat_feedback` (`GET /:id/feedback`, `PUT
/:id/feedback/:messageId { verdict: "up" | "down" | null }`), gone with the thread. This version
only records it; nothing changes the member's behaviour.

The web's code blocks come from the markdown-it fence rule in
`packages/client/src/assistant-markdown.ts` (a head with the language and a copy button) and
are coloured by shiki, loaded on demand in `apps/web/src/ui/highlight.ts`.

## Searching the conversations (v1.6 搜对话内容)

⌘K's 对话 group searches every conversation of the owner's (archived too) for the typed words.

- The index is the server's own table `chat_messages`: one row per message with words (the
  person's and the members', file names included; not tool results or reasoning), with its
  `tokens`, a tsvector of the message's CJK bigrams and lowercased words
  (`packages/domain/src/chat-search.ts`), under a GIN index. No extension, so embedded PGlite and
  Postgres behave the same. `closeRun` fills it as a run closes; `indexBacklog` (run in the
  background at start) indexes the runs from before the index or whose indexing failed
  (`chat_runs.indexed_at` is null). A message sent again with the same id moves to the new run.
- `GET /api/copilotkit/threads/search?q=&limit=` (20 by default, at most 50; 400 without words):
  the hits newest first, each with its conversation (id, name, archived), the message id, who
  said it, when its turn began, and a snippet around the first phrase found (`before`, `match`,
  `after`). The typed words, split on spaces, must each appear as a substring; the tokens only
  narrow the candidates (a lone CJK character has no bigram, so only the substring test applies).
  A superseded stretch's messages are skipped (join on `chat_runs.superseded_at`); a deleted
  conversation's rows go with it (cascade).
- The web (`apps/web/src/shell/Palette.tsx`): with words typed, the 对话 group lists the hits
  (asked of the server 180 ms after the typing pauses) with the match marked and the
  conversation's name and day as the hint. Picking one sets `frame.jump` and opens that
  conversation; `ChatScreen` scrolls to the message once it is drawn and lights it for a moment
  (`.hit`), or says 没找到这条消息 after a while.
- Tests: `tests/chat-search.test.ts` (tokens, query, snippet, hit labels), `tests/chat-store.test.ts`
  (index on close, search, superseded / archived / deleted, backlog, ten thousand messages within a
  second), `tests/chat-routes.test.ts` (the route), and an end-to-end search check against a
  running stack (the palette, the jump to the message, archived and deleted chats).
