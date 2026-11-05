/**
 * v1.4 (docs/apps.md): 设置 › 连接的应用: the directory with each app's state, 连接 / 断开, and a
 * form that adds a custom MCP server (name, address, optional token). Apps belong to the space.
 */

import { appRows } from "@m/shell/apps";
import { serverText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useState } from "react";
import { appLimits } from "../../../../../packages/domain/src/apps";
import { useApps } from "../../shell/useApps";
import { Btn, ErrorLine, Field } from "../../ui/primitives";
import { errorText, Flag, KV } from "./parts";

export function AppsSection({ notify }: { notify: (text: string) => void }) {
  const { api } = useWorkspace();
  const { apps, reload } = useApps();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "", token: "" });
  const s = t.settings.apps;

  async function run(id: string, name: string, work: () => Promise<{ url?: string } | undefined>) {
    setBusy(id);
    setError("");
    // Opened before the request answers, so the browser does not block it as a popup.
    const tab = window.open("", "_blank");
    try {
      const result = await work();
      if (result?.url) {
        if (tab) tab.location.href = result.url;
        else window.location.href = result.url;
        notify(s.opened);
      } else {
        tab?.close();
        notify(s.connected(name));
      }
      setAsking(null);
      setToken("");
      await reload();
    } catch (e) {
      tab?.close();
      setError(s.failed(serverText(errorText(e))));
      // A server that wants a token: the field opens under its row.
      if (!id.startsWith("custom")) setAsking(id);
    } finally {
      setBusy("");
    }
  }
  const connect = (id: string, name: string) =>
    run(id, name, () =>
      api.request<{ url?: string }>(`/api/apps/${encodeURIComponent(id)}/connect`, {
        ...(token ? { token } : {}),
      }),
    );
  async function disconnect(id: string, name: string) {
    if (!window.confirm(s.confirmDisconnect(name))) return;
    setBusy(id);
    setError("");
    try {
      await api.request(`/api/apps/${encodeURIComponent(id)}/disconnect`, {});
      notify(s.disconnected(name));
      await reload();
    } catch (e) {
      setError(s.failed(serverText(errorText(e))));
    } finally {
      setBusy("");
    }
  }
  const add = () =>
    run("custom", form.name, async () => {
      const result = await api.request<{ url?: string }>("/api/apps/mcp", {
        name: form.name,
        url: form.url,
        ...(form.token ? { token: form.token } : {}),
      });
      if (!result.url) setForm({ name: "", url: "", token: "" });
      return result;
    });

  return (
    <div>
      <KV k={s.title}>
        <span className="tp-small">{s.hint}</span>
      </KV>
      {appRows(apps).map((row) => (
        <div key={row.id}>
          <KV
            k={row.name}
            right={
              <>
                {row.connect ? (
                  <Btn
                    className="sm"
                    busy={busy === row.id}
                    onClick={() => void connect(row.id, row.name)}
                  >
                    {row.connect}
                  </Btn>
                ) : null}
                {row.disconnect ? (
                  <Btn
                    className="sm ghost"
                    disabled={busy === row.id}
                    onClick={() => void disconnect(row.id, row.name)}
                  >
                    {row.disconnect}
                  </Btn>
                ) : null}
              </>
            }
          >
            {row.tag ? <Flag text={row.tag} tone="grey" /> : null}
            <Flag text={row.stateLabel} tone={row.state === "connected" ? "grey" : "amber"} />
            <span className="tp-small">{row.line}</span>
          </KV>
          {asking === row.id ? (
            <form
              className="tp-box"
              onSubmit={(e) => {
                e.preventDefault();
                void connect(row.id, row.name);
              }}
            >
              <Field
                label={s.tokenField}
                hint={s.tokenHint}
                type="password"
                autoComplete="off"
                value={token}
                maxLength={appLimits.token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="row">
                <Btn type="submit" variant="pri" className="sm" busy={busy === row.id}>
                  {s.connect}
                </Btn>
                <Btn className="sm ghost" onClick={() => setAsking(null)}>
                  {t.common.cancel}
                </Btn>
              </div>
            </form>
          ) : null}
        </div>
      ))}
      <form
        className="tp-box"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="tp-box-title">{s.addTitle}</div>
        <Field
          label={s.name}
          value={form.name}
          maxLength={appLimits.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label={s.url}
          placeholder={s.urlHint}
          value={form.url}
          maxLength={appLimits.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
        <Field
          label={s.tokenField}
          hint={s.tokenHint}
          type="password"
          autoComplete="off"
          value={form.token}
          maxLength={appLimits.token}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
        />
        <ErrorLine error={error} />
        <div className="row">
          <Btn
            type="submit"
            variant="pri"
            className="sm"
            busy={busy === "custom"}
            disabled={!form.name.trim() || !form.url.trim()}
          >
            {busy === "custom" ? s.adding : s.add}
          </Btn>
        </div>
      </form>
    </div>
  );
}
