/**
 * v1.6 聊天里发文件: the file cards in the chat.
 *   AttachmentCard  a file the person sent, in their own message: a picture shows as a
 *                   thumbnail (opened full size on click); any other file is a card with its
 *                   name that opens the file page at the computer's copy (/workspace/收到/…)
 *                   when there is one, else downloads it.
 *   DeliveredCard   a file a member saved under /workspace/成品 in this reply (seen in the
 *                   reply's write steps): a card that opens the file page there.
 */
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { File, FileImage, FileSpreadsheet, FileText, FolderOpen, Presentation } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  attachmentKind,
  type ChatAttachment,
} from "../../../../packages/domain/src/chat-attachments";
import { extensionOf } from "../../../../packages/domain/src/workspace-files";
import { attachmentBlob, attachmentRecord, downloadAttachment } from "./attachments";

function iconFor(name: string, mimeType = ""): ReactNode {
  const kind = attachmentKind(name, mimeType);
  const extension = extensionOf(name);
  if (kind === "image") return <FileImage size={16} />;
  if (extension === "xlsx" || extension === "csv" || extension === "tsv")
    return <FileSpreadsheet size={16} />;
  if (extension === "pptx") return <Presentation size={16} />;
  if (kind === "document" || kind === "text" || kind === "markdown") return <FileText size={16} />;
  return <File size={16} />;
}

/** A picture's bytes as an object URL while the card is shown. */
function useThumbnail(id: string, enabled: boolean): string | null {
  const { api } = useWorkspace();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current: string | null = null;
    let gone = false;
    void attachmentBlob(api, id, true)
      .then((blob) => {
        if (gone) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [api, id, enabled]);
  return url;
}

export function AttachmentCard({ file }: { file: ChatAttachment }) {
  const { api } = useWorkspace();
  const nav = useShellNav();
  const picture = attachmentKind(file.name, file.mimeType) === "image";
  const thumb = useThumbnail(file.id, picture);
  const [error, setError] = useState("");
  const words = t.chat.attachments;
  const open = async () => {
    setError("");
    try {
      if (picture) {
        const blob = await attachmentBlob(api, file.id, true);
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      // A copy on the members' computer (the server made one when there was a computer: the
      // open core's container; the hosted runtime flag says nothing about it) opens the file page.
      const record = await attachmentRecord(api, file.id);
      if (record.workspacePath) {
        nav.openPanel({ kind: "files", path: record.workspacePath });
        return;
      }
      await downloadAttachment(api, file);
    } catch (e) {
      setError(e instanceof Error && /404/.test(e.message) ? words.gone : words.openFailed);
    }
  };
  if (picture && thumb)
    return (
      <button
        type="button"
        className="attach-card pic"
        data-attachment={file.id}
        title={words.open(file.name)}
        aria-label={words.open(file.name)}
        onClick={() => void open()}
      >
        <img className="thumb" src={thumb} alt={file.name} />
        {error ? <span className="attach-err">{error}</span> : null}
      </button>
    );
  return (
    <button
      type="button"
      className="attach-card"
      data-attachment={file.id}
      title={words.open(file.name)}
      onClick={() => void open()}
    >
      {iconFor(file.name, file.mimeType)}
      <span className="attach-name">{file.name}</span>
      {error ? <span className="attach-err">{error}</span> : null}
    </button>
  );
}

export function DeliveredCard({ path }: { path: string }) {
  const nav = useShellNav();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const words = t.chat.attachments;
  return (
    <button
      type="button"
      className="attach-card delivered"
      title={words.openDelivered(name)}
      onClick={() => nav.openPanel({ kind: "files", path })}
    >
      <FolderOpen size={16} />
      <span className="attach-kind">{words.delivered}</span>
      <span className="attach-name">{name}</span>
    </button>
  );
}
