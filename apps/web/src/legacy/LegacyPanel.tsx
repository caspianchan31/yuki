/**
 * Phase C (docs/web.md): the "legacy" panel, from shell/PanelHost.tsx's legacy case. The
 * sheets load the first time one opens (a bundle of their own, as on the phone), with a skeleton
 * sheet meanwhile. Each detail gets a fresh sheet (keyed by what it shows), so opening another
 * review, file or mail while one is open never keeps the previous one's state. The panel's
 * afterClose is run by ShellNavProvider (shell/nav.tsx) once the panel is closed or replaced.
 */
import { computerDetailKey } from "@m/environments";
import type { Detail } from "@m/workspace";
import { lazy, Suspense } from "react";
import type { PanelProps } from "../panels/types";
import { Sheet, Skeleton } from "../ui/primitives";
import "./legacy.css";

const LegacySheet = lazy(() => import("./LegacySheet"));

/** What an old detail sheet shows (shell/PanelHost.tsx legacyDetailKey). */
export function legacyDetailKey(detail: Detail): string {
  switch (detail.type) {
    case "computer":
      return `computer:${computerDetailKey(detail.environment)}`;
    case "review":
      return `review:${detail.action.id}`;
    case "file":
      return `file:${detail.file.id}`;
    case "mail":
      return `mail:${detail.mail.id}`;
    case "browser":
      return `browser:${detail.browser.id}`;
    case "email":
      return `email:${detail.draft?.id ?? "new"}`;
    case "event":
      return `event:${detail.event?.id ?? "new"}`;
    case "task":
      return `task:${detail.taskId}`;
    default:
      return detail.type;
  }
}

export function LegacyPanel({ panel, onClose }: PanelProps<"legacy">) {
  return (
    <div className="lg">
      <Suspense
        fallback={
          <Sheet title="" onClose={onClose}>
            <Skeleton lines={6} />
          </Sheet>
        }
      >
        <LegacySheet key={legacyDetailKey(panel.detail)} detail={panel.detail} onClose={onClose} />
      </Suspense>
    </div>
  );
}
