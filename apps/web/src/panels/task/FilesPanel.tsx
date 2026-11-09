/**
 * v1.6 文件浏览器: the file page. Two groups in one sheet:
 *   电脑      the members' computer's /workspace as a folder tree (list / read / write / mkdir of
 *             the computer API, plus v1.6's upload, download, rename, delete into the recycle
 *             bin, restore). 收到/ is where the person's uploads go, 成品/ is what members
 *             deliver (its newest files sit at the top). Markdown is edited in place; text and
 *             code are read; pictures are shown; a PDF opens in the browser; anything else is
 *             downloaded. 「让成员改」 puts the file's path into the chat.
 *   成员文件  each member's AGENTS.md, MEMORY.md and daily notes (docs/member-files.md), edited
 *             in place with a line saying what the file is.
 * A site without a computer (the hosted site today) shows only the second group's content.
 */

import { useShellData } from "@m/shell/data";
import {
  changedLine,
  fitsFileLimit,
  localDay,
  memberFilesPath,
  normalizeFile,
  normalizeFileList,
  recentNotes,
  yukiMemberId,
} from "@m/shell/members/member-files";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerSnapshot } from "../../../../../packages/domain/src/computer";
import {
  cleanFileName,
  deliveredFolder,
  deliveredPath,
  parentPath,
  pathCrumbs,
  receivedFolder,
  sizeLabel,
  trashDays,
  type WorkspaceFileKind,
  workspaceFileKind,
  workspaceFileMaxBytes,
} from "../../../../../packages/domain/src/workspace-files";
import "../../shell/member-files.css";
import { useAllMembers } from "../../shell/useMembers";
import { Btn, cx, ErrorLine, Sheet } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { errorText } from "./parts";

const f = t.filesPage;

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified?: string;
}
interface TrashEntry {
  id: string;
  path: string;
  name: string;
  type: string;
  size: number;
  deletedAt: string;
}

export function FilesPanel({ panel, onClose }: PanelProps<"files">) {
  const [group, setGroup] = useState<"computer" | "members">(panel.group ?? "computer");
  return (
    <Sheet
      title={f.title}
      onClose={onClose}
      wide
      actions={
        <div className="fp-tabs" role="tablist">
          {(["computer", "members"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={group === key}
              className={cx("fp-tab", group === key && "on")}
              onClick={() => setGroup(key)}
            >
              {f.groups[key]}
            </button>
          ))}
        </div>
      }
    >
      <div className="tp fp">
        {group === "computer" ? (
          <ComputerFiles start={panel.path} onClose={onClose} />
        ) : (
          <MembersFiles />
        )}
      </div>
    </Sheet>
  );
}

// ───────────────────────────── 电脑 ─────────────────────────────

type View = { kind: "dir"; path: string } | { kind: "file"; path: string } | { kind: "trash" };

