/**
 * Phase C (docs/web.md): 「把 <name> 移到… / 分到…」, from shell/accounts/AssignPanel.tsx. Lists
 * the target projects (names and account counts from the overview, else the project list) and
 * 退回未分配; warns first when the account still has tasks here (「移走后这些任务找不到账号」) — a
 * note, not a step to confirm. A move across projects is two existing PATCHes (useAccountOps);
 * when the second fails the account stays unassigned and the panel offers 再试.
 */
import { useProjects } from "@m/projects-state";
import { moveNote, moveTargets } from "@m/shell/accounts/accounts-core";
import { useAccountLookup, useAccountOps } from "@m/shell/accounts/hooks";
import { useOverview, useShellData } from "@m/shell/data";
import type { AccountModel } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import type { PanelProps } from "../panels/types";
import { Btn, ErrorLine, IconBtn, Sheet, Skeleton } from "../ui/primitives";
import { ConfirmBox, OptionRow } from "./parts";
import "./accounts.css";

export function AssignPanel({ panel, onClose }: PanelProps<"assign">) {
  const { environmentId } = panel;
  const nav = useShellNav();
  const data = useShellData();
  const { projects } = useProjects();
  const overview = useOverview();
  const lookup = useAccountLookup(environmentId);
  const ops = useAccountOps();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // While a move runs the account leaves one list before the next has it: keep showing it.
  const last = useRef<AccountModel | null>(null);
  if (lookup.model) last.current = lookup.model;
  const account = lookup.model ?? (busy !== null ? last.current : null);
  /** The second step failed: the account sits in 未分配 and 再试 sends it on to `target`. */
  const [stuck, setStuck] = useState<{ target: string; error: string } | null>(null);
  const back = () => nav.openPanel({ kind: "account", environmentId });
  const backButton = <IconBtn icon={ArrowLeft} label={t.common.back} onClick={back} />;

  if (!account)
    return (
      <Sheet
        title={lookup.loading ? t.accountDetail.loadingAccount : t.accountDetail.gone}
        onClose={onClose}
        actions={backButton}
      >
        {lookup.loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <p className="muted">{t.accountDetail.gone}</p>
            <ErrorLine error={lookup.error} />
          </>
        )}
      </Sheet>
    );

  const from = account.projectId;
  // Assigning an unassigned account is one PATCH: the two-step note is only for a move.
  const note = moveNote(from);
  const live = projects.filter((project) => !project.deleting);
  const targets = moveTargets(live, from);
  const counts = new Map((overview.projects ?? []).map((item) => [item.id, item.accounts]));
  // The account's live tasks here (other projects' tasks are not loaded: phase 2, N4).
  const tasks = lookup.isCurrent
    ? data.entries.filter((entry) => entry.environmentId === account.id && !entry.phase.ended)
    : [];

  async function moveTo(target: string | null, origin: string | null) {
    if (busy) return;
    setBusy(target ?? "");
    setError("");
    try {
      const outcome = await ops.move(account?.id ?? environmentId, origin, target);
      if (outcome.state === "done") {
        setStuck(null);
        back();
      } else if (outcome.state === "stuck" && target !== null)
        setStuck({ target, error: outcome.error });
      else setError(outcome.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      title={from !== null ? t.assign.moveTitle(account.name) : t.assign.assignTitle(account.name)}
      onClose={onClose}
      actions={backButton}
    >
      <div className="acc-stack">
        {stuck ? (
          <>
            <ConfirmBox text={t.assign.stuck}>
              <Btn
                variant="danger"
                className="sm"
                busy={busy !== null}
                onClick={() => void moveTo(stuck.target, null)}
              >
                {t.assign.retry}
              </Btn>
            </ConfirmBox>
            <ErrorLine error={stuck.error} />
          </>
        ) : null}
        {!stuck && tasks.length > 0 ? (
          <p className="acc-redtext" style={{ margin: 0, fontSize: 13 }}>
            {t.assign.tasksWarning(
              tasks.length,
              tasks.map((entry) => entry.task.title).join(t.common.listSep),
            )}
          </p>
        ) : null}
        <div>
          {!stuck &&
            targets.map((project) => (
              <OptionRow
                key={project.id}
                title={project.name}
                subtitle={t.assign.accounts(counts.get(project.id) ?? project.environments)}
                busy={busy === project.id}
                disabled={busy !== null && busy !== project.id}
                onClick={() => void moveTo(project.id, from)}
              />
            ))}
          {!stuck && from !== null ? (
            <OptionRow
              title={t.assign.unassign}
              busy={busy === ""}
              disabled={busy !== null && busy !== ""}
              onClick={() => void moveTo(null, from)}
            />
          ) : null}
        </div>
        <ErrorLine error={error} />
        {busy !== null ? (
          <p className="acc-small" role="status">
            {t.assign.moving}
          </p>
        ) : null}
        {note !== null ? <p className="acc-small">{note}</p> : null}
      </div>
    </Sheet>
  );
}
