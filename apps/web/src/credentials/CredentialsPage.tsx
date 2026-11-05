/**
 * Phase C (docs/web.md): the 凭据 page, from packages/client/src/shell/credentials/CredentialsPage.tsx.
 * The one place the owner manages every credential of the current project: 发信邮箱, 代理,
 * each account's site logins and 本项目用. Values are never shown back. Read when
 * opened and after each change; never polled.
 *
 * Quiet-core manner: a card only for what the owner has to judge (待补, a credential whose last
 * use failed or that cannot be read), then quiet groups (empty ones left out), a row opening to
 * its times and actions. Platform-set-up spaces (邀请码注册 P0 ①): no proxy, no
 * section and no 添加 for them (memberCredentials, credentialSections, quietGroups).
 */

import { noContent } from "@m/projects-core";
import { credentialErrorText } from "@m/shell/accounts/hooks";
import {
  entryWhat,
  loginParts,
  memberCredentials,
  requestLine,
  requestPreset,
  timesLine,
  withoutComputer,
} from "@m/shell/credentials/credentials-core";
import {
  judgedEntries,
  judgmentLine,
  quietGroups,
  quietLine,
} from "@m/shell/credentials/quiet-core";
import { credentialsChanged, useCredentials } from "@m/shell/credentials/useCredentials";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { usePlatformEnv } from "@m/tenancy-client";
import { useWorkspace } from "@m/workspace";
import { Plus } from "lucide-react";
import { useState } from "react";
import type {
  CredentialRequestView,
  CredentialView,
} from "../../../../packages/domain/src/credentials";
import { Avatar, Btn, cx, ErrorLine, Skeleton } from "../ui/primitives";
import "./credentials.css";

type Api = ReturnType<typeof useCredentials>["api"];
type AddKind = "site_login" | "proxy" | "mailbox";

