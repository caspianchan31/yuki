// v1.6 聊天里发文件: the web's side of the chat's attachment routes (/api/chat/attachments):
// an upload before the message goes, a file's bytes by id (with the session's headers, which an
// <img> or a link could not send), a download, and the record that says where the members'
// computer got its copy.
import type { useWorkspace } from "@m/workspace";
import type { ChatAttachment } from "../../../../packages/domain/src/chat-attachments";

export type Api = ReturnType<typeof useWorkspace>["api"];

export interface AttachmentRecord extends ChatAttachment {
  size: number;
  createdAt: string;
  workspacePath: string | null;
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {}
  return `${response.status} ${response.statusText}`.trim();
}

/** Uploads one file; what the message will name. */
export async function uploadAttachment(api: Api, file: File): Promise<AttachmentRecord> {
  const response = await fetch(
    api.url(`/api/chat/attachments?name=${encodeURIComponent(file.name || "file")}`),
    {
      method: "POST",
      headers: { ...api.headers(), "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!response.ok) throw new Error(await errorOf(response));
  return (await response.json()) as AttachmentRecord;
}

export async function attachmentRecord(api: Api, id: string): Promise<AttachmentRecord> {
  const response = await fetch(api.url(`/api/chat/attachments/${encodeURIComponent(id)}/meta`), {
    headers: api.headers(),
  });
  if (!response.ok) throw new Error(await errorOf(response));
  return (await response.json()) as AttachmentRecord;
}

export async function attachmentBlob(api: Api, id: string, inline: boolean): Promise<Blob> {
  const response = await fetch(
    api.url(`/api/chat/attachments/${encodeURIComponent(id)}${inline ? "?inline=1" : ""}`),
    { headers: api.headers() },
  );
  if (!response.ok) throw new Error(await errorOf(response));
  return response.blob();
}

/** Saves the file through the browser's download, under its own name. */
export async function downloadAttachment(api: Api, file: ChatAttachment): Promise<void> {
  const blob = await attachmentBlob(api, file.id, false);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
