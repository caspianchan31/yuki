/**
 * v1.5 (open core): the members' computer on a member's card. One computer is shared by every
 * member of the install; the card says whether it runs, is paused or is not set up, opens its
 * live picture big (ComputerViewer, v1.7.3: it was a small frame inside the card) and lets the
 * person take it over (接手) and hand it back (交还). Draws nothing when the server's computer is
 * not the container (the hosted computer has its own card).
 */

import { t } from "@m/shell/strings";
import { ErrorLine } from "../ui/primitives";
import { useContainerComputer } from "./container-computer-state";

/** `inSettings`: the 设置 → 电脑 pane, which has no heading of its own and adds 暂停 / 启动. */
export function ContainerComputer({ inSettings = false }: { inSettings?: boolean } = {}) {
  const computer = useContainerComputer();
  const c = t.containerComputer;
  if (!computer?.ours || !computer.snapshot) return null;
  const { snapshot, configured, running, person, busy, viewerOpen } = computer;
  const word = !configured
    ? c.unset
    : snapshot.status === "running"
      ? c.running
      : snapshot.status === "error"
        ? c.error
        : c.stopped;
  return (
    <section>
      {inSettings ? null : <h3>{c.title}</h3>}
      <div className="member-card">
        <div>{word}</div>
        {!configured ? <div className="roster-line">{c.unsetHint}</div> : null}
        {configured ? <div className="roster-line">{c.shared}</div> : null}
        {configured && snapshot.status === "error" && snapshot.message ? (
          <div className="roster-line">{snapshot.message}</div>
        ) : null}
        {configured && running ? (
          <div className="roster-line">{person ? c.personDrives : c.memberDrives}</div>
        ) : null}
        {configured ? (
          <div className="member-actions">
            {inSettings ? (
              <button
                type="button"
                className="member-run quiet"
                disabled={busy}
                onClick={() => void computer.power()}
              >
                {running ? c.pause : c.start}
              </button>
            ) : null}
            <button
              type="button"
              className="member-run quiet"
              disabled={busy}
              onClick={() => (viewerOpen ? computer.closeViewer() : void computer.look())}
            >
              {busy && !viewerOpen ? c.starting : c.look}
            </button>
            {running ? (
              <button
                type="button"
                className="member-run quiet"
                disabled={busy}
                onClick={() => void computer.control(person ? "member" : "person")}
              >
                {person ? c.handBack : c.drive}
              </button>
            ) : null}
          </div>
        ) : null}
        <ErrorLine error={viewerOpen ? "" : computer.error} />
      </div>
    </section>
  );
}
