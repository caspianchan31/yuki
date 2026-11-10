// A stand-in for the members' computer container (apps/server/src/desktop-agent.ts): the same
// calls, answered from memory, with a log of what was asked.
import type { Config } from "../../apps/server/src/config.ts";
import type {
  BrowserAction,
  DesktopAgent,
  DesktopAgentState,
  DesktopAppAction,
  DesktopAppsView,
  DesktopExecResult,
  DesktopPage,
  PointerAction,
} from "../../apps/server/src/desktop-agent.ts";

export const desktopConfig: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "/unused",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost/callback",
  allowedOrigins: [],
};

export class FakeAgent {
  running = false;
  calls: string[] = [];
  execs: { command: string; cwd: string }[] = [];
  fileRequests: Record<string, unknown>[] = [];
  /** What the next exec answers, and what makes it throw. */
  result: DesktopExecResult = {
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  };
  execError: Error | null = null;
  stateError: Error | null = null;
  page: DesktopPage = { url: "https://example.com/", title: "Example", text: "Example Domain" };
  browserActions: BrowserAction[] = [];
  /** What the desktop's apps answer, and what was asked of them. */
  appsView: DesktopAppsView = {
    app: "mousepad",
    snapshot: "s1",
    windows: ["note.txt - Mousepad"],
    elements: [
      { n: 1, role: "menu", name: "File" },
      { n: 2, role: "text", name: "", text: "first line\n" },
    ],
  };
  appActions: DesktopAppAction[] = [];
  pointerActions: PointerAction[] = [];
  readonly live = { view: "v".repeat(32), control: "c".repeat(32), port: 6080 };

  asAgent() {
    return this as unknown as DesktopAgent;
  }
  liveAddress(port: number) {
    return { host: "computer", port };
  }
  private snapshot(): DesktopAgentState {
    return {
      desktop: this.running ? "running" : "stopped",
      startedAt: this.running ? 1 : null,
      live: this.running ? this.live : null,
      size: "1280x800",
    };
  }
  async state() {
    this.calls.push("state");
    if (this.stateError) throw this.stateError;
    return this.snapshot();
  }
  /** What each start was asked (the account's time zone, when the service names one). */
  readonly starts: { timezone?: string }[] = [];
  async start(options: { timezone?: string } = {}) {
    this.calls.push("start");
    this.starts.push(options);
    this.running = true;
    return this.snapshot();
  }
  async stop() {
    this.calls.push("stop");
    this.running = false;
    return this.snapshot();
  }
  async exec(command: string, cwd: string) {
    this.calls.push("exec");
    this.execs.push({ command, cwd });
    if (this.execError) throw this.execError;
    return this.result;
  }
  async files<T>(request: Record<string, unknown>): Promise<T> {
    this.calls.push("files");
    this.fileRequests.push(request);
    return { path: request.path, entries: [], text: "" } as T;
  }
  async browser(action: BrowserAction) {
    this.calls.push("browser");
    this.browserActions.push(action);
    return this.page;
  }
  async screenshot() {
    this.calls.push("screenshot");
    return "UE5H";
  }
  async pointer(action: PointerAction) {
    this.calls.push("pointer");
    this.pointerActions.push(action);
    // A JPEG's first bytes, base64: what the agent answers since v1.7.5.
    return {
      at: [Math.round((action.x * 1280) / 1000), Math.round((action.y * 800) / 1000)],
      screen: [1280, 800],
      image: "/9j/4AAQ",
    };
  }
  async desktopApps(action: DesktopAppAction) {
    this.calls.push("desktop");
    this.appActions.push(action);
    return this.appsView;
  }
}
