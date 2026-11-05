/**
 * Phase C (docs/web.md): the account detail's four blocks between 标签 and 这个号上的任务,
 * from shell/accounts/OperatingBlocks.tsx: 人设 (four parts, who set each, 改 in place, 历史 n 版
 * with 用这一版), 长期目标 (改 / 清空), 经营计划 (第 n 版 · when, six parts folded) and 手上的活
 * (each job given to it here, opens the job). Saved at once, no confirmation. Read with the
 * account's own project's client, again every 30 s while the detail is open.
 */
import type { MuseApi } from "@m/api";
import {
  type AccountOperatingView,
  normalizeAccountOperating,
  partSource,
  personaChanges,
  versionWho,
} from "@m/shell/accounts/operating-core";
import { useShellData } from "@m/shell/data";
import { accountJobLines } from "@m/shell/jobs/jobs-core";
import type { AccountModel } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { phaseWords, t } from "@m/shell/strings";
import { operatingPlanBlock } from "@m/shell/task/detail-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type PersonaFieldName, personaFieldNames } from "../../../../packages/domain/src/accounts";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { Btn, ErrorLine, TextArea } from "../ui/primitives";
import { Block } from "./parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyDraft = (): Record<PersonaFieldName, string> => ({
  who: "",
  voice: "",
  background: "",
  boundaries: "",
});

