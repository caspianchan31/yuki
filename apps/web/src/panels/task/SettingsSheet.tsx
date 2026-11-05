/**
 * 设置 in panes (docs/v1.5.md R9): 通用 (账号 <name> [改密码] [退出], 外观, 时区, 动作审查 and its
 * two lists, 后台 heartbeat, 版本, 高级), 电脑 (the open build with a computer container only),
 * 应用 (谷歌 and the connected apps) and 技能. The password form is the change-password flow of
 * settings-core, only in a live workspace.
 */

import { useAuth } from "@m/auth-state";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { serverText, t } from "@m/shell/strings";
import { checkPassword, passwordErrorText, workerLine } from "@m/shell/task/settings-core";
import { versionLabel } from "@m/shell/version";
import { useWorkspace } from "@m/workspace";
import { useEffect, useRef, useState } from "react";
import type { ComputerSnapshot } from "../../../../../packages/domain/src/computer";
import { ContainerComputer } from "../../shell/ContainerComputer";
import { useTenancyUi } from "../../tenancy-ui";
import { Btn, cx, ErrorLine, Field, Sheet } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { AppsSection } from "./AppsSection";
import { AppearanceSection, TimeZoneSection } from "./GeneralSettings";
import { errorText, Fold, KV } from "./parts";
import { ReviewSettingsSection } from "./ReviewSettings";
import { SkillsSection } from "./SkillsSection";

type Pane = "general" | "computer" | "apps" | "skills";

