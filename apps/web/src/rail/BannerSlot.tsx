/**
 * Phase C (docs/web.md, the prototype's banner slot): under the top bar, at most two rows —
 * a system notice (the first two below), then the most urgent of the rest — from the bars the
 * phone stacks above the chat:
 *   red    the worker or the API is down (shell/WorkerDownBar.tsx, frame/strip.downBarText);
 *          查看 opens 设置 (平台管理 → 系统 for the platform operator: the heartbeat, the incidents)
 *   red    the space is read-only (the tenancy port's banners); 去订阅
 *   amber  (fork, make it run) the infrastructure keeps stopping this project's runs
 *          (shell/InfraBar.tsx, frame/strip.infraNoticeText): one notice for the project, not a
 *          card per run; it goes by itself once runs work again
 *   amber  a trial or grace period ending soon (the tenancy port's banners); 去订阅
 *   grey   conversations from before v0.5 still in CopilotKit's cloud (shell/CloudThreadsBar.tsx)
 * ✕ hides a row other than a system notice for this visit; the next one shows. It also routes the shared code's "show this rail
 * section" (ShellNav.openDrawer, an old link) to the member pane.
 */

import { useShellData } from "@m/shell/data";
import { cloudThreadsText } from "@m/shell/frame/cloud-threads";
import { downBarText, infraNoticeText } from "@m/shell/frame/strip";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useSpaceInfo } from "@m/tenancy-client";
import { useWorkspace } from "@m/workspace";
import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { setFrame } from "../shell/state";
import { type BannerItem, useTenancyUi } from "../tenancy-ui";
import "./rail.css";

// Banners the owner hid in this visit (a reload shows them again).
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const hide = (key: string) => {
  hidden = new Set([...hidden, key]);
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getHidden = () => hidden;

type Banner = BannerItem;

export function BannerSlot({ workspaceError }: { workspaceError: string }) {
  const { worker, agentError, ready, entries, now } = useShellData();
  const nav = useShellNav();
  const { workspace } = useWorkspace();
  const { operator } = useSpaceInfo();
  const { readOnly, ending } = useTenancyUi().useBanners();
  const shut = useSyncExternalStore(subscribe, getHidden, getHidden);
  useFocusSection();

  const candidates: Banner[] = [];
  const down = downBarText({ agentError, workspaceError, ready, worker });
  if (down)
    candidates.push({
      key: "down",
      tone: "red",
      text: down,
      action: {
        text: t.downBar.view,
        run: () => {
          if (!operator) return nav.openPanel({ kind: "settings" });
          nav.closePanel();
          setFrame({ platform: "system", drawer: false });
        },
      },
    });
  if (readOnly) candidates.push(readOnly);
  // One notice while the infrastructure keeps stopping the project's runs
  // (not while the worker is down: that notice already says nothing moves).
  const infra = down ? null : infraNoticeText(entries, now);
  if (infra) candidates.push({ key: "infra", tone: "amber", text: infra });
  if (ending) candidates.push(ending);
  const cloud = cloudThreadsText(workspace.runtime.cloudThreads);
  if (cloud) candidates.push({ key: "cloud", tone: "grey", text: cloud });

  // At most two rows: a system notice (the worker or API down, a read-only space, the
  // infrastructure stopping runs) never hides the other row.
  const isSystem = (item: Banner) =>
    item.key === "down" || item.key === "readOnly" || item.key === "infra";
  const system = candidates.find(isSystem);
  const other = candidates.find((item) => !isSystem(item) && !shut.has(item.key));
  const shown = [system, other].filter((item): item is Banner => !!item);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((banner) => (
        <div
          key={banner.key}
          className={`banner ${banner.tone}`}
          role={banner.tone === "red" ? "alert" : "status"}
        >
          <span className="tx">{banner.text}</span>
          {banner.action ? (
            <button type="button" className="act" onClick={banner.action.run}>
              {banner.action.text}
            </button>
          ) : null}
          {!isSystem(banner) ? (
            <button
              type="button"
              className="x"
              title={t.needs.dismiss}
              aria-label={t.needs.dismiss}
              onClick={() => hide(banner.key)}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** ShellNav.focusSection (openDrawer on the phone) on the web: 需要你 is in the member's chat; any
 * other section opens the member pane. */
function useFocusSection() {
  const { focusSection, clearFocusSection } = useShellNav();
  useEffect(() => {
    if (!focusSection) return;
    if (focusSection === "needs") {
      clearFocusSection();
      return;
    }
    setFrame({ pane: true, details: true, peek: null });
  }, [focusSection, clearFocusSection]);
}
