/**
 * Phase C: an assistant's or a report's Markdown, rendered by the same markdown-it instance the
 * phone app uses (assistant-markdown.ts: no raw HTML, safe links only). Links open in a new tab.
 * v1.6 聊天基础动作: a code block comes with a copy button in its head (handled here by the one
 * click handler on the rendered HTML) and gets its syntax colours once the text has settled.
 */

import { assistantMarkdown, codeCopyLabel } from "@m/assistant-markdown";
import { t } from "@m/shell/strings";
import { type MouseEvent, useEffect, useMemo, useRef } from "react";
import { copyToClipboard } from "./clipboard";
import { highlightCode } from "./highlight";

/** How long a block may keep changing (a reply streaming) before its colours are drawn. */
const settleMs = 350;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const out = assistantMarkdown.render(text);
    return out.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
  }, [text]);
  // One object per html: React 19 writes innerHTML again whenever this prop is a new object,
  // which would wipe the colours and the 已复制 label set on the DOM below at every re-render.
  const inner = useMemo(() => ({ __html: html }), [html]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      for (const code of root.querySelectorAll<HTMLElement>(".code-block[data-lang] pre code")) {
        const lang = code.closest<HTMLElement>(".code-block")?.dataset.lang ?? "";
        const source = code.textContent ?? "";
        void highlightCode(source, lang)
          .then((inner) => {
            // Only while the block is still the one that was read (not re-rendered since).
            if (!gone && inner && code.isConnected && code.textContent === source)
              code.innerHTML = inner;
          })
          .catch((error: unknown) => {
            console.warn("[Yuki] code colours failed", error);
          });
      }
    }, settleMs);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [html]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-code-copy]");
    if (!button) return;
    event.preventDefault();
    const code = button.closest(".code-block")?.querySelector("pre code");
    const source = code?.textContent ?? "";
    void copyToClipboard(source).then((ok) => {
      button.textContent = ok ? t.chat.actions.copied : t.common.copyFailed;
      window.setTimeout(() => {
        button.textContent = codeCopyLabel;
      }, 1500);
    });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the click handler serves the copy buttons inside the rendered HTML
    // biome-ignore lint/a11y/useKeyWithClickEvents: those buttons are real buttons and take the keyboard themselves
    <div
      ref={box}
      className={className ? `md ${className}` : "md"}
      onClick={onClick}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false escapes raw HTML
      dangerouslySetInnerHTML={inner}
    />
  );
}
