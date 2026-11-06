/**
 * Phase C (prototype .topbar): the breadcrumb 空间 / 成员 and the light buttons (her computer,
 * 详情, 更多; only 更多 on 平台管理). On a phone ☰ opens the roster drawer. A page leaves
 * the same ways: the project's crumb on the project's pages (凭据), the browser's Back (平台管理).
 */

import { useProjects } from "@m/projects-state";
import { useShellData } from "@m/shell/data";
import {
  openThreadMark,
  subscribeThreadNames,
  threadNames,
  threadsArchived,
} from "@m/shell/frame/thread-rows";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useMuseThread } from "@m/threads-state";
import { Ellipsis, Menu, Monitor, PanelRight } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTenancyUi } from "../tenancy-ui";
import { cx } from "../ui/primitives";
import { openMemberComputer } from "./member-computer";
import { useNarrow } from "./narrow";
import { setFrame, useFrame } from "./state";

const w = t.web;

export function Topbar() {
  const nav = useShellNav();
  const frame = useFrame();
  const ui = useTenancyUi();
  const { project, current } = useProjects();
  const data = useShellData();
  const { accountById } = data;
  const memberName = frame.peek ? (accountById.get(frame.peek)?.name ?? "") : "";
  const narrow = useNarrow();
  const page = frame.platform
    ? w.platform.entry
    : nav.view === "credentials"
      ? t.header.credentials
      : null;
  const projectName = project?.name ?? t.projects.defaultName;
  // 凭据 is the project's: its name before the page's.
  const projectPage = !frame.platform && nav.view === "credentials";
  const toConversation = () => {
    setFrame({ platform: null });
    nav.setView("work");
  };
  // v1.5.1: in Yuki's chat, a conversation that is not the main chat says which it is, archived or
  // not, with the way back (11-06: an archived old chat looked just like the main one).
  const threads = useMuseThread();
  const names = useSyncExternalStore(subscribeThreadNames, threadNames);
  const archived = useSyncExternalStore(subscribeThreadNames, threadsArchived);
  const mark =
    !frame.platform && !frame.peek && nav.view === "work"
      ? openThreadMark({
          selectedId: threads.selection.id,
          mainId: threads.mainId,
          visited: threads.visited,
          names,
          archived,
        })
      : null;
  return (
    <div className="topbar">
      <button
        type="button"
        className="tb-btn ham"
        aria-label={w.openNav}
        onClick={() => setFrame({ drawer: true })}
      >
        <Menu size={16} />
      </button>
      <nav className="crumbs" aria-label={w.location}>
        <ui.Crumb />
        {page || memberName ? <span className="crumb-sep">/</span> : null}
        {page ? (
          <>
            {projectPage ? (
              <>
                <button type="button" className="crumb" title={w.toChat} onClick={toConversation}>
                  {projectName}
                </button>
                <span className="crumb-sep">/</span>
              </>
            ) : null}
            <span className="crumb cur">{page}</span>
          </>
        ) : memberName ? (
          <span className="crumb cur">{memberName}</span>
        ) : mark ? (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb cur">{mark.label}</span>
            {mark.archived ? <span className="crumb-tag">{t.threads.archived}</span> : null}
            <button
              type="button"
              className="crumb"
              onClick={() => threads.select({ id: threads.mainId, existing: true })}
            >
              {t.threads.backToMain}
            </button>
          </>
        ) : null}
      </nav>
      {/* 账号 and 详情 are the project's; 平台管理 has none of them. */}
      {frame.platform ? null : (
        <>
          {memberName && frame.peek && accountById.get(frame.peek)?.view.computer !== false ? (
            <button
              type="button"
              className="tb-btn"
              title={w.memberComputer(memberName)}
              aria-label={w.memberComputer(memberName)}
              onClick={() => {
                const id = frame.peek;
                if (!id) return;
                const account = accountById.get(id);
                if (!account) return;
                openMemberComputer(nav, data.recheckSignIn, account);
              }}
            >
              <Monitor size={15} />
            </button>
          ) : null}
          {frame.peek && memberName ? (
            <button
              type="button"
              className={cx("tb-btn", (narrow ? frame.details : frame.pane) && "on")}
              title={w.memberProfile(memberName)}
              aria-label={w.memberProfile(memberName)}
              aria-pressed={narrow ? frame.details : frame.pane}
              onClick={() => {
                const open = narrow ? frame.details : frame.pane;
                setFrame(open ? { pane: false } : { pane: true, details: true });
              }}
            >
              <PanelRight size={15} />
            </button>
          ) : null}
          {/* v1.4: Yuki's own card (her routines) in her chat. */}
          {!frame.peek && current === null && nav.view === "work" ? (
            <button
              type="button"
              className={cx("tb-btn", frame.details && "on")}
              title={w.yukiDetail}
              aria-label={w.yukiDetail}
              aria-pressed={frame.details}
              onClick={() =>
                setFrame(frame.details ? { pane: false } : { pane: true, details: true })
              }
            >
              <PanelRight size={15} />
            </button>
          ) : null}
        </>
      )}
      <button
        type="button"
        className="tb-btn"
        title={w.more}
        aria-label={w.more}
        onClick={() => setFrame({ palette: true, paletteQuery: "", paletteGroup: "commands" })}
      >
        <Ellipsis size={15} />
      </button>
    </div>
  );
}
