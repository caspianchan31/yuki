/**
 * The desktop an account is using right now, small
 * beside the timeline on a wide window, by itself (`desktopPreview`): its name, what it is doing
 * and the live picture, view only. Clicking it opens her computer page; taking over
 * still goes through the desktop card. The stream is read once when it appears (it keeps the
 * desktop awake no longer than a first look does) and not refreshed.
 */
import { scopeComputerPath } from "@m/environments";
import type { DesktopPreview as Preview } from "@m/shell/desk/preview-core";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useEffect, useState } from "react";
import "./accounts.css";

export function DesktopPreview({
  preview,
  onOpen,
}: {
  preview: Preview;
  /** Open her computer page. */
  onOpen: () => void;
}) {
  const { api } = useWorkspace();
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    setUrl("");
    void api
      .request<{ url: string }>(scopeComputerPath("/api/computer/desktop", preview.environmentId))
      .then((value) => {
        if (alive) setUrl(value.url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, preview.environmentId]);
  const label = t.computer.previewTitle(preview.name);
  return (
    <button
      type="button"
      className="acc-preview"
      aria-label={label}
      title={t.computer.previewOpen}
      onClick={onOpen}
    >
      <span className="h">{label}</span>
      <span className="d">{preview.doing}</span>
      <span className="f">
        {url ? (
          <iframe
            src={url}
            title={t.computer.desktopFrame}
            tabIndex={-1}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        ) : null}
      </span>
    </button>
  );
}
