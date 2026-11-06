// The members' computer of the open core (v1.5, docs/computer-container.md): one Linux desktop in
// its own container, shared by every member of this install. Members work only there, never on
// the person's own machine. This class is what the open ComputerService does with it:
//   - state, start and stop of the desktop session (the container itself always runs; a stopped
//     session is the computer paused), and the pause after `idleMs` without anyone using it;
//   - commands with receipts, the files helper, browser actions on the desktop's browser;
//   - the live view: a ticket per owner in the iframe's path (an iframe cannot send the session's
//     bearer token), view-only unless the person took the computer over; the websocket proxy
//     (desktop-live.ts) picks the VNC server by who drives at the moment it connects.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { ComputerCommand, ComputerSnapshot } from "../../../packages/domain/src/computer.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { BrowserAction, DesktopAgent, DesktopPage } from "./desktop-agent.ts";
import { AppError } from "./errors.ts";

export const desktopProvider = "desktop";
export const desktopReceipts = "computer-commands";
const fileLimit = 256 * 1024;
/** Screenshots kept for the person's chat: the newest ones, each for an hour. */
export const keptShots = 20;
export const shotTtlMs = 60 * 60_000;
export const desktopCommandSchema = z.object({
  command: z.string().trim().min(1).max(16000),
  cwd: z.string().default("/workspace"),
});
export const desktopPathSchema = z.object({ path: z.string().min(1).max(2048) });
export const desktopWriteSchema = desktopPathSchema.extend({ text: z.string().max(fileLimit) });
export const controlSchema = z.object({ by: z.enum(["person", "member"]) }).strict();

/** Who drives the desktop: its members, or the person who took it over. */
export type Driver = "member" | "person";
export interface LiveView {
  url: string;
  /** Who drives now; the frame takes input only while it is the person. */
  control: Driver;
}
/** A live websocket the proxy holds open, closed when who drives changes. */
export interface LiveSocket {
  driver: Driver;
  close(): void;
}

/** What a member is told while the person drives. */
export const personDrivesNote =
  "The person took over the computer and is using it now. Do not act on it: wait until they hand it back, and tell them you are waiting.";

/** A path inside /workspace, normalised; anything else is refused. */
export function workspacePath(raw: string) {
  if (raw.includes("\0")) throw new AppError("Invalid path", 400);
  const path = posix.normalize(raw.startsWith("/") ? raw : `/workspace/${raw}`);
  if (path !== "/workspace" && !path.startsWith("/workspace/"))
    throw new AppError("Path must be inside /workspace", 400);
  return path.replace(/\/$/, "") || "/workspace";
}

/** The members' computer container behind a ComputerService of the open core; null with none
 * (and for the closed layer's service, which has no such thing). */
export function desktopOf(computer: unknown): DesktopComputer | null {
  const container = (computer as { container?: unknown }).container;
  return container instanceof DesktopComputer ? container : null;
}

