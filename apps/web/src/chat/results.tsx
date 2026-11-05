/**
 * Phase C (docs/web.md): what a task produced, as the chat shows it: TaskResults and
 * FileThreadCard (thread-artifacts.tsx), ArtifactCard and its finance form (agent-ui.tsx), and the
 * browser session card the chat borrows from computer.tsx (BrowserThreadCard). Opening a file or a
 * browser goes to its legacy sheet (useWorkspace().open), as on the phone.
 */
import { useAgentWorkspace } from "@m/agent-workspace";
import { taskResultsKey } from "@m/shell/chat/core";
import {
  artifactFields,
  artifactView,
  foldText,
  humanizeKey,
  kindLabel,
} from "@m/shell/results/artifact-core";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { ChevronRight, FileText, Globe2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Artifact, BrowserSession } from "../../../../packages/domain/src";
import type { AgentArtifact, AgentTask } from "../../../../packages/domain/src/agent";
import { Btn, ErrorLine, Field, Pill } from "../ui/primitives";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FileThreadCard({ file }: { file: Artifact }) {
  const { open } = useWorkspace();
  const words = t.files;
  return (
    <button
      type="button"
      className="tcard"
      style={{ textAlign: "left" }}
      aria-label={words.open(file.name)}
      onClick={() => open({ type: "file", file })}
    >
      <div className="ph">
        <b style={{ color: "var(--fg)" }}>{file.name.replace(/\.pdf$/i, "")}</b>
        {file.fields?.length ? (
          <div className="kvs">
            {file.fields.slice(0, 4).map((field) => (
              <div key={field.name} style={{ display: "contents" }}>
                <span className="k">{field.name.replace(/_/g, " ").toUpperCase()}</span>
                <span>{field.value || "—"}</span>
              </div>
            ))}
          </div>
        ) : (
          <span>{words.pages(file.pageCount)}</span>
        )}
      </div>
      <div className="th">
        <span className="ic">
          <FileText size={16} />
        </span>
        <span className="grow">
          <div className="t">{file.name}</div>
          <div className="d">{words.kind}</div>
        </span>
        <ChevronRight size={16} className="hint" />
      </div>
    </button>
  );
}

/** A browser session the chat shows (computer.tsx BrowserThreadCard): its page, a preview while
 * it is live, and the way into it. */
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { open } = useWorkspace();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  const c = t.computer;
  return (
    <div className="tcard">
      <div className="th">
        <span className="ic">
          <Globe2 size={16} />
        </span>
        <span className="grow">
          <div className="t">{c.browser}</div>
          <div className="d">
            {browser.status === "closed"
              ? c.sessionSaved
              : browser.status === "error"
                ? c.sessionAttention
                : browser.title}
          </div>
        </span>
      </div>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <img
          className="shot"
          src={browser.previewUrl}
          alt={c.preview(browser.title)}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="ph" style={{ alignItems: "center", textAlign: "center" }}>
          <Globe2 size={24} />
          <span style={{ overflowWrap: "anywhere" }}>
            {failed ? c.previewUnavailable : browser.url}
          </span>
        </div>
      )}
      <div className="acts-row start">
        <Btn onClick={() => open({ type: "browser", browser })}>
          {browser.status === "closed"
            ? c.reopenBrowser
            : browser.status === "error"
              ? c.reconnectBrowser
              : c.takeControl}
        </Btn>
      </div>
    </div>
  );
}

/**
 * What a delegated task produced (files, documents, browser sessions),
 * shown under its task card in chat. Hydrated by ID on replay (signed URLs are never stored in
 * messages), and only for a task that has results, once per new result.
 */
