# Mail through the project's own mailbox (fork)

Until now email went only through a Google connection (Gmail API): the server had no Google client configured, the shell had no button to connect it, and the customers this is for (a factory with its own sales mailbox on its own domain) have no Gmail. A run asked to send outreach ended with drafts. Now a project's own mailbox is the channel, and Google stays the other one.

## The mailbox is a credential

A `mailbox` entry of the project's credential store (`credentials.md`): address, SMTP server (host, port, TLS mode: 465 is TLS from the first byte, any other port requires STARTTLS) and, when the mailbox is also read, an IMAP server (host, port, 993 by default). The password (or the app password most providers want for SMTP/IMAP) is the secret: sealed like every other, never shown, never in the model's sight, a log, an API response or a run event. The address is the entry's user name; the servers are metadata.

- `use(scope, { id, part: "mailbox_password" }, "mail_send" | "mail_read", actor, sink)` is the only way the password leaves the store: straight into the SMTP or IMAP client, one history row per use.
- `scrub` masks it in desktop command output like the other secrets.
- Replacing changes the servers without the password, or the password alone; a new SMTP port without a TLS mode takes the mode that port implies.
- Nothing knows any provider: the form asks for the servers; the hints say only that most mailboxes want an app password generated in their web settings.

Files: `apps/server/src/mail/channels.ts` (`MailChannels`: the project's mailbox, `mailbox:<entry id>` as its connection id), `smtp.ts` (nodemailer, one connection per message), `imap.ts` (imapflow + mailparser, INBOX only, bodies bounded at 20,000 characters, at most 50 messages a thread); the store's `mailbox` branch in `credentials/store.ts` and `validate.ts` (`validateMailbox`).

## Which channel

The mailbox the project uses (`usedBy` project), else the first saved; a mailbox saved without a choice serves the project. Sending: the project's mailbox when it has one, else Google. Reading (`search_mail`, `read_mail_thread`, `read_workspace` mail): the mailbox when it has an IMAP server, else Google. A thread read from the mailbox also shows what this workspace sent in it (kept locally; the mailbox's Sent folder is not read).

## Sending stays reviewed

