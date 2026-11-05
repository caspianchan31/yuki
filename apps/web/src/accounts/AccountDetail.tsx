/**
 * Phase C (docs/web.md): one account, from shell/accounts/AccountDetail.tsx, as a sheet: its
 * face, the latest desktop screenshot (only while the desktop runs; never starts anything), 桌面
 * (state, 看看 → opens the computer sheet, 启动 / 暂停 on the person's click), 项目 (移到… / 分配到…),
 * 登录, 标签, its tasks, 最近汇报, then 在聊天里派活…, 退回未分配, 编辑,
 * 删除 (type the name). Tasks and reports are known for accounts of the project on screen; for
 * another project's account the detail offers to switch there.
 */

import type { MuseApi } from "@m/api";
import { scopeComputerPath } from "@m/environments";
import { useProjects } from "@m/projects-state";
import { accountReportLines, deleteConfirmed } from "@m/shell/accounts/accounts-core";
import { accountErrorText, useAccountLookup, useAccountOps } from "@m/shell/accounts/hooks";
import { personRow } from "@m/shell/accounts/people-core";
import { desktopNeed } from "@m/shell/chat/guide-core";
import { useShellData } from "@m/shell/data";
import { type AccountModel, factShot, signInRows } from "@m/shell/model";
import { carryComposerAcrossSwitch, useShellNav } from "@m/shell/nav";
import { phaseWords, t } from "@m/shell/strings";
import { useMemo, useState } from "react";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import type { PanelProps } from "../panels/types";
import { Btn, ErrorLine, Field, Sheet, Skeleton } from "../ui/primitives";
import { AccountLight, Block, ConfirmBox, Face, KV, PhasePill } from "./parts";
import { usePicture } from "./picture";
import "./accounts.css";

export function AccountDetailPanel({ panel, onClose }: PanelProps<"account">) {
  const lookup = useAccountLookup(panel.environmentId);
  const account = lookup.model;
  if (!account)
    return (
      <Sheet
        title={lookup.loading ? t.accountDetail.loadingAccount : t.accountDetail.gone}
        onClose={onClose}
      >
        {lookup.loading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <p className="muted">{t.accountDetail.gone}</p>
            <ErrorLine error={lookup.error} />
          </>
        )}
      </Sheet>
    );
  return (
    <AccountDetailBody
      key={account.id}
      account={account}
      isCurrent={lookup.isCurrent}
      reloadError={lookup.error}
      onClose={onClose}
    />
  );
}

type Busy = "" | "start" | "stop" | "unassign" | "delete";

