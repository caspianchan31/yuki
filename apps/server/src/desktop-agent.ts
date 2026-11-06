// The members' computer container, as the Yuki service reaches it (open core, v1.5): its control
// agent (apps/desktop/desktopd.py) over the compose network. Nothing here runs Docker: the
// container is started by `docker compose up` beside the service, and the service only talks to
// it (docs/computer-container.md). Every call carries the shared token; none follows a redirect.
import { readFile } from "node:fs/promises";
import { AppError } from "./errors.ts";

export interface DesktopExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}
export interface DesktopPage {
  url: string;
  title: string;
  text: string;
}
export interface DesktopAgentState {
  desktop: "running" | "stopped";
  startedAt: number | null;
  /** The live view's two VNC tokens (view-only, with input) while the desktop runs. */
  live: { view: string; control: string; port: number } | null;
  size: string;
}
export type BrowserAction =
  | { action: "open"; url: string }
  | { action: "read" }
  | { action: "click"; text: string }
  | { action: "type"; field?: string; text: string }
  | { action: "press"; key: string }
  | { action: "back" };

/** A member's step with the desktop's apps (apps.py behind the agent's /desktop): a look numbers an
 * app's buttons, fields and menus; click, type and set name one by the look's snapshot and n. */
export type DesktopAppAction =
  | { action: "apps" }
  | { action: "open"; app: "editor" | "files"; path?: string }
  | { action: "look"; app: string }
  | { action: "click"; snapshot: string; n: number }
  | { action: "type" | "set"; snapshot: string; n: number; text: string }
  | { action: "press"; key: string; app?: string };

/** One numbered element of an app's look; `text` is a field's content. */
export interface DesktopAppElement {
  n: number;
  role: string;
  name: string;
  state?: string[];
  text?: string;
}

/** What the desktop's apps answer: the open apps (apps), or one app's look (every other action). */
export interface DesktopAppsView {
  apps?: { name: string; windows: string[] }[];
  app?: string;
  snapshot?: string;
  windows?: string[];
  elements?: DesktopAppElement[];
  texts?: string[];
  /** Interactive elements past the first 150, not numbered. */
  more?: number;
  /** A key pressed with no app named. */
  pressed?: string;
  note?: string;
}

export interface DesktopAgentOptions {
  /** The agent's address, e.g. http://desktop:7070 (DESKTOP_URL). */
  url: string;
  /** The token, or the file holding it (DESKTOP_TOKEN / DESKTOP_TOKEN_FILE). */
  token?: string;
  tokenFile?: string;
  fetch?: typeof fetch;
}

/** A reply the agent could not give: unreachable, or refused. */
export const unreachable = () =>
  new AppError(
    "The computer does not answer. Check that its container runs (docker compose ps).",
    503,
  );

export class DesktopAgent {
  private readonly fetcher: typeof fetch;
  private token: string | null = null;
  readonly url: string;
  constructor(private readonly options: DesktopAgentOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch;
  }
  /** The live view's host and port inside the compose network. */
  liveAddress(port: number) {
    const url = new URL(this.url);
    return { host: url.hostname, port };
  }
  private async secret(): Promise<string> {
    if (this.options.token) return this.options.token;
    if (this.token) return this.token;
    if (!this.options.tokenFile) throw new AppError("DESKTOP_TOKEN_FILE is not set", 503);
    try {
      const value = (await readFile(this.options.tokenFile, "utf8")).trim();
      if (value.length < 32) throw new Error("short");
      this.token = value;
      return value;
    } catch {
      // The computer makes the token at its first start; until then there is none to read.
      throw unreachable();
    }
  }
  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal; raw?: string } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${await this.secret()}`,
          ...(body !== undefined || options.raw !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      options.signal?.throwIfAborted();
      if (timeout.aborted)
        throw new AppError("The computer took too long to answer; try again.", 503);
      throw unreachable();
    }
    if (response.status === 401) {
      // A token file the computer replaced is read again on the next call.
      this.token = null;
      throw unreachable();
    }
    const value = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | { error?: string }
      | null;
    if (!response.ok)
      throw new AppError(
        (value && typeof value.error === "string" && value.error.slice(0, 500)) ||
          "The computer could not do that",
        response.status >= 500 ? 502 : 400,
      );
    return value as T;
  }
  health() {
    return this.call<{ ok: boolean }>("GET", "/health", undefined, { timeoutMs: 3000 });
  }
  state() {
    return this.call<DesktopAgentState>("GET", "/state", undefined, { timeoutMs: 5000 });
  }
  /** Starts the desktop session, in the account's time zone when the service names one. */
  start(options: { timezone?: string } = {}) {
    return this.call<DesktopAgentState>("POST", "/start", options, { timeoutMs: 60000 });
  }
  stop() {
    return this.call<DesktopAgentState>("POST", "/stop", {}, { timeoutMs: 20000 });
  }
  exec(command: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal) {
    return this.call<DesktopExecResult>(
      "POST",
      "/exec",
      { command, cwd, timeout: timeoutSeconds },
      { timeoutMs: (timeoutSeconds + 10) * 1000, signal },
    );
  }
  /** The files helper's request (apps/desktop/files.py), (path, operation and content). */
  async files<T>(request: Record<string, unknown>): Promise<T> {
    const reply = await this.call<{ result?: T; error?: string }>("POST", "/files", undefined, {
      raw: JSON.stringify(request),
      timeoutMs: 20000,
    });
    if (reply.error !== undefined || reply.result === undefined)
      throw new AppError(reply.error || "File operation failed", 400);
    return reply.result;
  }
  async screenshot(): Promise<string> {
    return (await this.call<{ png: string }>("POST", "/screenshot", {}, { timeoutMs: 20000 })).png;
  }
  async browser(action: BrowserAction, signal?: AbortSignal): Promise<DesktopPage> {
    return (
      await this.call<{ page: DesktopPage }>("POST", "/browser", action, {
        timeoutMs: 60000,
        signal,
      })
    ).page;
  }
  /** The desktop's apps; an app being opened may take the agent up to about a minute. */
  async desktopApps(action: DesktopAppAction, signal?: AbortSignal): Promise<DesktopAppsView> {
    return (
      await this.call<{ view: DesktopAppsView }>("POST", "/desktop", action, {
        timeoutMs: 90000,
        signal,
      })
    ).view;
  }
}