`prepare_email` → 等你审阅 → the owner approves → sent. The proposal carries the mailbox's connection id and address; at approval the project's mailbox must still be that one (replaced or removed: refused, 「项目的发信邮箱换过了，这封要重新准备」). The Google checks (connected, the task's starting connection) apply to Google proposals only. The sent message is kept in the workspace's mail (`Sent · <address>`) with its Message-ID; a reply carries `In-Reply-To` and `References`.

## No mailbox

`prepare_email` in a project with no mailbox and no Google connection does not fail the run: it opens a request in the project's credential store (site `mailbox`, the pseudo-site `mailboxRequestSite`), which 待补 shows as 「本项目要一个发信邮箱（任务要发邮件）」 with 去添加 opening the mailbox form, and answers the model `no_mailbox` (asked already, do not ask again, go on with what needs no sending). Saving a mailbox closes the requests and tells the project's operating task, which sends in its next run. The task prompts say email goes out through `prepare_email`, which asks for a mailbox by itself; never drafts handed to the person.

## Google

设置 has a Google row again (the old Connections tab is not mounted): 已连接 <account> or 没连接, 连接 (asks for send access) / 重新连接 / 断开. It needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server (redirect `<PUBLIC_API_URL>/api/google/callback`); without them the row says the server has no Google connection configured.

## Tests

`tests/mailbox.test.ts` (the entry: sealed, used only through `use`, recorded, masked, replaced, refused shapes; an email in a project with a mailbox prepared, approved and sent through it with the project's address and kept; none without a mailbox; a replaced mailbox refuses the approval), `apps/mobile/test/shell-mailbox.test.ts` (row line, group first, the 待补 line and its form, what the form sends).

## What an outreach email may say

The first real run (示例项目, 「我是家具厂，我卖的是床，帮我卖到境外」) prepared outreach that claimed certifications, capacity and lead times the owner never gave, signed with a made-up address. Two rules now:

- `prepare_email` refuses (`status: refused`, with the reason) a draft whose subject or body names an address that is neither the sending account nor one of its recipients (`apps/server/src/mail/draft-check.ts`); no review card is made.
- The task prompt's 「never invent personal facts」 now says what anything sent for the person says about them or their business comes from the project brief, memories or their own words, and a missing fact is asked for with `ask_user` before the message is prepared.

## Statements about the person need a source

The prompt rule did not hold: in 示例项目 (task d5f20f44) the owner had said only 「我是家具厂，我卖的是床，帮我卖到境外」, and the outreach still claimed certifications, a container load, compliance labels and a sample lead time. So the server checks every email before it makes a review card (`apps/server/src/mail/claim-check.ts`):

- One model call of its own (the task's model, `claimCheckInstructions`, no tools: the answer is the JSON object `{"claims":[{"statement","evidence"}]}` in text) lists every statement the email makes about the sender or their business, each with `evidence`: the words of a source that state it, copied exactly. The sources are what the person gave: the project brief, the memories, the task's prompt, their answers (`state.answer`), the owner's fields of the account's persona, and the sending address. Nothing in it knows a trade, a site or a figure.
- The server keeps a statement as supported only when its evidence is really in a source (compared without case, spacing or punctuation). No evidence, or evidence that is not there, is a statement without a source; the checker cannot wave a claim through by saying it is plausible.
- Statements without a source: no review card. `prepare_email` answers `status: unsupported_claims` with the list (`claims`) and tells the run to take them out or `ask_user` for the facts; the run event is 「Email sent back: statements without a source」. The answer, once given, is a source for the next check.
- The checker can be wrong, so a draft is never held back for good: after `claimReturnLimit` (2) send-backs in a task the next draft goes to review with the statements shown in a 「没有来源的说法」 block on the card (`claimCheck: { status: "checked", unsupported }`). A card resets the count (`state.claimReturns`).
- `parseClaims` reads the list the usual ways a model writes it: in a code fence, with prose before or after it (brackets matched outside strings), as a top-level array, under another key (`statements`, `items`, …, or the object's only array, one level down too), items with other keys (`claim`, `text`; `quote`, `source`) or as plain strings (no evidence). An empty list is an answer: no statement about the person, so the email passes. A cut-off or unreadable list is none.
- An answer with no list in it leaves a line in the API log, `[claim-check] no list in the answer`, with the attempt, the answer's length, the stream's event types and its first 500 characters (anything shaped like a key masked), so a live failure shows what the provider or relay returned.
- A first attempt that fails (an error, an empty stream, no list in the answer) is tried once more, within `claimCheckTimeoutMs` for both.
- A check that does not work (both attempts fail, or `claimCheckTimeoutMs` passes) never holds the email: it goes to review with 「未核对」 on the card (`claimCheck: { status: "unchecked", reason }`) and the run event 「Email not checked」.
- A draft already prepared (under review, approved, declined: the same idempotency key) is not checked again.

Why text and not a tool call: the first version answered through a tool (`record_claims`, an array of objects with a nullable field, sent in strict mode). In live use (`openai/gemini-3.8-flash-high` through the sub2api relay in Chat Completions format) its first live run came back as the relay's 「empty_stream」 and every card fell back to 未核对. Plain text is what every provider and relay passes through, and a tool-only call was the one thing that request did differently from the task's own calls. The text version then ran live (02:26Z) but ended 「The check gave no list of statements」: the answer was not the exact object the first parser wanted, and nothing showed what it was; hence the tolerant parser and the log line.

The note is beside the draft, not part of what is approved (not in the proposal's hash). Limit: the task's prompt counts as the person's words, and the chat assistant writes it from what they said.

Tests: `tests/mail-claim-check.test.ts` (evidence must be in a source; sent back with no card; supported passes, one request with no tools; a failing check and a check with no list go to review unchecked after two attempts; a failed first attempt is tried again; the check through a Chat Completions gateway as in production; each way of writing the list, an empty list passing, what is not a list, the log line; after the limit the card shows the statements). The fixtures in `tests/helpers/model.ts` can answer with text (`{ text }`) in both wire formats, `tests/model-outcome.test.ts` (the check is one request more), `tests/prompt-lint.test.ts` (`claimCheckInstructions` carries no site, error code or number of ours).

## An unapproved review does not end the task

A review that expired unanswered (30 minutes) or that the person declined used to fail the whole task (`Reviewed action expired`), so the outreach loop died on the first email nobody clicked. On a general (`agent`) task the next run is now told (`approvalResult`: 「Not approved (expired): … was not sent」, run event 「Review not approved」), and preparing the same draft again answers `expired`/`denied` instead of failing; the run goes on with other work. Document replies keep the old behaviour; a send that failed or whose outcome is unknown still stops the task. Test: `tests/model-worker.test.ts` ("a review the person did not approve…").

### A decline or expiry of a message is final

A declined, unapproved or expired message to people (`isMessageToPeople`: email, Slack) is final. In the same run of that task (a repeating task's runs each start fresh; `state.runStartedAt`), a new message proposal to any of the same recipients (email: to, cc and bcc, compared without case; Slack: the channel) is refused by the server before any claim check or card: `prepare_email` / `prepare_slack_message` answer `status: refused` with the reason (`AgentService.finalSendRefusal`, `ActionService.finalRecipients`): it is not retried, reworded or sent another way, and the run tells the person it did not go out. A message to other people is not held to it; non-message actions (calendar, an app's call) keep the old behaviour (the run may change them and prepare again). The reply for the declined draft itself says the same. Tests: `tests/action-review.test.ts` ("a declined or expired message is final…").
