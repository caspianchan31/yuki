// No computer (未接电脑): the open core's computer. Members work through chat, apps and routines;
// nothing here starts a desktop, runs a command or reads a screen. Every operation that needs a
// computer answers 503 with `noComputerMessage`; what only reads (a snapshot, a member's desktop
// state for a listing) answers that there is none.
import type { ComputerCommand, ComputerSnapshot } from "../../../packages/domain/src/computer.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { Incidents } from "./incidents.ts";

export const noComputerMessage = "No computer is connected (未接电脑).";
const noComputer = () => new AppError(noComputerMessage, 503);

export type ComputerState = "missing" | "stopped" | "running";
export type DesktopState = { state: ComputerState } | { state: "error"; message: string };

/** A member's computer settings (no secret); with no computer nothing is saved. */
export interface ComputerSettingsView {
  proxy: { configured: boolean; preview: string | null };
  timezone: string | null;
  locale: string | null;
  updatedAt: string | null;
  unreadable: boolean;
  localeUnreadable: boolean;
}
export interface ComputerSettingsEndpoint {
  proxy: { scheme: string; host: string; port: number } | null;
  unreadable: boolean;
  localeUnreadable: boolean;
  timezone: string | null;
  locale: string | null;
}
/** Whether a member's desktop browser could start; never with no computer. */
export const proxyReadable = (view: ComputerSettingsView) =>
  view.proxy.configured && !view.unreadable;
const noSettings: ComputerSettingsView = {
  proxy: { configured: false, preview: null },
  timezone: null,
  locale: null,
  updatedAt: null,
  unreadable: false,
  localeUnreadable: false,
};
export class ComputerSettings {
  systemHidden?: (owner: string) => Promise<boolean>;
  async view(_owner: string): Promise<ComputerSettingsView> {
    return { ...noSettings, proxy: { ...noSettings.proxy } };
  }
  async endpoint(_owner: string): Promise<ComputerSettingsEndpoint> {
    return {
      proxy: null,
      unreadable: false,
      localeUnreadable: false,
      timezone: null,
      locale: null,
    };
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

export class ComputerService {
  /** What the AI could not clear itself; with no computer an incident has no picture. */
  readonly incidents: Incidents;
  /** Nothing is saved for a computer that is not there. */
  readonly settings = new ComputerSettings();
  readonly provider = "none";
  constructor(
    readonly db: Store,
    readonly config: Config,
  ) {
    this.incidents = new Incidents(db, config.dataDir, {
      screenshot: async () => null,
      mask: async (_owner, text) => text,
      scope: async () => null,
    });
  }
  async snapshot(_owner: string): Promise<ComputerSnapshot> {
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
    throw noComputer();
  }
  async states(owners: string[]): Promise<DesktopState[]> {
    return owners.map(() => ({ state: "missing" }));
  }
  async start(
    _owner: string,
    _options: { ensure?: () => Promise<void> } = {},
  ): Promise<ComputerSnapshot> {
    throw noComputer();
  }
  async stop(_owner: string): Promise<ComputerSnapshot> {
    throw noComputer();
  }
  /** Nothing to destroy: no desktop was ever made. */
  async destroy(owner: string) {
    return this.snapshot(owner);
  }
  async execute(_owner: string, _raw: unknown, _options: object = {}): Promise<ComputerCommand> {
    throw noComputer();
  }
  async holdOf(_owner: string): Promise<DesktopHold | null> {
    return null;
  }
  /** The desktop's picture now, for an incident: there is none. */
  async incidentScreenshot(_owner: string): Promise<Uint8Array | null> {
    return null;
  }
}
