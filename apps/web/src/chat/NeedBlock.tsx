/**
 * Phase C (docs/web.md): a stop report, from shell/chat/ChatCards.tsx (NeedReport) and the
 * task kinds of shell/components/NeedCard.tsx. While the task still waits for what the report says
 * it is an amber block (red for a failure) with its inline actions: the question and the answer
 * box (发送回答, 立即继续), 等你审阅 (opens the review sheet), the error and 重试. The other kinds
 * (account, project, review) are drawn by MemberNeeds. Once the task no longer waits for it, or
 * for an older one, it is the report itself, with the receipt of what the person did after it.
 */
import { isComposingKey } from "@m/ime";
import { type TaskActions, useTaskActions } from "@m/shell/actions";
import {
  type AnswerField,
  answerPayload,
  missingFieldsOf,
  needReportView,
  receiptLine,
  reviewLine,
} from "@m/shell/chat/core";
import type { GroupTurn } from "@m/shell/chat/group-core";
import { useShellData } from "@m/shell/data";
import { type NeedItem, stopNeed } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { phaseWords, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { type KeyboardEvent, useMemo, useState } from "react";
import type { ActionProposal, Workspace } from "../../../../packages/domain/src";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { clockLabel, durationLabel } from "../../../../packages/domain/src/task-phase";
import { Btn, ErrorLine } from "../ui/primitives";
import { Block, ReceiptLine, StatusPill, TaskAccount } from "./parts";
import { ProgressReportGroup } from "./ReportBlock";

/** A stop report: the live need card while the task still waits for what it says (its
 * newest only, `latest`), else the report with the receipt of what the person did after it. */
export function NeedBlock({
  report,
  latest,
  turn,
}: {
  report: ChatReport;
  latest: boolean;
  /** Who speaks the live card. */
  turn: GroupTurn;
}) {
  const nav = useShellNav();
  const { needs, now } = useShellData();
  const view = needReportView({ report, latest, needs, receipts: nav.receipts });
  if (view.kind === "card") return <TaskNeed item={view.item} turn={turn} at={report.createdAt} />;
  return (
    <>
      <ProgressReportGroup reports={[report]} />
      {view.kind === "receipt" ? <ReceiptLine text={receiptLine(view.receipt, now)} /> : null}
    </>
  );
}

function TaskNeed({
  item,
  turn,
  at,
}: {
  item: Extract<NeedItem, { kind: "task" }>;
  turn: GroupTurn;
  at: string;
}) {
  const { now, accounts } = useShellData();
  const { entry, account } = item;
  const { task, phase } = entry;
  const failed = phase.key === "fail";
  const when = clockLabel(at ?? phase.at ?? task.updatedAt, now, phaseWords);
  return (
    <Block
      turn={turn}
      time={when}
      tone={failed ? "fail" : "need"}
      tag={<StatusPill phase={phase} />}
      label={`${phase.label}${t.common.sep}${task.title}`}
    >
      <div className="body">
        <div className="row" style={{ gap: 6 }}>
          <span className="who">{task.title}</span>
          <TaskAccount
            environmentId={entry.environmentId}
            account={account}
            accountsLoading={accounts.loading}
          />
        </div>
        {phase.key === "input" ? (
          <>
            <div className="where">
              {phase.reason === "question" ? task.question?.trim() || phase.sub : phase.sub}
            </div>
            <AnswerBox task={task} continueNow={phase.reason !== "question"} />
          </>
        ) : phase.key === "approval" ? (
          <TaskReview task={task} />
        ) : (
          <TaskFailure entry={entry} />
        )}
      </div>
    </Block>
  );
}

/** A failure, or an account's standing loop that stopped (failed: 重试, paused: 恢复). */
function TaskFailure({ entry }: { entry: Extract<NeedItem, { kind: "task" }>["entry"] }) {
  const actions = useTaskActions();
  const { task } = entry;
  const busy = actions.busy?.taskId === task.id;
  const stop = stopNeed(entry);
  return (
    <>
      <div className="where">{stop.text}</div>
      <div className="row-acts">
        <Btn
          className="sm"
          variant="pri"
          busy={busy}
          onClick={() => void actions.control(task.id, stop.op)}
        >
          {stop.label}
        </Btn>
      </div>
      <ActionError actions={actions} taskId={task.id} />
    </>
  );
}

type Task = Extract<NeedItem, { kind: "task" }>["entry"]["task"];

function ActionError({ actions, taskId }: { actions: TaskActions; taskId: string }) {
  return <ErrorLine error={actions.error?.taskId === taskId ? actions.error.message : ""} />;
}

/** Opens the upstream review sheet for `actionId`; looks it up again when the list is stale. */
function useOpenReview() {
  const nav = useShellNav();
  const { reviews } = useShellData();
  const { api, workspace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const find = (actions: readonly ActionProposal[], id: string | null | undefined) =>
    id ? actions.find((action) => action.id === id) : undefined;
  const known = (id: string | null | undefined) => find(reviews, id) ?? find(workspace.actions, id);
  const open = async (id: string | null | undefined) => {
    const action = known(id);
    if (action) {
      nav.openPanel({ kind: "legacy", detail: { type: "review", action } });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.request<Workspace>("/api/workspace");
      const fresh = find(snapshot.actions ?? [], id);
      if (fresh) nav.openPanel({ kind: "legacy", detail: { type: "review", action: fresh } });
      else setError(t.taskDetail.reviewMissing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { known, open, busy, error };
}

/** 等你审阅 (an upstream email or calendar draft): the review opens in its sheet. */
function TaskReview({ task }: { task: Task }) {
  const { now } = useShellData();
  const review = useOpenReview();
  const action = review.known(task.actionId);
  return (
    <>
      <div className="where">
        {action
          ? reviewLine(action, now, (ms) => durationLabel(ms, phaseWords), task.title)
          : task.question?.trim() || phaseWords.approval}
      </div>
      <div className="row-acts">
        <Btn
          className="sm"
          variant="pri"
          busy={review.busy}
          onClick={() => void review.open(task.actionId)}
        >
          {t.needs.review}
        </Btn>
      </div>
      <ErrorLine error={review.error} />
    </>
  );
}

/** The answer box: one input per requested field (state.missingFields), else free text; 发送回答,
 * and 立即继续 when the task only waits to be told to go on. Enter sends, Shift+Enter a new line. */
function AnswerBox({ task, continueNow }: { task: Task; continueNow: boolean }) {
  const actions = useTaskActions();
  const fields = useMemo(() => missingFieldsOf(task), [task]);
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const payload = answerPayload(text, values, fields);
  const busy = actions.busy?.taskId === task.id;
  const send = async () => {
    if (!payload || busy) return;
    if (await actions.answer(task.id, payload.answer, payload.fields)) {
      setText("");
      setValues({});
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e.nativeEvent)) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className="stack">
      {fields.map((field) =>
        field.checkbox ? (
          <CheckField
            key={field.name}
            field={field}
            checked={values[field.name] === true}
            onToggle={() =>
              setValues((current) => ({ ...current, [field.name]: current[field.name] !== true }))
            }
          />
        ) : (
          <label key={field.name} className="field">
            <span>{field.label}</span>
            <input
              className="input"
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
              onChange={(e) =>
                setValues((current) => ({ ...current, [field.name]: e.target.value }))
              }
            />
          </label>
        ),
      )}
      {!fields.length ? (
        <textarea
          className="input"
          aria-label={t.needs.answer}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.needs.answerPlaceholder}
          onKeyDown={onKey}
          rows={2}
          style={{ minHeight: 64 }}
        />
      ) : null}
      <div className="row-acts" style={{ marginTop: 0 }}>
        <Btn
          className="sm"
          variant="pri"
          busy={busy && actions.busy?.action === "input"}
          disabled={!payload || busy}
          onClick={() => void send()}
        >
          {t.needs.send}
        </Btn>
        {continueNow ? (
          <Btn
            className="sm"
            disabled={busy}
            onClick={() => void actions.answer(task.id, t.needs.continueAnswer)}
          >
            {t.needs.continueNow}
          </Btn>
        ) : null}
      </div>
      <ActionError actions={actions} taskId={task.id} />
    </div>
  );
}

function CheckField({
  field,
  checked,
  onToggle,
}: {
  field: AnswerField;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="row" style={{ gap: 8 }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span>{field.label}</span>
    </label>
  );
}
