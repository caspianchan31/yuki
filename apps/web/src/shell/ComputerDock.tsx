/**
 * v1.7.3 电脑在旁边 (container-computer-state.tsx): the computer beside the conversation and
 * the computer opened big.
 *
 * ComputerDock: on a wide window, a small live preview of the members' computer kept on the
 * right of the conversation (what they are doing, who drives); a click opens it big. It can be
 * folded to a narrow tab, remembered on this device.
 * ComputerViewer: the whole desktop over the page, as large as the window allows, where the
 * person takes over (接手) and hands it back (交还). Esc or 关闭 closes it.
 */

import { t } from "@m/shell/strings";
import { Maximize2, Monitor, PanelRightClose, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorLine } from "../ui/primitives";
import { useContainerComputer } from "./container-computer-state";

const foldedKey = "yuki.computerDock.folded";
function readFolded(): boolean {
  try {
    return localStorage.getItem(foldedKey) === "1";
  } catch {
    return false;
  }
}
function writeFolded(folded: boolean) {
  try {
    if (folded) localStorage.setItem(foldedKey, "1");
    else localStorage.removeItem(foldedKey);
  } catch {
    // Blocked storage: the dock opens unfolded next time.
  }
}

function statusWord(
  c: typeof t.containerComputer,
  state: { configured: boolean; status?: string },
) {
  if (!state.configured) return c.unset;
  if (state.status === "running") return c.running;
  if (state.status === "error") return c.error;
  return c.stoppedShort;
}

export function ComputerDock() {
  const computer = useContainerComputer();
  const [folded, setFolded] = useState(readFolded);
  const c = t.containerComputer;
  const running = !!computer?.running;
  const preview = computer?.preview;
  // A running computer shows its picture in the preview (asked for once; it does not wake it).
  useEffect(() => {
    if (running && !folded) void preview?.();
  }, [running, folded, preview]);
  if (!computer?.ours || !computer.configured) return null;
  const fold = (next: boolean) => {
    setFolded(next);
    writeFolded(next);
  };
  if (folded)
    return (
      <aside className="computer-dock folded" aria-label={c.title}>
        <button
          type="button"
          className="computer-dock-tab"
          title={c.showDock}
          aria-label={c.showDock}
          onClick={() => fold(false)}
        >
          <Monitor size={15} />
          <span>{c.title}</span>
          <i className={running ? "cd-dot on" : "cd-dot"} />
        </button>
      </aside>
    );
  const { snapshot, person, view, viewerOpen, busy } = computer;
  return (
    <aside className="computer-dock" aria-label={c.title}>
      <div className="computer-dock-head">
        <Monitor size={15} />
        <strong>{c.title}</strong>
        <span className={running ? "cd-dot on" : "cd-dot"} />
        <span className="computer-dock-status">
          {statusWord(c, { configured: true, status: snapshot?.status })}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="tb-btn"
          title={c.enlarge}
          aria-label={c.enlarge}
          disabled={busy}
          onClick={() => void computer.look()}
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          className="tb-btn"
          title={c.hideDock}
          aria-label={c.hideDock}
          onClick={() => fold(true)}
        >
          <PanelRightClose size={14} />
        </button>
      </div>
      <button
        type="button"
        className="computer-dock-screen"
        title={c.enlarge}
        aria-label={c.enlarge}
        disabled={busy}
        onClick={() => void computer.look()}
      >
        {view && !viewerOpen ? (
          <iframe
            key={view.url}
            src={view.url}
            title={c.frame}
            tabIndex={-1}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="computer-dock-placeholder">
            {viewerOpen ? c.inViewer : running ? c.connecting : c.pausedHint}
          </span>
        )}
      </button>
      <div className="computer-dock-line">
        {running ? (person ? c.personDrives : c.memberDrives) : c.lookHint}
      </div>
      <ErrorLine error={viewerOpen ? "" : computer.error} />
    </aside>
  );
}

export function ComputerViewer() {
  const computer = useContainerComputer();
  const open = !!computer?.viewerOpen;
  const close = computer?.closeViewer;
  useEffect(() => {
    if (!open || !close) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
  if (!computer?.ours || !open) return null;
  const c = t.containerComputer;
  const { snapshot, running, person, view, busy } = computer;
  return (
    <div className="computer-viewer" role="dialog" aria-modal="true" aria-label={c.title}>
      <div className="computer-viewer-scrim" onClick={computer.closeViewer} aria-hidden="true" />
      <div className="computer-viewer-box">
        <div className="computer-viewer-head">
          <Monitor size={16} />
          <strong>{c.title}</strong>
          <span className={running ? "cd-dot on" : "cd-dot"} />
          <span className="computer-dock-status">
            {statusWord(c, { configured: computer.configured, status: snapshot?.status })}
            {running ? ` · ${person ? c.personDrives : c.memberDrives}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          {running ? (
            <button
              type="button"
              className="member-run"
              disabled={busy}
              onClick={() => void computer.control(person ? "member" : "person")}
            >
              {person ? c.handBack : c.drive}
            </button>
          ) : null}
          <button
            type="button"
            className="tb-btn"
            title={c.close}
            aria-label={c.close}
            onClick={computer.closeViewer}
          >
            <X size={16} />
          </button>
        </div>
        <div className="computer-viewer-stage">
          {view ? (
            <div className="computer-viewer-screen">
              <iframe
                key={view.url}
                src={view.url}
                title={c.frame}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <span className="computer-dock-placeholder">{busy ? c.starting : c.connecting}</span>
          )}
        </div>
        <div className="computer-viewer-foot">
          {view?.control === "member" ? c.viewOnly : person ? c.drivingHint : ""}
          <ErrorLine error={computer.error} />
        </div>
      </div>
    </div>
  );
}
