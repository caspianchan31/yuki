/**
 * Phase C (docs/web.md): the live desktop and the Linux workspace of the desktop sheet, from
 * desktop-stream.tsx and computer-workspace.tsx (their web paths: the stream is embedded in a
 * sandboxed frame). The state is the phone's (desktop-stream-state.ts,
 * computer-workspace-state.ts); this file draws it.
 */

import {
  desktopExists,
  parentFolder,
  straightQuotes,
  useComputerFiles,
  useLinuxWorkspace,
  type WorkspaceTab,
  workspaceStatusText,
} from "@m/computer-workspace-state";
import { desktopUrl, useDesktopStream } from "@m/desktop-stream-state";
import { serverText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { type ComputerCommand, type ComputerSnapshot, isDesktopProvider } from "@openmuse/domain";
import {
  ArrowLeft,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Hammer,
  Monitor,
  Play,
  Power,
  RefreshCw,
  Save,
  Terminal,
  Upload,
} from "lucide-react";
import { memo, useState } from "react";
import { Btn, cx, ErrorLine, Field, Skeleton } from "../ui/primitives";
import { BrowserConsole, Callout, CodeArea, EmptyNote, LinkRow } from "./bits";
import { DesktopScope, useComputerDraft, useDesktopScope } from "./scope";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Opens a URL in a window of its own (the phone's Linking.openURL on the web). */
export function openWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The running desktop, embedded and kept awake while shown, with 打开桌面 for a window of its
 * own. Memoized on its props, so a parent re-render never remounts the VNC session. */
export const DesktopStream = memo(function DesktopStream({
  running,
  embed = true,
}: {
  running: boolean;
  /** False shows only the 打开桌面 button. */
  embed?: boolean;
}) {
  const { api } = useWorkspace();
  const { url, error, setError } = useDesktopStream(running && embed);
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    setError("");
    // A window opened before the request keeps the browser from blocking it as a popup.
    const pending = embed && url ? null : window.open("about:blank", "_blank");
    try {
      const target = embed && url ? url : await desktopUrl(api);
      if (pending) {
        pending.opener = null;
        pending.location.href = target;
      } else openWindow(target);
    } catch (e) {
      pending?.close();
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  }
  return (
    <div className="lg-stack">
      <ErrorLine error={error} />
      {embed && !url && !error ? <div className="sk lg-frame-sk" aria-hidden="true" /> : null}
      {url && embed ? <BrowserConsole url={url} title={t.computer.desktopFrame} sandboxed /> : null}
      {running && (!embed || url) ? (
        <div className="row">
          <Btn icon={ExternalLink} disabled={opening} onClick={() => void open()}>
            {opening ? t.computer.opening : t.computer.openDesktop}
          </Btn>
        </div>
      ) : null}
    </div>
  );
});

/** Live view of the computer's desktop, shared with the chat's desktop card. */
function ComputerDesktop({ running }: { running: boolean }) {
  if (!running)
    return (
      <EmptyNote
        icon={Monitor}
        title={t.computer.desktopOff}
        detail={t.computer.desktopOffDetail}
      />
    );
  return (
    <div className="lg-stack">
      <DesktopStream running />
      <p className="hint">{t.computer.desktopShared}</p>
    </div>
  );
}

/**
 * An account's (or the default) desktop, live, for other areas (the pinned desktop, a peek): the
 * scope of `environmentId` (null: the default desktop) and its stream while it runs, polled
 * like the sheet's workspace. `embed` false shows only 打开桌面.
 */
export function DesktopView({
  environmentId,
  name = "",
  embed = true,
}: {
  environmentId: string | null;
  name?: string;
  embed?: boolean;
}) {
  return (
    <div className="lg">
      <DesktopScope environment={environmentId ? { id: environmentId, name } : null}>
        <DesktopViewInner embed={embed} />
      </DesktopScope>
    </div>
  );
}
function DesktopViewInner({ embed }: { embed: boolean }) {
  const command = useComputerDraft("command");
  const cwd = useComputerDraft("cwd");
  const { snapshot, error, connectionError, running } = useLinuxWorkspace({
    tab: "Desktop",
    command,
    cwd,
  });
  if (!snapshot)
    return error || connectionError ? (
      <ErrorLine error={error || connectionError} />
    ) : (
      <Skeleton lines={3} />
    );
  if (!isDesktopProvider(snapshot.provider) || !running)
    return (
      <EmptyNote
        icon={Monitor}
        title={t.computer.desktopOff}
        detail={t.computer.desktopOffDetail}
      />
    );
  return <DesktopStream running embed={embed} />;
}

/** The Linux desktop: its state, start / stop, the terminal, the files and the live desktop. */
export function LinuxWorkspace({
  tab,
  onSnapshot,
}: {
  tab: WorkspaceTab;
  onSnapshot?: (snapshot: ComputerSnapshot) => void;
}) {
  const { environment } = useDesktopScope();
  const c = t.computer;
  const [command, setCommand] = useComputerDraft("command");
  const [cwd, setCwd] = useComputerDraft("cwd");
  // The confirmation step of 重建桌面 is open.
  const [rebuilding, setRebuilding] = useState(false);
  const {
    snapshot,
    error,
    connectionError,
    busy,
    running,
    commandRunning,
    showHistory,
    setShowHistory,
    editingCommand,
    setEditingCommand,
    control,
    run,
    reload,
  } = useLinuxWorkspace({ tab, command: [command, setCommand], cwd: [cwd, setCwd], onSnapshot });
  async function rebuild() {
    if (await control("destroy")) setRebuilding(false);
  }
  return (
    <div className="lg-stack wide">
      <div className="lg-status">
        <Terminal size={18} className="lg-ico" />
        <div className="grow">
          <div className="lg-strong">{c.workspace}</div>
          <div className="muted">{workspaceStatusText(snapshot)}</div>
        </div>
        {!snapshot && !error ? <span className="spin" aria-hidden="true" /> : null}
      </div>
      {snapshot?.message ? <p className="hint">{serverText(snapshot.message)}</p> : null}
      {snapshot?.enabled ? (
        <div className="row">
          {running ? (
            <Btn icon={Power} busy={busy} onClick={() => void control("stop")}>
              {c.stop}
            </Btn>
          ) : (
            <Btn variant="pri" icon={Play} busy={busy} onClick={() => void control("start")}>
              {c.start}
            </Btn>
          )}
          {desktopExists(snapshot) ? (
            <Btn icon={Hammer} disabled={busy || rebuilding} onClick={() => setRebuilding(true)}>
              {c.rebuild}
            </Btn>
          ) : null}
          <Btn icon={RefreshCw} disabled={busy} onClick={reload}>
            {c.refresh}
          </Btn>
        </div>
      ) : null}
      {/* what destroying this desktop means, then the one button that
          does it; the step stays open with the error when the server refuses (a run holds it). */}
      {rebuilding && desktopExists(snapshot) ? (
        <Callout tone="amber" title={c.rebuild}>
          <p className="muted">{c.rebuildConfirm}</p>
          <div className="row">
            <Btn variant="danger" icon={Hammer} busy={busy} onClick={() => void rebuild()}>
              {c.rebuildNow}
            </Btn>
            <Btn disabled={busy} onClick={() => setRebuilding(false)}>
              {c.cancel}
            </Btn>
          </div>
        </Callout>
      ) : null}
      <ErrorLine error={error || connectionError} />
      {!snapshot && (error || connectionError) ? (
        <div className="row">
          <Btn onClick={reload}>{c.retryConnection}</Btn>
        </div>
      ) : null}
      {snapshot?.enabled ? (
        <>
          <div
            className="lg-stack wide"
            style={{ display: tab === "Terminal" ? undefined : "none" }}
          >
            {editingCommand || command.length > 0 || snapshot.commands.length === 0 ? (
              <div className="lg-term">
                <div className="hint lg-mono">{c.terminal}</div>
                <Field
                  label={c.cwd}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  className="input lg-mono"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <CodeArea
                  label={c.command}
                  value={command}
                  onChange={setCommand}
                  placeholder="pwd"
                  rows={3}
                  maxLength={16000}
                />
                {/[‘’“”]/.test(command) ? (
                  <div className="row">
                    <Btn onClick={() => setCommand(straightQuotes)}>{c.straightQuotes}</Btn>
                  </div>
                ) : null}
                <div className="row">
                  <Btn
                    variant="pri"
                    icon={Play}
                    busy={commandRunning}
                    disabled={!running || !command.trim() || busy}
                    onClick={() => void run()}
                  >
                    {c.runCommand}
                  </Btn>
                </div>
                <p className="hint">
                  {snapshot.network === "enabled" ? c.networkOn : c.networkOff}
                </p>
              </div>
            ) : (
              <div className="row">
                <Btn
                  variant="pri"
                  icon={Terminal}
                  disabled={!running || busy || commandRunning}
                  onClick={() => setEditingCommand(true)}
                >
                  {c.newCommand}
                </Btn>
              </div>
            )}
            {commandRunning ? <p className="muted">{c.commandRunning}</p> : null}
            {snapshot.commands.length === 0 ? (
              <EmptyNote
                icon={Terminal}
                title={c.firstCommandTitle}
                detail={c.firstCommandDetail}
              />
            ) : (
              [...snapshot.commands]
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                .slice(0, showHistory ? undefined : 5)
                .map((item) => <CommandReceipt key={item.id} run={item} />)
            )}
            {snapshot.commands.length > 5 ? (
              <div className="row">
                <Btn onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? c.showRecent : c.showEarlier}
                </Btn>
              </div>
            ) : null}
          </div>
          <div style={{ display: tab === "Files" ? undefined : "none" }}>
            <ComputerFiles running={running} active={tab === "Files"} />
          </div>
          {isDesktopProvider(snapshot.provider) && tab === "Desktop" ? (
            <ComputerDesktop running={running} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const timeLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(t.app.lang, { hour: "numeric", minute: "2-digit" });
};

function CommandReceipt({ run }: { run: ComputerCommand }) {
  const [expanded, setExpanded] = useState(true);
  const tone = run.status === "succeeded" ? "ok" : run.status === "running" ? "lg-accent" : "err";
  return (
    <div className="lg-receipt">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className={cx("lg-small", tone)}>
          {t.computer.commandStatus[run.status] ?? run.status.replace("_", " ")}
          {run.exitCode !== undefined ? t.computer.exitCode(run.exitCode) : ""}
        </span>
        <span className="hint">{timeLabel(run.startedAt)}</span>
      </div>
      <pre className="lg-pre strong">{`$ ${run.command}`}</pre>
      <div className="hint lg-mono">{run.cwd}</div>
      {expanded ? (
        <>
          {run.stdout ? <pre className="lg-pre">{run.stdout}</pre> : null}
          {run.stderr ? <pre className="lg-pre err">{run.stderr}</pre> : null}
          {!run.stdout && !run.stderr && run.status !== "running" ? (
            <p className="hint">{t.computer.noOutput}</p>
          ) : null}
          {run.truncated ? <p className="hint">{t.computer.outputTruncated}</p> : null}
        </>
      ) : null}
      {run.stdout || run.stderr ? (
        <div className="row">
          <Btn onClick={() => setExpanded(!expanded)}>
            {expanded ? t.computer.hideOutput : t.computer.showOutput}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function ComputerFiles({ running, active }: { running: boolean; active: boolean }) {
  const { workspace } = useWorkspace();
  const c = t.computer;
  const pathDraft = useComputerDraft("path");
  const editorDraft = useComputerDraft("editor");
  const {
    path,
    setPath,
    editor,
    setEditor,
    directory,
    error,
    notice,
    busy,
    loading,
    dirty,
    folder,
    setFolder,
    importing,
    setImporting,
    reload,
    importDocument,
    save,
    mkdir,
    openEntry,
    newFile,
    closeEditor,
  } = useComputerFiles({ running, active, path: pathDraft, editor: editorDraft });
  return (
    <div className="lg-stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="lg-strong">{c.files}</div>
        {busy || loading ? <span className="spin" aria-hidden="true" /> : null}
      </div>
      <div className="hint lg-mono lg-select">{editor?.path || path}</div>
      <ErrorLine error={error} />
      {notice ? <p className="ok">{notice}</p> : null}
      {!running ? <p className="muted">{c.filesOff}</p> : null}
      {editor ? (
        <>
          <Field
            label={c.filePath}
            value={editor.path}
            onChange={(e) => setEditor({ ...editor, path: e.target.value })}
            className="input lg-mono"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <CodeArea
            label={c.fileContents}
            value={editor.text}
            onChange={(text) => setEditor({ ...editor, text })}
            rows={12}
          />
          <div className="row">
            <Btn
              variant="pri"
              icon={Save}
              busy={busy}
              disabled={!running || !editor.path.trim()}
              onClick={() => void save()}
            >
              {c.saveFile}
            </Btn>
            <Btn disabled={busy} icon={ArrowLeft} onClick={closeEditor}>
              {dirty ? c.discard : c.backToFiles}
            </Btn>
          </div>
        </>
      ) : (
        <>
          <div className="row">
            {path !== "/workspace" ? (
              <Btn disabled={busy} icon={ArrowLeft} onClick={() => setPath(parentFolder(path))}>
                {c.up}
              </Btn>
            ) : null}
            <Btn disabled={!running || busy} icon={FilePlus2} onClick={newFile}>
              {c.newFile}
            </Btn>
            <Btn disabled={!running || busy} icon={FolderPlus} onClick={() => setFolder("")}>
              {c.newFolder}
            </Btn>
            <Btn disabled={!running || busy} icon={RefreshCw} onClick={reload}>
              {c.refreshFiles}
            </Btn>
            <Btn disabled={!running || busy} icon={Upload} onClick={() => setImporting(!importing)}>
              {importing ? c.hideDocuments : c.copyDocument}
            </Btn>
          </div>
          {importing ? (
            <div className="lg-box">
              <div className="lg-strong">{c.choosePdf}</div>
              <p className="hint">{c.copyHint}</p>
              {workspace.files.map((file) => (
                <LinkRow
                  key={file.id}
                  icon={FileText}
                  title={file.name}
                  onClick={() => void importDocument(file)}
                />
              ))}
              {!workspace.files.length ? <p className="muted">{c.noDocuments}</p> : null}
            </div>
          ) : null}
          {folder !== undefined ? (
            <form
              className="lg-box"
              onSubmit={(e) => {
                e.preventDefault();
                if (running && folder.trim()) void mkdir();
              }}
            >
              <Field
                label={c.folderName}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoFocus
              />
              <div className="row">
                <Btn type="submit" variant="pri" disabled={!running || !folder.trim()} busy={busy}>
                  {c.createFolder}
                </Btn>
                <Btn disabled={busy} onClick={() => setFolder(undefined)}>
                  {c.cancel}
                </Btn>
              </div>
            </form>
          ) : null}
          {running && directory?.path === path ? (
            <div>
              {directory.entries.map((entry) => (
                <LinkRow
                  key={entry.path}
                  icon={entry.type === "directory" ? Folder : FileText}
                  title={entry.name}
                  detail={
                    entry.type === "directory"
                      ? c.folder
                      : entry.type === "symlink"
                        ? c.symlink
                        : c.kb(Math.max(1, Math.ceil(entry.size / 1024)))
                  }
                  onClick={() => openEntry(entry)}
                />
              ))}
            </div>
          ) : null}
          {running &&
          !busy &&
          !loading &&
          !error &&
          directory?.path === path &&
          directory.entries.length === 0 ? (
            <EmptyNote icon={Folder} title={c.emptyTitle} detail={c.emptyDetail} />
          ) : null}
        </>
      )}
    </div>
  );
}