function AccountDetailBody({
  account,
  isCurrent,
  reloadError,
  onClose,
}: {
  account: AccountModel;
  isCurrent: boolean;
  reloadError: string;
  onClose: () => void;
}) {
  const nav = useShellNav();
  const data = useShellData();
  const projects = useProjects();
  const ops = useAccountOps();
  const d = t.accountDetail;
  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const api = useMemo(() => data.apiFor(account.projectId), [data.apiFor, account.projectId]);
  const projectName = ops.projectName(account.projectId);

  const entries = useMemo(
    () => (isCurrent ? data.entries.filter((entry) => entry.environmentId === account.id) : []),
    [isCurrent, data.entries, account.id],
  );
  const reportLines = useMemo(
    () =>
      isCurrent
        ? accountReportLines(
            data.reports.value,
            new Set(entries.map((entry) => entry.task.id)),
            data.now,
          )
        : [],
    [isCurrent, data.reports.value, entries, data.now],
  );

  // v1.5: a desktop can always be started.
  const canStart = true;
  const running = account.desktop === "running";
  async function act(kind: "start" | "stop" | "unassign" | "delete") {
    if (busy) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "start" || kind === "stop")
        await ops.setDesktop(account.id, account.projectId, kind);
      else if (kind === "unassign") {
        const outcome = await ops.move(account.id, account.projectId, null);
        if (outcome.state !== "done") setError(outcome.error);
      } else {
        // Closes as soon as the server confirms; the lists catch up behind it.
        await ops.remove(account.id, account.projectId, nav.closePanel);
        return;
      }
    } catch (e) {
      setError(accountErrorText(e));
    } finally {
      setBusy("");
    }
  }
  function dispatch() {
    const text = t.composer.dispatchPrefill(account.name);
    if (isCurrent) nav.prefill(text, account.id);
    else {
      carryComposerAcrossSwitch(text, account.id);
      projects.select(account.projectId);
    }
  }
  const switchHere = () => projects.select(account.projectId);
  // A desktop opened while a site waits on the owner lands on 桌面 with that
  // step and the AI's picture above it; closing it has the AI look again.
  const need = desktopNeed(account.flags, (site) =>
    factShot(account.view.signIns?.find((fact) => fact.site === site)),
  );
  const assignLabel = account.projectId !== null ? d.moveTo : d.assignTo;
  function lookAt() {
    nav.openPanel({
      kind: "legacy",
      detail: {
        type: "computer",
        environment: {
          id: account.id,
          name: account.name,
          accountLabel: account.view.accountLabel,
        },
        ...(need ? { focus: "desktop" as const, need } : {}),
      },
      ...(need ? { afterClose: () => void data.recheckSignIn(need.site, account.id) } : {}),
    });
  }
  const clock = (iso: string) => clockLabel(iso, data.now, phaseWords);

  return (
    <Sheet title={account.name} onClose={onClose}>
      {/* the account's face first, as in the members bar and the page. */}
      <Face
        person={personRow(account, data.now, {
          unknown: !isCurrent && account.projectId !== null,
          stalled: data.stalled,
        })}
      />
      <LatestShot account={account} api={api} />

      <KV
        k={d.desktop}
        right={
          <>
            {running &&
              (isCurrent ? (
                <Btn className="sm" onClick={lookAt}>
                  {d.look}
                </Btn>
              ) : (
                <Btn className="sm" onClick={switchHere}>
                  {d.switchTo(projectName)}
                </Btn>
              ))}
            <Btn
              className="sm"
              busy={busy === "start" || busy === "stop"}
              disabled={!!busy || (!running && !canStart)}
              onClick={() => void act(running ? "stop" : "start")}
            >
              {busy === "start"
                ? d.starting
                : busy === "stop"
                  ? d.stopping
                  : running
                    ? d.stop
                    : d.start}
            </Btn>
          </>
        }
      >
        <span className="row" style={{ gap: 6 }}>
          <AccountLight light={account.light} />
          {account.desktop === "stopped" ? t.desktop.stoppedKept : account.desktopWord}
        </span>
        {account.desktopReason ? (
          <span className="acc-small acc-redtext">{account.desktopReason}</span>
        ) : null}
      </KV>

      <KV
        k={d.project}
        right={
          <Btn
            className="sm"
            onClick={() => nav.openPanel({ kind: "assign", environmentId: account.id })}
          >
            {assignLabel}
          </Btn>
        }
      >
        {projectName}
      </KV>

      {account.login ? (
        <KV
          k={t.signIn.label}
          right={
            isCurrent ? (
              <Btn className="sm" onClick={() => nav.setView("credentials")}>
                {t.signIn.credentials}
              </Btn>
            ) : undefined
          }
        >
          {signInRows(account).map((row) => (
            <div key={row.site} className="acc-stack tight">
              <span className={row.flagged ? "acc-redtext" : undefined}>{row.headline}</span>
              {row.username ? (
                <span className="acc-small">{t.signIn.asUser(row.username)}</span>
              ) : null}
              {row.at ? <span className="acc-small">{t.signIn.at(clock(row.at))}</span> : null}
              {row.detail ? <span className="acc-small">{t.signIn.detail(row.detail)}</span> : null}
              {row.seen ? <span className="acc-small">{t.signIn.seen(row.seen)}</span> : null}
            </div>
          ))}
        </KV>
      ) : null}

      {account.label ? <KV k={d.label}>{account.label}</KV> : null}

      <Block title={d.tasks}>
        {isCurrent ? (
          account.tasks.length ? (
            account.tasks.map((entry) => (
              <button
                key={entry.task.id}
                type="button"
                className="acc-task"
                onClick={() => nav.openPanel({ kind: "task", taskId: entry.task.id })}
              >
                <PhasePill phase={entry.phase} />
                <span className="t">{entry.task.title}</span>
              </button>
            ))
          ) : (
            <p className="acc-small">{d.noTasks}</p>
          )
        ) : account.projectId === null ? (
          <p className="acc-small">{d.noTasks}</p>
        ) : (
          <div className="acc-stack">
            <p className="acc-small">{d.otherProject(projectName)}</p>
            <Btn className="sm" style={{ alignSelf: "flex-start" }} onClick={switchHere}>
              {d.switchTo(projectName)}
            </Btn>
          </div>
        )}
      </Block>

      {isCurrent ? (
        <Block title={d.reports}>
          {reportLines.length ? (
            reportLines.map((line) => (
              <div key={line.id} className="acc-inline">
                <button
                  type="button"
                  className="acc-task"
                  aria-label={`${line.clock} ${line.label} ${line.text}${line.unconfirmed ? ` ${line.unconfirmed}` : ""}`}
                  onClick={() => nav.openPanel({ kind: "task", taskId: line.taskId })}
                >
                  <span className="t">
                    <span className="acc-mono acc-faint">{line.clock}</span>
                    {`  ${line.label}${t.common.sep}${line.text}`}
                    {line.unconfirmed ? (
                      <span className="acc-unconfirmed">{line.unconfirmed}</span>
                    ) : null}
                  </span>
                </button>
                {line.link ? (
                  <a
                    className="linkbtn"
                    href={withScheme(line.link)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={d.reportOpen}
                  >
                    {t.common.link}
                  </a>
                ) : null}
              </div>
            ))
          ) : (
            <p className="acc-small">{d.noReports}</p>
          )}
        </Block>
      ) : null}

      <ErrorLine error={error || reloadError} />
      {confirmDelete ? (
        <div style={{ marginTop: 14 }}>
          <ConfirmBox text={d.removeWarning}>
            <div className="acc-stack" style={{ width: "100%" }}>
              <Field
                label={d.removeConfirm(account.name)}
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
                  busy={busy === "delete"}
                  disabled={!deleteConfirmed(typed, account.name) || !!busy}
                  onClick={() => void act("delete")}
                >
                  {busy === "delete" ? d.removing : d.removeButton}
                </Btn>
                <Btn
                  className="sm"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmDelete(false);
                    setTyped("");
                  }}
                >
                  {t.common.cancel}
                </Btn>
              </div>
            </div>
          </ConfirmBox>
        </div>
      ) : (
        <div className="acc-actions">
          {account.projectId !== null ? (
            <>
              <Btn variant="pri" onClick={dispatch}>
                {isCurrent ? d.dispatch : d.dispatchIn(projectName)}
              </Btn>
              <Btn
                busy={busy === "unassign"}
                disabled={!!busy}
                onClick={() => void act("unassign")}
              >
                {d.unassign}
              </Btn>
            </>
          ) : null}
          <Btn
            className="ghost"
            disabled={!!busy}
            onClick={() => nav.openPanel({ kind: "accountEditor", environmentId: account.id })}
          >
            {d.edit}
          </Btn>
          <Btn className="dtext" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
            {d.remove}
          </Btn>
        </div>
      )}
    </Sheet>
  );
}

