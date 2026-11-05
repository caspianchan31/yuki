/**
 * Phase C (docs/web.md): the desktop sheet (an account's desktop, or the project's default
 * desktop under 设置 → 高级), from computer.tsx ComputerSheet: what the desktop was opened for
 * (a step only the owner can do, a code to type), the tabs (an account: 桌面 · 终端; the default desktop also
 * 浏览器 and 文件), the Linux workspace, browser sessions and the saved documents.
 */
import { browserAddress } from "@m/browser-address";
import { appVisible } from "@m/computer-workspace-state";
import { incidentShotPath } from "@m/incidents-core";
import { computerTabs } from "@m/shell/accounts/accounts-core";
import { type DesktopNeed, desktopNeedTitle, desktopStep } from "@m/shell/chat/guide-core";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { type BrowserSession, type ComputerSnapshot, isDesktopProvider } from "@openmuse/domain";
import { FileText, FolderOpen, Globe2, Monitor, Plus, RefreshCw, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, cx, ErrorLine, Field, Sheet } from "../ui/primitives";
import { Callout, LinkRow, Subtitle } from "./bits";
import { LinuxWorkspace } from "./desktop";
import { IncidentShot } from "./IncidentShot";
import { useComputerDraft, useDesktopScope } from "./scope";

const tabIcons = { Browser: Globe2, Desktop: Monitor, Terminal, Files: FolderOpen } as const;

/** What the desktop was opened for, above it until the sheet
 * closes: the one line to do there and the AI's picture of that moment. */
function DesktopNeedBlock({ need }: { need: DesktopNeed }) {
  const step = desktopStep(need.status);
  return (
    <Callout tone="amber" title={desktopNeedTitle(need)}>
      {step ? <p style={{ margin: 0 }}>{step}</p> : null}
      {need.shot ? <IncidentShot path={incidentShotPath(need.shot)} site={need.site} /> : null}
    </Callout>
  );
}

/** A browser session of the default desktop: its preview and the way back into it. */
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { open } = useWorkspace();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  return (
    <div className="lg-box">
      <div className="lg-status">
        <Globe2 size={18} className="lg-ico" />
        <div className="grow">
          <div className="lg-strong">{t.computer.browser}</div>
          <div className="hint lg-ellipsis">
            {browser.status === "closed"
              ? t.computer.sessionSaved
              : browser.status === "error"
                ? t.computer.sessionAttention
                : browser.title}
          </div>
        </div>
      </div>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <img
          className="lg-preview"
          alt={t.computer.preview(browser.title)}
          src={browser.previewUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="lg-preview empty">
          <Globe2 size={24} />
          <span className="lg-ellipsis">
            {failed ? t.computer.previewUnavailable : browser.url}
          </span>
        </div>
      )}
      <div className="row">
        <Btn onClick={() => open({ type: "browser", browser })}>
          {browser.status === "closed"
            ? t.computer.reopenBrowser
            : browser.status === "error"
              ? t.computer.reconnectBrowser
              : t.computer.takeControl}
        </Btn>
      </div>
    </div>
  );
}

export function ComputerSheet({
  focusDesktop = false,
  need,
  onClose,
}: {
  focusDesktop?: boolean;
  /** The step the desktop was opened for, kept above it until it closes. */
  need?: DesktopNeed;
  onClose: () => void;
}) {
  const { workspace, api, refresh, open, navigate } = useWorkspace();
  // An environment's sheet is named after it.
  const { environment } = useDesktopScope();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useComputerDraft("tab");
  // Fork: opened to finish a step on the desktop (the owner's step, a code to type): the Desktop tab,
  // whatever tab was used last. While the desktop is off this shows Terminal with 启动桌面.
  const focused = useRef(false);
  useEffect(() => {
    if (focusDesktop && !focused.current) {
      focused.current = true;
      setTab("Desktop");
    }
  }, [focusDesktop, setTab]);
  // Unknown until the first snapshot, so a remembered Desktop tab survives reopening.
  const [desktop, setDesktop] = useState<boolean>();
  const onSnapshot = useCallback((snapshot: ComputerSnapshot) => {
    // A transient provider error keeps the last known state instead of closing the tab.
    if (snapshot.status !== "error")
      setDesktop(isDesktopProvider(snapshot.provider) && snapshot.status === "running");
  }, []);
  // An account's desktop shows only Desktop and Terminal; the
  // default desktop keeps all four. A remembered Desktop tab falls back to Terminal while off.
  const { shown, tabs } = computerTabs(!!environment, desktop, tab);
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (!appVisible()) return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
      });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      wide
      title={environment ? t.computer.accountTitle(environment.name) : t.settings.defaultDesktop}
      onClose={onClose}
    >
      <Subtitle>
        {environment
          ? t.computer.accountSubtitle(environment.accountLabel ?? null)
          : t.settings.defaultDesktopHint}
      </Subtitle>
      <div className="lg-stack wide">
        {need ? <DesktopNeedBlock need={need} /> : null}
        {shown === "Browser" ? (
          <Callout
            tone="grey"
            title={available ? t.computer.browserConnected : t.computer.browserOffline}
          >
            <span className="muted">
              {available ? t.computer.browserConnectedHint : t.computer.browserOfflineHint}
            </span>
          </Callout>
        ) : null}
        <div className="viewbar lg-tabs" role="tablist">
          {tabs.map((item) => {
            const Icon = tabIcons[item];
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={shown === item}
                className={cx("vtab", shown === item && "on")}
                onClick={() => setTab(item)}
              >
                <Icon size={14} />
                {t.computer.tabs[item]}
              </button>
            );
          })}
        </div>
        <div style={{ display: shown === "Browser" ? "none" : undefined }}>
          <LinuxWorkspace tab={shown === "Browser" ? "Terminal" : shown} onSnapshot={onSnapshot} />
        </div>
        <ErrorLine error={error} />
        {shown === "Browser" ? (
          <>
            <form
              className="lg-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <Field
                label={t.computer.address}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <Btn
                type="submit"
                variant="pri"
                icon={Plus}
                busy={busy}
                disabled={!available || !url.trim()}
              >
                {t.computer.openBrowser}
              </Btn>
            </form>
            {[...workspace.browsers]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((browser) => (
                <BrowserThreadCard key={browser.id} browser={browser} />
              ))}
            {!workspace.browsers.length ? <p className="muted">{t.computer.noBrowsers}</p> : null}
            <p className="hint">{t.computer.browsersHint}</p>
          </>
        ) : shown === "Files" ? (
          <>
            <div>
              <div className="lg-strong">{t.computer.documents}</div>
              <p className="hint">{t.computer.documentsHint}</p>
            </div>
            <div>
              {workspace.files.map((file) => (
                <LinkRow
                  key={file.id}
                  icon={FileText}
                  title={file.name}
                  detail={t.computer.pdfPages(file.pageCount)}
                  onClick={() => open({ type: "file", file })}
                />
              ))}
            </div>
            <div className="row">
              <Btn
                icon={Plus}
                onClick={() => {
                  onClose();
                  navigate("files");
                }}
              >
                {t.computer.importDocument}
              </Btn>
            </div>
          </>
        ) : null}
        <div className="row">
          <Btn
            icon={RefreshCw}
            onClick={() =>
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(String(e)))
            }
          >
            {t.computer.refreshComputer}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}
