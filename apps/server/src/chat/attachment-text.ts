// v1.6 聊天里发文件: a sent file's words, for the model. Text and code are decoded as they are;
// a PDF's text is taken page by page (unpdf); Word, Excel and PowerPoint files are read from
// their XML (packages/integrations/src/office-text.ts). A picture has no words here (the model
// looks at it); any other file gives an empty string.
import { extractText, getDocumentProxy } from "unpdf";
import {
  attachmentKind,
  attachmentReadable,
} from "../../../../packages/domain/src/chat-attachments.ts";
import { extensionOf } from "../../../../packages/domain/src/workspace-files.ts";
import { docxText, pptxText, xlsxText } from "../../../../packages/integrations/src/office-text.ts";

/** The most text an attachment gives (beyond it the end is cut with a note). */
export const attachmentTextMax = 400_000;

export async function attachmentText(name: string, mimeType: string, bytes: Uint8Array) {
  if (!attachmentReadable(name, mimeType)) return "";
  const extension = extensionOf(name);
  let text: string;
  if (extension === "pdf" || mimeType === "application/pdf") text = await pdfText(bytes);
  else if (extension === "docx") text = docxText(bytes);
  else if (extension === "xlsx") text = xlsxText(bytes);
  else if (extension === "pptx") text = pptxText(bytes);
  else text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  if (text.length > attachmentTextMax)
    return `${text.slice(0, attachmentTextMax)}\n[cut: the file has ${text.length} characters]`;
  return text;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = text.map(
    (page, index) => `--- page ${index + 1} of ${totalPages} ---\n${page.trim()}`,
  );
  return pages.join("\n\n").trim();
}

/** A short word for the kind, for the note the model reads. */
export function attachmentKindWord(name: string, mimeType: string): string {
  const kind = attachmentKind(name, mimeType);
  if (kind === "image") return "picture";
  if (kind === "document") {
    const extension = extensionOf(name);
    return extension === "pdf"
      ? "PDF"
      : extension === "docx"
        ? "Word document"
        : extension === "xlsx"
          ? "spreadsheet"
          : extension === "pptx"
            ? "slides"
            : "table";
  }
  if (kind === "markdown") return "Markdown";
  if (kind === "text") return "text file";
  return "file";
}
