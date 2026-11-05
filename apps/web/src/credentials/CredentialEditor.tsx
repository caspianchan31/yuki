/**
 * Phase C (docs/web.md): add a credential to the current project, or replace parts of one,
 * from packages/client/src/shell/credentials/CredentialEditor.tsx. A site login: 站点, 用户名, 密码,
 * 两步验证密钥 (the key, not a code), Cookie (a pasted export), used by one account or by the
 * project's default desktop; a mailbox (SMTP, and IMAP when given). Saved values are never shown back: a saved part reads
 * 「已保存」 and its input stays empty (typing replaces it); secrets are password inputs. Saving a
 * login makes the AI sign the account in by itself (a task per site).
 */

import { credentialErrorText } from "@m/shell/accounts/hooks";
import {
  type ClearablePart,
  clearableParts,
  clearPatch,
  emptyLogin,
  emptyMailbox,
  entryWhat,
  type LoginDraft,
  loginBody,
  loginPatch,
  type MailboxDraft,
  mailboxBody,
} from "@m/shell/credentials/credentials-core";
import { credentialsChanged, useCredentials } from "@m/shell/credentials/useCredentials";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import type {
  CredentialKind,
  CredentialUsedBy,
  MailboxParts,
  SiteLoginParts,
} from "../../../../packages/domain/src/credentials";
import type { PanelProps } from "../panels/types";
import { Btn, ErrorLine, Field, IconBtn, Sheet, Skeleton } from "../ui/primitives";
import "./credentials.css";

const userKey = (user: CredentialUsedBy) =>
  user.type === "project" ? "project" : `account:${user.environmentId}`;

