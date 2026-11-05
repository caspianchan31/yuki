/**
 * Phase C (docs/web.md): one job of the project (the live panel's 活 row, a chat card's 查看),
 * from shell/jobs/JobDetail.tsx: what the owner said, its deadline, each account's state with its
 * own reason or note, what the accounts did for it (their ledger rows), and the owner's own
 * changes, saved at once with no confirmation: 改 (title, words, deadline), 加号 / 撤下, 结束这件活,
 * and 重新打开 for an archived one. Read from GET /api/agent/jobs/:id with the project's own
 * client, so an account of another project is never offered.
 */

import { ApiError } from "@m/api-response";
import { useShellData } from "@m/shell/data";
import { useFounderRef } from "@m/shell/founder/useFounder";
import {
  assigneeName,
  assigneeWord,
  jobPanelEmpty,
  normalizeJobDetail,
} from "@m/shell/jobs/jobs-core";
import { phaseWords, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JobAction, JobView } from "../../../../../packages/domain/src/jobs";
import { clockLabel } from "../../../../../packages/domain/src/task-phase";
import { Btn, ErrorLine, Field, Section, Sheet, Skeleton, TextArea } from "../../ui/primitives";
import type { PanelProps } from "../types";
import { errorText, KV } from "./parts";

export function JobDetailPanel({ panel, onClose }: PanelProps<"job">) {
  const { jobId } = panel;
  const { api } = useWorkspace();
  const data = useShellData();
  const words = t.jobs.panel;
  const founder = useFounderRef();
  const [detail, setDetail] = useState<{ job: JobView; actions: JobAction[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", brief: "", due: "" });
  const path = `/api/agent/jobs/${encodeURIComponent(jobId)}`;
  const load = useCallback(async () => {
    try {
      const next = normalizeJobDetail(await api.request<unknown>(path));
      setDetail(next);
      setGone(!next);
      setError("");
    } catch (e) {
      // Gone: the panel says so once (not also the server's 「找不到这件活。」).
      const missing = e instanceof ApiError && e.status === 404;
      setGone(missing);
      setError(missing ? "" : errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api, path]);
  useEffect(() => {
    void load();
  }, [load]);
  // Every read of /api/agent carries the job too: follow it while the panel is open.
  const live = data.jobs.find((job) => job.id === jobId);
  const liveVersion = live?.version;
  useEffect(() => {
    if (liveVersion !== undefined && detail && liveVersion !== detail.job.version) void load();
  }, [liveVersion, detail, load]);

  async function act(kind: string, run: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(kind);
    setError("");
    try {
      const next = normalizeJobDetail(await run());
      if (next) setDetail(next);
      void data.refreshAll();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  }
  const job = detail?.job ?? null;
  const addable = useMemo(
    () =>
      job
        ? data.accounts.value.filter(
            (account) =>
              !job.assignees.some(
                (item) =>
                  item.envId === account.id &&
                  (item.status === "assigned" || item.status === "taken"),
              ),
          )
        : [],
    [job, data.accounts.value],
  );
  if (!job) {
    const empty = jobPanelEmpty({ loading, gone, error });
    return (
      <Sheet title={empty.title} onClose={onClose} wide>
        {loading ? <Skeleton lines={5} /> : null}
        {empty.line ? <p className="muted">{empty.line}</p> : null}
        <ErrorLine error={empty.error} />
      </Sheet>
    );
  }
  const clock = (iso: string | null) => (iso ? clockLabel(iso, data.now, phaseWords) : "");
  const archived = !!job.archivedAt;
  const saveEdit = () =>
    void act("edit", () =>
      api.request(
        path,
        { title: draft.title.trim(), brief: draft.brief.trim(), due: draft.due.trim() || null },
        "PUT",
      ),
    ).then((ok) => ok && setEditing(false));

  return (
    <Sheet
      title={job.title}
      onClose={onClose}
      wide
      footer={
        editing ? undefined : archived ? (
          <Btn
            busy={busy === "reopen"}
            onClick={() => void act("reopen", () => api.request(path, { reopen: true }, "PUT"))}
          >
            {words.reopen}
          </Btn>
        ) : (
          <>
            <Btn aria-expanded={adding} onClick={() => setAdding(!adding)}>
              {words.addAccount}
            </Btn>
            <Btn
              onClick={() => {
                setDraft({ title: job.title, brief: job.brief, due: job.due?.text ?? "" });
                setEditing(true);
              }}
            >
              {words.edit}
            </Btn>
            <Btn
              variant="danger"
              busy={busy === "close"}
              onClick={() => void act("close", () => api.request(`${path}/close`, {}))}
            >
              {words.close}
            </Btn>
          </>
        )
      }
    >
      <div className="tp">
        {editing ? (
          <form
            className="tp-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.title.trim() && draft.brief.trim()) saveEdit();
            }}
          >
            <Field
              label={words.titleLabel}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <TextArea
              label={words.briefLabel}
              value={draft.brief}
              onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
            />
            <Field
              label={words.dueLabel}
              value={draft.due}
              onChange={(e) => setDraft({ ...draft, due: e.target.value })}
            />
            <div className="row">
              <Btn
                type="submit"
                variant="pri"
                className="sm"
                busy={busy === "edit"}
                disabled={!draft.title.trim() || !draft.brief.trim()}
              >
                {words.save}
              </Btn>
              <Btn className="sm ghost" onClick={() => setEditing(false)}>
                {words.cancel}
              </Btn>
            </div>
          </form>
        ) : (
          <div>
            <KV k={words.brief}>
              <span className="tp-pre">{job.brief}</span>
            </KV>
            <KV k={words.due}>{job.due?.text ?? words.noDue}</KV>
            {job.everyone ? <p className="tp-small">{words.everyone}</p> : null}
            {archived ? (
              <p className="tp-small">
                {[
                  words.doneAt(clock(job.archivedAt)),
                  job.closedReason ? words.closedReason(job.closedReason) : "",
                ]
                  .filter(Boolean)
                  .join(t.common.sep)}
              </p>
            ) : null}
          </div>
        )}

        <Section title={words.accounts}>
          <div className="tp-lines">
            {job.assignees.map((item) => (
              <div key={item.envId} className="row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <span className="tp-strong">
                      {assigneeName(founder, item.name, item.envId)}
                    </span>
                    {`${t.common.sep}${assigneeWord(item)}`}
                  </div>
                  {item.status === "declined" && item.reason ? (
                    <div className="tp-small">{words.reason(item.reason)}</div>
                  ) : null}
                  {item.ownerInsisted && item.status !== "declined" ? (
                    <div className="tp-small">{words.insisted}</div>
                  ) : null}
                  {item.note && item.status !== "declined" ? (
                    <div className="tp-small">{words.note(item.note)}</div>
                  ) : null}
                </div>
                {!archived && item.live && item.status !== "done" && item.status !== "dropped" ? (
                  <button
                    type="button"
                    className="linkbtn"
                    disabled={!!busy}
                    onClick={() =>
                      void act(`remove:${item.envId}`, () =>
                        api.request(`${path}/assign`, { remove: [item.envId] }),
                      )
                    }
                  >
                    {busy === `remove:${item.envId}` ? <span className="spin" /> : null}
                    {words.remove}
                  </button>
                ) : null}
              </div>
            ))}
            {!archived && adding ? (
              addable.length ? (
                <div className="row">
                  {addable.map((account) => (
                    <Btn
                      key={account.id}
                      className="sm"
                      busy={busy === `add:${account.id}`}
                      onClick={() =>
                        void act(`add:${account.id}`, () =>
                          api.request(`${path}/assign`, { add: [account.id] }),
                        ).then((ok) => ok && setAdding(false))
                      }
                    >
                      {account.name}
                    </Btn>
                  ))}
                </div>
              ) : (
                <p className="tp-small">{words.addNone}</p>
              )
            ) : null}
          </div>
        </Section>

        <Section title={words.actions}>
          <div className="tp-lines">
            {detail?.actions.length ? (
              detail.actions.map((item) => (
                <div key={`${item.environmentId}:${item.at}:${item.action}`} className="tp-line">
                  <span className="tp-faint tp-mono">{clock(item.at)}</span>
                  <span>
                    {[item.account, item.site, item.action].filter(Boolean).join(t.common.sep)}
                  </span>
                  {item.permalink ? (
                    <a className="linkbtn" href={item.permalink} target="_blank" rel="noreferrer">
                      {t.common.link}
                    </a>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="tp-small">{words.noActions}</p>
            )}
          </div>
        </Section>

        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}
