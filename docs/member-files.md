# Member files

Every member has a small set of Markdown files. They are how a member knows what she is for, what she has learned, and what she did lately. She reads them before she works, she writes to them when she learns something, and you can open and change them from her card.

The main member, Yuki, has the same files (her id is `yuki`).

## The three kinds of file

| File | What it holds |
| --- | --- |
| `AGENTS.md` | Her duties and ways of working: who she is, how she speaks, what she never touches, her long-term goal, her routines. |
| `MEMORY.md` | Her long-term memory: one fact per line, things that stay true. |
| `notes/YYYY-MM-DD.md` | A daily note: what happened that day, one line each with the time. The date is the day in the account's time zone (设置 → 通用 → 时区, the one routines use), else her computer's, or UTC when neither is set. |

Nothing else is a member file. A path outside these three kinds is refused, and a file is at most 64 KB.

## When she reads them

Before every turn of her work, the server reads `AGENTS.md`, `MEMORY.md`, today's note and yesterday's note and puts them in her prompt. This is done by the server, not left to the model:

- her one-to-one conversation,
- a task or a routine run on her account,
- Yuki's own chat, and a task that belongs to no account, read Yuki's files.

Each file has a cut-off (about 6000 characters for `AGENTS.md` and `MEMORY.md`, about 2500 for a note). A file longer than that is cut and the prompt says so; she can read the whole file with the `read_member_file` tool.

## When she writes them

- `remember_fact` adds one line to `MEMORY.md` (the same fact twice adds nothing).
- `update_member_file` rewrites `AGENTS.md` or `MEMORY.md` as a whole. She is told to read the file first and keep what is still right.
- `note_today` adds one line to today's note.
- `read_member_file` reads one file, or lists them.
- When a task or a routine run settles, the server adds a line to the member's note for the day (time, task name, a sentence of the result). This does not depend on the model remembering to do it.
- `set_account_persona` and `set_account_goal` (and the persona and goal an owner types) still keep their own records, and also rewrite the `## 职责` and `## 长期目标` sections of `AGENTS.md`. The rest of the file is left as it is.

A member made from a template starts with the template's duties and routines in her `AGENTS.md`.

## The first time

The first time a member's files are used and `AGENTS.md` does not exist, the server writes one from the persona and long-term goal she already had. If `MEMORY.md` does not exist it is written from the facts remembered for her. This happens once; the older records are not changed or removed, and later changes to them do not touch the files again.

## Where they are kept

**Open-source build.** Plain files on disk:

```
${MEMBER_FILES_DIR:-$DATA_DIR/members}/<member id>/AGENTS.md
${MEMBER_FILES_DIR:-$DATA_DIR/members}/<member id>/MEMORY.md
${MEMBER_FILES_DIR:-$DATA_DIR/members}/<member id>/notes/2026-11-05.md
```

`<member id>` is `yuki` for Yuki and the member's id for the others. Next to the files the server keeps a hidden `.changes.json` that remembers who changed which file; a file you changed with your own editor shows as changed by "editor".

With Docker Compose, `DATA_DIR` is `/data`, which is the `yuki-data` volume, so the files are in `/data/members` inside the service. To get at them:

```
docker compose exec yuki ls /data/members
docker compose cp yuki:/data/members ./members   # copy them out
```

(Use the service name in your `docker-compose.yml`.) To keep them somewhere else, set `MEMBER_FILES_DIR` and mount that path.

**Hosted build.** The hosted service keeps the files in its database, one record per file in the space's own records. They are not on a disk you can reach; open and change them from the card, or read and write them with the API below.

## Changing them by hand

- From the app: open a member's card (Yuki's: the profile button in the top bar of the main chat). 职责 shows the beginning of `AGENTS.md`, 记住的事 the beginning of `MEMORY.md`, and 笔记 lists the notes of the last 7 days. 打开 opens an editor with the whole file; 保存 writes it, and it says who changed it last.
- On disk (open-source build): edit the `.md` files with any editor. The next turn reads what is there. Keep to the three names above; other files in the folder are ignored.

A change you save while a run is going is read by her next turn, not the one already started.

## The API

The app uses these; `yuki` stands for the main member, and any other id must be a member of the space you are signed in to.

- `GET /api/members/:id/files` lists the files (path, size, last change, who).
- `GET /api/members/:id/files/<path>` reads one (404 when it does not exist yet, for example a day with no note).
- `PUT /api/members/:id/files/<path>` with `{ "content": "…" }` replaces it.

## Limits

- Files are per space, not per project: a member is in the space, and so are her files. Yuki's files belong to the space.
- Deleting a member does not delete her files.
