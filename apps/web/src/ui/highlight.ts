/**
 * v1.6 聊天基础动作: syntax colours for the code blocks in a reply, from shiki's grammars with
 * its JavaScript regex engine (no WebAssembly), loaded only when a block of a known language is
 * on the page and one language at a time. Colours come as CSS variables for the light and the
 * dark theme (`--shiki-light` / `--shiki-dark`); chat.css picks one by the page's scheme.
 */
import type { HighlighterCore, LanguageInput } from "shiki/core";

const languages: Record<string, LanguageInput> = {
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  dockerfile: () => import("shiki/dist/langs/dockerfile.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
};

const aliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  mts: "typescript",
  py: "python",
  python3: "python",
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  docker: "dockerfile",
  htm: "html",
  vue: "html",
  svg: "xml",
  jsonc: "json",
  json5: "json",
  kt: "kotlin",
  rb: "ruby",
  golang: "go",
  patch: "diff",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
};

/** The language a fence's word names, as this page can colour it; null when it cannot. */
export function highlightLanguage(word: string): string | null {
  const key = word.trim().toLowerCase();
  if (!key) return null;
  const id = aliases[key] ?? key;
  return id in languages ? id : null;
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [
        import("shiki/dist/themes/github-light.mjs"),
        import("shiki/dist/themes/github-dark.mjs"),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

/**
 * The code as coloured spans, to put inside the block's `<code>` (its lines stay separated by
 * newlines, so the text copied from it is the code itself); null for a language this page does
 * not colour.
 */
export async function highlightCode(code: string, word: string): Promise<string | null> {
  const id = highlightLanguage(word);
  if (!id) return null;
  const engine = await highlighter();
  let loading = loaded.get(id);
  if (!loading) {
    const load = languages[id];
    if (!load) return null;
    loading = engine.loadLanguage(load);
    loaded.set(id, loading);
  }
  await loading;
  const html = engine.codeToHtml(code, {
    lang: id,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  const inner = /<code[^>]*>([\s\S]*)<\/code>\s*<\/pre>\s*$/.exec(html)?.[1];
  return inner ?? null;
}
