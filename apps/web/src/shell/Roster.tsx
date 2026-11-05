/**
 * v1.2: the app opens on the contact list. Yuki, the main member, stays above the groups; members
 * sit under 每天 / 每周 / 没有例行 by their routine, and projects under 群 with the hall first.
 * The footer holds 设置 and, for the platform operator, 平台管理.
 */

import { normalizeReports } from "@m/chat-reports-core";
import { useProjects } from "@m/projects-state";
import { useOverview, useShellData } from "@m/shell/data";
import { useProjectRows } from "@m/shell/frame/useProjectRows";
import { needsForMember } from "@m/shell/members/member-detail";
import { accountMember } from "@m/shell/members/members-core";
import {
  bucketsFromAgent,
  groupNeedCount,
  type RosterGroup,
  type RosterMember,
  type RoutineBucket,
  rosterLine,
  rosterPreview,
  rosterSections,
  taskRoutineBucket,
} from "@m/shell/members/roster";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatReport } from "../../../../packages/domain/src/agent";
import { clockLabel } from "../../../../packages/domain/src/task-phase";
import { needEnvironment } from "../chat/MemberNeeds";
import { useTenancyUi } from "../tenancy-ui";
import { MemberFace } from "../ui/MemberFace";
import { faceOf, pickFace } from "../ui/member-face";
import { cx } from "../ui/primitives";
import { dotOf } from "./faces";
import { peekAccount, setFrame, useFrame } from "./state";
import { useEveryone } from "./useMembers";

interface ListedMember extends RosterMember {
  state: "needs" | "blocked" | "running" | "waiting" | "idle";
  /** A clock beside the name when the second line is her latest result. */
  clock: string;
  /** The face she was made with; absent: the one her name picks. */
  face?: unknown;
}

