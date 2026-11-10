// Phase C: the web app is plain React on the DOM, built by Vite.
// The logic the phone app already has (packages/client/src: the API client, the providers, the
// *-core models, strings) is imported as it is; nothing here draws with React Native. Two rules
// keep it that way:
//   1. A mobile module X with a web version (apps/web/src/platform/X, or X.web.* beside it) is
//      replaced by that version, the way Metro picks a platform file.
//   2. Importing React Native, Expo or their icon set fails the build, naming the importer.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { readExtraHtml, withExtraHtml } from "./index-extra";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, "../../packages/client/src");
const platform = path.resolve(here, "src/platform");
const domain = path.resolve(here, "../../packages/domain/src");
const exts = [".tsx", ".ts", ".js"];
const forbidden =
  /^(react-native(-[\w-]+)?|expo(-[\w-]+)?|@expo\/[^/]+|lucide-react-native)(\/.*)?$|^@copilotkit\/react-native(?!\/headless$)/;

function sameFile(base: string): string | null {
  for (const ext of exts) if (existsSync(base + ext)) return base + ext;
  return null;
}

function mobileOverlay(): Plugin {
  return {
    name: "openmuse-mobile-overlay",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (forbidden.test(source))
        this.error(
          `${source} imported by ${importer ?? "?"}: the web app does not use React Native`,
        );
      // The shared modules' zod is the app's own (one copy with CopilotKit's, so tool schemas
      // pass its checks); packages keep theirs (@ag-ui/core is on zod 3).
      if ((source === "zod" || source.startsWith("zod/")) && importer?.startsWith(mobile))
        return this.resolve(source, path.join(here, "src/main.tsx"), {
          ...options,
          skipSelf: true,
        });
      if (!importer || !source.startsWith(".")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved?.id.startsWith(mobile)) return null;
      const rel = path.relative(mobile, resolved.id).replace(/\.(tsx|ts|js)$/, "");
      return (
        sameFile(path.join(platform, rel)) ?? sameFile(path.join(mobile, `${rel}.web`)) ?? null
      );
    },
  };
}

/** v1.7.1: index-extra.html beside index.html, or WEB_INDEX_EXTRA, goes before `</body>` (index-extra.ts). */
function indexExtra(): Plugin {
  const extra = readExtraHtml(
    process.env,
    path.resolve(here, "../.."),
    path.join(here, "index-extra.html"),
  );
  return {
    name: "openmuse-index-extra",
    transformIndexHtml: (html) => withExtraHtml(html, extra),
  };
}

export default defineConfig({
  plugins: [mobileOverlay(), react(), indexExtra()],
  resolve: {
    alias: [
      {
        find: "@copilotkit/react-native/headless",
        replacement: path.join(platform, "copilotkit-headless.tsx"),
      },
      { find: "@m", replacement: mobile },
      { find: "@openmuse/domain", replacement: path.join(domain, "index.ts") },
    ],
    // One React, one CopilotKit: modules under packages/client resolve these from here. Not zod
    // (the overlay above sends the shared modules' zod to the app's): @ag-ui/core validates every
    // streamed event with zod 3, and forcing one copy on everything made every replayed event fail
    // its check, silently, so a conversation reopened with none of its messages.
    dedupe: [
      "react",
      "react-dom",
      "@copilotkit/react-core",
      "@copilotkit/core",
      "@ag-ui/client",
      "markdown-it",
      // tenancy/web sits outside this package: it resolves its icons from here too.
      "lucide-react",
    ],
  },
  server: { fs: { allow: [path.resolve(here, "../..")] } },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  envPrefix: ["VITE_"],
  // The shared modules read the Expo names; the web build fills them from VITE_API_URL / VITE_BUILD.
  define: {
    "process.env.EXPO_PUBLIC_API_URL": JSON.stringify(process.env.VITE_API_URL ?? ""),
    "process.env.EXPO_PUBLIC_BUILD": JSON.stringify(process.env.VITE_BUILD ?? ""),
  },
});
