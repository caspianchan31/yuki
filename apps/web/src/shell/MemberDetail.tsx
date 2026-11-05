/**
 * v1.2: the right rail for the member you opened. Duty from the persona, routines
 * from the live tasks (RoutineCards: 暂停/恢复, 测试, 修改, 删除 and 最近运行).
 */

import { useProjects } from "@m/projects-state";
import { deleteConfirmed } from "@m/shell/accounts/accounts-core";
import { accountErrorText, useAccountLookup, useAccountOps } from "@m/shell/accounts/hooks";
import { normalizeAccountOperating } from "@m/shell/accounts/operating-core";
import { useShellData } from "@m/shell/data";
import { memberScreen } from "@m/shell/desk/preview-core";
import { useProjectRows } from "@m/shell/frame/useProjectRows";
import {
  appsToConnect,
  dutyText,
  goalRoutines,
  memberRoutines,
  usageDayLabel,
} from "@m/shell/members/member-detail";
import { loginLine } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { DesktopPreview } from "../accounts/DesktopPreview";
import { MemberFace } from "../ui/MemberFace";
import { faceOf } from "../ui/member-face";
import { Btn, ErrorLine, Field, IconBtn, Skeleton } from "../ui/primitives";
import { ContainerComputer } from "./ContainerComputer";
import { FilePreview, NotesList, useMemberFiles } from "./MemberFiles";
import { openMemberComputer } from "./member-computer";
import { RoutineCards } from "./RoutineCards";
import "./new-member.css";
import { setFrame } from "./state";