export function Roster() {
  const data = useShellData();
  const overview = useOverview();
  const rows = useProjectRows();
  const { current, select } = useProjects();
  const nav = useShellNav();
  const frame = useFrame();
  const ui = useTenancyUi();
  const everyone = useEveryone();
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Map<string, RoutineBucket>>(() => new Map());

  const refreshTopology = data.topology.refresh;
  useEffect(() => {
    void refreshTopology();
  }, [refreshTopology]);

  const otherKey = rows
    .map((row) => row.id)
    .filter((id) => id !== current)
    .join("\n");
  useEffect(() => {
    const ids = otherKey ? otherKey.split("\n") : [];
    let gone = false;
    void Promise.all(
      ids.map(async (id) => {
        try {
          return bucketsFromAgent(await data.apiFor(id).request<unknown>("/api/agent"));
        } catch {
          return new Map<string, RoutineBucket>();
        }
      }),
    ).then((maps) => {
      if (gone) return;
      const merged = new Map<string, RoutineBucket>();
      for (const map of maps) for (const [id, bucket] of map) merged.set(id, bucket);
      setRemote(merged);
    });
    return () => {
      gone = true;
    };
  }, [data.apiFor, otherKey]);

  const [wider, setWider] = useState<ChatReport[]>([]);
  useEffect(() => {
    let gone = false;
    void data
      .apiFor(current)
      .request<unknown>("/api/chat-reports?limit=50")
      .then((page) => {
        if (!gone) setWider(normalizeReports(page));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [current, data.apiFor, data.reports.value]);

  const preview = useMemo(
    () => rosterPreview(data.tasks, wider.length ? wider : data.reports.value),
    [data.reports.value, data.tasks, wider],
  );

  const members = useMemo(() => {
    const local: ListedMember[] = data.accounts.value.map((account) => {
      const card = accountMember(account, data.now, data.stalled);
      const quiet = !card.line.trim() || card.line.trim() === t.members.idle;
      const latest = preview.get(account.id) ?? null;
      const line = rosterLine(card.line, latest?.text ?? null, quiet);
      return {
        id: account.id,
        name: account.name,
        line,
        clock: quiet && latest && line !== card.line.trim() ? clockLabel(latest.at, data.now) : "",
        bucket: taskRoutineBucket(account.tasks.map((entry) => entry.task)),
        projectId: account.projectId,
        state: card.state,
        face: account.view.face,
      };
    });
    const seen = new Set(local.map((member) => member.id));
    const elsewhere: ListedMember[] = everyone
      .filter((environment) => !seen.has(environment.id))
      .map((environment) => ({
        id: environment.id,
        name: environment.name,
        line: "",
        clock: "",
        bucket: remote.get(environment.id) ?? "none",
        projectId: environment.projectId,
        state: "idle",
        face: environment.face,
      }));
    return [...local, ...elsewhere];
  }, [data.accounts.value, data.now, data.stalled, everyone, preview, remote]);

  // The open project's line counts only what stays in that group's chat. A member's own
  // need is on her conversation, so it is not counted here.
  const here = needsForMember(data.needs, null, needEnvironment).length;
  const groupRow = (row: (typeof rows)[number]): RosterGroup => {
    const listed = overview.projects?.find((project) => project.id === row.id);
    const waiting =
      row.id === current ? here : listed?.needs ? groupNeedCount(listed.needs) : row.needsYou;
    return {
      id: row.id,
      name: row.name,
      line: waiting > 0 ? t.members.projectNeeds(waiting) : (row.countLabel ?? ""),
      deleting: row.deleting,
    };
  };
  // The hall is Yuki's own conversation, listed above the rest; only the other groups sit under 群.
  const hallRow = rows.find((row) => row.id === null);
  const hallLine = hallRow ? groupRow(hallRow).line : "";
  const hallNeeds = hallRow && hallLine !== hallRow.countLabel ? hallLine : "";
  const groups: RosterGroup[] = rows.filter((row) => row.id !== null).map(groupRow);

  const needle = query.trim().toLowerCase();
  const sections = rosterSections({
    members: needle
      ? members.filter((member) => member.name.toLowerCase().includes(needle))
      : members,
    groups: needle ? groups.filter((group) => group.name.toLowerCase().includes(needle)) : groups,
    keepGroups: !needle,
  });

  const work = nav.view === "work" && !frame.platform;
  const openChat = () => {
    setFrame({ drawer: false, platform: null });
    nav.setView("work");
  };
  const openMember = (member: ListedMember) => {
    openChat();
    if (member.projectId !== current) select(member.projectId);
    peekAccount(member.id);
  };
  const openGroup = (group: RosterGroup) => {
    if (group.deleting) return;
    openChat();
    setFrame({ peek: null });
    if (group.id !== current) select(group.id);
  };

  return (
    <aside className="sidebar roster" aria-label="成员和群">
      <div className="sb-top">
        <span className="roster-brand">
          <MemberFace shape="flake" color="var(--fg)" size={22} />
          <span className="space-name">{t.app.name}</span>
        </span>
        <button
          type="button"
          className="tb-btn"
          aria-label="新成员"
          onClick={() => setFrame({ newMember: true })}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="sb-sec">
        <label className="roster-search">
          <input
            type="search"
            aria-label={t.web.search}
            placeholder={t.web.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="sb-sec roster-list">
        <button
          type="button"
          className={cx("sb-item", work && current === null && !frame.peek && "on")}
          onClick={() => {
            openChat();
            setFrame({ peek: null });
            if (current !== null) select(null);
          }}
        >
          <MemberFace shape="flake" color="var(--fg)" size={28} star label={t.app.name} />
          <span className="roster-text">
            <span className="lbl">{t.app.name}</span>
            <span className="roster-line">{hallNeeds || t.members.mainLine}</span>
          </span>
        </button>
        {sections.map((section) => (
          <div key={section.key}>
            {section.key === "groups" ? (
              <div className="sb-label sb-label-row">
                <span>{section.label}</span>
                <button
                  type="button"
                  className="sb-label-btn"
                  onClick={() => setFrame({ newGroup: true, drawer: false })}
                >
                  <Plus size={12} />
                  {t.newGroup.open}
                </button>
              </div>
            ) : (
              <div className="sb-label">{section.label}</div>
            )}
            {section.members.map((member) => {
              const listed = member as ListedMember;
              const face = faceOf(listed);
              return (
                <button
                  key={listed.id}
                  type="button"
                  className={cx("sb-item", frame.peek === listed.id && "on")}
                  onClick={() => openMember(listed)}
                >
                  <MemberFace {...face} size={28} state={dotOf[listed.state]} label={listed.name} />
                  <span className="roster-text">
                    <span className="roster-name">
                      <span className="lbl">{listed.name}</span>
                      {listed.clock ? <span className="roster-clock">{listed.clock}</span> : null}
                    </span>
                    {listed.line ? <span className="roster-line">{listed.line}</span> : null}
                  </span>
                </button>
              );
            })}
            {section.groups.map((group) => (
              <button
                key={group.id ?? "hall"}
                type="button"
                className={cx("sb-item", work && !frame.peek && group.id === current && "on")}
                onClick={() => openGroup(group)}
              >
                <MemberFace {...pickFace(group.name)} size={28} label={group.name} />
                <span className="roster-text">
                  <span className="lbl">{group.name}</span>
                  {group.line ? <span className="roster-line">{group.line}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sb-bottom">
        <ui.RosterEntry
          on={!!frame.platform}
          onOpen={(tab) => {
            nav.closePanel();
            // Already open: stays on its tab.
            setFrame({ platform: frame.platform ?? tab, drawer: false });
          }}
        />
        <button
          type="button"
          className="sb-item"
          onClick={() => {
            setFrame({ drawer: false });
            nav.openPanel({ kind: "settings" });
          }}
        >
          <span className="ic">
            <Settings size={15} />
          </span>
          <span className="lbl">{t.header.settings}</span>
        </button>
      </div>
    </aside>
  );
}