export function SettingsPanel({ onClose }: PanelProps<"settings">) {
  const nav = useShellNav();
  const { workspace, notify, api, refresh: refreshWorkspace } = useWorkspace();
  const { session, signOut, changePassword } = useAuth();
  const { worker, refreshAll } = useShellData();
  const ui = useTenancyUi();
  const live = workspace.mode === "live";
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 电脑 appears only for the open build with a computer container.
  const [hasComputer, setHasComputer] = useState(false);
  useEffect(() => {
    let gone = false;
    api
      .request<ComputerSnapshot>("/api/computer")
      .then((snapshot) => !gone && setHasComputer(snapshot.provider === "desktop"))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [api]);
  const panes: Pane[] = ["general", ...(hasComputer ? ["computer" as const] : [])];
  if (live) panes.push("apps", "skills");
  const [chosen, setChosen] = useState<Pane>("general");
  const pane = panes.includes(chosen) ? chosen : "general";

  // 改密码
  const [form, setForm] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const closeForm = () => {
    setForm(false);
    setPasswordError("");
    setCurrent("");
    setNext("");
    setRepeat("");
  };
  async function savePassword() {
    const check = checkPassword({ current, next, repeat });
    if (!check.ok) return setPasswordError(check.error);
    setPasswordBusy(true);
    setPasswordError("");
    try {
      await changePassword(check.current, check.next);
      if (!mounted.current) return;
      closeForm();
      setPasswordDone(true);
    } catch (e) {
      if (mounted.current) setPasswordError(passwordErrorText(e));
    } finally {
      if (mounted.current) setPasswordBusy(false);
    }
  }

  // Google (Gmail and Calendar), shared by every project.
  const google = workspace.connections.find((c) => c.id === "google");
  const googleOn = google?.status === "connected";
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  async function connectGoogle() {
    setGoogleBusy(true);
    setGoogleError("");
    // Opened before the request answers, so the browser does not block it as a popup.
    const tab = window.open("", "_blank");
    try {
      const result = await api.request<{ url: string | null }>("/api/google/connect", {
        capability: "write",
      });
      if (result.url) {
        if (tab) tab.location.href = result.url;
        else window.location.href = result.url;
        notify(t.settings.googleOpened);
      } else {
        tab?.close();
        await refreshWorkspace();
      }
    } catch (e) {
      tab?.close();
      if (mounted.current) setGoogleError(t.settings.googleFailed(serverText(errorText(e))));
    } finally {
      if (mounted.current) setGoogleBusy(false);
    }
  }
  async function disconnectGoogle() {
    setGoogleBusy(true);
    setGoogleError("");
    try {
      await api.request("/api/google/disconnect", {});
      await refreshWorkspace();
      notify(t.settings.googleDisconnected);
    } catch (e) {
      if (mounted.current) setGoogleError(t.settings.googleFailed(serverText(errorText(e))));
    } finally {
      if (mounted.current) setGoogleBusy(false);
    }
  }

  // 后台
  const heartbeat = workerLine(worker);
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    try {
      await refreshAll();
      notify(t.common.refreshed);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  return (
    <Sheet title={t.settings.title} onClose={onClose} wide>
      <div className="st">
        <nav className="st-nav" aria-label={t.settings.paneNav}>
          {panes.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`settings-pane-${id}`}
              aria-current={id === pane ? "page" : undefined}
              onClick={() => setChosen(id)}
            >
              {t.settings.panes[id]}
            </button>
          ))}
        </nav>
        <div className="st-pane">
          {pane === "general" ? (
            <div className="tp">
              <div>
                <KV
                  k={t.settings.admin}
                  right={
                    <>
                      {live && !form ? (
                        <Btn
                          className="sm"
                          onClick={() => {
                            setForm(true);
                            setPasswordDone(false);
                            setPasswordError("");
                          }}
                        >
                          {t.settings.changePassword}
                        </Btn>
                      ) : null}
                      <Btn className="sm ghost" onClick={() => void signOut()}>
                        {t.settings.signOut}
                      </Btn>
                    </>
                  }
                >
                  {session.username || t.settings.adminFallback}
                </KV>
                {passwordDone && !form ? (
                  <p className="tp-small">{t.settings.passwordChanged}</p>
                ) : null}
                {form ? (
                  <form
                    className="tp-box"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void savePassword();
                    }}
                  >
                    <Field
                      label={t.settings.currentPassword}
                      type="password"
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      autoComplete="current-password"
                      autoCapitalize="none"
                    />
                    <Field
                      label={t.settings.newPassword}
                      hint={t.settings.newPasswordHint}
                      type="password"
                      value={next}
                      onChange={(e) => setNext(e.target.value)}
                      autoComplete="new-password"
                      autoCapitalize="none"
                    />
                    <Field
                      label={t.settings.repeatPassword}
                      type="password"
                      value={repeat}
                      onChange={(e) => setRepeat(e.target.value)}
                      autoComplete="new-password"
                      autoCapitalize="none"
                    />
                    <ErrorLine error={passwordError} />
                    <div className="row">
                      <Btn type="submit" variant="pri" className="sm" busy={passwordBusy}>
                        {t.settings.savePassword}
                      </Btn>
                      <Btn className="sm ghost" disabled={passwordBusy} onClick={closeForm}>
                        {t.common.cancel}
                      </Btn>
                    </div>
                  </form>
                ) : null}

                <ui.SettingsSpace live={live} />

                <AppearanceSection />
                {live ? <TimeZoneSection /> : null}
                {live ? <ReviewSettingsSection /> : null}
                <KV
                  k={t.settings.worker}
                  right={
                    <Btn className="sm" busy={refreshing} onClick={() => void refresh()}>
                      {t.common.refresh}
                    </Btn>
                  }
                >
                  <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <span
                      className={cx(
                        "tp-light",
                        heartbeat.state === "ok" ? "" : heartbeat.state === "down" ? "red" : "grey",
                      )}
                      style={heartbeat.state === "ok" ? { background: "var(--accent)" } : undefined}
                    />
                    <span
                      className={cx("tp-mono", heartbeat.state === "down" && "tp-red")}
                      style={{ fontFamily: "inherit", minWidth: 0 }}
                    >
                      {heartbeat.text}
                    </span>
                  </span>
                </KV>
                <KV k={t.settings.version}>
                  <span className="tp-small">{versionLabel()}</span>
                </KV>
              </div>

              <Fold label={t.settings.advanced}>
                <p className="tp-strong">{t.settings.defaultDesktop}</p>
                <p className="muted">{t.settings.defaultDesktopHint}</p>
                <Btn
                  className="sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => nav.openPanel({ kind: "legacy", detail: { type: "computer" } })}
                >
                  {t.settings.openDefaultDesktop}
                </Btn>
              </Fold>
            </div>
          ) : null}
          {pane === "computer" ? (
            <div className="tp">
              <ContainerComputer inSettings />
            </div>
          ) : null}
          {pane === "apps" ? (
            <div className="tp">
              {live ? (
                <KV
                  k={t.settings.google}
                  right={
                    <>
                      <Btn className="sm" busy={googleBusy} onClick={() => void connectGoogle()}>
                        {googleOn ? t.settings.googleReconnect : t.settings.googleConnect}
                      </Btn>
                      {googleOn ? (
                        <Btn
                          className="sm ghost"
                          disabled={googleBusy}
                          onClick={() => void disconnectGoogle()}
                        >
                          {t.settings.googleDisconnect}
                        </Btn>
                      ) : null}
                    </>
                  }
                >
                  {googleOn && google?.account
                    ? t.settings.googleConnected(google.account)
                    : t.settings.googleNone}
                </KV>
              ) : null}
              <ErrorLine error={googleError} />

              <AppsSection notify={notify} />
            </div>
          ) : null}
          {pane === "skills" ? (
            <div className="tp">
              <SkillsSection />
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
