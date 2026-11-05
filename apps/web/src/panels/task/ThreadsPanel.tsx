/**
 * Phase C (docs/web.md): the conversation switcher behind 「主聊天 ▾」, from
 * shell/ThreadSwitcher.tsx (which replaced the conversation part of threads.tsx ThreadsSheet):
 * 主聊天 (this project's command channel), 开新主聊天 (archives the current main chat, found under
 * 已归档, and opens an empty one; no confirmation, since nothing is lost), the side chats (opened
 * here but not saved yet as 「侧聊 n」, then the saved ones) with 改名 / 归档 / 恢复, 加载更多对话,
 * the 已归档 toggle, and 「+ 新侧聊」.
 */

import { useThreads } from "@copilotkit/react-native/headless";
import { rememberThreads, sideThreadRows, type ThreadRowModel } from "@m/shell/frame/thread-rows";
import { useProjectTitle } from "@m/shell/store-space";
import { t } from "@m/shell/strings";
import { useMuseThread } from "@m/threads-state";
import { Archive, ArchiveRestore, Pencil, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Btn, ErrorLine, Field, Sheet, Skeleton } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { errorText, OptionRow } from "./parts";

export function ThreadsPanel({ onClose }: PanelProps<"threads">) {
  const projectName = useProjectTitle();
  const {
    enabled,
    selection,
    visited,
    mainId,
    loading,
    error: mainError,
    retry,
    select,
    start,
    startNewMain,
  } = useMuseThread();
  const threads = useThreads({ agentId: "default", enabled, includeArchived: true, limit: 20 });
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [renewing, setRenewing] = useState(false);
  useEffect(() => {
    rememberThreads(threads.threads);
  }, [threads.threads]);

  const open = (id: string, existing: boolean) => {
    select({ id, existing });
    onClose();
  };
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
    } catch (e) {
      setError(`${t.common.errorPrefix}${errorText(e)}`);
    }
  }
  const mainRow = (
    <OptionRow
      title={t.threads.main}
      detail={t.threads.mainHint(projectName)}
      selected={selection.id === mainId}
      onClick={() => open(mainId, true)}
    />
  );
  // 开新主聊天, right under 主聊天. It opens the new main chat and a toast
  // says where the old one went.
  async function renewMain() {
    setError("");
    setRenewing(true);
    try {
      await startNewMain();
      onClose();
    } catch (e) {
      setError(`${t.common.errorPrefix}${errorText(e)}`);
    } finally {
      setRenewing(false);
    }
  }
  if (!enabled)
    return (
      <Sheet title={t.threads.title} onClose={onClose}>
        <div className="tp">{mainRow}</div>
      </Sheet>
    );
  if (loading)
    return (
      <Sheet title={t.threads.title} onClose={onClose}>
        <div className="tp">
          {mainError ? (
            <>
              <ErrorLine error={`${t.common.errorPrefix}${mainError}`} />
              <Btn className="sm" style={{ alignSelf: "flex-start" }} onClick={retry}>
                {t.threads.retryMain}
              </Btn>
            </>
          ) : (
            <Skeleton lines={4} />
          )}
        </div>
      </Sheet>
    );

  const rows = sideThreadRows({
    visited,
    saved: threads.threads,
    mainId,
    selectedId: selection.id,
    archived,
  });
  return (
    <Sheet
      title={t.threads.title}
      onClose={onClose}
      footer={
        archived ? undefined : (
          <Btn
            variant="pri"
            icon={Plus}
            onClick={() => {
              start();
              onClose();
            }}
          >
            {t.threads.newSide}
          </Btn>
        )
      }
    >
      <div className="tp">
        <div className="tp-lines">
          {mainRow}
          <div className="row">
            <Btn
              className="sm ghost"
              icon={RotateCcw}
              busy={renewing}
              onClick={() => void renewMain()}
            >
              {t.threads.newMain}
            </Btn>
          </div>
        </div>
        <section className="tp-lines" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4
              className="sec-h"
              style={{
                margin: 0,
                fontSize: 11,
                letterSpacing: "0.06em",
                color: "var(--fg3)",
                fontWeight: 600,
              }}
            >
              {archived ? t.threads.archived : t.threads.side}
            </h4>
            <button
              type="button"
              className="linkbtn muted"
              aria-pressed={archived}
              onClick={() => {
                setArchived(!archived);
                setEditing(undefined);
              }}
            >
              {archived ? t.threads.showActive : `${t.threads.archived} ${t.fold.closed}`}
            </button>
          </div>
          {threads.isLoading ? <Skeleton lines={3} /> : null}
          {threads.listError ? (
            <div className="row">
              <ErrorLine error={t.threads.listError} />
              <Btn className="sm" onClick={threads.refetchThreads}>
                {t.threads.retry}
              </Btn>
            </div>
          ) : null}
          <ErrorLine error={error} />
          {rows.map((row) => (
            <SideRow
              key={row.id}
              row={row}
              editing={editing === row.id}
              name={name}
              busy={threads.isMutating}
              onOpen={() =>
                open(
                  row.id,
                  row.saved || (visited.find((item) => item.id === row.id)?.existing ?? false),
                )
              }
              onName={setName}
              onRename={() => {
                if (editing === row.id) {
                  if (name.trim()) void mutate(() => threads.renameThread(row.id, name.trim()));
                } else {
                  setEditing(row.id);
                  setName(row.label === t.threads.untitled ? "" : row.label);
                }
              }}
              onCancelRename={() => setEditing(undefined)}
              onArchive={() =>
                void mutate(() =>
                  row.archived ? threads.unarchiveThread(row.id) : threads.archiveThread(row.id),
                )
              }
            />
          ))}
          {!threads.isLoading && !threads.listError && !rows.length ? (
            <p className="muted">{archived ? t.threads.noArchived : t.progress.web.noSide}</p>
          ) : null}
          {threads.fetchMoreError ? <ErrorLine error={t.threads.moreError} /> : null}
          {threads.hasMoreThreads ? (
            <Btn
              className="sm"
              style={{ alignSelf: "flex-start" }}
              busy={threads.isFetchingMoreThreads}
              onClick={threads.fetchMoreThreads}
            >
              {t.threads.loadMore}
            </Btn>
          ) : null}
        </section>
        <p className="tp-small">{t.threads.sideHint}</p>
      </div>
    </Sheet>
  );
}