export function TaskResults({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  const results = taskResultsKey(task);
  const [detail, setDetail] = useState<{
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!results) return;
    let active = true;
    void api
      .request<{ artifacts: AgentArtifact[]; files: Artifact[]; browsers: BrowserSession[] }>(
        `/api/agent/tasks/${encodeURIComponent(task.id)}`,
      )
      .then((result) => {
        if (active) {
          setDetail(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
    // `attempt` reads again on 重新读取任务结果.
  }, [api, task.id, results, attempt]);
  if (!results) return null;
  return (
    <>
      {detail?.browsers?.map((browser) => (
        <BrowserThreadCard key={browser.id} browser={browser} />
      ))}
      {[...(detail?.files || [])]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 1)
        .map((file) => (
          <FileThreadCard key={file.id} file={file} />
        ))}
      {detail?.artifacts?.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
      <ErrorLine error={error} />
      {error ? (
        <div>
          <Btn className="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t.tools.reloadResults}
          </Btn>
        </div>
      ) : null}
    </>
  );
}

/**
 * What a task produced, in the owner's words: the heading and every key from the
 * model humanized, nested objects as a short 「名：值」 list, long text folded; 查看完整结果 / 收起
 * only when something is folded (results/artifact-core.ts).
 */
export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [expanded, setExpanded] = useState(false);
  if (artifact.kind === "finance") return <FinanceArtifact artifact={artifact} />;
  const view = artifactView(artifactFields(artifact.data), expanded);
  return (
    <div className="tcard">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <b style={{ minWidth: 0 }}>{humanizeKey(artifact.title)}</b>
        <Pill>{kindLabel(artifact.kind)}</Pill>
      </div>
      {artifact.summary ? (
        <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
          {expanded ? artifact.summary : foldText(artifact.summary, 280)}
        </div>
      ) : null}
      {view.fields.map((field) => (
        <div key={field.key} className="fld">
          <div className="lbl">{field.label}</div>
          {field.value.type === "list" ? (
            <ul>
              {field.value.items.map((item, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the items have no id of their own
                <li key={`${field.key}-${index}`}>{item}</li>
              ))}
            </ul>
          ) : field.value.type === "pairs" ? (
            <div className="kvs">
              {field.value.pairs.map((pair, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two keys can humanize alike
                <div key={`${pair.label}-${index}`} style={{ display: "contents" }}>
                  <span className="k">{pair.label}</span>
                  <span style={{ textAlign: "right" }}>{pair.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className={field.value.type === "number" ? "num" : undefined}>
              {field.value.text}
            </div>
          )}
        </div>
      ))}
      {view.more || (artifact.summary?.length ?? 0) > 280 ? (
        <div>
          <Btn className="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? t.artifacts.less : t.artifacts.more}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}

/** The finance report (agent-ui.tsx FinanceArtifact): the period's income, spending and savings,
 * where the money went, a goal to save it as, and the transactions. */
function FinanceArtifact({ artifact }: { artifact: AgentArtifact }) {
  const fw = t.artifacts.finance;
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { mutate } = useAgentWorkspace();
  const [goalTitle, setGoalTitle] = useState("");
  const [goalSaved, setGoalSaved] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState("");
  const saveGoal = async () => {
    setGoalBusy(true);
    setGoalError("");
    try {
      await mutate("/goals", {
        title: goalTitle.trim(),
        category: "Finances",
        description: fw.goalDescription(artifact.title, artifact.summary),
        milestones: [...fw.goalMilestones],
      });
      setGoalSaved(true);
    } catch (error) {
      setGoalError(errorText(error));
    } finally {
      setGoalBusy(false);
    }
  };
  const amount = (value: unknown) =>
    Number(value ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const categories = Array.isArray(artifact.data.categories) ? artifact.data.categories : [];
  const transactions = Array.isArray(artifact.data.transactions) ? artifact.data.transactions : [];
  const spending = Number(artifact.data.spending) || 1;
  const period = record(artifact.data.period);
  return (
    <div className="tcard">
      <button
        type="button"
        aria-label={fw.open(artifact.title)}
        aria-expanded={details}
        onClick={() => setDetails(!details)}
        style={{ textAlign: "left" }}
        className="stack"
      >
        <span className="hint" style={{ whiteSpace: "pre-line" }}>
          {`${fw.source}\n${String(period?.from ?? "")} — ${String(period?.to ?? "")}\n${fw.count(transactions.length)}`}
        </span>
        <span className="kvs" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {(
            [
              [fw.income, "income"],
              [fw.spending, "spending"],
              [fw.saved, "saved"],
            ] as const
          ).map(([label, key]) => (
            <span key={key} className="ph" style={{ padding: 10, gap: 2 }}>
              <span className="hint">{label}</span>
              <span
                className="num"
                style={{ fontSize: 17, color: key === "saved" ? "var(--green)" : "var(--fg)" }}
              >
                {amount(artifact.data[key])}
              </span>
              <span className="hint">{fw.currency}</span>
            </span>
          ))}
        </span>
        <span className="th">
          <span className="grow">
            <span className="t">{fw.name}</span>
            <span className="d" style={{ display: "block" }}>
              {fw.tagline}
            </span>
          </span>
          <ChevronRight size={16} className="hint" />
        </span>
      </button>
      {details ? (
        <div className="stack">
          <b className="muted">{fw.where}</b>
          {categories.map((category) => {
            const row = record(category);
            if (!row) return null;
            return (
              <div key={String(row.name)} className="stack" style={{ gap: 4 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>{String(row.name)}</span>
                  <span>{amount(row.amount)}</span>
                </div>
                <div className="bar">
                  <span
                    style={{ width: `${Math.min(100, (Number(row.amount) / spending) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
          <span className="hint">{fw.note}</span>
          {goalSaved ? (
            <span>{fw.goalSaved}</span>
          ) : (
            <div className="stack">
              <Field
                label={fw.goalLabel}
                value={goalTitle}
                onChange={(e) => setGoalTitle(e.target.value)}
                placeholder={fw.goalPlaceholder}
              />
              <ErrorLine error={goalError} />
              <div>
                <Btn
                  className="sm"
                  busy={goalBusy}
                  disabled={!goalTitle.trim()}
                  onClick={() => void saveGoal()}
                >
                  {fw.goalCreate}
                </Btn>
              </div>
            </div>
          )}
          <div>
            <Btn className="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? fw.hideTransactions : fw.showTransactions}
            </Btn>
          </div>
          {expanded
            ? transactions.slice(0, 100).map((transaction) => {
                const row = record(transaction);
                return row ? (
                  <div
                    key={String(row.id ?? display(row))}
                    className="row"
                    style={{ justifyContent: "space-between", flexWrap: "nowrap" }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <div>{String(row.description)}</div>
                      <div className="hint">
                        {String(row.date)} · {String(row.category)}
                      </div>
                    </span>
                    <span>{amount(row.amount)}</span>
                  </div>
                ) : null;
              })
            : null}
          {expanded && transactions.length > 100 ? (
            <span className="hint">{fw.first100}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
