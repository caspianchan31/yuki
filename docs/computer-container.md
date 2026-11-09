# The members' computer (container)

Yuki's members get a computer of their own: a small Linux desktop with a browser, a terminal and
a shared `/workspace` folder. It runs in its own container, apart from the Yuki service, so what
members do there never touches your machine.

```
 your browser ──▶  yuki (service: web app + API)  ──▶  computer (desktop, browser, files)
                   the only published port             never published; reached by the service
```

- **Two containers.** `yuki` is the service (the web app and the API on one port). `computer` is
  the members' computer. They share a private network that has no way in from your machine and no
  way out; only `computer` is also connected to the internet, for its browser.
- **Members work only in `computer`.** Commands, files and browsing from a conversation go there.
- **You can watch it live, take it over, and hand it back.** From a member's card.
- **When nobody uses it, the desktop pauses.** Files stay; the next use brings it back by itself.

## Start it

You need Docker with the Compose plugin, a model provider's API key, and about 3 GB of free memory
(the defaults are 1 GB for the service and 2 GB for the computer).

```sh
cp .env.example .env
```

Edit `.env` and set at least the model and its key, and an account to sign in with:

```sh
MODEL=openai/gpt-5                # or anthropic/<model> or google/<model>
OPENAI_API_KEY=sk-...             # the key of that provider
OPENMUSE_ADMIN_USERNAME=you
OPENMUSE_ADMIN_PASSWORD=choose-a-long-password
```

Then:

```sh
docker compose up -d --build
```

Open http://localhost:8787 and sign in. (Without an admin account in `.env`, the service prints a
one-time setup code in its log: `docker compose logs yuki`.)

The first start builds both images, which takes a few minutes. It also makes, by itself:

- the **shared token** the service uses to talk to the computer, in the `computer-secrets` volume.
  Only the two containers see it; it never appears in `.env` or in a log;
- the two **keys** the service seals your saved secrets with, in the `yuki-keys` volume.

### Settings

All in `.env` (see `.env.example`):

| Setting | Default | What it does |
|---|---|---|
| `YUKI_PORT`, `YUKI_PUBLIC_URL` | `8787`, `http://localhost:8787` | The port, and the address your browser opens (built into the web app; change both together, then `docker compose up -d --build`). |
| `YUKI_BIND` | `127.0.0.1` | Which address the port is published on. Leave it unless you put TLS in front and mean to reach Yuki from other machines. |
| `YUKI_MEMORY`, `COMPUTER_MEMORY` | `1g`, `2g` | Memory limit of each container. A browser needs room; do not go under 1g for the computer. |
| `DESKTOP_IDLE_MINUTES` | `15` | Minutes without use before the desktop pauses. |
| `DESKTOP_SIZE` | `1280x800` | The screen size. |

## See it and take it over

Open a member's card (click the member), and look at the **Computer** section:

- **Running**, **Paused** or **Not set up**. "Not set up" means the service was started without a
  computer container, for example with `pnpm dev`; compose sets it up for you.
- **看电脑 (Look at the computer)** shows the live screen. It is view only. If the computer is
  paused it is started first.
- **接手 (Take over)** gives you the mouse and keyboard on that same screen. While you drive,
  members stop using the computer: their tools that change anything answer that they must wait,
  and they tell you they are waiting. Looking, such as reading a file or checking the status, still works.
- **交还 (Hand back)** returns it to the members.

How the live view stays safe: the page and the viewer's code are the Yuki service's own copy, never
taken from the computer (the computer runs whatever its members run, and the page runs next to your
session); only the screen's websocket is relayed to the computer. Both are on the service's address
(same origin), behind a ticket your signed-in session gets and that expires after half an hour; the
computer's own ports are not published. View only is enforced on the computer's side, not just in
the page: the view-only connection cannot send input at all.

## Update it

`deploy/update.sh <tag>` updates a running stack in place: it fetches the tag (with `--force`, so a
tag the project re-pointed still comes through), builds, stops the service, backs up the data and
key volumes to `backups/<time>/`, starts, and checks the health answer. Since v1.7 it then starts
the desktop through the computer's daemon and waits for it to say `running` (its browser came up);
when the health or the desktop check fails it puts the previous image and the backed-up volumes
back. `deploy/update.sh --status` shows what runs, `--check` runs only the two checks.
Settings: `YUKI_ROOT` (default `/opt/yuki-self`, holding `src/` and `backups/`), `YUKI_PROJECT`
(the compose project, default `yuki-self`), `YUKI_PORT` (the published port, default 8787),
`YUKI_DESKTOP_CHECK=off` for a stack without a computer.

## Pause and resume

A running desktop that nobody used for `DESKTOP_IDLE_MINUTES` is paused: its processes (browser
windows, terminals, anything a command left running) end, and `/workspace` stays. A member's
next command, file access or browser step starts the desktop again by itself, and so does
**看电脑**. An open live frame on a member's card counts as use for about half an hour.

