export interface ComputerCommand {
  id: string;
  command: string;
  /** Full input binding for keyed desktop actions; command is only a short display label. */
  actionHash?: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "interrupted";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt?: string;
}
export interface ComputerSnapshot {
  enabled: boolean;
  /** The computer provider; "none" when no computer is connected. */
  provider: string;
  status: "unconfigured" | "stopped" | "running" | "error";
  workspacePath: "/workspace";
  /** Whether the computer can reach the internet. */
  network: "disabled" | "enabled";
  message?: string;
  /** False while no desktop exists on the provider (never started, or
   * destroyed), so 重建桌面 is offered only for one that does; absent from older servers. */
  created?: boolean;
  /** On a running desktop, whether its browser
   * check is still to do on this start (`due`) or was done on it (`done`). */
  browserCheck?: "due" | "done";
  commands: ComputerCommand[];
}
/** Whether a computer provider runs a graphical desktop (a screen to show and drive). */
export const isDesktopProvider = (provider: string) => false;
export interface ComputerDirectory {
  path: string;
  entries: { name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[];
}
