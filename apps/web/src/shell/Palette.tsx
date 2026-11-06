/**
 * Phase C (prototype .pal): ⌘K. One box finds projects, accounts, tasks and spaces, and runs the
 * frame's commands (the pages, which the phone's 更多 reaches, settings, 平台管理 and its tabs,
 * sign out); the
 * words match an option's name or its hint. Opened on a group (更多: the commands; the project
 * crumb: the projects) it lists that group only, the group's name beside an empty box (⌫ in the
 * empty box shows everything again); typed, 「>」 or a group's name does the same. Within a group
 * the options whose name matches come before those only their hint matches. ↑↓ pick, ↵ opens,
 * Esc closes.
 */

import { useAuth } from "@m/auth-state";
import { useProjects } from "@m/projects-state";
import { useShellData } from "@m/shell/data";
import { useProjectRows } from "@m/shell/frame/useProjectRows";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useMuseThread } from "@m/threads-state";
import { useWorkspace } from "@m/workspace";
import { useEffect, useMemo, useRef, useState } from "react";
import { type PaletteItem, useTenancyUi } from "../tenancy-ui";
import { cx } from "../ui/primitives";
import { type PaletteGroup, peekAccount, setFrame, useFrame } from "./state";

const w = t.web;
type Group = PaletteGroup;
type Option = PaletteItem;

/** Which group a query opened on stands for, and the text left to match. */
function parse(query: string): { group: Group | null; text: string } {
  if (query.startsWith(">")) return { group: "commands", text: query.slice(1).trim() };
  for (const [key, label] of Object.entries(w.paletteGroups) as [Group, string][])
    if (query === label || query.startsWith(`${label} `))
      return { group: key, text: query.slice(label.length).trim() };
  return { group: null, text: query.trim() };
}