function fmtWhen(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function KindIcon({ entry }: { entry: Pick<Entry, "type" | "name"> }) {
  if (entry.type === "directory") return <Folder size={16} />;
  const kind = workspaceFileKind(entry.name);
  if (kind === "image") return <FileImage size={16} />;
  if (kind === "markdown" || kind === "text") return <FileText size={16} />;
  return <FileIcon size={16} />;
}

function ComputerFiles({ start, onClose }: { start?: string; onClose: () => void }) {
  const { api, notify } = useWorkspace();
  const nav = useShellNav();
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null | undefined>(undefined);
  const startIsFile = !!start && start !== "/workspace" && /\.[^/]+$/.test(start);
  const [view, setView] = useState<View>(
    start
      ? startIsFile
        ? { kind: "file", path: start }
        : { kind: "dir", path: start }
      : { kind: "dir", path: "/workspace" },
  );
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [delivered, setDelivered] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const ensured = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let gone = false;
    api
      .request<ComputerSnapshot>("/api/computer")
      .then((value) => !gone && setSnapshot(value))
      .catch(() => !gone && setSnapshot(null));
    return () => {
      gone = true;
    };
  }, [api]);
  // The members' computer container is always there to wake; another provider's computer counts
  // only once it exists (the hosted site with no computer made says `created: false`).
  const connected =
    !!snapshot &&
    snapshot.enabled !== false &&
    snapshot.status !== "unconfigured" &&
    snapshot.provider !== "none" &&
    (snapshot.provider === "desktop" || snapshot.created !== false);
  // The full page (upload, download, rename, the recycle bin) is the members' computer's; another
  // provider has only the folder tree and Markdown.
  const full = connected && snapshot?.provider === "desktop";
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  // The folder shown, and 成品's newest files at the root.
  useEffect(() => {
    if (!connected || view.kind !== "dir") return;
    let gone = false;
    setEntries(null);
    setError("");
    const load = async () => {
      try {
        let listing = await api.request<{ entries: Entry[] }>(
          `/api/computer/files?path=${encodeURIComponent(view.path)}`,
        );
        if (view.path === "/workspace" && full && !ensured.current) {
          ensured.current = true;
          const names = new Set(listing.entries.map((entry) => entry.name));
          const missing = [receivedFolder, deliveredFolder].filter((name) => !names.has(name));
          if (missing.length) {
            for (const name of missing)
              await api.request("/api/computer/files/mkdir", { path: `/workspace/${name}` });
            listing = await api.request<{ entries: Entry[] }>(
              `/api/computer/files?path=${encodeURIComponent(view.path)}`,
            );
          }
        }
        if (gone) return;
        // The desktop's own hidden folders (.cache, .config…) are not the person's files.
        setEntries(listing.entries.filter((entry) => !entry.name.startsWith(".")));
        if (view.path === "/workspace") {
          const done = await api
            .request<{ entries: Entry[] }>(
              `/api/computer/files?path=${encodeURIComponent(deliveredPath)}`,
            )
            .catch(() => ({ entries: [] as Entry[] }));
          if (gone) return;
          setDelivered(
            done.entries
              .filter((entry) => entry.type === "file")
              .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
              .slice(0, 5),
          );
        }
      } catch (e) {
        if (!gone) setError(errorText(e));
      }
    };
    void load();
    return () => {
      gone = true;
    };
  }, [api, connected, full, view, version]);

  async function act(step: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await step();
      refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const here = view.kind === "dir" ? view.path : "/workspace";

  const newFolder = () => {
    const raw = window.prompt(f.newFolderPrompt);
    if (raw === null) return;
    const name = cleanFileName(raw);
    if (!name) return setError(f.badName);
    void act(async () => {
      await api.request("/api/computer/files/mkdir", { path: `${here}/${name}` });
    });
  };
  const rename = (entry: Entry) => {
    const raw = window.prompt(f.renamePrompt, entry.name);
    if (raw === null || raw === entry.name) return;
    const name = cleanFileName(raw);
    if (!name) return setError(f.badName);
    void act(async () => {
      await api.request("/api/computer/files/rename", {
        path: entry.path,
        to: `${parentPath(entry.path)}/${name}`,
      });
    });
  };
  const remove = (entry: Entry) => {
    if (!window.confirm(f.deleteConfirm(entry.name))) return;
    void act(async () => {
      await api.request("/api/computer/files/delete", { path: entry.path });
      notify(f.deleted(entry.name));
    });
  };
  const upload = (file: globalThis.File) => {
    if (file.size > workspaceFileMaxBytes) return setError(f.tooBig);
    void act(async () => {
      await uploadTo(api, `${here}/${file.name}`, file);
      notify(f.uploaded(file.name));
    });
  };
  const download = (entry: Pick<Entry, "path" | "name">) =>
    void downloadFrom(api, entry.path, entry.name).catch((e) => setError(errorText(e)));
  const askMember = (path: string) => {
    nav.prefill(f.askMemberText(path));
    onClose();
  };

  if (snapshot === undefined) return <p className="tp-small">{f.loading}</p>;
  if (!connected) return <p className="tp-small">{f.noComputer}</p>;

  if (view.kind === "trash")
    return (
      <TrashView
        onBack={() => setView({ kind: "dir", path: "/workspace" })}
        onRestored={(path) => {
          notify(f.restored(path));
        }}
      />
    );

  if (view.kind === "file")
    return (
      <FileView
        path={view.path}
        full={full}
        onBack={() => setView({ kind: "dir", path: parentPath(view.path) })}
        onDownload={() =>
          download({ path: view.path, name: view.path.slice(view.path.lastIndexOf("/") + 1) })
        }
        onAskMember={() => askMember(view.path)}
      />
    );

  const crumbs = pathCrumbs(view.path, f.root);
  return (
    <>
      <nav className="fp-crumbs" aria-label={f.root}>
        {crumbs.map((crumb, i) => (
          <span key={crumb.path}>
            {i > 0 ? <span className="fp-sep">/</span> : null}
            {i === crumbs.length - 1 ? (
              <span className="fp-here">{crumb.label}</span>
            ) : (
              <button
                type="button"
                className="fp-crumb"
                onClick={() => setView({ kind: "dir", path: crumb.path })}
              >
                {crumb.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      <div className="fp-bar">
        {full ? (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) upload(file);
              }}
            />
            <Btn
              className="sm"
              icon={Upload}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? f.uploading : f.upload}
            </Btn>
          </>
        ) : null}
        <Btn className="sm" icon={FolderPlus} disabled={busy} onClick={newFolder}>
          {f.newFolder}
        </Btn>
        {full ? (
          <Btn
            className="sm"
            icon={Trash2}
            disabled={busy}
            onClick={() => setView({ kind: "trash" })}
          >
            {f.trash}
          </Btn>
        ) : null}
      </div>
      {view.path === "/workspace" ? <p className="tp-small">{f.folderHint}</p> : null}
      {snapshot?.status === "stopped" && entries === null ? (
        <p className="tp-small">{f.computerOff}</p>
      ) : null}
      <ErrorLine error={error} />
      {view.path === "/workspace" && delivered.length ? (
        <section className="fp-strip">
          <h4>{f.deliveredStrip}</h4>
          {delivered.map((entry) => (
            <div key={entry.path} className="fp-row">
              <KindIcon entry={entry} />
              <button
                type="button"
                className="fp-name"
                onClick={() => setView({ kind: "file", path: entry.path })}
              >
                {entry.name}
              </button>
              <span className="fp-meta">{fmtWhen(entry.modified)}</span>
              {full ? (
                <button
                  type="button"
                  className="fp-act"
                  title={f.download}
                  onClick={() => download(entry)}
                >
                  <Download size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {entries === null && !error ? <p className="tp-small">{f.loading}</p> : null}
      {entries && entries.length === 0 ? <p className="tp-small">{f.empty}</p> : null}
      {entries?.map((entry) => (
        <div key={entry.path} className="fp-row">
          <KindIcon entry={entry} />
          <button
            type="button"
            className="fp-name"
            disabled={entry.type === "symlink"}
            onClick={() =>
              setView(
                entry.type === "directory"
                  ? { kind: "dir", path: entry.path }
                  : { kind: "file", path: entry.path },
              )
            }
          >
            {entry.name}
            {entry.type === "directory" ? "/" : ""}
          </button>
          <span className="fp-meta">
            {entry.type === "file" ? sizeLabel(entry.size) : ""}
            {entry.modified ? ` · ${fmtWhen(entry.modified)}` : ""}
          </span>
          {full ? (
            <span className="fp-acts">
              {entry.type === "file" ? (
                <button
                  type="button"
                  className="fp-act"
                  title={f.download}
                  onClick={() => download(entry)}
                >
                  <Download size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="fp-act"
                title={f.rename}
                disabled={busy}
                onClick={() => rename(entry)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="fp-act"
                title={f.delete}
                disabled={busy}
                onClick={() => remove(entry)}
              >
                <Trash2 size={14} />
              </button>
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

type Api = ReturnType<typeof useWorkspace>["api"];

async function uploadTo(api: Api, path: string, file: Blob) {
  const response = await fetch(
    api.url(`/api/computer/files/upload?path=${encodeURIComponent(path)}`),
    {
      method: "POST",
      headers: { ...api.headers(), "Content-Type": "application/octet-stream" },
      body: file,
    },
  );
  if (!response.ok) throw new Error(await errorOf(response));
}

async function fetchBytes(api: Api, path: string, inline: boolean): Promise<Blob> {
  const response = await fetch(
    api.url(
      `/api/computer/files/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
    ),
    { headers: api.headers() },
  );
  if (!response.ok) throw new Error(await errorOf(response));
  return response.blob();
}

async function downloadFrom(api: Api, path: string, name: string) {
  const blob = await fetchBytes(api, path, false);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // no body
  }
  return `HTTP ${response.status}`;
}

/** One file of the computer, by its kind. */
function FileView({
  path,
  full,
  onBack,
  onDownload,
  onAskMember,
}: {
  path: string;
  full: boolean;
  onBack: () => void;
  onDownload: () => void;
  onAskMember: () => void;
}) {
  const { api, notify } = useWorkspace();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind: WorkspaceFileKind = workspaceFileKind(name);
  const [text, setText] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let gone = false;
    let url: string | null = null;
    setText(null);
    setBlobUrl(null);
    setError("");
    setDirty(false);
    if (kind === "markdown" || kind === "text") {
      api
        .request<{ text: string }>("/api/computer/files/read", { path })
        .then((file) => !gone && setText(file.text))
        .catch((e) => !gone && setError(errorText(e)));
    } else if ((kind === "image" || kind === "pdf") && full) {
      fetchBytes(api, path, true)
        .then((blob) => {
          if (gone) return;
          url = URL.createObjectURL(blob);
          setBlobUrl(url);
        })
        .catch((e) => !gone && setError(errorText(e)));
    }
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, path, kind, full]);

  async function save() {
    if (text === null || saving) return;
    setSaving(true);
    setError("");
    try {
      await api.request("/api/computer/files/write", { path, text });
      setDirty(false);
      notify(f.saved);
    } catch {
      setError(f.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const crumbs = pathCrumbs(parentPath(path), f.root);
  return (
    <>
      <div className="fp-filehead">
        <Btn className="sm" icon={ArrowLeft} onClick={onBack}>
          {f.back}
        </Btn>
        <span className="fp-meta">
          {crumbs.map((crumb) => crumb.label).join(" / ")} / <strong>{name}</strong> ·{" "}
          {f.kinds[kind]}
        </span>
      </div>
      <div className="fp-bar">
        {full ? (
          <Btn className="sm" icon={Download} onClick={onDownload}>
            {f.download}
          </Btn>
        ) : null}
        <Btn className="sm" onClick={onAskMember}>
          {f.askMember}
        </Btn>
        {kind === "markdown" ? (
          <Btn
            className="sm"
            variant="pri"
            busy={saving}
            disabled={text === null || !dirty}
            onClick={() => void save()}
          >
            {saving ? f.saving : f.save}
          </Btn>
        ) : null}
      </div>
      <p className="tp-small">
        {kind === "markdown"
          ? f.editHint
          : kind === "text" || kind === "image" || kind === "pdf"
            ? f.viewHint
            : f.binaryHint}
      </p>
      <ErrorLine error={error} />
      {kind === "markdown" ? (
        <textarea
          className="input mf-text"
          aria-label={name}
          value={text ?? ""}
          disabled={text === null}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
        />
      ) : null}
      {kind === "text" ? <pre className="fp-pre">{text ?? (error ? "" : f.loading)}</pre> : null}
      {kind === "image" && full ? (
        blobUrl ? (
          <img className="fp-image" src={blobUrl} alt={name} />
        ) : error ? null : (
          <p className="tp-small">{f.loading}</p>
        )
      ) : null}
      {kind === "pdf" && full && blobUrl ? (
        <iframe className="fp-pdf" src={blobUrl} title={name} />
      ) : null}
    </>
  );
}

/** The recycle bin: what was deleted, 找回, 彻底删除. */
function TrashView({
  onBack,
  onRestored,
}: {
  onBack: () => void;
  onRestored: (path: string) => void;
}) {
  const { api } = useWorkspace();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [days, setDays] = useState(trashDays);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let gone = false;
    api
      .request<{ entries: TrashEntry[]; days: number }>("/api/computer/files/trash")
      .then((bin) => {
        if (gone) return;
        setEntries(bin.entries);
        setDays(bin.days);
      })
      .catch((e) => !gone && setError(errorText(e)));
    return () => {
      gone = true;
    };
  }, [api, version]);
  const act = (step: () => Promise<void>) =>
    void step()
      .then(() => setVersion((n) => n + 1))
      .catch((e) => setError(errorText(e)));
  return (
    <>
      <div className="fp-filehead">
        <Btn className="sm" icon={ArrowLeft} onClick={onBack}>
          {f.back}
        </Btn>
        <strong>{f.trash}</strong>
      </div>
      <p className="tp-small">{f.trashHint(days)}</p>
      <ErrorLine error={error} />
      {entries === null && !error ? <p className="tp-small">{f.loading}</p> : null}
      {entries && entries.length === 0 ? <p className="tp-small">{f.trashEmpty}</p> : null}
      {entries?.map((entry) => (
        <div key={entry.id} className="fp-row fp-trashrow">
          <KindIcon
            entry={{ type: entry.type === "directory" ? "directory" : "file", name: entry.name }}
          />
          <span className="fp-name fp-static">
            {entry.name}
            <span className="fp-meta">
              {f.from(parentPath(entry.path).replace(/^\/workspace/, f.root))} ·{" "}
              {f.deletedAt(fmtWhen(entry.deletedAt))}
              {entry.type === "file" ? ` · ${sizeLabel(entry.size)}` : ""}
            </span>
          </span>
          <span className="fp-acts">
            <Btn
              className="sm"
              icon={RotateCcw}
              onClick={() =>
                act(async () => {
                  const back = await api.request<{ path: string }>("/api/computer/files/restore", {
                    id: entry.id,
                  });
                  onRestored(back.path);
                })
              }
            >
              {f.restore}
            </Btn>
            <Btn
              className="sm"
              variant="danger"
              onClick={() => {
                if (!window.confirm(f.purgeConfirm(entry.name))) return;
                act(async () => {
                  await api.request("/api/computer/files/purge", { id: entry.id });
                });
              }}
            >
              {f.purge}
            </Btn>
          </span>
        </div>
      ))}
    </>
  );
}

// ───────────────────────────── 成员文件 ─────────────────────────────

interface Member {
  id: string;
  name: string;
  projectId: string | null;
}

function MembersFiles() {
  const everyone = useAllMembers();
  const members = useMemo<Member[]>(() => {
    const seen = new Set<string>([yukiMemberId]);
    const list: Member[] = [{ id: yukiMemberId, name: t.app.name, projectId: null }];
    for (const member of everyone) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      list.push({ id: member.id, name: member.name, projectId: member.projectId });
    }
    return list;
  }, [everyone]);
  const [open, setOpen] = useState<string>(yukiMemberId);
  const [editing, setEditing] = useState<{ member: Member; path: string } | null>(null);
  if (editing)
    return (
      <MemberFileEditor
        member={editing.member}
        path={editing.path}
        onBack={() => setEditing(null)}
      />
    );
  return (
    <>
      <p className="tp-small">{f.membersHint}</p>
      {members.map((member) => (
        <section key={member.id} className="fp-member">
          <button
            type="button"
            className={cx("fp-memberhead", open === member.id && "on")}
            aria-expanded={open === member.id}
            onClick={() => setOpen(open === member.id ? "" : member.id)}
          >
            {member.name}
          </button>
          {open === member.id ? (
            <MemberFileList member={member} onOpen={(path) => setEditing({ member, path })} />
          ) : null}
        </section>
      ))}
    </>
  );
}

function MemberFileList({ member, onOpen }: { member: Member; onOpen: (path: string) => void }) {
  const { apiFor } = useShellData();
  const [files, setFiles] = useState<
    { path: string; updatedAt: string; updatedBy: string }[] | null
  >(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    apiFor(member.projectId)
      .request<unknown>(memberFilesPath(member.id))
      .then((raw) => !gone && setFiles(normalizeFileList(raw)))
      .catch(() => !gone && setError(t.memberFiles.loadFailed));
    return () => {
      gone = true;
    };
  }, [apiFor, member]);
  const notes = files ? recentNotes(files, localDay()) : [];
  const fixed = ["AGENTS.md", "MEMORY.md"];
  const row = (path: string, label: string, meta?: string) => (
    <div key={path} className="fp-row">
      <FileText size={16} />
      <button type="button" className="fp-name" onClick={() => onOpen(path)}>
        {label}
      </button>
      <span className="fp-meta">{meta ?? ""}</span>
    </div>
  );
  return (
    <>
      <ErrorLine error={error} />
      {files === null && !error ? <p className="tp-small">{f.loading}</p> : null}
      {files
        ? fixed.map((path) => {
            const file = files.find((entry) => entry.path === path);
            return row(
              path,
              `${path} · ${t.memberFiles.pathNames[path] ?? ""}`,
              file ? changedLine(file) : t.memberFiles.empty,
            );
          })
        : null}
      {files ? row(`notes/${localDay()}.md`, `${t.memberFiles.notes} · ${localDay()}`) : null}
      {notes
        .filter((note) => note.day !== localDay())
        .map((note) => row(note.path, `${t.memberFiles.notes} · ${note.day}`))}
    </>
  );
}

function MemberFileEditor({
  member,
  path,
  onBack,
}: {
  member: Member;
  path: string;
  onBack: () => void;
}) {
  const { apiFor } = useShellData();
  const { notify } = useWorkspace();
  const [text, setText] = useState<string | null>(null);
  const [meta, setMeta] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let gone = false;
    setText(null);
    apiFor(member.projectId)
      .request<unknown>(memberFilesPath(member.id, path))
      .then((raw) => {
        if (gone) return;
        const file = normalizeFile(raw);
        setText(file?.content ?? "");
        setMeta(file ? changedLine(file) : "");
      })
      .catch(() => {
        if (gone) return;
        if (path.startsWith("notes/")) setText("");
        else setError(t.memberFiles.loadFailed);
      });
    return () => {
      gone = true;
    };
  }, [apiFor, member, path]);
  async function save() {
    if (text === null || saving) return;
    if (!fitsFileLimit(text)) return setError(t.memberFiles.tooLong);
    setSaving(true);
    setError("");
    try {
      await apiFor(member.projectId).request(
        memberFilesPath(member.id, path),
        { content: text },
        "PUT",
      );
      setDirty(false);
      notify(f.saved);
    } catch {
      setError(t.memberFiles.saveFailed);
    } finally {
      setSaving(false);
    }
  }
  const whatIs = f.whatIs[path] ?? (path.startsWith("notes/") ? f.whatIs.notes : "");
  return (
    <>
      <div className="fp-filehead">
        <Btn className="sm" icon={ArrowLeft} onClick={onBack}>
          {f.back}
        </Btn>
        <span className="fp-meta">
          {member.name} / <strong>{path}</strong>
          {meta ? ` · ${t.memberFiles.changed(meta)}` : ""}
        </span>
        <Btn
          className="sm"
          variant="pri"
          busy={saving}
          disabled={text === null || !dirty}
          onClick={() => void save()}
        >
          {saving ? f.saving : f.save}
        </Btn>
      </div>
      {whatIs ? <p className="tp-small">{whatIs}</p> : null}
      <ErrorLine error={error} />
      <textarea
        className="input mf-text"
        aria-label={path}
        value={text ?? ""}
        disabled={text === null}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
    </>
  );
}