export function MemberDetail({
  environmentId,
  onClose,
}: {
  environmentId: string;
  onClose: () => void;
}) {
  const lookup = useAccountLookup(environmentId);
  const data = useShellData();
  const nav = useShellNav();
  const rows = useProjectRows();
  const ops = useAccountOps();
  const { current, select } = useProjects();
  const account = lookup.model;
  const [removing, setRemoving] = useState<"ask" | "busy" | null>(null);
  const [typed, setTyped] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [duty, setDuty] = useState("");
  const [dutyFor, setDutyFor] = useState<string | null>(null);
  const [goalText, setGoalText] = useState("");
  const [usage, setUsage] = useState<{
    day: string;
    input: number;
    output: number;
    turns: number;
    costUsd: number | null;
  } | null>(null);
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const apiFor = data.apiFor;
  const accountId = account?.id;
  const projectId = account?.projectId ?? null;
  const dutyHere = dutyFor === accountId ? duty : "";
  const goalHere = dutyFor === accountId ? goalText : "";
  const usageHere = usageFor === accountId ? usage : null;
  const files = useMemberFiles(accountId, projectId, account?.name ?? "");

  useEffect(() => {
    if (!accountId || !lookup.isCurrent) return;
    let gone = false;
    let dutyTimer = 0;
    let usageTimer = 0;
    const loadDuty = () => {
      void apiFor(projectId)
        .request<unknown>(`/api/agent/accounts/${encodeURIComponent(accountId)}`)
        .then((payload) => {
          if (gone) return;
          const operating = normalizeAccountOperating(payload);
          const parts = operating.persona?.parts;
          setDuty(
            dutyText({
              who: parts?.who?.value ?? null,
              background: parts?.background?.value ?? null,
              boundaries: parts?.boundaries?.value ?? null,
            }),
          );
          setGoalText(operating.goal?.text ?? "");
          setDutyFor(accountId);
        })
        .catch(() => {
          if (gone) return;
          setDuty("");
          setGoalText("");
          setDutyFor(accountId);
          dutyTimer = window.setTimeout(loadDuty, 5_000);
        });
    };
    const loadUsage = () => {
      void apiFor(projectId)
        .request<{
          day?: string;
          input?: number;
          output?: number;
          turns?: number;
          costUsd?: number | null;
        }>(`/api/agent/accounts/${encodeURIComponent(accountId)}/usage`)
        .then((row) => {
          if (gone) return;
          setUsage({
            day: typeof row.day === "string" ? row.day : "",
            input: row.input ?? 0,
            output: row.output ?? 0,
            turns: row.turns ?? 0,
            costUsd: typeof row.costUsd === "number" ? row.costUsd : null,
          });
          setUsageFor(accountId);
        })
        .catch(() => {
          if (gone) return;
          usageTimer = window.setTimeout(loadUsage, 5_000);
        });
    };
    loadDuty();
    loadUsage();
    return () => {
      gone = true;
      window.clearTimeout(dutyTimer);
      window.clearTimeout(usageTimer);
    };
  }, [accountId, apiFor, lookup.isCurrent, projectId]);

  useEffect(() => {
    setRemoving(null);
    setTyped("");
    setRemoveError("");
  }, [environmentId]);

  if (!account) {
    return (
      <div className="member-detail">
        {lookup.loading ? <Skeleton lines={5} /> : <p className="muted">{t.accountDetail.gone}</p>}
      </div>
    );
  }

  const face = faceOf(account.view);
  const project = rows.find((row) => row.id === account.projectId);
  const routines = memberRoutines(account.tasks.map((entry) => entry.task));
  // A standing loop with no clock of its own is how she keeps working, not one of the routines
  // she was given. It stays on the list only when she has no scheduled routine to show.
  const scheduled = routines.filter((routine) => routine.when.length > 0);
  const shownRoutines = scheduled.length > 0 ? scheduled : routines;
  const dutyLines = dutyHere
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const role = dutyLines[0] ?? "";
  const logins = loginLine(account.view);
  // With no computer connected (未接电脑) nothing about a desktop is shown.
  const computer = account.view.computer !== false;
  const screen = computer ? memberScreen(account, account.tasks) : null;
  const r = t.accountDetail;

  async function removeMember() {
    if (!account || removing === "busy") return;
    setRemoving("busy");
    setRemoveError("");
    try {
      // Back to Yuki's own conversation as soon as the server confirms.
      await ops.remove(account.id, account.projectId, () => {
        setFrame({ peek: null, details: false, drawer: false, platform: null });
        nav.setView("work");
        if (current !== null) select(null);
      });
    } catch (e) {
      setRemoveError(accountErrorText(e));
      setRemoving("ask");
    }
  }

  return (
    <div className="member-detail">
      <div className="member-detail-h">
        <MemberFace {...face} size={36} label={account.name} />
        <div className="roster-text">
          <span className="lbl">{account.name}</span>
          <span className="roster-line">
            {[role, project ? `在「${project.name}」群` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        <IconBtn icon={X} label={t.common.close} onClick={onClose} />
      </div>
      {screen ? (
        <DesktopPreview
          preview={screen}
          onOpen={() => openMemberComputer(nav, data.recheckSignIn, account)}
        />
      ) : null}
      <section>
        <h3>职责</h3>
        <FilePreview files={files} path="AGENTS.md" />
      </section>
      <section>
        <h3>例行</h3>
        {shownRoutines.length === 0 && goalRoutines(goalHere).length === 0 ? (
          <p className="muted">没有例行</p>
        ) : null}
        <RoutineCards
          key={environmentId}
          routines={shownRoutines}
          entries={account.tasks}
          projectId={projectId}
        />
        {goalRoutines(goalHere).map((routine) => (
          <div key={`${routine.title}\n${routine.when}`} className="member-card">
            <div className="lbl">{routine.title}</div>
            <div className="roster-line">{routine.when} · 记在目标里</div>
          </div>
        ))}
      </section>
      {computer ? null : <ContainerComputer />}
      {computer ? (
        <section>
          <h3>电脑</h3>
          <div className="member-card">
            <div>{t.desktop.card[account.desktop] ?? account.desktopWord}</div>
            {account.desktopReason ? (
              <div className="roster-line">{account.desktopReason}</div>
            ) : null}
            <div className="member-actions">
              <button
                type="button"
                className="member-run quiet"
                onClick={() => openMemberComputer(nav, data.recheckSignIn, account)}
              >
                {t.memberCard.openComputer}
              </button>
            </div>
            {logins ? <div className="roster-line">{logins}</div> : null}
            {appsToConnect(goalHere) ? (
              <div className="roster-line">要连接：{appsToConnect(goalHere)}</div>
            ) : null}
          </div>
        </section>
      ) : appsToConnect(goalHere) ? (
        <section>
          <h3>应用</h3>
          <div className="member-card">
            <div className="roster-line">要连接：{appsToConnect(goalHere)}</div>
          </div>
        </section>
      ) : null}
      <section>
        <h3>用量</h3>
        <div className="member-card">
          {usageHere ? (
            <>
              <div>
                {usageHere.day ? `${usageDayLabel(usageHere.day)} · ` : ""}
                {usageHere.input + usageHere.output} token
              </div>
              <div className="roster-line">
                {usageHere.turns} 轮 ·{" "}
                {usageHere.costUsd != null
                  ? `约 $${usageHere.costUsd.toFixed(4)}`
                  : "金额还没按模型定价"}
              </div>
            </>
          ) : (
            <div className="roster-line">用量还没读到</div>
          )}
        </div>
      </section>
      <section>
        <h3>{t.memberFiles.memory}</h3>
        <FilePreview files={files} path="MEMORY.md" />
      </section>
      <section>
        <h3>{t.memberFiles.notes}</h3>
        <NotesList files={files} />
      </section>
      <p className="roster-line">也可以直接在对话里跟 {account.name} 说，她会自己改。</p>
      <section>
        <h3>其他</h3>
        {computer ? (
          <div className="member-actions">
            <button
              type="button"
              className="member-run quiet"
              onClick={() => nav.openPanel({ kind: "account", environmentId: account.id })}
            >
              {t.memberCard.settings}
            </button>
          </div>
        ) : null}
        {removing ? (
          <div className="md-remove" role="alert">
            <p>{r.removeWarning}</p>
            <Field
              label={r.removeConfirm(account.name)}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={account.name}
            />
            <div className="row">
              <Btn
                variant="danger"
                className="sm"
                busy={removing === "busy"}
                disabled={!deleteConfirmed(typed, account.name)}
                onClick={() => void removeMember()}
              >
                {r.removeMember}
              </Btn>
              <Btn
                className="sm"
                disabled={removing === "busy"}
                onClick={() => {
                  setRemoving(null);
                  setTyped("");
                  setRemoveError("");
                }}
              >
                {t.common.cancel}
              </Btn>
            </div>
            <ErrorLine error={removeError} />
          </div>
        ) : (
          <div className="member-actions">
            <button type="button" className="member-run quiet" onClick={() => setRemoving("ask")}>
              {r.removeMember}
            </button>
          </div>
        )}
      </section>
      {files.editor}
    </div>
  );
}