const withScheme = (link: string) => (/^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`);

/**
 * 最近截图: the desktop's latest screenshot (GET …/computer/desktop/screenshot with the
 * account's project header), read only while the desktop runs; a 404 (none yet) or any failure
 * shows the placeholder. Never starts the desktop.
 */
function LatestShot({ account, api }: { account: AccountModel; api: MuseApi }) {
  const running = account.desktop === "running";
  const path = scopeComputerPath("/api/computer/desktop/screenshot", account.id);
  const [shot, failed] = usePicture(api, path, running);
  const p = t.accountDetail;
  // No picture (yet): one quiet line, never an empty grey frame.
  const placeholder = (text: string) => <p className="acc-shot-ph">{text}</p>;
  if (!running)
    return placeholder(
      account.desktop === "missing"
        ? p.shotEmpty
        : account.desktop === "error"
          ? p.shotError
          : p.shotStopped,
    );
  if (shot.kind === "none") return placeholder(p.shotNone);
  if (shot.kind === "loading")
    return (
      <p className="acc-shot-ph" role="status">
        {p.shotLoading}
      </p>
    );
  return (
    <figure style={{ margin: "0 0 4px" }}>
      <img className="acc-shot" src={shot.uri} alt={p.shotAlt} onError={failed} />
      <figcaption className="acc-small" style={{ marginTop: 6 }}>
        {p.shotLatest}
      </figcaption>
    </figure>
  );
}
