/**
 * Fork: username + password sign-in. The welcome screen asks the server whether an account
 * exists: the sample workspace opens by itself, a live workspace without an account shows the
 * one-time setup form (username, password, the code from the server log), otherwise the sign-in
 * form. The session is kept in localStorage on web so a reload keeps the user signed in; a 401 on
 * any call ends it. The menu's Account section signs out and changes the password.
 */
import { KeyRound, LogOut } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { API_URL, authClient } from "./api";
import { AuthContext, type AuthSubmit, useAuth, useAuthGate } from "./auth-state";
import { passwordMin, type StoredSession, validPassword, validUsername } from "./session-core";
import { t } from "./shell/strings";
import { Button, Card, colors, ErrorNotice, Field, Mascot, s } from "./ui";

export type { AuthGateState, AuthSubmit, AuthValue } from "./auth-state";
export { AuthContext, platformStorage, useAuth, useAuthGate } from "./auth-state";

// The sign-in and setup screens speak Chinese (shell/strings.ts).
const a = t.auth;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Holds the session; renders the welcome screen until there is one. */
export function AuthGate({
  username,
  children,
}: {
  /** The sign-in form's username to start with (a reset link just used). */
  username?: string;
  children: (session: StoredSession) => ReactNode;
}) {
  const { session, value, status, busy, error, load, submit } = useAuthGate();
  if (session && value)
    return <AuthContext.Provider value={value}>{children(session)}</AuthContext.Provider>;
  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colors.canvas,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
      }}
    >
      <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
        <Mascot size={72} />
        <Text style={{ fontSize: 30, color: colors.text, fontWeight: "600", textAlign: "center" }}>
          {a.welcome}
        </Text>
        <Text style={[s.muted, { textAlign: "center" }]}>{a.tagline}</Text>
        {busy && !status ? (
          <ActivityIndicator color={colors.blueDark} />
        ) : status?.setupRequired ? (
          <SetupForm busy={busy} error={error} onSubmit={submit} />
        ) : status ? (
          <SignInForm
            busy={busy}
            error={error}
            initialUsername={username ?? ""}
            onSubmit={submit}
          />
        ) : (
          <Card style={{ width: "100%" }}>
            <ErrorNotice error={error || a.unreachable} />
            <Button primary onPress={() => void load()}>
              {a.tryAgain}
            </Button>
            <Text style={[s.small, { marginTop: 15 }]}>{a.serverHint(API_URL)}</Text>
          </Card>
        )}
      </View>
    </SafeAreaView>
  );
}

type Submit = AuthSubmit;

function SignInForm({
  busy,
  error,
  initialUsername,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  initialUsername: string;
  onSubmit: Submit;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  function go() {
    if (!username.trim() || !password) {
      setFormError(a.missing);
      return;
    }
    setFormError("");
    void onSubmit(() => authClient.signIn({ username: username.trim(), password })).then((ok) => {
      // A rejected password is not kept around for a second try.
      if (!ok) setPassword("");
    });
  }
  return (
    <Card style={{ width: "100%" }}>
      <Text style={[s.text, { fontWeight: "600", marginBottom: 8 }]}>{a.signIn}</Text>
      <ErrorNotice error={formError || error} />
      <Field
        label={a.username}
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        onSubmitEditing={go}
      />
      <Field
        label={a.password}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={go}
      />
      <Button primary busy={busy} onPress={go}>
        {a.signIn}
      </Button>
    </Card>
  );
}

function SetupForm({ busy, error, onSubmit }: { busy: boolean; error: string; onSubmit: Submit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState("");
  function go() {
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
    <Card style={{ width: "100%" }}>
      <Text style={[s.text, { fontWeight: "600" }]}>{a.setupTitle}</Text>
      <Text style={[s.small, { marginBottom: 8 }]}>{a.setupHint}</Text>
      <ErrorNotice error={formError || error} />
      <Field
        label={a.username}
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        placeholder={a.usernamePlaceholder}
      />
      <Field
        label={a.password}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder={a.passwordPlaceholder(passwordMin)}
      />
      <Field
        label={a.repeatPassword}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
      />
      <Field
        label={a.setupCode}
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={a.setupCodePlaceholder}
        onSubmitEditing={go}
      />
      <Button primary busy={busy} onPress={go}>
        {a.createAccount}
      </Button>
    </Card>
  );
}

/** The menu's Account block: who is signed in, sign out, change password (live mode only). */
export function AccountSection({ mode }: { mode: "sample" | "live" }) {
  const { session, signOut, changePassword } = useAuth();
  const [form, setForm] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (mode !== "live") return null;
  async function save() {
    const secret = validPassword(next);
    if (typeof secret !== "string") return setError(secret.error);
    if (confirm !== next) return setError("The two new passwords differ.");
    if (!current) return setError("Enter your current password.");
    setBusy(true);
    setError("");
    try {
      await changePassword(current, secret);
      if (!mounted.current) return;
      setForm(false);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.label}>Account</Text>
      <Text style={s.small}>Signed in as {session.username ?? "admin"}</Text>
      {done && !form && (
        <Text style={s.small}>Password changed. Other sessions were signed out.</Text>
      )}
      {!form ? (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button small icon={KeyRound} onPress={() => setForm(true)}>
            Change password
          </Button>
          <Button small icon={LogOut} onPress={() => void signOut()}>
            Sign out
          </Button>
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <Field
            label="Current password"
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoComplete="current-password"
          />
          <Field
            label="New password"
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoComplete="new-password"
            placeholder="at least 8 characters"
          />
          <Field
            label="Repeat new password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            onSubmitEditing={() => void save()}
          />
          <ErrorNotice error={error} />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button small primary busy={busy} onPress={() => void save()}>
              Save password
            </Button>
            <Button
              small
              disabled={busy}
              onPress={() => {
                setForm(false);
                setError("");
              }}
            >
              Cancel
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
