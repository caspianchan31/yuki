/**
 * v1.4: the small 修改 form of a routine: name, what it does, when. Sends only what changed
 * (PATCH /api/agent/routines/:id); the server refuses while a run is open and says so.
 */

import { useAgentWorkspace } from "@m/agent-workspace";
import {
  type RoutineDraft,
  routineDraftBody,
  routineDraftOf,
} from "@m/shell/members/member-detail";
import { useState } from "react";
import type { AgentTask } from "../../../../packages/domain/src/agent";
import type { Routine } from "../../../../packages/domain/src/routines";
import { Btn, ErrorLine, Field, TextArea } from "../ui/primitives";

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
const types: { value: RoutineDraft["type"]; label: string }[] = [
  { value: "every", label: "每隔一段时间" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "mail", label: "收到新邮件时" },
];

export function RoutineEditor({
  task,
  request,
  onDone,
}: {
  task: Pick<AgentTask, "id" | "title" | "prompt"> & { routine: Routine };
  request: (path: string, body: unknown, method: "PATCH") => Promise<unknown>;
  onDone: () => void;
}) {
  const { refresh } = useAgentWorkspace();
  const original = routineDraftOf(task);
  const [draft, setDraft] = useState<RoutineDraft>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<RoutineDraft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    const result = routineDraftBody(draft, original);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request(`/api/agent/routines/${encodeURIComponent(task.id)}`, result.body, "PATCH");
      await refresh().catch(() => {});
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="routine-edit">
      <Field label="名称" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      <TextArea
        label="要做什么"
        rows={3}
        value={draft.instruction}
        onChange={(e) => set({ instruction: e.target.value })}
      />
      <label className="field">
        <span>什么时候</span>
        <select
          className="input"
          value={draft.type}
          onChange={(e) => set({ type: e.target.value as RoutineDraft["type"] })}
        >
          {types.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      {draft.type === "every" ? (
        <Field
          label="间隔（分钟）"
          inputMode="numeric"
          value={draft.minutes}
          onChange={(e) => set({ minutes: e.target.value })}
        />
      ) : null}
      {draft.type === "daily" || draft.type === "weekly" ? (
        <Field
          label="时间（按成员的时区）"
          placeholder="09:00"
          value={draft.at}
          onChange={(e) => set({ at: e.target.value })}
        />
      ) : null}
      {draft.type === "weekly" ? (
        <div className="member-actions">
          {weekdays.map((word, day) => (
            <button
              key={word}
              type="button"
              className="member-run quiet"
              aria-pressed={draft.days.includes(day)}
              onClick={() =>
                set({
                  days: draft.days.includes(day)
                    ? draft.days.filter((d) => d !== day)
                    : [...draft.days, day],
                })
              }
            >
              {word}
            </button>
          ))}
        </div>
      ) : null}
      {draft.type === "mail" ? (
        <>
          <Field
            label="发件人含（可不填）"
            value={draft.from}
            onChange={(e) => set({ from: e.target.value })}
          />
          <Field
            label="主题含（可不填）"
            value={draft.subjectHas}
            onChange={(e) => set({ subjectHas: e.target.value })}
          />
        </>
      ) : null}
      <ErrorLine error={error} />
      <div className="member-actions">
        <Btn variant="pri" busy={busy} onClick={() => void save()}>
          保存
        </Btn>
        <Btn disabled={busy} onClick={onDone}>
          取消
        </Btn>
      </div>
    </div>
  );
}
