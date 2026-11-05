/**
 * Phase C (docs/web.md): 项目资料 as a panel, from shell/notes/NotesPanel.tsx: the brief the
 * tasks follow (edited in place, following the server text while the box is untouched) and the
 * project's memories.
 */

import { useShellData } from "@m/shell/data";
import { briefStatus } from "@m/shell/rail/rail-model";
import { t } from "@m/shell/strings";
import { useEffect, useRef, useState } from "react";
import { Btn, ErrorLine, Section, Sheet, TextArea } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { errorText } from "./parts";

export function NotesPanel({ onClose }: PanelProps<"notes">) {
  const { memories, brief } = useShellData();
  const shown = memories.filter((memory) => !memory.accountId);
  const list = shown.length ? (
    <ul className="tp-lines" style={{ margin: 0, paddingLeft: 18 }}>
      {shown.map((memory) => (
        <li key={memory.id}>{memory.text}</li>
      ))}
    </ul>
  ) : (
    <p className="tp-small">{t.notes.noMemories}</p>
  );
  return (
    <Sheet title={t.notes.title} onClose={onClose}>
      <div className="tp">
        {brief.available ? <BriefBox /> : null}
        {brief.available ? <Section title={t.notes.memories}>{list}</Section> : list}
        <p className="tp-small">{t.notes.memoriesHint}</p>
      </div>
    </Sheet>
  );
}

/** The project brief, saved with 保存. */
export function BriefBox() {
  const { brief, now } = useShellData();
  const server = brief.value.text;
  const [draft, setDraft] = useState(server);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // Follow the server text while the person has not changed the box.
  const lastServer = useRef(server);
  useEffect(() => {
    setDraft((current) => (current === lastServer.current ? server : current));
    lastServer.current = server;
  }, [server]);
  const dirty = draft !== server;
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await brief.save(draft);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const status = briefStatus(brief.value.updatedAt, saved && !dirty, now);
  return (
    <div className="tp" style={{ gap: 6 }}>
      <TextArea
        label={t.notes.briefLabel}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        placeholder={t.notes.briefPlaceholder}
        readOnly={brief.loading}
        style={{ minHeight: 96, fontSize: 13 }}
      />
      <div className="row">
        <Btn
          className="sm"
          variant={dirty ? "pri" : undefined}
          busy={saving}
          disabled={!dirty || brief.loading}
          onClick={() => void save()}
        >
          {saving ? t.common.saving : t.notes.briefSave}
        </Btn>
        {status ? <span className="tp-faint">{status}</span> : null}
      </div>
      <ErrorLine
        error={error || brief.error ? `${t.common.errorPrefix}${error || brief.error}` : null}
      />
    </div>
  );
}
