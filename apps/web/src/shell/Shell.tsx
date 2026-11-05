/**
 * Phase C (docs/web.md, the prototype): the web app's frame. Roster · main (top bar, one banner
 * slot, the page: the conversation, 凭据 or 平台管理) · member pane (only for 详情 or
 * an account picked). One panel at a time over it (PanelHost), the ⌘K palette, a toast. Under
 * 860 px the roster is a drawer and a tab bar sits below.
 */

import { useProjects } from "@m/projects-state";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useSpaceInfo } from "@m/tenancy-client";
import { Check, Ellipsis, MessageCircle, Users, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { ChatArea } from "../chat/ChatArea";
import { PanelHost } from "../panels/PanelHost";
import { BannerSlot } from "../rail/BannerSlot";
import { useTenancyUi } from "../tenancy-ui";
import { cx, Skeleton } from "../ui/primitives";
import { GroupMembers } from "./GroupMembers";
import { MemberDetail } from "./MemberDetail";
import { NewGroup } from "./NewGroup";
import { NewMember } from "./NewMember";
import { useNarrow } from "./narrow";
import { Palette } from "./Palette";
import { Roster } from "./Roster";
import { setFrame, useFrame } from "./state";
import { Topbar } from "./Topbar";
import { YukiDetail } from "./YukiDetail";

const CredentialsPage = lazy(() =>
  import("../credentials/CredentialsPage").then((m) => ({ default: m.CredentialsPage })),
);
const pageFallback = (
  <div className="page">
    <Skeleton lines={6} />
  </div>
);

export interface ShellProps {
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}

export function Shell({ toast, clearToast, error, prompt }: ShellProps) {
  const nav = useShellNav();
  const frame = useFrame();
  const { totalNeedsYou } = useShellData();
  const ui = useTenancyUi();
  const opening = ui.useStoreOpening();
  // ⌘K / Ctrl+K anywhere opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFrame({ palette: true, paletteQuery: "", paletteGroup: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 平台管理 is the platform's, not the project's: no project pane beside it (on a phone it
  // covered the page). Only the operator has it (an address with its tab opens it for no one else).
  const operator = useSpaceInfo().operator;
  const { current } = useProjects();
  const platform = operator ? frame.platform : null;
  // The member's detail, or the group's member list while a group is open. On a wide window
  // that column stays; the phone's 详情 only covers the chat, and closing it does not hide the
  // wide column.
  const narrow = useNarrow();
  const onChat = nav.view === "work";
  // The main chat is one-on-one with Yuki: it has no group list beside it, only her own card (her
  // routines, v1.4) when 详情 is pressed.
  const yukiCard = current === null && !frame.peek && frame.details;
  const paneOpen = onChat && (narrow ? frame.details && (!!frame.peek || yukiCard) : frame.pane);
  const showPane = !platform && paneOpen && (!!frame.peek || current !== null || yukiCard);
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (wasNarrow.current && !narrow && onChat) setFrame({ pane: true });
    wasNarrow.current = narrow;
  }, [narrow, onChat]);
  // The accounts page is gone; an old call that still asks for it lands on the conversation.
  const setView = nav.setView;
  useEffect(() => {
    if (nav.view === "accounts") setView("work");
  }, [nav.view, setView]);
  const page = platform ? "platform" : nav.view === "accounts" ? "work" : nav.view;
  // The chat is on screen only on its own page and, at the phone layout's width, while neither
  // the member pane nor a panel covers the whole screen over it (app.css): what it records as
  // seen is only what the person can see (ChatArea's `inView`).
  const chatInView = page === "work" && !(narrow && (showPane || !!nav.panel));
  const platformNeeds = ui.usePlatformNeeds();
  // The tab's title counts what 需要你 counts: the operator's 平台管理 items too.
  const needsYou = totalNeedsYou + platformNeeds;
  useEffect(() => {
    document.title = t.app.tabTitle(needsYou);
  }, [needsYou]);
  // Choosing one of the shell's own views (the conversation, 凭据) leaves 平台管理; only a
  // change of view does (the page loading with the tab in its address keeps it).
  const viewBefore = useRef(nav.view);
  useEffect(() => {
    if (viewBefore.current === nav.view) return;
    viewBefore.current = nav.view;
    setFrame({ platform: null });
  }, [nav.view]);
  // Something to say or type in the chat (a card's 「换个号」, 在聊天里派活…) shows the chat.
  useEffect(() => {
    if (nav.composer) setFrame({ platform: null });
  }, [nav.composer]);
  // `me` is read before the shell shows: anyone but the operator leaves an address with the tab.
  useEffect(() => {
    if (frame.platform && !operator) setFrame({ platform: null });
  }, [frame.platform, operator]);
  return (
    <div
      className={cx(
        "app",
        "simple",
        showPane ? "peek" : "no-pane",
        frame.details && "rail",
        frame.drawer && "sb-open",
      )}
    >
      <Roster />
      <div className="scrim" onClick={() => setFrame({ drawer: false })} aria-hidden="true" />
      <main className="main">
        <Topbar />
        {opening ? (
          <div className="content">
            <ui.StoreOpening />
          </div>
        ) : (
          <>
            <BannerSlot workspaceError={error} />
            {/* The conversation stays mounted while a page is open, so it keeps its state. */}
            <div className="chat-host" style={{ display: page === "work" ? "flex" : "none" }}>
              <div className="chat-col">
                <ChatArea prompt={prompt} inView={chatInView} />
              </div>
            </div>
            {page === "platform" && platform ? (
              <div className="content">
                <Suspense fallback={pageFallback}>
                  <ui.PlatformPage tab={platform} />
                </Suspense>
              </div>
            ) : null}
            {page === "credentials" ? (
              <div className="content">
                <Suspense fallback={pageFallback}>
                  <CredentialsPage />
                </Suspense>
              </div>
            ) : null}
          </>
        )}
        <TabBar page={page} />
      </main>
      <aside className="pane" aria-label={t.web.details}>
        {showPane ? (
          frame.peek ? (
            <MemberDetail
              environmentId={frame.peek}
              onClose={() => setFrame(narrow ? { details: false } : { pane: false })}
            />
          ) : current === null ? (
            <YukiDetail onClose={() => setFrame(narrow ? { details: false } : { pane: false })} />
          ) : (
            <GroupMembers onClose={() => setFrame({ pane: false })} />
          )
        ) : null}
      </aside>
      <PanelHost />
      {frame.newMember ? <NewMember /> : null}
      {frame.newGroup ? <NewGroup /> : null}
      {frame.palette ? <Palette /> : null}
      <div className={cx("toast", !!toast && "show")} role="status">
        {toast ? (
          <span className="row" style={{ gap: 8 }}>
            <Check size={14} />
            {toast}
            <button
              type="button"
              aria-label={t.common.close}
              onClick={clearToast}
              style={{ color: "inherit" }}
            >
              <X size={14} />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TabBar({ page }: { page: string }) {
  const nav = useShellNav();
  const tabs = t.web.tabs;
  return (
    <nav className="tabs" aria-label={t.web.location}>
      <button
        type="button"
        className={cx(page === "work" && "on")}
        onClick={() => {
          setFrame({ platform: null });
          nav.setView("work");
        }}
      >
        <MessageCircle size={18} />
        {tabs.chat}
      </button>
      <button type="button" onClick={() => setFrame({ drawer: true })} aria-label={t.web.openNav}>
        <Users size={18} />
        {tabs.members}
      </button>
      <button
        type="button"
        onClick={() => setFrame({ palette: true, paletteQuery: "", paletteGroup: "commands" })}
      >
        <Ellipsis size={18} />
        {tabs.more}
      </button>
    </nav>
  );
}
