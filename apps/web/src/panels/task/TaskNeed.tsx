/**
 * Phase C (docs/web.md): the need card inside the task panel — the task's question with its
 * answer box (fields from state.missingFields when present, 立即继续 for a stop that was not a
 * question), its review (opens the review sheet, looked up again when the list is stale), its
 * failure with 重试, and an upstream proposal that belongs to it; after acting it collapses to the
 * receipt line. From the task / review kinds of shell/components/NeedCard.tsx (owned by the chat
 * cards unit, whose web card can replace this one once it exists).
 */

import { useTaskActions } from "@m/shell/actions";
import {
  answerPayload,
  missingFieldsOf,
  receiptForNeed,
  receiptLine,
  reviewLine,
} from "@m/shell/chat/core";
import { useShellData } from "@m/shell/data";
import type { NeedItem } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { failureText, phaseWords, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useId, useMemo, useState } from "react";
import type { ActionProposal, Workspace } from "../../../../../packages/domain/src";
import type { AgentTask } from "../../../../../packages/domain/src/agent";
import { clockLabel, durationLabel } from "../../../../../packages/domain/src/task-phase";
import { Btn, cx, ErrorLine } from "../../ui/primitives";
import { errorText, ReceiptLine, StatusPill } from "./parts";

export function TaskNeed({ item }: { item: NeedItem }) {
  const nav = useShellNav();
  const { now } = useShellData();
  const receipt = receiptForNeed(item, nav.receipts);
  if (receipt) return <ReceiptLine text={receiptLine(receipt, now)} />;
  if (item.kind === "task") {
    const { task, phase } = item.entry;
    const failed = phase.key === "fail";
    return (
      <section
        className={cx("tp-need", failed && "fail")}
        aria-label={`${phase.label}${t.common.sep}${task.title}`}
      >
        <div className="row">
          <StatusPill phase={phase} />
          <span className="tp-faint">
            {clockLabel(phase.at ?? task.updatedAt, now, phaseWords)}
          </span>
        </div>
        {phase.key === "input" ? (
          <>
            <p className="tp-pre">
              {phase.reason === "question" ? task.question?.trim() || phase.sub : phase.sub}
            </p>
            <AnswerBox task={task} continueNow={phase.reason !== "question"} />
          </>
        ) : phase.key === "approval" ? (
          <TaskReview task={task} />
        ) : (
          <TaskFailure task={task} sub={phase.sub} />
        )}
      </section>
    );
  }
  if (item.kind === "review") return <ReviewNeed action={item.action} />;
  return null;
}

function TaskFailure({ task, sub }: { task: AgentTask; sub: string }) {
  const actions = useTaskActions();
  const busy = actions.busy?.taskId === task.id;
  return (
    <>
      <p className="tp-pre">{failureText(task.error?.trim() ?? "") || sub}</p>
      <div className="row">
        <Btn className="sm" busy={busy} onClick={() => void actions.control(task.id, "retry")}>
          {t.needs.retry}
        </Btn>
      </div>
      <ErrorLine error={actions.error?.taskId === task.id ? actions.error.message : ""} />
    </>
  );
}

/** Opens the upstream review sheet for `actionId`; looks it up again when the list is stale. */
function useOpenReview() {
  const nav = useShellNav();
  const { reviews } = useShellData();
  const { api, workspace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const find = (list: readonly ActionProposal[], id: string | null | undefined) =>
    id ? list.find((action) => action.id === id) : undefined;
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { known, open, busy, error };
}

function TaskReview({ task }: { task: AgentTask }) {
  const { now } = useShellData();
  const review = useOpenReview();
  const action = review.known(task.actionId);
  return (
    <>
      <p>
        {action
          ? reviewLine(action, now, (ms) => durationLabel(ms, phaseWords), task.title)
          : task.question?.trim() || phaseWords.approval}
      </p>
      <div className="row">
        <Btn className="sm" busy={review.busy} onClick={() => void review.open(task.actionId)}>
          {t.needs.review}
        </Btn>
      </div>
      <ErrorLine error={review.error} />
    </>
  );
}

function ReviewNeed({ action }: { action: ActionProposal }) {
  const { now } = useShellData();
  const review = useOpenReview();
  return (
    <section
      className="tp-need"
      aria-label={`${phaseWords.labels.approval}${t.common.sep}${action.title}`}
    >
      <div className="row">
        <StatusPill phase={{ label: phaseWords.labels.approval, tone: "amber" }} />
        <span className="tp-faint">{clockLabel(action.createdAt, now, phaseWords)}</span>
      </div>
      <p>{reviewLine(action, now, (ms) => durationLabel(ms, phaseWords))}</p>
      <div className="row">
        <Btn className="sm" busy={review.busy} onClick={() => void review.open(action.id)}>
          {t.needs.review}
        </Btn>
      </div>
      <ErrorLine error={review.error} />
    </section>
  );
}

function AnswerBox({ task, continueNow }: { task: AgentTask; continueNow: boolean }) {
  const actions = useTaskActions();
  const fields = useMemo(() => missingFieldsOf(task), [task]);
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const payload = answerPayload(text, values, fields);
  const busy = actions.busy?.taskId === task.id;
  const id = useId();
  const send = async () => {
    if (!payload || busy) return;
    if (await actions.answer(task.id, payload.answer, payload.fields)) {
      setText("");
      setValues({});
    }
  };
  return (
    <>
      {fields.map((field) =>
        field.checkbox ? (
          <label key={field.name} className="tp-radio">
            <input
              type="checkbox"
              checked={values[field.name] === true}
              onChange={() =>
                setValues((current) => ({ ...current, [field.name]: current[field.name] !== true }))
              }
            />
            {field.label}
          </label>
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
        <label className="field" htmlFor={id}>
          <span>{t.needs.answer}</span>
          <textarea
            id={id}
            className="input"
            value={text}
            placeholder={t.needs.answerPlaceholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </label>
      ) : null}
      <div className="row">
        <Btn
          variant="pri"
          className="sm"
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
      <ErrorLine error={actions.error?.taskId === task.id ? actions.error.message : ""} />
    </>
  );
}
