/**
 * Phase C (docs/web.md): the fallback new background task form behind 「新后台任务」, from
 * shell/task/NewTaskForm.tsx. It says the chat is the normal way and that pacing, voice and
 * reporting are the task's own (nothing about them is asked here); 要做什么; 在哪个账号上跑（必选）
 * — this project's accounts only, the one it was opened with preselected; 重复: 只跑一次 / 每 [60]
 * 分钟; 交给后台 → POST /api/agent/tasks with a requestId that stays the same while the input does.
 */

import { useAgentWorkspace } from "@m/agent-workspace";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import {
  checkNewTask,
  initialAccount,
  type NewTaskCheck,
  type Submission,
  submissionFor,
} from "@m/shell/task/new-task-core";
import { useWorkspace } from "@m/workspace";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { setFrame } from "../../shell/state";
import { Btn, ErrorLine, Sheet, Skeleton } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { AccountLight, errorText, OptionRow } from "./parts";

type FormError = Extract<NewTaskCheck, { ok: false }> | { field: "submit"; error: string };

export function NewTaskPanel({ panel, onClose }: PanelProps<"newTask">) {
  const { environmentId } = panel;
  const { api, notify } = useWorkspace();
  const { delegate } = useAgentWorkspace();
  const { accounts, accountsUnavailable } = useShellData();
  const nav = useShellNav();
  // 未分组 (the default project) holds only unassigned accounts: none of them is "this
  // project's", so the form points to 账号与代理 instead.
  const inDefault = api.projectId === null;
  const list = useMemo(() => (inDefault ? [] : accounts.value), [inDefault, accounts.value]);
  const ids = useMemo(() => list.map((account) => account.id), [list]);
  const [what, setWhat] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const selectedId = chosen && ids.includes(chosen) ? chosen : initialAccount(ids, environmentId);
  const selected = list.find((account) => account.id === selectedId) ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repeat, setRepeat] = useState<"once" | "every">("once");
  const [minutes, setMinutes] = useState("60");
  const [error, setError] = useState<FormError | null>(null);
  const [busy, setBusy] = useState(false);
  const submission = useRef<Submission | null>(null);
  const submitting = useRef(false);
  const whatId = useId();

  async function submit() {
    if (submitting.current) return;
    const check = checkNewTask({ what, environmentId: selectedId, repeat, minutes }, ids);
    if (!check.ok) return setError(check);
    submission.current = submissionFor(submission.current, check.payload);
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await delegate(check.payload, submission.current.id);
      onClose();
      notify(t.newTask.submitted);
    } catch (e) {
      setError({ field: "submit", error: errorText(e) });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const errorFor = (field: FormError["field"]) => (error?.field === field ? error.error : "");
  const noAccounts = !list.length;

  return (
    <Sheet
      title={t.newTask.title}
      onClose={onClose}
      footer={
        <Btn variant="pri" busy={busy} disabled={noAccounts} onClick={() => void submit()}>
          {t.newTask.submit}
        </Btn>
      }
    >
      <form
        className="tp"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted">{t.newTask.hint}</p>

        <label className="field" htmlFor={whatId}>
          <span>{t.newTask.what}</span>
          <textarea
            id={whatId}
            className="input"
            rows={3}
            value={what}
            placeholder={t.newTask.whatPlaceholder}
            onChange={(e) => {
              setWhat(e.target.value);
              if (error?.field === "what") setError(null);
            }}
          />
          <ErrorLine error={errorFor("what")} />
        </label>

        <div className="field">
          <span>{t.newTask.account}</span>
          {selected ? (
            <>
              <button
                type="button"
                className="tp-opt"
                aria-label={t.newTask.pickAccount(selected.name)}
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                <AccountLight light={selected.light} />
                <span className="grow" style={{ fontWeight: 400 }}>
                  {t.newTask.accountOption(
                    selected.name,
                    t.accountsRail.desktop(selected.desktopWord),
                  )}
                </span>
                <ChevronDown size={16} className="muted" />
              </button>
              {pickerOpen ? (
                <div className="tp-lines" role="listbox" aria-label={t.newTask.account}>
                  {list.map((account) => (
                    <OptionRow
                      key={account.id}
                      title={account.name}
                      detail={t.accountsRail.desktop(account.desktopWord)}
                      selected={account.id === selectedId}
                      leading={<AccountLight light={account.light} />}
                      onClick={() => {
                        setChosen(account.id);
                        setPickerOpen(false);
                        if (error?.field === "account") setError(null);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              <small className="hint">{t.newTask.accountHint}</small>
              <ErrorLine error={errorFor("account")} />
            </>
          ) : inDefault ? (
            <>
              <ErrorLine error={t.empty.defaultBody} />
              <button
                type="button"
                className="linkbtn"
                style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  onClose();
                  setFrame({ newMember: true });
                }}
              >
                {t.empty.newMember}
              </button>
            </>
          ) : accounts.loading && !accountsUnavailable ? (
            <Skeleton lines={2} />
          ) : (
            <>
              <ErrorLine error={t.newTask.noAccounts} />
              {!accountsUnavailable ? (
                <button
                  type="button"
                  className="linkbtn"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => nav.openPanel({ kind: "join" })}
                >
                  {t.empty.joinAccount}
                </button>
              ) : null}
            </>
          )}
        </div>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, color: "var(--fg2)", fontWeight: 500, padding: 0 }}>
            {t.newTask.repeat}
          </legend>
          <label className="tp-radio">
            <input
              type="radio"
              name="repeat"
              checked={repeat === "once"}
              onChange={() => {
                setRepeat("once");
                if (error?.field === "minutes") setError(null);
              }}
            />
            {t.newTask.once}
          </label>
          <div className="row">
            <label className="tp-radio">
              <input
                type="radio"
                name="repeat"
                checked={repeat === "every"}
                onChange={() => setRepeat("every")}
              />
              {t.newTask.every}
            </label>
            <input
              className="input tp-num"
              aria-label={t.newTask.intervalLabel}
              value={minutes}
              inputMode="numeric"
              maxLength={5}
              onFocus={() => setRepeat("every")}
              onChange={(e) => {
                setMinutes(e.target.value);
                setRepeat("every");
                if (error?.field === "minutes") setError(null);
              }}
            />
            <span>{t.newTask.minutes}</span>
          </div>
          <ErrorLine error={errorFor("minutes")} />
        </fieldset>

        <ErrorLine error={errorFor("submit")} />
      </form>
    </Sheet>
  );
}
