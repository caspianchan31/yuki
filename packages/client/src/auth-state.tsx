/**
 * The sign-in state of auth.tsx without React Native: the session
 * context, the storage it is kept in, and the gate's state machine (useAuthGate), so the phone's
 * AuthGate and the web app's gate render from the same logic. The welcome screens stay in auth.tsx.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { authClient } from "./api";
import { setUnauthorizedHandler } from "./api-client";
import { ApiError } from "./api-response";
import { authErrorText } from "./auth-errors";
import { isWeb } from "./platform-env";
import {
  type AuthStatus,
  memorySessionStorage,
  readStoredSession,
  type SessionStorage,
  type StoredSession,
  writeStoredSession,
} from "./session-core";
import { useClientTenancy } from "./tenancy-client";

export interface AuthValue {
  session: StoredSession;
  /** Ends the session on the server (best effort) and returns to the sign-in screen. */
  signOut: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}
export const AuthContext = createContext<AuthValue | null>(null);
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("Auth provider is unavailable");
  return context;
}

export function platformStorage(): SessionStorage {
  if (isWeb) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    } catch {
      // Blocked storage: the session lives for this page only.
    }
  }
  return memorySessionStorage();
}

const message = authErrorText;

/** Hands a sign-in or setup attempt to the gate: true once it opened a session. */
export type AuthSubmit = (work: () => Promise<StoredSession>) => Promise<boolean>;

export interface AuthGateState {
  /** The session, once signed in (the context value is built from it). */
  session: StoredSession | null;
  /** The value AuthContext.Provider hands down while signed in; null before. */
  value: AuthValue | null;
  /** The server's answer to the status read: null until it answers (or when it could not). */
  status: AuthStatus | null;
  busy: boolean;
  error: string;
  /** The right password of a sign-up not opened yet (or refused). */
  registration: object | null;
  /** Reads the server's status again (the 再试一次 of an unreachable server). */
  load: () => Promise<void>;
  submit: AuthSubmit;
}

/** The gate's state machine: holds the session (kept in platformStorage), reads the server's
 * status while signed out, opens the sample workspace by itself, and ends the session on a 401. */
export function useAuthGate(): AuthGateState {
  const storage = useMemo(platformStorage, []);
  // The tenancy port reads a refused sign-in's registration status (none in a single-user core).
  const { normalizeRegistration } = useClientTenancy();
  const [session, setSession] = useState<StoredSession | null>(() => readStoredSession(storage));
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The right password of a sign-up not opened yet (or refused).
  const [registration, setRegistration] = useState<object | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => writeStoredSession(storage, session), [storage, session]);
  // Whether a session is open. A 401 that arrives after the session already ended (its requests
  // were still on their way) leaves the gate alone: ending it again cleared the status the gate had
  // just read and nothing read it again, so it said 连不上服务器 instead of the sign-in (v1.5.1).
  const signedIn = useRef(session !== null);
  useEffect(() => {
    signedIn.current = session !== null;
  }, [session]);
  const end = useCallback(() => {
    if (!signedIn.current) return;
    signedIn.current = false;
    setSession(null);
    setStatus(null);
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(end);
    return () => setUnauthorizedHandler(undefined);
  }, [end]);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await authClient.status();
      if (!mounted.current) return;
      if (next.mode === "sample") {
        // The sample workspace is loopback-only and opens without credentials.
        setSession(await authClient.signIn({}));
        return;
      }
      setStatus(next);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!session) void load();
  }, [session, load]);

  const submit = useCallback(
    async (work: () => Promise<StoredSession>) => {
      setBusy(true);
      setError("");
      setRegistration(null);
      try {
        const next = await work();
        if (mounted.current) setSession(next);
        return true;
      } catch (e) {
        if (!mounted.current) return false;
        const waiting =
          e instanceof ApiError && e.status === 403 && e.body && typeof e.body === "object"
            ? normalizeRegistration((e.body as { registration?: unknown }).registration)
            : null;
        if (waiting) setRegistration(waiting);
        else setError(message(e));
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [normalizeRegistration],
  );
  const value = useMemo<AuthValue | null>(
    () =>
      session
        ? {
            session,
            signOut: async () => {
              await authClient.signOut(session.token).catch(() => undefined);
              end();
            },
            changePassword: async (current, next) => {
              const fresh = await authClient.changePassword(session.token, { current, next });
              setSession(fresh);
            },
          }
        : null,
    [session, end],
  );
  return { session, value, status, busy, error, registration, load, submit };
}