export function CredentialsPage() {
  const nav = useShellNav();
  const data = useShellData();
  const c = t.credentials;
  const { api, list: read, loading, error } = useCredentials();
  const [adding, setAdding] = useState(false);
  // The platform sets up this space's proxies; members
  // see neither (no section, no 添加) and manage site logins and mailboxes as before.
  const platformEnv = usePlatformEnv();
  // With no computer connected only mailboxes are shown and added.
  const computer = useWorkspace().workspace.runtime.computer !== false;
  const shown = read ? memberCredentials(read, platformEnv) : null;
  const list = shown && !computer ? withoutComputer(shown) : shown;
  const add = (kind: AddKind) => {
    setAdding(false);
    nav.openPanel({ kind: "credentialEditor", preset: { kind } });
  };
  const kinds: { kind: AddKind; label: string }[] = [
    { kind: "mailbox", label: c.addMailbox },
    ...(computer ? [{ kind: "site_login" as const, label: c.addLogin }] : []),
    ...(platformEnv || !computer ? [] : [{ kind: "proxy" as const, label: c.addProxy }]),
  ];
  const openRequest = (request: CredentialRequestView) =>
    nav.openPanel({ kind: "credentialEditor", preset: requestPreset(request) });
  const judged = list ? judgedEntries(list) : [];
  const requests = list?.requests ?? [];
  const empty = !!list && !list.entries.length && !list.requests.length;
  return (
    <div className="page">
      <h1>{c.title}</h1>
      <p className="sub">{c.introShort}</p>
      <div className="cred-tools">
        <Btn variant="pri" icon={Plus} aria-expanded={adding} onClick={() => setAdding(!adding)}>
          {c.add}
        </Btn>
        {adding
          ? kinds.map((item) => (
              <Btn key={item.kind} onClick={() => add(item.kind)}>
                {item.label}
              </Btn>
            ))
          : null}
      </div>
      {platformEnv ? <p className="cred-note">{c.platformProxy}</p> : null}
      <ErrorLine error={error} />
      {loading && !list ? <Skeleton lines={5} /> : null}

      {requests.length || judged.length ? (
        <section className="cred-judge inbox" aria-label={c.groups.pending}>
          {requests.map((request) => (
            <div key={request.id} className="it a">
              <span className="ic a" aria-hidden="true">
                !
              </span>
              <span className="t">{requestLine(request)}</span>
              <span className="b">
                <Btn variant="pri" onClick={() => openRequest(request)}>
                  {c.addForRequest}
                </Btn>
              </span>
            </div>
          ))}
          {judged.map((entry) => (
            <div key={entry.id} className="it r">
              <span className="ic r" aria-hidden="true">
                !
              </span>
              <span className="t">{judgmentLine(entry)}</span>
              <span className="b">
                <Btn
                  variant="pri"
                  onClick={() => nav.openPanel({ kind: "credentialEditor", entryId: entry.id })}
                >
                  {c.replace}
                </Btn>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {list ? (
        <>
          {empty ? <p className="muted">{c.none}</p> : null}
          {quietGroups(list, platformEnv).map((group) => (
            <section key={group.key} className="cred-grp">
              <h3>
                {group.account ? <Avatar initial={group.account.initial} state="idle" /> : null}
                <span>{group.title}</span>
              </h3>
              {group.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} api={api} />
              ))}
            </section>
          ))}
          {list.entries.length ? (
            <button
              type="button"
              className="cred-history"
              onClick={() => nav.openPanel({ kind: "credentialHistory" })}
            >
              {c.allHistory}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** One credential: what it is and one line under it; opening it shows its times and
 * 更换 · 记录 · 清除. */
function EntryRow({ entry, api }: { entry: CredentialView; api: Api }) {
  const nav = useShellNav();
  const data = useShellData();
  const { notify } = useWorkspace();
  const c = t.credentials;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parts = loginParts(entry);
  const what = entry.label ? `${entry.label} · ${entryWhat(entry)}` : entryWhat(entry);
  async function clear() {
    setBusy(true);
    setError("");
    try {
      await noContent(
        api.request<unknown>(
          `/api/credentials/${encodeURIComponent(entry.id)}`,
          undefined,
          "DELETE",
        ),
      );
      notify(c.cleared);
      credentialsChanged();
      void data.refreshAll();
    } catch (err) {
      setError(credentialErrorText(err));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }
  const replace = () => nav.openPanel({ kind: "credentialEditor", entryId: entry.id });
  const history = () => nav.openPanel({ kind: "credentialHistory", entryId: entry.id });
  const confirmBox = confirm ? (
    <div className="cred-confirm" role="alert">
      <p>{c.clearConfirm}</p>
      <Btn variant="danger" busy={busy} onClick={() => void clear()}>
        {c.clear}
      </Btn>
      <Btn disabled={busy} onClick={() => setConfirm(false)}>
        {t.common.cancel}
      </Btn>
    </div>
  ) : null;
  const errorLine = error ? (
    <div className="more">
      <ErrorLine error={error} />
    </div>
  ) : null;
  const quiet = quietLine(entry);
  return (
    <div className={cx("cred-row", open && "open")}>
      <button
        type="button"
        className="main"
        aria-expanded={open}
        aria-label={`${what}${t.common.sep}${quiet}`}
        onClick={() => setOpen(!open)}
      >
        <span className="t">{what}</span>
        <span className="d">{parts ? `${parts}${t.common.sep}${quiet}` : quiet}</span>
      </button>
      <span />
      {open ? (
        <div className="more">
          <div className="hint">{timesLine(entry, data.now)}</div>
          <div className="cred-links">
            <button type="button" onClick={replace}>
              {c.replace}
            </button>
            <button type="button" onClick={history}>
              {c.history}
            </button>
            {!confirm ? (
              <button type="button" className="danger" onClick={() => setConfirm(true)}>
                {c.clear}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {open ? confirmBox : null}
      {open ? errorLine : null}
    </div>
  );
}
