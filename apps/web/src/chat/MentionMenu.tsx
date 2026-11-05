/**
 * v1.2: the @ list under the chat box. `useMentionOptions` gathers what an @ can name (this
 * group's members, Yuki and the other members, the groups, the routines of this scope, the space's skills; connected apps); `MentionMenu` draws the filtered rows. What the
 * words do is in shell/chat/mention.ts.
 */

import { useProjects } from "@m/projects-state";
import { mentionApps } from "@m/shell/apps";
import { type MentionOption, mentionOptions } from "@m/shell/chat/mention";
import { useShellData } from "@m/shell/data";
import { t } from "@m/shell/strings";
import { useEffect, useMemo } from "react";
import { useApps } from "../shell/useApps";
import { useAllMembers, useGroupName } from "../shell/useMembers";
import { useSkills } from "../shell/useSkills";
import { cx } from "../ui/primitives";

/** The main member has no record of her own; this id only keeps her row's key unique. */
const mainMemberId = "main";

/** `typing`: an @ is being typed; the skills and apps are read again when that starts (a skill saved
 * in chat, an app just connected, must show without a reload or the tab regaining focus). */
export function useMentionOptions(typing = false): MentionOption[] {
  const data = useShellData();
  const { projects, current } = useProjects();
  const members = useAllMembers();
  const groupName = useGroupName();
  const tasks = data.tasks;
  const { skills, reload: reloadSkills } = useSkills();
  const { apps, reload: reloadApps } = useApps();
  useEffect(() => {
    if (!typing) return;
    void reloadSkills();
    void reloadApps();
  }, [typing, reloadSkills, reloadApps]);
  return useMemo(
    () =>
      mentionOptions({
        main: { id: mainMemberId, name: t.app.name },
        members: members.map((member) => ({
          id: member.id,
          name: member.name,
          projectId: member.projectId,
        })),
        groups: projects
          .filter((project) => !project.deleting)
          .map((project) => ({ id: project.id, name: project.name })),
        tasks,
        skills,
        apps: mentionApps(apps),
        groupId: current,
        groupName,
      }),
    [members, projects, tasks, skills, apps, current, groupName],
  );
}

export function MentionMenu({
  id,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  items: readonly MentionOption[];
  active: number;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  return (
    <div className="mention-anchor">
      <div className="mention-menu" role="listbox" id={id} aria-label={t.mention.list}>
        {items.map((option, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the box keeps focus; arrow keys and Enter drive the list from there
          <div
            key={option.key}
            id={`${id}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            className={cx("mention-row", index === active && "on")}
            // The box keeps focus and its caret while a row is pressed.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(option)}
          >
            <span className="mention-name">{option.name}</span>
            {option.here ? (
              <span className="mention-hint">{t.mention.here}</span>
            ) : option.hint ? (
              <span className="mention-hint">{t.mention.inGroup(option.hint)}</span>
            ) : null}
            <span className="mention-kind">
              {option.key === `member:${mainMemberId}`
                ? t.mention.main
                : t.mention.kinds[option.kind]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