export class DesktopComputer {
  readonly provider = desktopProvider;
  private driver: { by: Driver; since: number } = { by: "member", since: 0 };
  private lastActive = 0;
  private readonly tickets = new Map<string, { owner: string; expires: number }>();
  private readonly ticketOf = new Map<string, string>();
  private readonly sockets = new Set<LiveSocket>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private sweep?: ReturnType<typeof setInterval>;
  private starting: Promise<void> | null = null;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly agent: DesktopAgent,
    options: { now?: () => number; idleMs?: number; sweepMs?: number | null } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? (config.desktop?.idleMinutes ?? 15) * 60_000;
    if (options.sweepMs !== null) {
      this.sweep = setInterval(
        () => void this.pauseIfIdle().catch(() => {}),
        options.sweepMs ?? 60_000,
      );
      this.sweep.unref?.();
    }
  }
  close() {
    if (this.sweep) clearInterval(this.sweep);
    for (const socket of this.sockets) socket.close();
  }
  /** Someone used the computer: its idle pause starts again from now. */
  touch() {
    this.lastActive = this.now();
  }
  get drivenBy(): Driver {
    return this.driver.by;
  }

  // ───────────────────────────── state ─────────────────────────────

  async running(): Promise<boolean> {
    return (await this.agent.state()).desktop === "running";
  }
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    const base = {
      enabled: true,
      provider: desktopProvider,
      workspacePath: "/workspace" as const,
      network: "enabled" as const,
      // One shared computer: there is no per-member desktop to rebuild from the app.
      created: false,
      control: this.driver.by,
    };
    try {
      const state = await this.agent.state();
      return {
        ...base,
        status: state.desktop === "running" ? "running" : "stopped",
        commands: await this.commands(owner),
      };
    } catch (error) {
      return {
        ...base,
        status: "error",
        message: error instanceof AppError ? error.message : "The computer does not answer",
        commands: await this.commands(owner),
      };
    }
  }
  async commands(owner: string): Promise<ComputerCommand[]> {
    const all = await this.db.list<ComputerCommand>(owner, desktopReceipts);
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  }
  /** Starts the desktop session; one start at a time, the others wait for it. */
  async start(): Promise<void> {
    this.touch();
    if (!this.starting)
      this.starting = (async () => {
        try {
          if (!(await this.running())) await this.agent.start();
        } finally {
          this.starting = null;
        }
      })();
    await this.starting;
  }
  /** Ends the session (the computer pauses); the person's control ends with it. */
  async stop(): Promise<void> {
    await this.agent.stop();
    this.driver = { by: "member", since: this.now() };
    for (const socket of [...this.sockets]) socket.close();
  }
  /** The idle pause: a running desktop nobody used for `idleMs` stops. A person driving it keeps it
   * awake while the live view refreshes (each refresh touches it). */
  async pauseIfIdle(): Promise<boolean> {
    if (this.starting || this.now() - this.lastActive < this.idleMs) return false;
    if (!(await this.running())) return false;
    await this.stop();
    return true;
  }

  // ───────────────────────────── who drives ─────────────────────────────

  private setDriver(by: Driver) {
    if (this.driver.by === by) return;
    this.driver = { by, since: this.now() };
    // Every open frame reconnects with the other VNC server (the web reloads it on the change).
    for (const socket of [...this.sockets]) socket.close();
  }
  /** 我来操作 / 交还: the person takes the computer over, or hands it back to the members. */
  async setControl(owner: string, raw: unknown): Promise<LiveView> {
    const { by } = controlSchema.parse(raw);
    if (by === "person" && !(await this.running()))
      throw new AppError("The computer is not running; start it first.", 409);
    this.setDriver(by);
    this.touch();
    return this.liveView(owner);
  }
  /** Refuses a member's action while the person drives. */
  assertMembersDrive() {
    if (this.driver.by === "person") throw new AppError(personDrivesNote, 409, { paused: true });
  }

  // ───────────────────────────── live view ─────────────────────────────

  /** The frame's address: the service's viewer page behind this owner's ticket (desktop-live.ts),
   * view-only unless the person drives. The same address while who drives stays the same, so a
   * refresh never reloads it. */
  async liveView(owner: string): Promise<LiveView> {
    const state = await this.agent.state();
    if (state.desktop !== "running" || !state.live)
      throw new AppError("The computer is not running", 409);
    this.touch();
    const ticket = this.ticket(owner);
    const base = new URL(this.config.publicUrl);
    const prefix = `${base.pathname.replace(/\/$/, "")}/api/computer/live/${ticket}`;
    const viewOnly = this.driver.by === "person" ? "0" : "1";
    const query = new URLSearchParams({ view_only: viewOnly });
    return { url: `${base.origin}${prefix}/view.html?${query}`, control: this.driver.by };
  }
  private ticket(owner: string) {
    const expires = this.now() + 30 * 60_000;
    const existing = this.ticketOf.get(owner);
    const held = existing ? this.tickets.get(existing) : undefined;
    if (existing && held && held.expires > this.now()) {
      held.expires = expires;
      return existing;
    }
    if (existing) this.tickets.delete(existing);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { owner, expires });
    this.ticketOf.set(owner, ticket);
    return ticket;
  }
  /** The owner a live ticket was made for, while it holds. */
  liveOwner(ticket: string): string | null {
    const held = this.tickets.get(ticket);
    if (!held) return null;
    if (held.expires <= this.now()) {
      this.tickets.delete(ticket);
      return null;
    }
    return held.owner;
  }
  /** Where the websocket of a live ticket goes: the VNC token of who drives now. */
  async liveTarget(ticket: string) {
    if (!this.liveOwner(ticket)) return null;
    const state = await this.agent.state();
    if (state.desktop !== "running" || !state.live) return null;
    const driver = this.driver.by;
    return {
      driver,
      token: driver === "person" ? state.live.control : state.live.view,
      ...this.agent.liveAddress(state.live.port),
    };
  }
  holdSocket(socket: LiveSocket) {
    this.sockets.add(socket);
    return () => this.sockets.delete(socket);
  }
  get liveSockets() {
    return this.sockets.size;
  }

  // ───────────────────────────── commands, files, browser ─────────────────────────────

  async execute(
    owner: string,
    raw: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ComputerCommand> {
    const args = desktopCommandSchema.parse(raw);
    const cwd = workspacePath(args.cwd);
    const id = options.idempotencyKey
      ? createHash("sha256").update(`computer-command:${options.idempotencyKey}`).digest("hex")
      : randomUUID();
    const previous = await this.db.get<ComputerCommand>(owner, desktopReceipts, id);
    if (previous) {
      if (previous.command !== args.command || previous.cwd !== cwd)
        throw new AppError("This operation ID already belongs to a different command", 409);
      return previous;
    }
    await this.start();
    const command: ComputerCommand = {
      id,
      command: args.command,
      cwd,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date(this.now()).toISOString(),
    };
    if (!(await this.db.insertIfAbsent(owner, desktopReceipts, command)))
      return (await this.db.get<ComputerCommand>(owner, desktopReceipts, id)) ?? command;
    let finished: ComputerCommand;
    try {
      const result = await this.agent.exec(args.command, cwd, 30, options.signal);
      finished = {
        ...command,
        status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        completedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      finished = {
        ...command,
        status: "interrupted",
        stderr:
          error instanceof AppError
            ? `${error.message} Inspect the workspace before running it again.`
            : "Execution was interrupted; inspect the workspace before retrying.",
        completedAt: new Date(this.now()).toISOString(),
      };
    }
    this.touch();
    return this.db.put(owner, desktopReceipts, finished);
  }
  private async file<T>(request: Record<string, unknown>): Promise<T> {
    if (typeof request.text === "string" && Buffer.byteLength(request.text) > fileLimit)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    await this.start();
    this.touch();
    return this.agent.files<T>(request);
  }
  async list(raw: string | undefined) {
    return this.file<{
      path: string;
      entries: { name: string; path: string; type: string; size: number }[];
    }>({ operation: "list", path: workspacePath(raw ?? "/workspace") });
  }
  async read(path: string) {
    return this.file<{ path: string; text: string }>({
      operation: "read",
      path: workspacePath(path),
    });
  }
  async write(path: string, text: string) {
    return this.file<{ path: string }>({ operation: "write", path: workspacePath(path), text });
  }
  async mkdir(path: string) {
    return this.file<{ path: string }>({ operation: "mkdir", path: workspacePath(path) });
  }
  async writePdf(path: string, bytes: Uint8Array) {
    if (bytes.length > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return this.file<{ path: string }>({
      operation: "write_pdf",
      path: workspacePath(path),
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  async pdfBytes(path: string) {
    const result = await this.file<{ path: string; base64: string }>({
      operation: "read_pdf",
      path: workspacePath(path),
    });
    return { name: posix.basename(path), bytes: Buffer.from(result.base64, "base64") };
  }
  /** The whole screen now, as base64 PNG; the desktop starts when it is paused. */
  async screenshot(): Promise<string> {
    await this.start();
    this.touch();
    return this.agent.screenshot();
  }
  private readonly shots = new Map<string, { png: string; at: number }>();
  /** Keeps a screenshot (base64 PNG) so the person sees it in the chat
   * (GET /api/computer/screenshots/:id); its id. The newest `keptShots` are kept, an hour each. */
  keepShot(png: string): string {
    const now = this.now();
    for (const [key, shot] of this.shots) if (now - shot.at > shotTtlMs) this.shots.delete(key);
    const id = randomBytes(16).toString("base64url");
    this.shots.set(id, { png, at: now });
    while (this.shots.size > keptShots) {
      const oldest = this.shots.keys().next().value;
      if (oldest === undefined) break;
      this.shots.delete(oldest);
    }
    return id;
  }
  /** A kept screenshot's PNG bytes; null when unknown or older than an hour. */
  shotOf(id: string): Buffer | null {
    const shot = this.shots.get(id);
    if (!shot || this.now() - shot.at > shotTtlMs) return null;
    return Buffer.from(shot.png, "base64");
  }
  /** A member's step in the desktop's browser: the desktop starts when it is paused; nothing is
   * done while the person drives. */
  async browse(action: BrowserAction, signal?: AbortSignal): Promise<DesktopPage> {
    this.assertMembersDrive();
    await this.start();
    this.assertMembersDrive();
    const page = await this.agent.browser(action, signal);
    this.touch();
    return page;
  }
}
