/**
 * Phase C (docs/web.md): an old detail sheet, by the kind of its Detail, from details.tsx
 * Details (the cases routeDetail still sends to a "legacy" panel: computer, mail, email, event,
 * file, review, browser). A computer detail with an environment shows that account's desktop.
 */
import type { Detail } from "@m/workspace";
import { ComputerSheet } from "./ComputerSheet";
import {
  BrowserDetail,
  EmailEditor,
  EventEditor,
  FileDetail,
  MailDetail,
  ReviewDetail,
} from "./details";
import { DesktopScope } from "./scope";

export default function LegacySheet({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  switch (detail.type) {
    case "computer":
      // Inside a scope the sheet's computer calls go to that environment.
      return (
        <DesktopScope environment={detail.environment ?? null}>
          <ComputerSheet
            focusDesktop={detail.focus === "desktop"}
            need={detail.need}
            onClose={onClose}
          />
        </DesktopScope>
      );
    case "mail":
      return <MailDetail mail={detail.mail} onClose={onClose} />;
    case "email":
      return <EmailEditor draft={detail.draft} onClose={onClose} />;
    case "event":
      return (
        <EventEditor
          event={detail.event}
          draft={detail.draft}
          neighbors={detail.neighbors}
          onClose={onClose}
        />
      );
    case "file":
      return <FileDetail file={detail.file} onClose={onClose} />;
    case "review":
      return <ReviewDetail initial={detail.action} onClose={onClose} />;
    case "browser":
      return <BrowserDetail initial={detail.browser} onClose={onClose} />;
    // task, delegate, topology, notifications and menu never reach a legacy panel (routeDetail).
    default:
      return null;
  }
}
