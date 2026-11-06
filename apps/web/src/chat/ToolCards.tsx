/**
 * Phase C (docs/web.md): the chat's tool cards, from mail-tool-card.tsx, search-tool-card.tsx,
 * browser-tool-card.tsx, desktop-tool-card.tsx (with environment-scope.tsx's DesktopToolCard) and
 * jev-tool-card.tsx. The results are read by tool-cards-core.ts and jev-actions.ts, as on the
 * phone. The desktop's live view belongs to the desktop sheet: the chat's desktop card is compact
 * (the step, the latest screenshot, 启动 when the desktop is off) and opens the sheet.
 */
import {
  EnvironmentScope,
  useDesktopHoldReason,
  useThreadEnvironmentScope,
} from "@m/environment-scope-state";
import {
  choiceAvailability,
  parseJevResult,
  retryChoiceAvailable,
  selectionText,
} from "@m/jev-actions";
import { computerStepFailed, computerStepText } from "@m/shell/chat/computer-steps";
import { type DesktopRun, desktopRunView } from "@m/shell/chat/core";
import { t } from "@m/shell/strings";
import {
  browserObservation,
  computerShotId,
  mailSearchResult,
  mailThreadResult,
  searchResult,
  siteLabel,
  toolResultError,
  toolResultValue,
} from "@m/tool-cards-core";
import { useWorkspace } from "@m/workspace";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe2,
  Hand,
  Mail,
  Monitor,
  RotateCw,
  Search,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import type { BrowserSession } from "../../../../packages/domain/src";
import type { JevOption, JevPanel } from "../../../../packages/domain/src/jev";
import { Btn, ErrorLine, Skeleton, Spinner } from "../ui/primitives";
import { BrowserRunContext, DesktopFoldContext, JevInteractionContext } from "./context";
import { useAuthedImage } from "./parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A page coming back into view stands for the app coming to the foreground (AppState). */
function useOnVisible(listener: () => void) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) ref.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}

// ───────────────────────────── mail ─────────────────────────────

export function MailToolCard({
  result,
  loading,
  search = false,
}: {
  result: unknown;
  loading: boolean;
  search?: boolean;
}) {
  const { open } = useWorkspace();
  const w = t.mailTools;
  const { active } = useContext(BrowserRunContext);
  const value = toolResultValue(result);
  const error = toolResultError(value);
  if (error !== undefined) return <ErrorLine error={error} />;
  if (loading)
    return (
      <div className="row muted" style={{ padding: "6px 0" }}>
        {active ? <span className="spin" /> : <Mail size={14} />}
        {!active ? w.paused : search ? w.checking : w.reading}
      </div>
    );
  if (search) {
    const parsed = mailSearchResult(value);
    if (!parsed) return <ErrorLine error={w.unreadableSearch} />;
    return (
      <div className="row muted" style={{ padding: "6px 0" }}>
        <Search size={14} />
        {parsed.count ? w.found(parsed.count, parsed.truncated) : w.noMatches}
      </div>
    );
  }
  const parsed = mailThreadResult(value);
  if (!parsed) return <ErrorLine error={w.unreadable} />;
  const message = parsed.messages.at(-1);
  if (!message) return <span className="muted">{w.empty}</span>;
  return (
    <div className="tcard">
      <div className="th">
        <span className="ic">
          <Mail size={16} />
        </span>
        <span className="grow">
          <div className="t">{message.sender}</div>
          <div className="d">{w.meta(parsed.messages.length)}</div>
        </span>
      </div>
      <b>{message.subject}</b>
      <div
        className="muted"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {message.body}
      </div>
      {parsed.truncated ? <span className="hint">{w.excerpt}</span> : null}
      <div className="acts-row start">
        <Btn className="sm" icon={Mail} onClick={() => open({ type: "mail", mail: message })}>
          {w.open}
        </Btn>
      </div>
    </div>
  );
}

// ───────────────────────────── search_web ─────────────────────────────

export function SearchToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const w = t.webTools;
  const { active } = useContext(BrowserRunContext);
  const value = toolResultValue(result);
  const error = toolResultError(value);
  const parsed = searchResult(value);
  const working = loading && active;
  const failure = error !== undefined ? error : !loading && !parsed ? w.searchUnreadable : "";
  const sources = parsed ? parsed.sources : [];
  const count = sources.length;
  return (
    <div className="tcard">
      <div className="row">
        {working ? <span className="spin" /> : <Search size={15} />}
        <span>
          {failure
            ? w.searchFailed
            : working
              ? w.searching
              : loading
                ? w.searchStopped
                : count
                  ? w.found(count)
                  : w.noSources}
        </span>
      </div>
      {!loading && parsed ? (
        <>
          {sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">
              {source.title || source.url}
            </a>
          ))}
          {parsed.truncated ? <span className="hint">{w.truncated}</span> : null}
          {parsed.warnings.map((warning) => (
            <span key={warning} className="hint">
              {warning}
            </span>
          ))}
        </>
      ) : null}
      <ErrorLine error={failure} />
    </div>
  );
}