function SideRow({
  row,
  editing,
  name,
  busy,
  onOpen,
  onName,
  onRename,
  onCancelRename,
  onArchive,
}: {
  row: ThreadRowModel;
  editing: boolean;
  name: string;
  busy: boolean;
  onOpen: () => void;
  onName: (name: string) => void;
  onRename: () => void;
  onCancelRename: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="tp-lines">
      <OptionRow
        title={row.label}
        label={t.threads.open(row.label)}
        selected={row.selected}
        onClick={onOpen}
      />
      {row.saved && editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRename();
          }}
        >
          <Field
            label={t.threads.nameLabel}
            value={name}
            onChange={(e) => onName(e.target.value)}
            autoFocus
          />
        </form>
      ) : null}
      {row.saved ? (
        <div className="row">
          <Btn
            className="sm"
            icon={Pencil}
            disabled={busy || (editing && !name.trim())}
            onClick={onRename}
          >
            {editing ? t.threads.saveName : t.threads.rename}
          </Btn>
          {editing ? (
            <Btn className="sm ghost" onClick={onCancelRename}>
              {t.common.cancel}
            </Btn>
          ) : (
            <Btn
              className="sm ghost"
              icon={row.archived ? ArchiveRestore : Archive}
              disabled={busy}
              onClick={onArchive}
            >
              {row.archived ? t.threads.restore : t.threads.archive}
            </Btn>
          )}
        </div>
      ) : null}
    </div>
  );
}
