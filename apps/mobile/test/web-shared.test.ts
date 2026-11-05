// Apps/web imports the phone app's logic as it is (the API client, the
// providers' state, the *-core models, strings). Its build fails on any React Native, Expo or
// lucide-react-native import, so the shared layer must reach none of them. This walks the
// relative import graph from that layer and names the chain to the first forbidden import.
// platform-env.ts is the one module allowed to touch React Native: the web app overlays it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const src = path.resolve(import.meta.dirname, "../../../packages/client/src");
// The multi-tenant layer's client logic (tenancy/client) is walked from its own entries: it is
// shared with apps/web the same way and must be as free of React Native.
const tenancySrc = path.resolve(import.meta.dirname, "../../../tenancy/client");
const tenancyNamed = [
  "spaces-state",
  "billing-state",
  "signup-status-state",
  "signup-admin-state",
  "password-reset-state",
  "port.ts",
];
const overlaid = new Set([path.join(src, "platform-env.ts")]);
const forbidden = (spec: string) =>
  spec !== "@copilotkit/react-native/headless" &&
  /^(react-native(-[\w-]+)?|expo(-[\w-]+)?|@expo\/[^/]+|lucide-react-native|@copilotkit\/react-native)(\/.*)?$/.test(
    spec,
  );
const exts = [".ts", ".tsx", ".js"];

const named = [
  "api.ts",
  "api-client.ts",
  "session-core.ts",
  "auth-state",
  "projects-state",
  "threads-state",
  "agent-workspace.tsx",
  "workspace.tsx",
  "shell/data.tsx",
  "shell/nav.tsx",
  "shell/model.ts",
  "shell/strings.ts",
  "shell/theme.ts",
  "shell/poll.ts",
  "shell/layout.ts",
  "chat-reports-state",
  "environments-screen-state",
  "shell/accounts/hooks.ts",
  "shell/credentials/useCredentials.ts",
  "thread-environment.tsx",
  "last-seen-store.ts",
  "platform-env.ts",
  // Phase C migration: the RN-free state the web screens share (the *-core models are walked
  // by `cores` below: report-core, tool-cards-core, task-schedule-core).
  "DateTimeEditor-state.ts",
  "chat-state.tsx",
  "computer-workspace-state.ts",
  "conversation-contexts.ts",
  "desktop-stream-state.ts",
  "details-state.ts",
  "environment-scope-state.tsx",
  "task-schedule-state.ts",
  "shell/chat/group-state.ts",
  "shell/components/need-card-state.ts",
];

function cores(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return cores(full);
    return /-core\.ts$/.test(name) ? [full] : [];
  });
}

function fileFor(base: string): string | null {
  // The web build takes X.web.* beside X when there is one, as Metro does.
  for (const ext of exts) if (existsSync(`${base}.web${ext}`)) return `${base}.web${ext}`;
  if (/\.(tsx?|js)$/.test(base) && existsSync(base)) return base;
  for (const ext of exts) if (existsSync(base + ext)) return base + ext;
  for (const ext of exts)
    if (existsSync(path.join(base, `index${ext}`))) return path.join(base, `index${ext}`);
  return null;
}

// Value imports only: `import type` / `export type` vanish at build time.
function specifiers(code: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of code.matchAll(re)) {
    if (m[1]) continue;
    out.push(m[2] ?? m[3]);
  }
  return out;
}

test("the layer apps/web shares reaches no React Native, Expo or lucide-react-native", () => {
  const entries = [
    ...new Set([
      ...named.map((name) => path.join(src, name)),
      ...cores(src),
      // The open-source export has no tenancy/ tree.
      ...(existsSync(tenancySrc)
        ? [...tenancyNamed.map((name) => path.join(tenancySrc, name)), ...cores(tenancySrc)]
        : []),
    ]),
  ];
  const problems: string[] = [];
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const entry of entries) {
    const file = fileFor(entry);
    if (!file) {
      problems.push(`missing entry ${path.relative(src, entry)}`);
      continue;
    }
    if (!parent.has(file)) {
      parent.set(file, null);
      queue.push(file);
    }
  }
  const chain = (file: string) => {
    const steps: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at))
      steps.unshift(path.relative(src, at));
    return steps.join(" -> ");
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (overlaid.has(file)) continue;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (forbidden(spec)) {
        problems.push(`${chain(file)} imports ${spec}`);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const next = fileFor(path.resolve(path.dirname(file), spec));
      if (!next) {
        problems.push(`${chain(file)} imports ${spec}, which does not resolve`);
        continue;
      }
      if (parent.has(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  assert.deepEqual(problems, []);
});
