// The open core's computer. With no computer container configured (DESKTOP_URL unset) it is no
// computer (未接电脑): members work through chat, apps and routines; nothing here starts a desktop,
// runs a command or reads a screen. Every operation that needs a computer answers 503 with
// `noComputerMessage`; what only reads (a snapshot, a member's desktop state for a listing)
// answers that there is none. With one configured (docs/computer-container.md) the same calls go to
// the members' computer container through `DesktopComputer` (desktop-computer.ts).

import { join } from "node:path";
import type { ComputerCommand, ComputerSnapshot } from "../../../packages/domain/src/computer.ts";
import { deliveredPath, receivedPath } from "../../../packages/domain/src/workspace-files.ts";
import { readAccountZone } from "./account-settings.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { DesktopAgent } from "./desktop-agent.ts";
import { DesktopComputer } from "./desktop-computer.ts";
import { defaultMaxGb, defaultRetentionDays, ShotStore } from "./desktop-shots-store.ts";
import { AppError } from "./errors.ts";
import { Incidents } from "./incidents.ts";

export const noComputerMessage = "No computer is connected (未接电脑).";
const noComputer = () => new AppError(noComputerMessage, 503);

export type ComputerState = "missing" | "stopped" | "running";
export type DesktopState = { state: ComputerState } | { state: "error"; message: string };

/** A member's computer settings (no secret); with no computer nothing is saved. */
export interface ComputerSettingsView {
  timezone: string | null;
  locale: string | null;
  updatedAt: string | null;
  localeUnreadable: boolean;
}
export class ComputerSettings {
  async view(_owner: string): Promise<ComputerSettingsView> {
    return { timezone: null, locale: null, updatedAt: null, localeUnreadable: false };
  }
}

/** The run that holds a desktop. With no computer nothing is ever held. */
export interface DesktopHold {
  id: "hold";
  holder: string;
  title: string;
  until: string;
}
export class DesktopHeldError extends AppError {
  constructor(readonly hold: DesktopHold) {
    super(`Desktop in use by ${hold.title}`, 409);
    this.name = "DesktopHeldError";
  }
}
/** Whether a desktop tool's error says another driver had the desktop. */
export function desktopConflict(message: string) {
  return message.startsWith("Desktop in use by ") || message.startsWith("Computer is busy");
}
/** One run's hold on the desktops it uses. With no computer there is nothing to hold: a run on a
 * member takes "her desktop" at its start and goes on; no run ever waits for another. */
export class DesktopSession {
  constructor(
    readonly computer: unknown,
    readonly holder: string,
    readonly title: string,
  ) {}
  async take(_owner: string) {}
  async release() {}
}
/** Moved desktops' earlier owners; with no computer there are none. */
export async function loadDesktopIdentities(_db: Store): Promise<Map<string, string>> {
  return new Map();
}

const dayMs = 24 * 60 * 60_000;

/** How often, and how long apart, a copy to the computer is tried while it comes up. */
const receiveAttempts = 5;
const receiveRetryMs = 4000;

