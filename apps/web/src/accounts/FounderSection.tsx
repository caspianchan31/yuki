/**
 * Phase C (docs/web.md): the founder's section of its own account detail, from
 * shell/founder/FounderSection.tsx (a React Native file of another area, redrawn here for the
 * account detail; the rules are founder-core.ts): 项目优先级, the owner's order of the projects
 * as numbered rows with labelled 上移 / 下移 buttons (the top five, the rest folded), each move
 * saved at once (PUT /api/founder/priorities); 各项目, one card per project in that order: its
 * state first (卡住 n / 需要你 n / 没人在做 with why, or 在做) and its stuck tasks, then the jobs the
 * project gave the founder, then 近 7 天做了 n 件; projects where nothing happens fold into
 * 「其余 n 个项目没人在做 ▸」. First her own 经营, what her loop really does
 * (founder-core founderState: 正在做 / 下次 … / 经营停了：why / 没在经营), with 打开日常运营 when it
 * waits on the owner; an order the owner never set reads 「未设置（按名称）」.
 */

import { useProjects } from "@m/projects-state";
import { useOverview, useShellData } from "@m/shell/data";
import {
  type CardChip,
  cardState,
  type FounderData,
  founderCards,
  founderState,
  moveInOrder,
  normalizeFounder,
  priorityNote,
  priorityRows,
  splitQuiet,
} from "@m/shell/founder/founder-core";
import { publishFounder } from "@m/shell/founder/useFounder";
import { carryPanelAcrossSwitch, type ShellPanel, useShellNav } from "@m/shell/nav";
import { refusalText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, cx, ErrorLine, Pill, Skeleton } from "../ui/primitives";
import { Block } from "./parts";

const errorText = (e: unknown) => refusalText(e instanceof Error ? e.message : String(e));

