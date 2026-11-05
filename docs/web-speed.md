# Web speed (fork)

## Step 1: serving

`workflows/deploy-remote.sh` precompresses the text files after the web build (`gzip -9 -k`); the site's nginx config sends the `.gz` as it is (`gzip_static on`), keeps files whose names carry a content hash for a year (`/_expo/static/`, `/assets/`, `expires max`) and checks the entry page every time (`expires epoch`). The server's nginx has no brotli module (it would need rebuilding the panel's nginx); level 9 is only about 2% smaller than the level 5 nginx used, so the gain of step 1 is repeat visits, which no longer ask the server about unchanged files.

## Step 2A: a smaller first bundle

Measured from a local `expo export -p web --source-maps` (main bundle, before → after):

| | before | after |
|---|---|---|
| raw | 5.96 MB | 3.10 MB |
| gzip -9 | 1.26 MB | 0.76 MB |

- **Icons** (`src/lucide-icons.js`, `metro.config.js`): "lucide-react-native" resolves to the app's own list of the icons it imports, each from its own module, instead of the package's barrel of 3,090. `apps/mobile/test/icons.test.ts` fails when an imported icon is missing from the list.
- **Code a browser never runs** (`src/web-shims/`, web only): `graphql` (the only use is CopilotKit's error classes extending `GraphQLError`), `@segment/analytics-node` (CopilotKit's server telemetry, pulled in by its root entry; with it `jose`), and the React Native polyfills `text-encoding` and `web-streams-polyfill` (CopilotKit installs them only where the global is missing; the shims hand back the browser's own).
- **Polyfills on the phone apps only**: `index.js` imports `src/native-polyfills`, which is CopilotKit's polyfills on iOS and Android (`.native.js`) and nothing on the web.
- **Panels opened now and then load on first opening** (`shell/PanelHost.tsx`, `React.lazy`): details, store, account editor, credential editor and history, job detail, new task, settings: each a bundle of its own on the web. Modules something else imports stay in the main bundle.
- Not done: Expo's tree shaking (`EXPO_UNSTABLE_TREE_SHAKING`, about 9% more) is still marked unstable; zod is bundled twice (3.25 for @ag-ui and CopilotKit, 4.6 for the app).

Checked in Expo web (local): the conversation loads and a message streams, icons render, the lazy panels open.

## Step 2B: the last screen first

What this device last read is kept per space and project (`src/last-seen.ts`, `src/last-seen-store.ts`; the browser's localStorage, at most 7 days and 512 KB an entry, cleared at sign-out) and shown at once on the next opening; each piece is replaced when the server answers:

- the gates before the shell: the spaces (`SpaceGate`, `/api/me`), the projects (`ProjectsProvider`), the workspace snapshot (`WorkspaceApp`, `/api/workspace`): with a copy the shell draws at once; without one it waits as before; a server that does not answer shows the red 「连不上服务器 · 正在重试」 bar over the last copy instead of a blank error page;
- the main chat's id (`threads.tsx`): opened at once; the server's first answer confirms it or moves to the chat it names without the 「主聊天已更换」 notice;
- the task snapshot (`/api/agent`), the accounts, the projects' overview and the main chat's reports.

Not done: the conversation's messages. The chat connects by having the server replay the whole thread (CopilotKit), which owns the messages; showing a copy first would duplicate them or be replaced by the replay, and changing that means changing CopilotKit itself. The main chat's id kept on the device lets that replay start one round trip sooner.

Checked in Expo web (local): with the API stopped, a reload shows the header, the members bar with each one's state and the next step from the last copy under the red bar; with a fresh API (a new main chat), the page moves to it quietly.

Tests: `apps/mobile/test/last-seen.test.ts`.
