// v1.4 (docs/apps.md): connected apps in 设置 and the @ list. Pure parts: the directory's rows
// (state, what the buttons do) and the names the @ list offers.
import type { AppEntry } from "../../../domain/src/apps.ts";
import { t } from "./strings.ts";

export interface AppRow {
  id: string;
  name: string;
  /** 预设 / 自定义 for an MCP server, empty for the rest. */
  tag: string;
  state: AppEntry["state"];
  /** The state in words. */
  stateLabel: string;
  /** The second line: the account or address, what it lets members do. */
  line: string;
  /** Buttons: 连接 / 重新连接 when it can be connected from here; 断开 when connected. */
  connect: string | null;
  disconnect: string | null;
}

export function appRows(entries: readonly AppEntry[]): AppRow[] {
  const s = t.settings.apps;
  return entries.map((entry) => {
    const connected = entry.state === "connected";
    // The mailbox is added in the project's credentials; Google keeps its own row above.
    const bySetting = entry.connect === "elsewhere" || entry.type === "google";
    const parts = [
      connected && entry.account ? entry.account : "",
      !connected && entry.type === "mailbox" ? s.mailboxHint : "",
      entry.type === "google" ? s.googleHint : "",
      entry.type === "mcp" && entry.url ? entry.url : "",
      connected && typeof entry.tools === "number" ? s.tools(entry.tools) : "",
      entry.abilities.join("、"),
    ].filter(Boolean);
    return {
      id: entry.id,
      name: entry.name,
      tag: entry.type === "mcp" ? (entry.preset ? s.preset : s.custom) : "",
      state: entry.state,
      stateLabel: s.states[entry.state] ?? entry.state,
      line: parts.join(" · "),
      connect:
        entry.state === "not_configured" || bySetting || (entry.connect === "token" && connected)
          ? null
          : connected
            ? s.reconnect
            : s.connect,
      disconnect: connected && !bySetting ? s.disconnect : null,
    };
  });
}

/** The @ list's apps: the ones that are connected. Picking one writes its name. */
export function mentionApps(entries: readonly AppEntry[]): { id: string; name: string }[] {
  return entries
    .filter((entry) => entry.state === "connected" && entry.name.trim())
    .map((entry) => ({ id: entry.id, name: entry.name.trim() }));
}

/** The lines of an app's call, argument by argument (key and value as
 * the model gave them; a nested value as JSON). */
export function appCallLines(data: Record<string, unknown>): { label: string; value: string }[] {
  const args = data.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
  }));
}