export function FounderSection() {
  const nav = useShellNav();
  const { api } = useWorkspace();
  const overview = useOverview();
  const projects = useProjects();
  const { now, stalled } = useShellData();
  const f = t.founder;
  const [data, setData] = useState<FounderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [moving, setMoving] = useState(false);
  const [allPriorities, setAllPriorities] = useState(false);
  const [showQuiet, setShowQuiet] = useState(false);
  // What the section reads and saves is the founder everyone shows (column row, job cards).
  useEffect(() => {
    if (data) publishFounder(data);
  }, [data]);

  const load = useCallback(async () => {
    try {
      setData(normalizeFounder(await api.request<unknown>("/api/founder")));
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
    void overview.refresh();
  }, [load, overview.refresh]);

  const cards = useMemo(
    () => (data ? founderCards(data, overview.projects, now) : []),
    [data, overview.projects, now],
  );

  async function move(projectId: string, step: -1 | 1) {
    if (!data || moving) return;
    const before = data;
    const order = moveInOrder(
      data.priorities.map((item) => item.projectId),
      projectId,
      step,
    );
    // Shown at once; the server's answer replaces it, a refusal puts the old order back.
    setData({
      ...data,
      priorities: order.flatMap((id, index) => {
        const item = data.priorities.find((row) => row.projectId === id);
        return item ? [{ ...item, rank: index + 1, set: true }] : [];
      }),
    });
    setMoving(true);
    setError("");
    try {
      const next = normalizeFounder(
        await api.request<unknown>("/api/founder/priorities", { order }, "PUT"),
      );
      if (next) setData(next);
    } catch (e) {
      setData(before);
      setError(errorText(e));
    } finally {
      setMoving(false);
    }
  }

  /** Opens `panel` in `projectId`, switching there first when it is another project. */
  function openIn(projectId: string | null, panel: ShellPanel) {
    if (projectId === projects.current) nav.openPanel(panel);
    else {
      carryPanelAcrossSwitch(panel);
      projects.select(projectId);
    }
  }
  function switchTo(projectId: string) {
    nav.closePanel();
    if (projectId !== projects.current) projects.select(projectId);
  }

  if (!data)
    return (
      <div>
        {loading ? <Skeleton lines={3} /> : null}
        <ErrorLine error={error} />
      </div>
    );

  const founder = data.founder;
  const priorityView = priorityRows(data.priorities, allPriorities);
  const folded = priorityRows(data.priorities, false).hidden;
  const { active, quiet } = splitQuiet(cards);
  const loop = founder ? founderState(founder, now, stalled) : null;
  const unset = priorityNote(data.priorities);
  return (
    <div>
      <ErrorLine error={error} />
      {founder && loop ? (
        <Block title={f.loop}>
          <p
            className={cx(
              "acc-small",
              loop.state === "needs" && "acc-redtext",
              loop.state === "blocked" && "acc-ambertext",
            )}
          >
            {loop.detail ?? loop.line}
          </p>
          {founder.loop && loop.phase?.needsYou ? (
            <button
              type="button"
              className="linkbtn"
              style={{ alignSelf: "flex-start" }}
              onClick={() =>
                founder.loop && openIn(null, { kind: "task", taskId: founder.loop.taskId })
              }
            >
              {f.openLoop}
            </button>
          ) : null}
        </Block>
      ) : null}
      <Block title={f.priorities}>
        <p className="acc-small">{f.prioritiesHint}</p>
        {unset ? <p className="acc-faint">{unset}</p> : null}
        {data.priorities.length ? (
          <div>
            {priorityView.shown.map((item, index) => (
              <div key={item.projectId} className="acc-prio">
                <span className={cx("n", index === 0 && "top")}>{index + 1}</span>
                <span className="nm">{item.name}</span>
                <Btn
                  className="sm"
                  icon={ArrowUp}
                  aria-label={f.up(item.name)}
                  disabled={moving || index === 0}
                  onClick={() => void move(item.projectId, -1)}
                >
                  {f.upShort}
                </Btn>
                <Btn
                  className="sm"
                  icon={ArrowDown}
                  aria-label={f.down(item.name)}
                  disabled={moving || index === data.priorities.length - 1}
                  onClick={() => void move(item.projectId, 1)}
                >
                  {f.downShort}
                </Btn>
              </div>
            ))}
            {folded ? (
              <button
                type="button"
                className="linkbtn"
                onClick={() => setAllPriorities(!allPriorities)}
              >
                {allPriorities ? f.hidePriorities : f.showAllPriorities(folded)}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="acc-small">{f.noProjects}</p>
        )}
      </Block>

      {cards.length ? (
        <Block title={f.projects}>
          {active.map((card) => {
            const state = cardState(card);
            return (
              <div key={card.projectId} className="acc-pcard">
                <div className="row">
                  <button
                    type="button"
                    className="linkbtn plain acc-ellipsis"
                    style={{ fontWeight: 600 }}
                    aria-label={f.switchTo(card.name)}
                    onClick={() => switchTo(card.projectId)}
                  >
                    {`${card.rank}. ${card.name}`}
                  </button>
                  {state.fine ? (
                    <span className="acc-small acc-greentext">{f.working}</span>
                  ) : (
                    state.chips.map((chip) => <StateChip key={chip.label} chip={chip} />)
                  )}
                </div>
                {card.why ? <span className="acc-small">{card.why}</span> : null}
                {card.stuck.map((task) => (
                  <button
                    key={task.taskId}
                    type="button"
                    className="linkbtn red"
                    style={{ textAlign: "left" }}
                    onClick={() => openIn(card.projectId, { kind: "task", taskId: task.taskId })}
                  >
                    {task.line}
                  </button>
                ))}
                {founder && card.jobs.length ? (
                  <div className="acc-stack tight">
                    <span className="acc-small" style={{ fontWeight: 600 }}>
                      {f.jobs}
                    </span>
                    {card.jobs.map((job) => (
                      <button
                        key={job.jobId}
                        type="button"
                        className="linkbtn"
                        style={{ textAlign: "left" }}
                        onClick={() => openIn(card.projectId, { kind: "job", jobId: job.jobId })}
                      >
                        {job.line}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="acc-faint">{f.actions7d(card.actions7d)}</span>
              </div>
            );
          })}
          {quiet.length ? (
            <div className="acc-stack tight">
              <button
                type="button"
                className="linkbtn muted"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setShowQuiet(!showQuiet)}
              >
                {showQuiet ? f.quietHide : f.quiet(quiet.length)}
              </button>
              {showQuiet
                ? quiet.map((card) => (
                    <button
                      key={card.projectId}
                      type="button"
                      className="linkbtn"
                      style={{ alignSelf: "flex-start" }}
                      aria-label={f.switchTo(card.name)}
                      onClick={() => switchTo(card.projectId)}
                    >
                      {`${card.rank}. ${card.name}${t.common.sep}${card.why ?? f.nobody}`}
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </Block>
      ) : null}
    </div>
  );
}

/** 「卡住 n」 (red) / 「需要你 n」 (amber) / 「没人在做」 (grey) on a project card. */
function StateChip({ chip }: { chip: CardChip }) {
  return (
    <Pill tone={chip.tone === "red" ? "r" : chip.tone === "amber" ? "a" : ""}>{chip.label}</Pill>
  );
}
