/**
 * Phase C: the sign-in gate of the web app. The state machine is the phone's (useAuthGate,
 * auth-state.tsx); this draws its screens: setup (no account yet), sign-in, unreachable server.
 */

import { API_URL, authClient } from "@m/api";
import { wrongPageAddress } from "@m/auth-errors";
import { AuthContext, type AuthSubmit, useAuthGate } from "@m/auth-state";
import { passwordMin, type StoredSession, validPassword, validUsername } from "@m/session-core";
import { t } from "@m/shell/strings";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTenancyUi } from "../tenancy-ui";
import { Btn, ErrorLine, Field, Spinner } from "../ui/primitives";
import { Brand, Centered } from "./Centered";

const a = t.auth;

export function AuthGate({
  username,
  children,
}: {
  /** The sign-in form's username to start with (a reset link just used). */
  username?: string;
  children: (session: StoredSession) => ReactNode;
}) {
  const gate = useAuthGate();
  if (gate.session && gate.value)
    return <AuthContext.Provider value={gate.value}>{children(gate.session)}</AuthContext.Provider>;
  return (
    <Centered>
      <Brand />
      <h1>{a.welcome}</h1>
      <p className="lead">{a.tagline}</p>
      {gate.busy && !gate.status ? (
        <Spinner />
      ) : gate.status?.setupRequired ? (
        <SetupForm busy={gate.busy} error={gate.error} onSubmit={gate.submit} />
      ) : gate.status ? (
        <SignInForm gate={gate} initialUsername={username ?? ""} />
      ) : (
        <Unreachable gate={gate} />
      )}
    </Centered>
  );
}

/** The server did not answer. A built page opened at another address than the one its API is built
 * for (localhost for 127.0.0.1, a LAN address) cannot reach it from there: it says where to open
 * Yuki, and goes there on a click (v1.5.1). In development the page and the API differ by design. */
function Unreachable({ gate }: { gate: ReturnType<typeof useAuthGate> }) {
  const there = import.meta.env.PROD ? wrongPageAddress(window.location.origin, API_URL) : null;
  if (there)
    return (
      <>
        <ErrorLine error={a.wrongAddress(there)} />
        <Btn variant="pri" onClick={() => window.location.assign(there)}>
          {a.openAt(there)}
        </Btn>
      </>
    );
  return (
    <>
      <ErrorLine error={gate.error || a.unreachable} />
      <Btn variant="pri" onClick={() => void gate.load()}>
        {a.tryAgain}
      </Btn>
      <p className="hint">{a.serverHint(API_URL)}</p>
    </>
  );
}

function SignInForm({
  gate,
  initialUsername,
}: {
  gate: ReturnType<typeof useAuthGate>;
  initialUsername: string;
}) {
  const ui = useTenancyUi();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  function go(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return setFormError(a.missing);
    setFormError("");
    void gate
      .submit(() => authClient.signIn({ username: username.trim(), password }))
      .then((ok) => {
        // A rejected password is not kept around for a second try.
        if (!ok) setPassword("");
      });
  }
  return (
    <form onSubmit={go} style={{ display: "contents" }}>
      <ErrorLine error={formError || gate.error} />
      <Field
        label={a.username}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="username"
      />
      <Field
        label={a.password}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      <Btn type="submit" variant="pri" busy={gate.busy} className="block">
        {a.signIn}
      </Btn>
      {gate.registration ? <ui.RegistrationCard view={gate.registration} /> : null}
    </form>
  );
}

function SetupForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  onSubmit: AuthSubmit;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState("");
  function go(e: FormEvent) {
    e.preventDefault();
    const name = validUsername(username);
    if (typeof name !== "string") return setFormError(a.usernameInvalid);
    const secret = validPassword(password);
    if (typeof secret !== "string") return setFormError(a.passwordTooShort(passwordMin));
    if (confirm !== password) return setFormError(a.passwordsDiffer);
    if (!code.trim()) return setFormError(a.codeMissing);
    setFormError("");
    void onSubmit(() => authClient.setup({ username: name, password: secret, code: code.trim() }));
  }
  return (
    <form onSubmit={go} style={{ display: "contents" }}>
      <strong>{a.setupTitle}</strong>
      <p className="hint">{a.setupHint}</p>
      <ErrorLine error={formError || error} />
      <Field
        label={a.username}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        placeholder={a.usernamePlaceholder}
      />
      <Field
        label={a.password}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        placeholder={a.passwordPlaceholder(passwordMin)}
      />
      <Field
        label={a.repeatPassword}
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
      />
      <Field
        label={a.setupCode}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={a.setupCodePlaceholder}
      />
      <Btn type="submit" variant="pri" busy={busy} className="block">
        {a.createAccount}
      </Btn>
    </form>
  );
}