/** Inputs that hold a secret: never filled from the browser's saved passwords, never spell-checked. */
const secretProps = {
  type: "password",
  autoComplete: "new-password",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;
const plainProps = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

export function CredentialEditor({ panel, onClose }: PanelProps<"credentialEditor">) {
  const { entryId, preset, projectId, accountName } = panel;
  const nav = useShellNav();
  const data = useShellData();
  const { notify, workspace } = useWorkspace();
  const computer = workspace.runtime.computer !== false;
  const { api, list, loading } = useCredentials(projectId);
  const c = t.credentials;
  const e = c.editor;
  const a = t.accountEditor;
  const formId = useId();
  const cookiesId = useId();
  const entry = entryId ? (list?.entries.find((item) => item.id === entryId) ?? null) : null;
  const [kind, setKind] = useState<CredentialKind>(
    preset ? preset.kind : computer ? "site_login" : "mailbox",
  );
  const [label, setLabel] = useState("");
  const [login, setLogin] = useState<LoginDraft>({ ...emptyLogin, site: preset?.site ?? "" });
  // A mailbox's address, password and servers.
  const [mailbox, setMailbox] = useState<MailboxDraft>(emptyMailbox);
  const setBox = (field: keyof MailboxDraft) => (value: string) =>
    setMailbox((current) => ({ ...current, [field]: value }));
  const [userTouched, setUserTouched] = useState(false);
  const [users, setUsers] = useState<string[]>(() =>
    preset?.environmentId
      ? [`account:${preset.environmentId}`]
      : preset?.environmentId === null
        ? ["project"]
        : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The project's accounts to choose from: the current project's list; for another project's
  // account (from the global page), that account alone.
  const accounts = useMemo(
    () =>
      accountName && preset?.environmentId
        ? [{ id: preset.environmentId, name: accountName }]
        : [...(data.accounts.value ?? [])].sort((x, y) => x.name.localeCompare(y.name)),
    [data.accounts.value, accountName, preset?.environmentId],
  );
  const shownKind = entry?.kind ?? kind;
  // Replacing: the saved users, until the owner picks again; the user name prefilled once.
  const savedUsers = entry ? entry.usedBy.map(userKey) : [];
  const chosen = entry && !userTouched ? savedUsers : users;
  const [prefilled, setPrefilled] = useState(false);
  if (entry && !prefilled) {
    setPrefilled(true);
    setLogin((current) => ({ ...current, username: entry.username ?? "" }));
    setLabel(entry.label ?? "");
    if (entry.kind === "mailbox") {
      const box = entry.parts as MailboxParts;
      setMailbox({
        address: box.address,
        password: "",
        smtpHost: box.smtpHost,
        smtpPort: String(box.smtpPort || ""),
        imapHost: box.imapHost ?? "",
        imapPort: String(box.imapPort ?? 993),
      });
    }
  }
  const single = shownKind === "site_login";
  const toggle = (key: string) => {
    setUserTouched(true);
    const base = entry && !userTouched ? savedUsers : users;
    setUsers(
      single
        ? base.includes(key)
          ? []
          : [key]
        : base.includes(key)
          ? base.filter((k) => k !== key)
          : [...base, key],
    );
  };
  const usedBy = (keys: string[]): CredentialUsedBy[] =>
    keys.map((key) =>
      key === "project"
        ? { type: "project" }
        : { type: "account", environmentId: key.slice("account:".length) },
    );
  const back = nav.view !== "credentials" ? () => nav.setView("credentials") : undefined;
  const backBtn = back ? <IconBtn icon={ArrowLeft} label={t.common.back} onClick={back} /> : null;

  async function save() {
    if (busy) return;
    setError("");
    let body: Record<string, unknown>;
    if (entry) {
      body = {};
      if (label.trim() !== (entry.label ?? "")) body.label = label.trim() || null;
      if (entry.kind === "mailbox") {
        const made = mailboxBody(mailbox, "replace");
        if ("error" in made) {
          setError(made.error as string);
          return;
        }
        Object.assign(body, made);
      }
      if (entry.kind === "site_login") {
        const parts = entry.parts as SiteLoginParts;
        const patch = loginPatch(login, {
          username: entry.username,
          password: parts.password,
          totp: !!parts.totp,
          cookies: !!parts.cookies,
        });
        if (patch && "error" in patch) {
          setError(patch.error);
          return;
        }
        Object.assign(body, patch ?? {});
      }
      if (userTouched) body.usedBy = usedBy(chosen);
      if (!Object.keys(body).length) {
        notify(c.unchanged);
        onClose();
        return;
      }
    } else {
      body = { kind, ...(label.trim() ? { label: label.trim() } : {}), usedBy: usedBy(chosen) };
      if (kind === "mailbox") {
        const made = mailboxBody(mailbox, "create");
        if ("error" in made) {
          setError(made.error as string);
          return;
        }
        Object.assign(body, made);
        // A mailbox nobody picked serves the project (what tasks send from).
        if (!chosen.length) body.usedBy = [{ type: "project" }];
      } else {
        const made = loginBody(login);
        if ("error" in made) {
          setError(made.error);
          return;
        }
        Object.assign(body, made);
      }
    }
    setBusy(true);
    try {
      await api.request<unknown>(
        entry ? `/api/credentials/${encodeURIComponent(entry.id)}` : "/api/credentials",
        body,
        entry ? "PATCH" : "POST",
      );
      notify(entry ? c.saved : c.added_toast);
      credentialsChanged();
      void data.refreshAll();
      onClose();
    } catch (err) {
      setError(credentialErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function clearPart(part: ClearablePart) {
    if (!entry || busy) return;
    const saved = entry.kind === "site_login" ? (entry.parts as SiteLoginParts) : null;
    setBusy(true);
    setError("");
    try {
      await api.request<unknown>(
        `/api/credentials/${encodeURIComponent(entry.id)}`,
        clearPatch(part, { totp: !!saved?.totp }),
        "PATCH",
      );
      if (part === "username") setLogin((current) => ({ ...current, username: "" }));
      notify(c.cleared);
      credentialsChanged();
    } catch (err) {
      setError(credentialErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (entryId && !entry)
    return (
      <Sheet title={c.title} onClose={onClose} actions={backBtn}>
        {loading ? <Skeleton lines={3} /> : <ErrorLine error={t.accountEditor.gone} />}
      </Sheet>
    );
  const newTitles: Partial<Record<CredentialKind, string>> = {
    mailbox: e.newMailbox,
  };
  const title = entry ? e.replaceTitle(entryWhat(entry)) : (newTitles[kind] ?? e.newLogin);
  const parts = entry?.kind === "site_login" ? (entry.parts as SiteLoginParts) : null;
  const clearable = parts
    ? clearableParts({
        username: entry?.username ?? null,
        password: !!parts.password,
        totp: !!parts.totp,
        cookies: !!parts.cookies,
      })
    : [];
  const clearButton = (part: ClearablePart) =>
    clearable.includes(part) ? (
      <button
        type="button"
        className="cred-clear"
        disabled={busy}
        onClick={() => void clearPart(part)}
      >
        {part === "password" && parts?.totp ? e.clearPasswordWithTotp : e.clearPart}
      </button>
    ) : null;
  const saved = (has: boolean) =>
    entry ? (has ? `${e.savedPart} · ${e.keep}` : undefined) : undefined;
  const kindOptions: { value: CredentialKind; label: string }[] = [
    // With no computer connected a mailbox is the only credential.
    ...(computer ? [{ value: "site_login" as const, label: c.addLogin }] : []),
    { value: "mailbox", label: c.addMailbox },
  ];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      actions={backBtn}
      footer={
        <>
          <Btn disabled={busy} onClick={onClose}>
            {t.common.cancel}
          </Btn>
          <Btn variant="pri" type="submit" form={formId} busy={busy}>
            {e.save}
          </Btn>
        </>
      }
    >
      <form id={formId} className="cred-form" onSubmit={submit} autoComplete="off">
        {!entry && !preset ? (
          <fieldset className="viewbar cred-fs" aria-label={c.title}>
            {kindOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className="vtab"
                aria-pressed={kind === option.value}
                onClick={() => setKind(option.value)}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        ) : null}
        <Field
          label={e.label}
          value={label}
          onChange={(ev) => setLabel(ev.target.value)}
          disabled={busy}
        />
        {shownKind === "mailbox" ? (
          <>
            <Field
              {...plainProps}
              type="email"
              label={e.mailboxAddress}
              placeholder={e.mailboxAddressPlaceholder}
              value={mailbox.address}
              onChange={(ev) => setBox("address")(ev.target.value)}
              disabled={busy}
            />
            <Field
              {...secretProps}
              label={e.mailboxPassword}
              hint={saved(true) ?? e.mailboxPasswordHint}
              value={mailbox.password}
              onChange={(ev) => setBox("password")(ev.target.value)}
              disabled={busy}
            />
            <Field
              {...plainProps}
              label={e.smtpHost}
              placeholder={e.smtpHostPlaceholder}
              value={mailbox.smtpHost}
              onChange={(ev) => setBox("smtpHost")(ev.target.value)}
              disabled={busy}
            />
            <Field
              label={e.smtpPort}
              hint={e.smtpPortHint}
              inputMode="numeric"
              value={mailbox.smtpPort}
              onChange={(ev) => setBox("smtpPort")(ev.target.value)}
              disabled={busy}
            />
            <Field
              {...plainProps}
              label={e.imapHost}
              hint={e.imapHostHint}
              placeholder={e.imapHostPlaceholder}
              value={mailbox.imapHost}
              onChange={(ev) => setBox("imapHost")(ev.target.value)}
              disabled={busy}
            />
            {mailbox.imapHost.trim() ? (
              <Field
                label={e.imapPort}
                inputMode="numeric"
                value={mailbox.imapPort}
                onChange={(ev) => setBox("imapPort")(ev.target.value)}
                disabled={busy}
              />
            ) : null}
            <p className="hint">{e.mailboxHint}</p>
          </>
        ) : null}
        {shownKind === "site_login" ? (
          <>
            {entry ? (
              <p className="cred-site">{entry.site}</p>
            ) : (
              <Field
                {...plainProps}
                label={a.loginSite}
                placeholder={a.loginSitePlaceholder}
                value={login.site}
                onChange={(ev) => {
                  const site = ev.target.value;
                  setLogin((current) => ({ ...current, site }));
                }}
                disabled={busy}
              />
            )}
            <Field
              {...plainProps}
              label={a.loginUsername}
              autoComplete="off"
              value={login.username}
              onChange={(ev) => {
                const username = ev.target.value;
                setLogin((current) => ({ ...current, username }));
              }}
              disabled={busy}
            />
            {clearButton("username")}
            <Field
              {...secretProps}
              label={a.loginPasswordInput}
              hint={saved(!!parts?.password)}
              value={login.password}
              onChange={(ev) => {
                const password = ev.target.value;
                setLogin((current) => ({ ...current, password }));
              }}
              disabled={busy}
            />
            {clearButton("password")}
            <Field
              {...secretProps}
              label={a.loginTotpInput}
              hint={saved(!!parts?.totp) ?? a.loginTotpHint}
              value={login.totpSeed}
              onChange={(ev) => {
                const totpSeed = ev.target.value;
                setLogin((current) => ({ ...current, totpSeed }));
              }}
              disabled={busy}
            />
            {clearButton("totpSeed")}
            <label className="field" htmlFor={cookiesId}>
              <span>{a.loginCookiesInput}</span>
              <textarea
                id={cookiesId}
                className="input"
                {...plainProps}
                autoComplete="off"
                value={login.cookies}
                onChange={(ev) => {
                  const cookies = ev.target.value;
                  setLogin((current) => ({ ...current, cookies }));
                }}
                disabled={busy}
              />
              {saved(!!parts?.cookies) ? (
                <small className="hint">{saved(!!parts?.cookies)}</small>
              ) : null}
            </label>
            {clearButton("cookies")}
          </>
        ) : null}
        <fieldset className="cred-users cred-fs">
          <legend>{e.usedBy}</legend>
          <div className="chips">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className="chip"
                aria-pressed={chosen.includes(`account:${account.id}`)}
                onClick={() => toggle(`account:${account.id}`)}
              >
                <span className="t">{account.name}</span>
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={chosen.includes("project")}
              onClick={() => toggle("project")}
            >
              <span className="t">{e.usedByProject}</span>
            </button>
          </div>
          {!chosen.length ? <p className="hint">{e.usedByNone}</p> : null}
        </fieldset>
        {shownKind === "site_login" ? <p className="hint">{a.loginsHint}</p> : null}
        <ErrorLine error={error} />
      </form>
    </Sheet>
  );
}
