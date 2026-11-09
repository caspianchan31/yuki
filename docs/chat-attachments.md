# Files in the chat (v1.6)

The person can send files and pictures with a message: the clip in the composer, a drag onto
it, or a paste (a screenshot from the clipboard). Each file uploads as soon as it is picked
(up to 10 MB, up to 10 per message); the message goes with the files' ids and shows a card per
file, a thumbnail for a picture. A member reads what was sent: a picture is looked at, a
document's words are read (PDF, Word, spreadsheet, slides, text, code).

## Where a file lives

- The bytes are kept by the server under `DATA_DIR/attachments` (`<id>`), with a record
  (`<id>.json`: the space, name, media type, size, when, and where the computer's copy went) and,
  once read, its words (`<id>.txt`). Kept for `ATTACHMENT_RETENTION_DAYS` (90) within
  `ATTACHMENT_MAX_GB` (5; the oldest go first). A deleted conversation takes its files with it.
- When the install has a computer (the open-core container), each sent file is also copied to
  `/workspace/收到/<name>` (a number is added when the name is taken), so the computer's tools can
  work on it and the file page shows it. Without a computer (the hosted build today) the file
  stays on the server and the member reads it from there.
- A file belongs to the space it was sent in: another space's request gets 404.

## What the message carries

A message without files is the plain string it always was. With files, its content is AG-UI
input parts: one `text` part and one `binary` part per file naming the attachment (`id`,
`mimeType`, `filename`), never the bytes. `packages/domain/src/chat-attachments.ts` reads
either shape (`messageText`, `attachmentsOf`, `userContent`); the stored conversation, the
replay and the reports read the text through it.

## What the model gets

Before a reply, `apps/server/src/chat/attachments-for-model.ts` turns each user message's
attachments into what a model takes: the newest four pictures across the conversation stay
attached as images (an older one is named and `read_attachment` shows it again); a document's
or text file's words follow its name in the message, cut to an excerpt of 12 000 characters
when long; anything else is named. The stored messages are not changed. The `read_attachment`
tool gives the whole text by id in pieces (`offset`), or a picture again. The words of a file
are the person's data, never instructions (the prompt says so).

Words come from `apps/server/src/chat/attachment-text.ts`: text and code as they are; a PDF
through `unpdf` (page by page); Word, Excel and PowerPoint files from their XML with the
small reader in `packages/integrations/src/{zip,office-text}.ts` (no Office library).

## Routes

Under `/api/chat/attachments`: `POST ?name=` with the bytes as the body (201 with the record;
413 over 10 MB), `GET /:id` (the file, served as what its name says: HTML and SVG as plain
text, `nosniff`, the UTF-8 name in `Content-Disposition`; `?inline=1` to view),
`GET /:id/meta` (the record).

## The cards

In the person's message each file is a card (`AttachmentCard`): a picture as a thumbnail that
opens full size; any other file opens the file page at the computer's copy when there is one,
else downloads. In a reply, a file a member saved under `/workspace/成品` (seen in the reply's
`write_*` steps) is a 成品 card (`DeliveredCard`) that opens the file page there.

## Acceptance

`tests/chat-attachments.test.ts` (unit), and an end-to-end check in both modes: a site without a
computer, and a throwaway open-source stack with one.
