/**
 * Phase C (prototype .pal): ⌘K. One box finds projects, accounts, tasks and spaces, and runs the
 * frame's commands (the pages, which the phone's 更多 reaches, settings, 平台管理 and its tabs,
 * sign out); the
 * words match an option's name or its hint. Opened on a group (更多: the commands; the project
 * crumb: the projects) it lists that group only, the group's name beside an empty box (⌫ in the
 * empty box shows everything again); typed, 「>」 or a group's name does the same. Within a group
 * the options whose name matches come before those only their hint matches. ↑↓ pick, ↵ opens,
 * Esc closes. v1.6 搜对话内容: typed words also search the conversations' messages on the server
 * (the 对话 group: a hit shows the words around the match and names its conversation; picking it
 * opens that conversation at the message).
 */

import { useAuth } from "@m/auth-state";
import { useProjects } from "@m/projects-state";
import {
  hitConversationLabel,
  hitDayLabel,
  type MessageHit,
  normalizeHits,
} from "@m/shell/chat/search-hits";
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
  const { enabled: threadsOn, startNewMain, select: openThread, mainId } = useMuseThread();
  const { notify } = useWorkspace();
  const tree = useWorkspaceTree();
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
      // v1.6 文件浏览器: the file page; the computer's files by name are the 找文件 group below.
      {
        key: "files",
        group: "commands",
        label: t.filesPage.command,
        hint: t.filesPage.commandHint,
        run: () => nav.openPanel({ kind: "files" }),
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
    // The 对话 group (chatOptions, from the server) stands between these and the files.
    return [...commands, ...projects, ...accountOptions, ...taskOptions, ...extra.spaces];
  }, [nav, rows, select, accounts.value, entries, extra, signOut, threadsOn, startNewMain, notify]);
  // The computer's folders and files (v1.6), each opening the file page there; shown after the commands.
  const fileOptions = useMemo<Option[]>(
    () =>
      tree.map((entry) => ({
        key: `f:${entry.path}`,
        group: "files",
        label: entry.name + (entry.type === "directory" ? "/" : ""),
        hint:
          entry.path
            .slice(0, entry.path.lastIndexOf("/"))
            .replace(/^\/workspace/, t.filesPage.root) || t.filesPage.root,
        run: () => nav.openPanel({ kind: "files", path: entry.path, group: "computer" }),
      })),
    [tree, nav],
  );

  const typed = parse(query);
  const group = typed.group ?? mode;
  const { text } = typed;
  const needle = text.toLowerCase();
  // v1.6 搜对话内容: the messages holding the typed words, from the server (already matched there).
  const search = useChatHits(text, threadsOn && (!group || group === "chat"));
  const chatOptions = useMemo<Option[]>(
    () =>
      search.hits.map((hit) => ({
        key: `m:${hit.threadId}:${hit.messageId}`,
        group: "chat",
        label: `${hit.snippet.before}${hit.snippet.match}${hit.snippet.after}`,
        parts: hit.snippet,
        hint: t.chat.search.where(
          hitConversationLabel(hit, {
            mainId,
            main: t.threads.main,
            untitled: t.threads.untitled,
            archived: t.chat.search.archived,
          }),
          hitDayLabel(hit.at),
        ),
        run: () => {
          setFrame({ jump: { threadId: hit.threadId, messageId: hit.messageId } });
          openThread({ id: hit.threadId, existing: true });
        },
      })),
    [search.hits, mainId, openThread],
  );
  const named = (option: Option) =>
    option.group === "chat" || option.label.toLowerCase().includes(needle);
  // Files before the chat hits: a file's name is a sharper match than a message naming it.
  const options = [...all, ...fileOptions, ...chatOptions];
  const groupOrder = [...new Set(options.map((option) => option.group))];
  const shown = options
    .filter(
      (option) =>
        (!group || option.group === group) &&
        (option.group !== "files" || group === "files" || needle) &&
        (option.group === "chat" ||
          !needle ||
          named(option) ||
          !!option.hint?.toLowerCase().includes(needle)),
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
          {shown.length === 0 ? (
            <div className="empty-state">
              {group === "chat" && !text
                ? t.chat.search.typeWords
                : search.pending
                  ? t.chat.search.searching
                  : w.paletteEmpty}
            </div>
          ) : null}
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
                  data-group={option.group}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(option)}
                >
                  <span className="l">
                    {option.parts ? (
                      <>
                        {option.parts.before}
                        <mark>{option.parts.match}</mark>
                        {option.parts.after}
                      </>
                    ) : (
                      option.label
                    )}
                  </span>
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

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}
/** v1.6: every folder and file of the members' computer, read once while the palette is open;
 * nothing on a site without that computer (the hosted site: the route is not there). */
function useWorkspaceTree(): TreeEntry[] {
  const { api } = useWorkspace();
  const [tree, setTree] = useState<TreeEntry[]>([]);
  useEffect(() => {
    let gone = false;
    api
      .request<{ entries: TreeEntry[] }>("/api/computer/files/tree")
      .then((found) => !gone && Array.isArray(found.entries) && setTree(found.entries))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [api]);
  return tree;
}

/** v1.6 搜对话内容: the messages holding the typed words, asked of the server a moment after the
 * typing pauses (`pending` while the answer for these words is not in yet); nothing while the
 * box is empty or the group shown is another. */
function useChatHits(text: string, enabled: boolean): { hits: MessageHit[]; pending: boolean } {
  const { api } = useWorkspace();
  const [found, setFound] = useState<{ words: string; hits: MessageHit[] }>({
    words: "",
    hits: [],
  });
  const words = enabled ? text.trim() : "";
  useEffect(() => {
    if (!words) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      api
        .request<unknown>(`/api/copilotkit/threads/search?q=${encodeURIComponent(words)}&limit=20`)
        .then((payload) => !gone && setFound({ words, hits: normalizeHits(payload) }))
        .catch(() => !gone && setFound({ words, hits: [] }));
    }, 180);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [api, words]);
  if (!words) return { hits: [], pending: false };
  // The last answer stays up while the next is fetched, so the list does not blink.
  return { hits: found.hits, pending: found.words !== words };
}