export class ComputerService {
  /** What the AI could not clear itself; with no computer an incident has no picture. */
  readonly incidents: Incidents;
  /** Nothing is saved for a computer that is not there. */
  readonly settings = new ComputerSettings();
  readonly provider: string;
  /** The members' computer container, when one is configured (read through `desktopOf`). */
  readonly container: DesktopComputer | null;
  constructor(
    readonly db: Store,
    readonly config: Config,
  ) {
    this.container = config.desktop
      ? new DesktopComputer(
          db,
          config,
          new DesktopAgent({
            url: config.desktop.url,
            token: config.desktop.token,
            tokenFile: config.desktop.tokenFile,
          }),
          {
            // The desktop's clock follows the account's time zone (设置 → 通用 → 时区).
            zone: (owner) => readAccountZone(db, owner),
            // v1.6: the pictures members take live on disk, apart from the process.
            shots: new ShotStore(join(config.dataDir, "screenshots"), {
              retentionMs: (config.screenshotRetentionDays ?? defaultRetentionDays) * dayMs,
              maxBytes: (config.screenshotMaxGb ?? defaultMaxGb) * 1024 ** 3,
            }),
          },
        )
      : null;
    this.provider = this.container ? "desktop" : "none";
    this.incidents = new Incidents(db, config.dataDir, {
      screenshot: async () => null,
      mask: async (_owner, text) => text,
      scope: async () => null,
    });
  }
  /** Stops the idle sweep and the live views (the server is shutting down, or a test ends). */
  close() {
    this.container?.close();
  }
  /** v1.6: a deleted conversation's kept screenshots go with it. */
  async forgetShots(ids: string[]) {
    await this.container?.shots?.remove(ids);
  }
  /** v1.6 回顾: a kept picture's PNG bytes for a shared replay; null when there is none. */
  shotPng(id: string): Buffer | null {
    return this.container?.shotOf(id) ?? null;
  }
  /** v1.6 聊天里发文件: a copy of a file sent in the chat goes to /workspace/收到 (a number is
   * added when the name is taken); the path it got, or null without a computer. The computer is
   * started for it when paused, and a computer still coming up is tried again a few times (a
   * cold start answered the first attempt with an error); one that cannot be reached gives null,
   * not an error. */
  async receiveFile(_owner: string, name: string, bytes: Uint8Array): Promise<string | null> {
    return this.placeFile(receivedPath, name, bytes);
  }
  /** v1.6 生成图片: a picture a member made goes to /workspace/成品 the same way. */
  async deliverFile(_owner: string, name: string, bytes: Uint8Array): Promise<string | null> {
    return this.placeFile(deliveredPath, name, bytes);
  }
  private async placeFile(dir: string, name: string, bytes: Uint8Array): Promise<string | null> {
    if (!this.container) return null;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.container.mkdir(dir).catch(() => undefined);
        const taken = new Set((await this.container.list(dir)).entries.map((entry) => entry.name));
        let candidate = name;
        for (let number = 2; taken.has(candidate); number++) {
          const dot = name.lastIndexOf(".");
          candidate =
            dot > 0 ? `${name.slice(0, dot)} (${number})${name.slice(dot)}` : `${name} (${number})`;
        }
        const path = `${dir}/${candidate}`;
        await this.container.writeBytes(path, bytes);
        return path;
      } catch {
        if (attempt >= receiveAttempts) return null;
        await new Promise((resolve) => setTimeout(resolve, receiveRetryMs));
      }
    }
  }
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    if (this.container) return this.container.snapshot(owner);
    return {
      enabled: false,
      provider: "none",
      status: "unconfigured",
      workspacePath: "/workspace",
      network: "disabled",
      message: noComputerMessage,
      commands: [],
    };
  }
  async state(_owner: string): Promise<ComputerState> {
    if (!this.container) throw noComputer();
    return (await this.container.running()) ? "running" : "stopped";
  }
  async states(owners: string[]): Promise<DesktopState[]> {
    if (!this.container) return owners.map(() => ({ state: "missing" }));
    // One computer for every member of this install: they all read its state.
    let state: DesktopState;
    try {
      state = { state: (await this.container.running()) ? "running" : "stopped" };
    } catch (error) {
      state = {
        state: "error",
        message: error instanceof AppError ? error.message : "The computer does not answer",
      };
    }
    return owners.map(() => state);
  }
  async start(
    owner: string,
    _options: { ensure?: () => Promise<void> } = {},
  ): Promise<ComputerSnapshot> {
    if (!this.container) throw noComputer();
    await this.container.start(owner);
    return this.container.snapshot(owner);
  }
  async stop(owner: string): Promise<ComputerSnapshot> {
    if (!this.container) throw noComputer();
    await this.container.stop();
    return this.container.snapshot(owner);
  }
  /** Nothing to destroy: the container's files are the person's (docker compose down -v). */
  async destroy(owner: string) {
    return this.snapshot(owner);
  }
  async execute(
    owner: string,
    raw: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ComputerCommand> {
    if (!this.container) throw noComputer();
    return this.container.execute(owner, raw, options);
  }
  async holdOf(_owner: string): Promise<DesktopHold | null> {
    return null;
  }
  /** The desktop's picture now, for an incident: there is none. */
  async incidentScreenshot(_owner: string): Promise<Uint8Array | null> {
    return null;
  }
}
