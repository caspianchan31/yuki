// v1.6 聊天里发文件: what the server and the web agree on about a file sent in the chat. The
// person's message carries its attachments as AG-UI input content parts (a text part and one
// `binary` part per file, naming the attachment's id, media type and file name; never the
// bytes). The bytes live in the server's attachment store; the model gets a picture as an image
// part and a document as its text. Pure, no imports beyond the sibling workspace-files rules.
import {
  deliveredPath,
  extensionOf,
  type WorkspaceFileKind,
  workspaceFileKind,
} from "./workspace-files.ts";

/** The most one attachment may be (the upload route refuses more). */
export const attachmentMaxBytes = 10 * 1024 * 1024;
/** The most attachments one message may carry. */
export const attachmentsPerMessage = 10;
/** An attachment's id as the store makes it: base64url of 16 random bytes. */
export const attachmentIdPattern = /^[A-Za-z0-9_-]{16,32}$/;
/** How long the store keeps an attachment (ATTACHMENT_RETENTION_DAYS). */
export const attachmentRetentionDays = 90;

/** One file sent in the chat, as the message names it. */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
}

/** A `binary` input content part (AG-UI) naming one attachment. */
export interface AttachmentPart {
  type: "binary";
  mimeType: string;
  id: string;
  filename: string;
}
export interface TextInputPart {
  type: "text";
  text: string;
}
export type UserContentPart = TextInputPart | AttachmentPart;

/** A message's content as the person wrote it: the string itself, or the text parts joined. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const loose = part as { type?: unknown; text?: unknown };
      return loose?.type === "text" && typeof loose.text === "string" ? [loose.text] : [];
    })
    .join("\n");
}

/** The attachments a message's content names (none for a plain string). */
export function attachmentsOf(content: unknown): ChatAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const loose = part as { type?: unknown; id?: unknown; mimeType?: unknown; filename?: unknown };
    if (loose?.type !== "binary" || typeof loose.id !== "string") return [];
    if (!attachmentIdPattern.test(loose.id)) return [];
    return [
      {
        id: loose.id,
        name: typeof loose.filename === "string" && loose.filename ? loose.filename : "file",
        mimeType:
          typeof loose.mimeType === "string" && loose.mimeType
            ? loose.mimeType
            : "application/octet-stream",
      },
    ];
  });
}

/** The content a user message is sent with: the plain text while nothing is attached (as
 * before v1.6, so older code paths see a string), else the parts. */
export function userContent(text: string, attachments: readonly ChatAttachment[]) {
  if (!attachments.length) return text;
  const parts: UserContentPart[] = [{ type: "text", text }];
  for (const file of attachments)
    parts.push({ type: "binary", mimeType: file.mimeType, id: file.id, filename: file.name });
  return parts;
}

/** Whether a message says anything: text, or at least one attachment. */
export function hasContent(content: unknown): boolean {
  return messageText(content).trim() !== "" || attachmentsOf(content).length > 0;
}

/** What kind of file an attachment is for the model and the card: a picture is looked at; a
 * document (PDF, Word, a spreadsheet, slides) and text are read as text; anything else is only
 * named. */
export type AttachmentKind = WorkspaceFileKind | "document";

const documentExtensions = new Set(["pdf", "docx", "xlsx", "pptx", "csv", "tsv"]);

export function attachmentKind(name: string, mimeType = ""): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  const extension = extensionOf(name);
  if (documentExtensions.has(extension) || extension === "pdf") return "document";
  if (mimeType.startsWith("text/")) return "text";
  const kind = workspaceFileKind(name);
  return kind === "pdf" ? "document" : kind;
}

/** Whether the model can be handed this attachment's words (text or a document). */
export function attachmentReadable(name: string, mimeType = ""): boolean {
  const kind = attachmentKind(name, mimeType);
  return kind === "text" || kind === "markdown" || kind === "document";
}

/** A file name the person's browser gave: one component, nothing hidden, at most 180
 * characters; "file" when nothing is left. */
export function cleanAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  const cleaned = Array.from(base)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 180);
}

/** A media type for a file whose browser gave none (or `application/octet-stream`): from its
 * name, by the shared workspace rules; HTML and SVG stay as they are here (the chat never
 * renders them), the download route decides how to serve them. */
export function attachmentMediaType(name: string, declared?: string | null): string {
  const given = declared?.trim().toLowerCase().split(";")[0] ?? "";
  if (given && given !== "application/octet-stream") return given;
  const extension = extensionOf(name);
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    zip: "application/zip",
  };
  if (known[extension]) return known[extension];
  if (workspaceFileKind(name) === "text") return "text/plain";
  return "application/octet-stream";
}

/** v1.6 生成图片: the pictures a reply made with generate_image, from its results (`image`
 * with the attachment's id, name and media type), in order, once each; a failed call is left out.
 * The chat shows each as a picture card. */
export function generatedImages(
  toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
  resultOf: (callId: string) => string | undefined,
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const call of toolCalls) {
    if (call.function.name !== "generate_image") continue;
    const file = generatedImageOf(resultOf(call.id));
    if (file && !out.some((item) => item.id === file.id)) out.push(file);
  }
  return out;
}

/** The picture a generate_image result names, or null. */
export function generatedImageOf(result: string | undefined): ChatAttachment | null {
  if (!result) return null;
  let parsed: { image?: { id?: unknown; name?: unknown; mimeType?: unknown } };
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const image = parsed?.image;
  if (typeof image?.id !== "string" || !attachmentIdPattern.test(image.id)) return null;
  return {
    id: image.id,
    name: typeof image.name === "string" && image.name ? image.name : "图片",
    mimeType: typeof image.mimeType === "string" && image.mimeType ? image.mimeType : "image/png",
  };
}

/** A reply's files under /workspace/成品: the paths its write steps (write_*, save_*) saved
 * there, in order, once each; a step whose result says `error` is left out. The chat shows each
 * as a 成品 card. */
export function deliveredPaths(
  toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
  resultOf: (callId: string) => string | undefined,
): string[] {
  const paths: string[] = [];
  for (const call of toolCalls) {
    if (!/^(write_|save_)/.test(call.function.name)) continue;
    let path: unknown;
    try {
      path = (JSON.parse(call.function.arguments) as { path?: unknown }).path;
    } catch {
      continue;
    }
    if (typeof path !== "string") continue;
    const full = path.startsWith("/") ? path : `/workspace/${path}`;
    if (!full.startsWith(`${deliveredPath}/`)) continue;
    const result = resultOf(call.id);
    if (result && /"error"\s*:/.test(result)) continue;
    if (!paths.includes(full)) paths.push(full);
  }
  return paths;
}