// ───────────────────────────── browse_web ─────────────────────────────

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { api, workspace, open } = useWorkspace();
  const w = t.webTools;
  const { running, active } = useContext(BrowserRunContext);
  const working = loading && active;
  const value = toolResultValue(result);
  const visited = browserObservation(value);
  const toolError = toolResultError(value);
  const sessionId = visited?.sessionId;
  const current = workspace.browsers.find((browser) => browser.id === sessionId);
  const [browser, setBrowser] = useState<BrowserSession>();
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(0);
  useOnVisible(() => setVisible((n) => n + 1));
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setError("");
    setPreviewFailed(false);
    api
      .request<BrowserSession>(`/api/browsers/${encodeURIComponent(sessionId)}`)
      .then((session) => {
        if (alive) setBrowser(session);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
    // `retry` (重新连接) and `visible` (the page back in view) read the session again.
  }, [api, sessionId, current?.updatedAt, retry, visible]);
  // A later turn can reuse the same browser. Never label that new page as an old source.
  const preview =
    browser?.status === "active" && browser.url === visited?.url && !previewFailed
      ? browser.previewUrl
      : undefined;
  const failure = toolError ?? (!loading && !visited ? w.noPage : "");
  return (
    <div className="tcard">
      <div className="th">
        <span className="ic">
          <Globe2 size={16} />
        </span>
        <span className="grow">
          <div className="t">{w.browser}</div>
          <div className="d">
            {working
              ? w.reading
              : loading
                ? w.browsingPaused
                : failure
                  ? w.readFailed
                  : siteLabel(visited?.url)}
          </div>
        </span>
        {working ? (
          <span className="spin" />
        ) : visited ? (
          <Check size={16} aria-label={w.pageRead} style={{ color: "var(--green)" }} />
        ) : null}
      </div>
      {preview ? (
        <img
          className="shot"
          src={api.url(preview)}
          alt={w.preview(visited?.title ?? "")}
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <div className="ph">
          <span style={{ color: "var(--fg)" }}>{visited?.title || siteLabel(url)}</span>
          {working ? (
            <Skeleton lines={3} />
          ) : visited ? (
            <span>
              {browser && browser.url !== visited.url
                ? w.movedOn
                : browser?.status === "closed"
                  ? w.sessionSaved
                  : browser?.status === "error"
                    ? w.sessionError
                    : previewFailed
                      ? w.previewUnavailable
                      : w.connecting}
            </span>
          ) : null}
        </div>
      )}
      <ErrorLine error={failure || error} />
      <div className="acts-row start">
        {!loading && visited ? (
          <Btn
            icon={Hand}
            disabled={!browser || running}
            onClick={() => browser && open({ type: "browser", browser })}
          >
            {w.takeControl}
          </Btn>
        ) : null}
        {error ? (
          <Btn className="sm" icon={RotateCw} onClick={() => setRetry((attempt) => attempt + 1)}>
            {w.reconnect}
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────────── desktop steps ─────────────────────────────

/**
 * The renderer of every desktop step
 * (use_desktop, and a command that opens the desktop browser). A step draws nothing unless it is
 * the first of its run (shell/chat/core.ts `desktopFold`); that one draws the run's block, scoped
 * to the conversation's account: its 打开桌面 opens that desktop, and says why instead while the
 * selection loads or names a deleted account.
 */
export function DesktopStepCard({ toolCallId }: { toolCallId: string }) {
  const { fold, replying } = useContext(DesktopFoldContext);
  const run = fold.get(toolCallId);
  const environment = useThreadEnvironmentScope();
  const reason = useDesktopHoldReason();
  if (!run || run.at !== toolCallId) return null;
  return (
    <EnvironmentScope environment={environment}>
      <DesktopRunBlock
        run={run}
        replying={replying}
        who={environment?.name ?? null}
        hold={reason}
      />
    </EnvironmentScope>
  );
}

/** v1.5.1: a step on the members' computer, one line in a reply's folded 过程: what the member did
 * there in plain words, and 没成功 when it did not. */
export function ComputerStepLine({
  name,
  args,
  result,
  loading,
}: {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  loading: boolean;
}) {
  const failed = !loading && computerStepFailed(result);
  return (
    <div className="hint" aria-busy={loading}>
      {computerStepText(name, args)}
      {failed ? t.computerSteps.failed : null}
    </div>
  );
}

/** A command: on the hosted desktop, a command that opened the desktop browser is a step of that
 * desktop run (DesktopStepCard draws the run once); any other command is a line of its own. */
export function CommandStepCard({
  toolCallId,
  args,
  result,
  loading,
}: {
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
  loading: boolean;
}) {
  const { fold } = useContext(DesktopFoldContext);
  if (fold.get(toolCallId)) return <DesktopStepCard toolCallId={toolCallId} />;
  return (
    <ComputerStepLine name="run_computer_command" args={args} result={result} loading={loading} />
  );
}

/** A screenshot a member took of the computer (computer_screenshot, open build): the picture
 * itself, so 「截图给我看」 shows it. The server keeps it for an hour. */
export function ComputerShotCard({ result, loading }: { result: unknown; loading: boolean }) {
  const c = t.containerComputer;
  const id = loading ? null : computerShotId(result);
  const shot = useAuthedImage(id ? `/api/computer/screenshots/${encodeURIComponent(id)}` : null);
  if (!loading && !id) return null;
  return (
    <div className="tcard" aria-busy={loading || shot.state === "loading"}>
      <div className="th">
        <span className="ic">
          <Monitor size={16} />
        </span>
        <span className="grow">
          <div className="t">{c.screenshot}</div>
          {loading ? (
            <div className="d">{c.shooting}</div>
          ) : shot.state === "none" ? (
            <div className="d">{c.shotGone}</div>
          ) : null}
        </span>
        {loading ? <span className="spin" /> : null}
      </div>
      {shot.state === "image" ? (
        <img className="shot" src={shot.src} alt={c.screenshot} onError={shot.fail} />
      ) : loading || shot.state === "loading" ? (
        <div className="ph">
          <Skeleton lines={3} />
        </div>
      ) : null}
    </div>
  );
}

/** One block for a reply's desktop steps: while the reply works on it, the live line
 * (「正在 Nova_Harrison 的桌面上操作 · 第 3 步 · 点击」) with the latest shot and one 打开桌面;
 * once the reply ended, one line (「在桌面上做了 3 步」) that opens on a click to the steps in
 * plain words, the latest shot and 打开桌面. The full step list stays where it was (the task
 * detail, the desktop sheet); the conversation never stacks a card per step. */
export function DesktopRunBlock({
  run,
  replying,
  who,
  hold,
}: {
  run: DesktopRun;
  replying: boolean;
  who: string | null;
  hold: string | null;
}) {
  const { open, notify } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const view = desktopRunView(run, replying, who);
  const shot = useAuthedImage(
    view.receiptId
      ? `/api/computer/desktop/screenshot?receipt=${encodeURIComponent(view.receiptId)}`
      : null,
  );
  const picture =
    shot.state === "image" ? (
      <img className="shot" src={shot.src} alt={t.desktop.screenshot} onError={shot.fail} />
    ) : null;
  const openDesktop = (
    <div className="acts-row start">
      <Btn
        className="sm"
        icon={Monitor}
        onClick={() => (hold ? notify(hold) : open({ type: "computer", focus: "desktop" }))}
      >
        {t.accountDetail.openDesktop}
      </Btn>
    </div>
  );
  if (view.live)
    return (
      <div className="tcard" role="status" aria-label={view.line} aria-busy="true">
        <div className="th">
          <span className="ic">
            <Spinner />
          </span>
          <span className="grow">
            <div className="t">{view.line}</div>
          </span>
        </div>
        {picture}
        {openDesktop}
      </div>
    );
  return (
    <div className="drun">
      <button
        type="button"
        className={view.failed ? "drun-line red" : "drun-line"}
        aria-expanded={expanded}
        aria-label={`${expanded ? t.desktop.collapseSteps : t.desktop.expandSteps}${t.common.colon}${view.line}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <Monitor size={14} />
        <span>{view.line}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded ? (
        <div className="tcard">
          <ol className="drun-steps">
            {run.steps.map((step) => (
              <li key={step.id} className={step.failed ? "red" : undefined}>
                {step.words}
                {step.failed ? `${t.common.sep}${t.desktop.stepFailed}` : ""}
              </li>
            ))}
          </ol>
          {picture}
          {openDesktop}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── present_choices ─────────────────────────────

function ChoiceButton({
  panel,
  option,
  disabled,
  pending,
  selected,
  position,
  onChoose,
}: {
  panel: JevPanel;
  option: JevOption;
  disabled: boolean;
  pending: boolean;
  selected: boolean;
  position: number;
  onChoose: (optionId: string) => void;
}) {
  if (panel.type === "comparison") {
    const caption = /exhibit/i.test(panel.title) ? t.choices.chooseExhibit : t.choices.chooseOption;
    return (
      <div>
        <Btn
          className="sm"
          variant="pri"
          aria-label={t.choices.chooseLabel(caption, option.label, position)}
          aria-pressed={selected}
          disabled={disabled}
          busy={pending}
          icon={selected ? Check : undefined}
          onClick={() => onChoose(option.id)}
        >
          {caption}
        </Btn>
      </div>
    );
  }
  return (
    <Btn
      className="sm"
      disabled={disabled}
      busy={pending}
      aria-pressed={selected}
      icon={selected ? Check : undefined}
      onClick={() => onChoose(option.id)}
    >
      {option.label}
    </Btn>
  );
}

export function JevToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const interaction = useContext(JevInteractionContext);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [failedOptionId, setFailedOptionId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const pendingRef = useRef(false);
  if (loading) return <Spinner label={t.choices.preparing} />;
  const parsed = parseJevResult(result);
  if (!parsed) return <ErrorLine error={t.choices.unreadable} />;
  if (parsed.error) return <ErrorLine error={parsed.error} />;
  const panel = parsed.panel;
  if (!panel) return null;

  const availability = choiceAvailability(
    panel,
    interaction.threadId || "",
    interaction.latestPanelId,
    interaction.busy,
    submittingId !== null ||
      confirmedId !== null ||
      interaction.confirmedSelection(panel.id) !== null,
  );
  const stale = availability === "wrong-thread" || availability === "stale";
  const selectedId = panel.selectedId || confirmedId || interaction.confirmedSelection(panel.id);
  const preferredOption = panel.preferredId
    ? panel.options.find((option) => option.id === panel.preferredId)
    : undefined;
  const disabled = availability !== "ready";

  async function choose(optionId: string, retrying = false) {
    const priorConfirmedId =
      panel?.selectedId || confirmedId || (panel && interaction.confirmedSelection(panel.id));
    if (
      !panel ||
      pendingRef.current ||
      priorConfirmedId ||
      (retrying
        ? !retryChoiceAvailable(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            failedOptionId,
            interaction.latestUserText,
            !!priorConfirmedId,
            !interaction.canRetry,
          ) || optionId !== failedOptionId
        : choiceAvailability(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            interaction.busy,
            false,
          ) !== "ready")
    )
      return;
    pendingRef.current = true;
    setSubmittingId(optionId);
    setSubmitError("");
    try {
      await (retrying ? interaction.retry : interaction.send)(selectionText(panel, optionId));
      setConfirmedId(optionId);
      setFailedOptionId(null);
    } catch (error) {
      setFailedOptionId(optionId);
      setSubmitError(errorText(error));
    } finally {
      pendingRef.current = false;
      setSubmittingId(null);
    }
  }

  return (
    <div className="tcard">
      <div className="stack" style={{ gap: 2, marginTop: 0 }}>
        <b>{panel.title}</b>
        {panel.mode === "sample" ? <span className="hint">{t.choices.sample}</span> : null}
        {panel.mode === "live" ? <span className="hint">{t.choices.live}</span> : null}
        {preferredOption && !selectedId ? (
          <span className="hint">{t.choices.preferred(preferredOption.label)}</span>
        ) : null}
        {stale ? <span className="hint">{t.choices.earlier}</span> : null}
        {selectedId ? <span className="hint">{t.choices.submitted}</span> : null}
      </div>
      {panel.type === "clarification" ? (
        <div className="acts-row start">
          {panel.options.map((option, index) => (
            <ChoiceButton
              key={option.id}
              panel={panel}
              option={option}
              disabled={disabled}
              pending={submittingId === option.id}
              selected={selectedId === option.id}
              position={index + 1}
              onChoose={(id) => void choose(id)}
            />
          ))}
        </div>
      ) : (
        panel.options.map((option, index) => (
          <div key={option.id} className="opt">
            <b>{option.label}</b>
            {option.details.length ? (
              <ul className="muted">
                {option.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
            {option.sources.map((source) => (
              <a
                key={`${option.id}-${source.url}`}
                className="src"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t.choices.source(source.title)}
              >
                {source.title}
                <ExternalLink size={12} />
              </a>
            ))}
            <ChoiceButton
              panel={panel}
              option={option}
              disabled={disabled}
              pending={submittingId === option.id}
              selected={selectedId === option.id}
              position={index + 1}
              onChoose={(id) => void choose(id)}
            />
          </div>
        ))
      )}
      <ErrorLine error={submitError} />
      {failedOptionId && !selectedId ? (
        <div>
          <Btn
            className="sm"
            disabled={
              !retryChoiceAvailable(
                panel,
                interaction.threadId || "",
                interaction.latestPanelId,
                failedOptionId,
                interaction.latestUserText,
                false,
                !interaction.canRetry || submittingId !== null,
              )
            }
            onClick={() => void choose(failedOptionId, true)}
          >
            {t.choices.retry}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
