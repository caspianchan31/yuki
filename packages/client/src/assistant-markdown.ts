import MarkdownIt from "markdown-it";

export const assistantMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

/** The label a code block's copy button starts with (the page swaps it for 已复制 after a click). */
export const codeCopyLabel = "复制";

// v1.6 聊天基础动作: a fenced code block is a card with a head naming its language and a copy
// button (`data-code-copy`; the page that renders the HTML handles the click and the highlighting
// of `pre > code.language-*`). Nothing else about the block changes: no line numbers, so what is
// copied is the code itself.
assistantMarkdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  if (!token) return "";
  const info = token.info.trim().split(/\s+/)[0] ?? "";
  const lang = info
    .replace(/[^\w+#.-]/g, "")
    .slice(0, 24)
    .toLowerCase();
  const safe = assistantMarkdown.utils.escapeHtml;
  const head =
    `<div class="code-head"><span class="code-lang">${safe(lang || "code")}</span>` +
    `<button type="button" class="code-copy" data-code-copy>${codeCopyLabel}</button></div>`;
  const code = `<pre><code${lang ? ` class="language-${safe(lang)}"` : ""}>${safe(token.content)}</code></pre>`;
  return `<div class="code-block"${lang ? ` data-lang="${safe(lang)}"` : ""}>${head}${code}</div>\n`;
};

export function isSafeAssistantUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}
