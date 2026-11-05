/**
 * Fork: username + password sign-in. Pure helpers, free of react-native so the node:test suite
 * can cover them: the stored session (web localStorage; memory elsewhere), the auth API calls
 * and input validation that mirrors the server's rules.
 */
import { readApiPayload } from "./api-response.ts";

export const SESSION_STORAGE_KEY = "openmuse.session";
export const usernamePattern = /^[A-Za-z0-9_.-]{1,32}$/;
export const passwordMin = 8;
/** The server's upper bound too (auth.ts passwordMax). */
export const passwordMax = 256;

export interface StoredSession {
  token: string;
  username: string | null;
  expiresAt: number;
}
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface AuthStatus {
  mode: "sample" | "live";
  configured: boolean;
  setupRequired: boolean;
}

export function memorySessionStorage(): SessionStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** The stored session when it is well-formed and not yet expired; otherwise null. */
export function readStoredSession(
  storage: SessionStorage | undefined,
  now = Date.now(),
): StoredSession | null {
  try {
    const raw = storage?.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.token !== "string" || !value.token) return null;
    if (typeof value.expiresAt !== "number" || value.expiresAt <= now) return null;
    return {
      token: value.token,
      username: typeof value.username === "string" ? value.username : null,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}
export function writeStoredSession(
  storage: SessionStorage | undefined,
  session: StoredSession | null,
): void {
  try {
    if (session) storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the session simply does not survive a reload.
  }
}

/** Client-side checks with the server's rules, so the form can explain before a round trip. */
export function validUsername(value: string): string | { error: string } {
  const username = value.trim();
  if (!usernamePattern.test(username))
    return { error: "Username: 1 to 32 characters, letters, digits, dot, dash or underscore." };
  return username;
}
export function validPassword(value: string): string | { error: string } {
  if (value.length < passwordMin)
    return { error: `Password must be at least ${passwordMin} characters.` };
  return value;
}

export class AuthClient {
  constructor(readonly baseUrl: string) {}
  private async call<T>(path: string, body?: unknown, token?: string, fallback?: string) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) {
      // Drain the (empty) body so the browser does not log the request as aborted.
      await response.arrayBuffer().catch(() => undefined);
      return undefined as T;
    }
    return readApiPayload<T>(response, fallback);
  }
  status() {
    return this.call<AuthStatus>(
      "/api/auth/status",
      undefined,
      undefined,
      "Could not reach the server.",
    );
  }
  signIn(input: { username?: string; password?: string }) {
    return this.call<StoredSession>("/api/session", input, undefined, "Could not sign in.");
  }
  setup(input: { username: string; password: string; code: string }) {
    return this.call<StoredSession>("/api/auth/setup", input, undefined, "Could not finish setup.");
  }
  signOut(token: string) {
    return this.call<undefined>("/api/auth/logout", {}, token);
  }
  changePassword(token: string, input: { current: string; next: string }) {
    return this.call<StoredSession>(
      "/api/auth/password",
      input,
      token,
      "Could not change the password.",
    );
  }
}