The container itself keeps running while the desktop is paused; the memory it holds then is small.

## Where things are

| What | Where |
|---|---|
| Conversations, settings, receipts of commands | volume `yuki-data` (`/data` in the service) |
| Sealing keys | volume `yuki-keys` (`/keys`) |
| Members' files | volume `computer-workspace` (`/workspace` in the computer) |
| Shared token | volume `computer-secrets` |

Look inside the computer yourself: `docker compose exec computer bash` (the same user the members
run as). Back up `/workspace` with a normal volume backup. To start over:

```sh
docker compose down          # stop; every volume stays
docker compose down -v       # stop and delete every volume: conversations, files, keys
```

## What members can do there

Under the tool names a conversation already knows: `computer_status`, `start_computer`,
`stop_computer`, `run_computer_command`, `list_computer_files`, `read_computer_file`,
`write_computer_file`, `mkdir_computer`, plus `computer_browser` (open, read, click, type, press
a key, back), `computer_desktop` and `computer_screenshot`. Commands run in `/workspace`, for up to
30 seconds, with capped output, and every one leaves a receipt.

`computer_desktop` works the desktop's apps. A text editor and a file manager come installed (a
member opens them by name, with a file or folder in `/workspace`), and any app on the screen can be
looked at. A look lists the app's buttons, fields and menus with a number each, and a field's text;
a member clicks one, types into it or sets its text by number, presses keys (Enter, ctrl+s), and
gets a fresh look back. The apps are read through the desktop's accessibility bus: an app that does
not report its controls there (the terminal, for one) can still be seen with a screenshot. The file
manager opens in its detailed list, where every file is a row a member can read.

There is no approval flow of its own: the container is the sandbox. What leaves it is reviewed
the way everything else is. Email and Slack messages are drafts until you press send, and action
review applies to them as before; a member is told never to send, post, submit a form, sign in or
buy anything from the computer unless you asked for that exact action.

## The file page (v1.6)

文件 in the roster (or ⌘K → 文件) opens the computer's `/workspace` as a folder tree. Two folders
have a fixed meaning: `收到/` is where your uploads land and where members look for what you
handed them; `成品/` is where members save what they deliver, and its newest files sit at the top
of the page. Both are made when the desktop starts (and by the page if missing).

- Markdown opens in an editor and saves in place; text and code are shown read-only; a picture
  is shown; a PDF opens in the browser's reader; anything else is downloaded. 「让成员改」 puts
  the file's path into the chat so you can say what to change.
- 上传 (up to 10 MB a file), 新建文件夹, 重命名 and 删除 are on the page. Deleting moves the
  file or folder into the recycle bin (`/workspace/.trash`, which members never see and no
  file tool accepts as a path); 回收站 lists what is there with 找回 and 彻底删除, and entries
  older than 30 days are cleared whenever the bin is read.
- ⌘K → 找文件 (or just type a name) finds any folder or file on the computer by name and opens
  the page there.

The routes behind it, all under `/api/computer/files`: `GET ?path=`, `POST /read`, `/write`,
`/mkdir` (since v1.5), and v1.6's `GET /tree`, `GET /download?path=[&inline=1]` (served with
the type the name says; HTML and SVG as plain text), `POST /upload?path=` (the bytes as the
body), `/rename {path, to}`, `/delete {path}`, `GET /trash`, `POST /restore {id}`,
`/purge {id}`. The second tab of the page, 成员文件, is docs/member-files.md.

A file sent in the chat (docs/chat-attachments.md) is also copied to `/workspace/收到/` when
the computer is configured, so members find it there and the file page shows it.

## Limits to know

- The computer is **one for the whole install**, shared by every member. Members who work at the
  same time share its screen and browser.
- Its browser has internet access. Treat what members download or open as untrusted. The
  computer cannot reach the service's private network, but it can reach whatever your machine's
  network lets a container reach, including other machines on your LAN.
- The browser runs without its own sandbox, because the container is the sandbox: the processes
  run as an unprivileged user with every capability dropped.
- Saved site logins are not part of this version. A member can type a login into a page when you
  give it in the conversation; the page's cookies stay in the computer's browser profile under
  `/workspace`.

## Without compose

Any computer container that answers the same control address works. Set `DESKTOP_URL` (for
example `http://localhost:7070`) and `DESKTOP_TOKEN_FILE` (the file holding its token) in `.env`
before `pnpm dev`. The container's image is `apps/desktop`; it makes its token on the first start
(`DESKTOP_TOKEN_FILE=/secrets/token` inside). The live view needs the service and the computer on
one network where the service can reach the computer's ports 7070 and 6080 (6080 for the screen's
websocket only).
