/**
 * v1.5 (docs/member-files.md): a member's AGENTS.md, MEMORY.md and daily notes on her card: the
 * beginning of each with 打开, and an editor panel (monospace text, 保存, 取消, who changed it
 * last). Yuki's card uses the same pieces with the member id `yuki`.
 */

import { useShellData } from "@m/shell/data";
import {
  changedLine,
  filePreview,
  fitsFileLimit,
  localDay,
  memberFilesPath,
  normalizeFile,
  normalizeFileList,
  recentNotes,
} from "@m/shell/members/member-files";
import { t } from "@m/shell/strings";
import { useCallback, useEffect, useState } from "react";
import { Btn, ErrorLine, Sheet } from "../ui/primitives";
import "./member-files.css";

const f = t.memberFiles;

interface Loaded {
  contents: Record<string, string>;
  notes: { day: string; path: string }[];
}

export function useMemberFiles(
  memberId: string | undefined,
  projectId: string | null,
  name: string,
) {
  const { apiFor } = useShellData();
  const [loaded, setLoaded] = useState<(Loaded & { for: string }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!memberId) return;
    let gone = false;
    let timer = 0;
    const load = async () => {
      try {
        const api = apiFor(projectId);
        const files = normalizeFileList(await api.request<unknown>(memberFilesPath(memberId)));
        const contents: Record<string, string> = {};
        for (const path of ["AGENTS.md", "MEMORY.md"])
          if (files.some((file) => file.path === path)) {
            const file = normalizeFile(await api.request<unknown>(memberFilesPath(memberId, path)));
            if (file) contents[path] = file.content;
          }
        if (gone) return;
        setLoaded({ for: memberId, contents, notes: recentNotes(files, localDay()) });
        setFailed(false);
      } catch {
        if (gone) return;
        setFailed(true);
        timer = window.setTimeout(() => void load(), 5_000);
      }
    };
    void load();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [memberId, projectId, apiFor, version]);

  const here = loaded && loaded.for === memberId ? loaded : null;
  const close = useCallback(() => setEditing(null), []);
  const editor =
    memberId && editing ? (
      <FileEditor
        memberId={memberId}
        projectId={projectId}
        name={name}
        path={editing}
        onClose={close}
        onSaved={() => {
          setEditing(null);
          setVersion((n) => n + 1);
        }}
      />
    ) : null;
  return { loaded: here, failed: failed && !here, open: setEditing, editor };
}

type MemberFilesView = ReturnType<typeof useMemberFiles>;

/** The beginning of one file, and 打开. */
export function FilePreview({ files, path }: { files: MemberFilesView; path: string }) {
  const content = files.loaded?.contents[path];
  const preview = content === undefined ? "" : filePreview(content);
  return (
    <div className="member-card mf-card">
      <div className="member-duty mf-preview">
        {preview || (files.failed ? f.loadFailed : files.loaded ? f.empty : "")}
      </div>
      <div className="member-actions">
        <button
          type="button"
          className="member-run quiet"
          disabled={!files.loaded}
          onClick={() => files.open(path)}
        >
          {f.open}
        </button>
      </div>
    </div>
  );
}

/** The last 7 days' notes, each with 打开. */
export function NotesList({ files }: { files: MemberFilesView }) {
  const notes = files.loaded?.notes ?? [];
  return (
    <div className="member-card mf-card">
      {files.failed ? <div className="roster-line">{f.loadFailed}</div> : null}
      {files.loaded && notes.length === 0 ? <div className="roster-line">{f.noNotes}</div> : null}
      {notes.map((note) => (
        <div key={note.path} className="mf-note">
          <span>{note.day}</span>
          <button type="button" className="member-run quiet" onClick={() => files.open(note.path)}>
            {f.open}
          </button>
        </div>
      ))}
      <div className="roster-line">{f.notesHint}</div>
    </div>
  );
}

function FileEditor({
  memberId,
  projectId,
  name,
  path,
  onClose,
  onSaved,
}: {
  memberId: string;
  projectId: string | null;
  name: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiFor } = useShellData();
  const [text, setText] = useState<string | null>(null);
  const [meta, setMeta] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let gone = false;
    setText(null);
    apiFor(projectId)
      .request<unknown>(memberFilesPath(memberId, path))
      .then((raw) => {
        if (gone) return;
        const file = normalizeFile(raw);
        setText(file?.content ?? "");
        setMeta(file ? changedLine(file) : "");
      })
      .catch(() => {
        if (gone) return;
        // A day with no note yet opens empty.
        if (path.startsWith("notes/")) setText("");
        else setError(f.loadFailed);
      });
    return () => {
      gone = true;
    };
  }, [memberId, projectId, path, apiFor]);

  async function save() {
    if (text === null || saving) return;
    if (!fitsFileLimit(text)) {
      setError(f.tooLong);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFor(projectId).request(memberFilesPath(memberId, path), { content: text }, "PUT");
      onSaved();
    } catch {
      setError(f.saveFailed);
      setSaving(false);
    }
  }

  return (
    <Sheet
      title={f.editorTitle(name, path)}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="roster-line mf-meta">{f.changed(meta)}</span>
          <Btn onClick={onClose} disabled={saving}>
            {f.cancel}
          </Btn>
          <Btn variant="pri" busy={saving} disabled={text === null} onClick={() => void save()}>
            {saving ? f.saving : f.save}
          </Btn>
        </>
      }
    >
      <p className="roster-line">
        {f.pathNames[path] ? `${f.pathNames[path]} · ${f.hint}` : f.hint}
      </p>
      <textarea
        className="input mf-text"
        aria-label={path}
        value={text ?? ""}
        disabled={text === null}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <ErrorLine error={error} />
    </Sheet>
  );
}
