/**
 * Phase C: an assistant's or a report's Markdown, rendered by the same markdown-it instance the
 * phone app uses (assistant-markdown.ts: no raw HTML, safe links only). Links open in a new tab.
 */

import { assistantMarkdown } from "@m/assistant-markdown";
import { useMemo } from "react";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const out = assistantMarkdown.render(text);
    return out.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
  }, [text]);
  return (
    <div
      className={className ? `md ${className}` : "md"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false escapes raw HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