export function Palette() {
  const frame = useFrame();
  const nav = useShellNav();
  const { signOut } = useAuth();
  const rows = useProjectRows();
  const { select } = useProjects();
  const { accounts, entries } = useShellData();
  // The tenancy layer's commands (平台管理 and its tabs) and space switches, when it has any.
  const extra = useTenancyUi().usePaletteItems();
  // 从头开始 and 以前的对话: the main chat's commands, when conversations are kept on the server.
  const { enabled: threadsOn, startNewMain } = useMuseThread();
  const { notify } = useWorkspace();
  const [query, setQuery] = useState(frame.paletteQuery);
  const [mode, setMode] = useState<Group | null>(frame.paletteGroup);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => setFrame({ palette: false, paletteQuery: "", paletteGroup: null });
  // Focus the box for a keyboard; on a touch screen opening the palette must not pop the keyboard.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);

  const all = useMemo<Option[]>(() => {
    const page = (view: "work" | "credentials") => () => {
      setFrame({ platform: null });
      nav.setView(view);
    };
    // v1.5: back in 更多 (lost with the pro view on 11-02). 从头开始 archives the main chat and
    // opens an empty one, nothing lost; 以前的对话 is the conversations panel with 已归档.
    const conversations: Option[] = threadsOn
      ? [
          {
            key: "start-over",
            group: "commands",
            label: t.threads.startOver,
            hint: t.threads.newMainHint,
            run: () =>
              void startNewMain().catch((error: unknown) =>
                notify(
                  `${t.common.errorPrefix}${error instanceof Error ? error.message : String(error)}`,
                ),
              ),
          },
          {
            key: "threads",
            group: "commands",
            label: t.threads.history,
            hint: t.threads.historyHint,
            run: () => nav.openPanel({ kind: "threads" }),
          },
        ]
      : [];
    const commands: Option[] = [
      {
        key: "new-member",
        group: "commands",
        label: t.newMember.title,
        run: () => setFrame({ newMember: true }),
      },
      {
        key: "credentials",
        group: "commands",
        label: t.header.credentials,
        run: page("credentials"),
      },
      {
        key: "notes",
        group: "commands",
        label: t.notes.title,
        run: () => nav.openPanel({ kind: "notes" }),
      },
      ...conversations,
      {
        key: "settings",
        group: "commands",
        label: t.header.settings,
        run: () => nav.openPanel({ kind: "settings" }),
      },
      ...extra.commands,
      { key: "sign-out", group: "commands", label: w.signOut, run: () => void signOut() },
    ];
    const projects: Option[] = rows
      .filter((row) => !row.deleting)
      .map((row) => ({
        key: `p:${row.id ?? "default"}`,
        group: "projects",
        label: row.name,
        hint: row.countLabel ?? undefined,
        run: () => {
          setFrame({ platform: null });
          nav.setView("work");
          if (!row.current) select(row.id);
        },
      }));
    const accountOptions: Option[] = accounts.value.map((account) => ({
      key: `a:${account.id}`,
      group: "accounts",
      label: account.name,
      // With no computer connected there is no desktop to say anything about.
      hint:
        account.view.computer === false ? undefined : t.accountsRail.desktop(account.desktopWord),
      run: () => peekAccount(account.id),
    }));
    // Each task's phase as every other surface shows it (a run while the worker has no
    // heartbeat reads 后台停着: ShellData's entries).
    const taskOptions: Option[] = entries.slice(0, 200).map(({ task, phase }) => ({
      key: `t:${task.id}`,
      group: "tasks",
      label: task.title,
      hint: phase.label,
      run: () => nav.openPanel({ kind: "task", taskId: task.id }),
    }));
    return [...commands, ...projects, ...accountOptions, ...taskOptions, ...extra.spaces];
  }, [nav, rows, select, accounts.value, entries, extra, signOut, threadsOn, startNewMain, notify]);

  const typed = parse(query);
  const group = typed.group ?? mode;
  const { text } = typed;
  const needle = text.toLowerCase();
  const named = (option: Option) => option.label.toLowerCase().includes(needle);
  const groupOrder = [...new Set(all.map((option) => option.group))];
  const shown = all
    .filter(
      (option) =>
        (!group || option.group === group) &&
        (!needle || named(option) || !!option.hint?.toLowerCase().includes(needle)),
    )
    // Each group together (its heading once), a name's match before a hint's.
    .sort(
      (a, b) =>
        groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
        Number(!named(a)) - Number(!named(b)),
    )
    .slice(0, 60);
  const current = Math.min(index, Math.max(shown.length - 1, 0));
  const run = (option: Option | undefined) => {
    if (!option) return;
    close();
    option.run();
  };
  let lastGroup: Group | null = null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim; Escape closes it from the keyboard
    <div
      className="ovl open"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="pal" role="dialog" aria-modal="true" aria-label={w.search}>
        <div className="pal-box">
          {mode ? <span className="pal-mode">{w.paletteGroups[mode]}</span> : null}
          <input
            ref={input}
            value={query}
            placeholder={mode ? "" : w.paletteHint}
            autoComplete="off"
            aria-label={mode ? `${w.search}${t.common.sep}${w.paletteGroups[mode]}` : w.search}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "Backspace" && !query && mode) {
                setMode(null);
                setIndex(0);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) run(shown[current]);
            }}
          />
        </div>
        <div className="list" role="listbox">
          {shown.length === 0 ? <div className="empty-state">{w.paletteEmpty}</div> : null}
          {shown.map((option, i) => {
            // The chip beside the box already names the group the palette opened on (更多: 命令).
            const heading =
              option.group !== lastGroup && option.group !== mode
                ? w.paletteGroups[option.group]
                : null;
            lastGroup = option.group;
            return (
              <div key={option.key}>
                {heading ? <div className="grp">{heading}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  className={cx("opt", i === current && "on")}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(option)}
                >
                  <span className="l">{option.label}</span>
                  {option.hint ? (
                    <span className="h" title={option.hint}>
                      {option.hint}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="foot">
          <span>
            <span className="kbd">↑↓</span> {w.paletteKeys.pick}
          </span>
          <span>
            <span className="kbd">↵</span> {w.paletteKeys.open}
          </span>
          <span>
            <span className="kbd">esc</span> {w.paletteKeys.close}
          </span>
        </div>
      </div>
    </div>
  );
}