export function OperatingBlocks({
  account,
  api,
  isCurrent,
}: {
  account: AccountModel;
  api: MuseApi;
  isCurrent: boolean;
}) {
  const nav = useShellNav();
  const data = useShellData();
  const path = `/api/agent/accounts/${encodeURIComponent(account.id)}`;
  // The records with the account they are of: another account's are never shown for this one.
  const [loaded, setLoaded] = useState<{ path: string; view: AccountOperatingView } | null>(null);
  const view = loaded?.path === path ? loaded.view : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<"" | "persona" | "goal">("");
  const [draft, setDraft] = useState(emptyDraft);
  const [goalDraft, setGoalDraft] = useState("");
  const [history, setHistory] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setLoaded({ path, view: normalizeAccountOperating(await api.request<unknown>(path)) });
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, path]);
  // `data.now` ticks every 30 s: the detail reads the records again.
  useEffect(() => {
    void load();
  }, [load, data.now]);
  async function save(kind: string, run: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(kind);
    setError("");
    try {
      setLoaded({ path, view: normalizeAccountOperating(await run()) });
      void data.refreshAll();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  }
  const jobs = useMemo(
    () => (isCurrent ? accountJobLines(data.jobs, account.id) : []),
    [isCurrent, data.jobs, account.id],
  );
  const clock = (iso: string) => (iso ? clockLabel(iso, data.now, phaseWords) : "");
  const persona = view?.persona ?? null;
  const plan = operatingPlanBlock(view?.plan ?? null, data.now);
  const p = t.persona;
  // Until the records are read, no block says it is empty: the account may well have them.
  if (!view)
    return (
      <>
        {[p.title, t.accountGoal.title, t.accountPlan.title].map((title) => (
          <Block key={title} title={title}>
            {error ? null : <div className="sk w60" aria-hidden="true" />}
          </Block>
        ))}
        <ErrorLine error={error} />
      </>
    );
  return (
    <>
      <Block title={p.title}>
        {editing === "persona" ? (
          <div className="acc-stack">
            {personaFieldNames.map((name) => (
              <TextArea
                key={name}
                label={p.fields[name]}
                value={draft[name]}
                rows={2}
                onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
              />
            ))}
            <p className="acc-small">{p.hint}</p>
            <div className="row">
              <Btn
                variant="pri"
                className="sm"
                busy={busy === "persona"}
                onClick={() => {
                  const fields = personaChanges(persona?.parts ?? null, draft);
                  if (!Object.keys(fields).length) return setEditing("");
                  void save("persona", () =>
                    api.request(`${path}/persona`, { fields }, "PUT"),
                  ).then((ok) => ok && setEditing(""));
                }}
              >
                {p.save}
              </Btn>
              <Btn className="sm ghost" onClick={() => setEditing("")}>
                {p.cancel}
              </Btn>
            </div>
          </div>
        ) : (
          <>
            {persona ? (
              personaFieldNames.map((name) => {
                const part = persona.parts[name];
                return (
                  <div key={name} className="acc-part">
                    <span className="k">{p.fields[name]}</span>
                    <p className="acc-pre">{part?.value ?? p.unset}</p>
                    {part ? <span className="src">{partSource(part)}</span> : null}
                  </div>
                );
              })
            ) : (
              <p className="acc-small">{p.empty}</p>
            )}
            <div className="row">
              <Btn
                className="sm"
                onClick={() => {
                  setDraft(
                    Object.fromEntries(
                      personaFieldNames.map((name) => [name, persona?.parts[name]?.value ?? ""]),
                    ) as Record<PersonaFieldName, string>,
                  );
                  setEditing("persona");
                }}
              >
                {p.edit}
              </Btn>
              {view.personaVersions.length ? (
                <button type="button" className="linkbtn" onClick={() => setHistory(!history)}>
                  {history ? p.hideHistory : p.history(view.personaVersions.length)}
                </button>
              ) : null}
            </div>
            {history &&
              view.personaVersions.map((version) => (
                <div key={version.version} className="acc-history">
                  <span className="acc-small">
                    {p.versionLine(version.version, versionWho(version), clock(version.at))}
                  </span>
                  {version.reason ? <span className="acc-small">{version.reason}</span> : null}
                  {personaFieldNames.map((name) =>
                    version.parts[name] ? (
                      <span key={name} className="acc-ellipsis">
                        {`${p.fields[name]}：${version.parts[name]?.value}`}
                      </span>
                    ) : null,
                  )}
                  {version.version === persona?.version ? (
                    <span className="acc-faint">{p.current}</span>
                  ) : (
                    <button
                      type="button"
                      className="linkbtn"
                      style={{ alignSelf: "flex-start" }}
                      disabled={!!busy}
                      onClick={() =>
                        void save(`use:${version.version}`, () =>
                          api.request(`${path}/persona/versions/${version.version}/use`, {}),
                        )
                      }
                    >
                      {p.use}
                    </button>
                  )}
                </div>
              ))}
          </>
        )}
      </Block>

      <Block title={t.accountGoal.title}>
        {editing === "goal" ? (
          <div className="acc-stack">
            <TextArea
              label={t.accountGoal.title}
              value={goalDraft}
              rows={3}
              placeholder={t.accountGoal.placeholder}
              onChange={(e) => setGoalDraft(e.target.value)}
            />
            <div className="row">
              <Btn
                variant="pri"
                className="sm"
                busy={busy === "goal"}
                disabled={!goalDraft.trim()}
                onClick={() =>
                  void save("goal", () =>
                    api.request(`${path}/goal`, { text: goalDraft.trim() }, "PUT"),
                  ).then((ok) => ok && setEditing(""))
                }
              >
                {t.accountGoal.save}
              </Btn>
              <Btn className="sm ghost" onClick={() => setEditing("")}>
                {t.accountGoal.cancel}
              </Btn>
            </div>
          </div>
        ) : (
          <>
            <p className={view.goal ? "acc-pre" : "acc-small"}>
              {view.goal?.text ?? t.accountGoal.empty}
            </p>
            <div className="row">
              <Btn
                className="sm"
                onClick={() => {
                  setGoalDraft(view.goal?.text ?? "");
                  setEditing("goal");
                }}
              >
                {t.accountGoal.edit}
              </Btn>
              {view.goal ? (
                <>
                  <Btn
                    className="sm dtext"
                    busy={busy === "clear"}
                    onClick={() =>
                      void save("clear", () => api.request(`${path}/goal`, { text: "" }, "PUT"))
                    }
                  >
                    {t.accountGoal.clear}
                  </Btn>
                  <span className="acc-small">{t.accountGoal.clearHint}</span>
                </>
              ) : null}
            </div>
          </>
        )}
      </Block>

      <Block title={t.accountPlan.title}>
        {plan && view.plan ? (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>{t.accountPlan.version(view.plan.version, clock(view.plan.setAt))}</span>
              <button type="button" className="linkbtn" onClick={() => setPlanOpen(!planOpen)}>
                {planOpen ? t.accountPlan.hide : t.accountPlan.show}
              </button>
            </div>
            {planOpen &&
              plan.rows.map((row) => (
                <div key={row.label} className="acc-stack tight">
                  <span className="acc-faint">{row.label}</span>
                  {row.lines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              ))}
          </>
        ) : (
          <p className="acc-small">{t.accountPlan.empty}</p>
        )}
      </Block>

      {isCurrent && (
        <Block title={t.accountJobs.title}>
          {jobs.length ? (
            jobs.map((job) => (
              <button
                key={job.jobId}
                type="button"
                className={job.archived ? "acc-task muted" : "acc-task"}
                onClick={() => nav.openPanel({ kind: "job", jobId: job.jobId })}
              >
                <span className="t">{job.line}</span>
              </button>
            ))
          ) : (
            <p className="acc-small">{t.accountJobs.empty}</p>
          )}
        </Block>
      )}
      <ErrorLine error={error} />
    </>
  );
}
