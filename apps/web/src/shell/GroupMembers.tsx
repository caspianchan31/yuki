/**
 * v1.2: the group's right rail. The group's name (it can be changed), who is in the group and
 * whether they are waiting on you or using the computer, and adding and removing members. A need
 * itself stays in that member's own chat. A member is in one group at a time, so adding one who is
 * in another group moves her here; removing one sends her back to no group.
 */

import { useProjects } from "@m/projects-state";
import { accountErrorText, environmentPath, useAccountOps } from "@m/shell/accounts/hooks";
import { useShellData } from "@m/shell/data";
import { useFounderRef } from "@m/shell/founder/useFounder";
import { useProjectRows } from "@m/shell/frame/useProjectRows";
import {
  groupChoices,
  groupError,
  groupMembersMax,
  groupNameProblem,
  moveMembersInto,
} from "@m/shell/members/groups";
import { groupMemberMark } from "@m/shell/members/member-detail";
import { accountMember } from "@m/shell/members/members-core";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { MemberFace } from "../ui/MemberFace";
import { faceOf } from "../ui/member-face";
import { Btn, ErrorLine, IconBtn } from "../ui/primitives";
import "./new-group.css";
import { peekAccount } from "./state";
import { useAllMembers, useGroupName } from "./useMembers";

const p = t.groupPane;

export function GroupMembers({ onClose }: { onClose: () => void }) {
  const data = useShellData();
  const ops = useAccountOps();
  const { current, rename } = useProjects();
  const rows = useProjectRows();
  const { notify } = useWorkspace();
  const groupName = useGroupName();
  const everyone = useAllMembers();
  const founderId = useFounderRef()?.environmentId ?? null;
  const name = rows.find((row) => row.id === current)?.name ?? "这个群";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const members = data.accounts.value
    .filter((account) => account.projectId === current)
    .map((account) => {
      const card = accountMember(account, data.now, founderId === account.id, data.stalled);
      return {
        id: account.id,
        name: account.name,
        face: account.view.face,
        mark: groupMemberMark({
          state: card.state,
          line: card.line,
          desktop: account.desktop,
        }),
      };
    })
    .sort((a, b) => {
      const rank = (tone: string) => (tone === "wait" ? 0 : tone === "desk" ? 1 : 2);
      return rank(a.mark.tone) - rank(b.mark.tone) || a.name.localeCompare(b.name, "zh");
    });
  // The hall is Yuki's own chat, not a group: nothing to rename, add to or remove from.
  const editable = current !== null;
  const full = members.length >= groupMembersMax;
  const candidates = groupChoices(
    everyone.filter((member) => member.projectId !== current),
    groupName,
  );
  const free = candidates.filter((choice) => choice.group === null);
  const elsewhere = candidates.filter((choice) => choice.group !== null);

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(groupError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }
  const settle = () => Promise.allSettled([ops.afterChange(), data.topology.refresh()]);

  async function saveName() {
    const next = draft.trim();
    if (!current) return;
    const problem = groupNameProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    if (next === name) {
      setRenaming(false);
      return;
    }
    await run("name", async () => {
      await rename(current, next);
      setRenaming(false);
      notify(p.renamed(next));
    });
  }

  const send = (id: string, step: { header: string | null; projectId: string | null }) =>
    data
      .apiFor(step.header)
      .request<unknown>(environmentPath(id), { projectId: step.projectId }, "PATCH");

  async function add(id: string, memberName: string, from: string | null) {
    if (!current) return;
    await run(id, async () => {
      const result = await moveMembersInto(
        current,
        [{ id, name: memberName, from }],
        send,
        accountErrorText,
      );
      for (const moved of result.moved) ops.recordMove(moved, current);
      for (const stuck of result.failed) if (stuck.stuck) ops.recordMove(stuck.id, null);
      await settle();
      const failed = result.failed[0];
      if (failed) {
        setError(failed.stuck ? `${p.stuck(memberName)}${failed.error}` : failed.error);
        return;
      }
      notify(from ? p.moved(memberName, groupName(from)) : p.added(memberName));
    });
  }

  async function remove(id: string, memberName: string) {
    if (!current) return;
    await run(id, async () => {
      await send(id, { header: current, projectId: null });
      ops.recordMove(id, null);
      await settle();
      notify(p.removed(memberName));
    });
  }

  return (
    <div className="member-detail">
      <div className="member-detail-h">
        {renaming ? (
          <form
            className="gp-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              className="input"
              aria-label={p.renameLabel}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              disabled={busy === "name"}
            />
            <Btn variant="pri" className="sm" type="submit" busy={busy === "name"}>
              {p.save}
            </Btn>
          </form>
        ) : (
          <div className="gp-title">
            <h2>{name}</h2>
            {editable ? (
              <IconBtn
                icon={Pencil}
                label={p.rename}
                onClick={() => {
                  setDraft(name);
                  setError("");
                  setRenaming(true);
                }}
              />
            ) : null}
          </div>
        )}
        <IconBtn icon={X} label="关闭" onClick={onClose} />
      </div>
      <h3>{p.members}</h3>
      {members.length === 0 ? (
        <p className="meta">这个群还没有成员。</p>
      ) : (
        <ul className="group-members">
          {members.map((member) => (
            <li key={member.id} className="gp-row">
              <button type="button" onClick={() => peekAccount(member.id)}>
                <MemberFace {...faceOf(member)} size={28} label={member.name} />
                <span className="who">{member.name}</span>
                <span className={`mark ${member.mark.tone}`}>{member.mark.text}</span>
              </button>
              {editable ? (
                <button
                  type="button"
                  className="gp-remove"
                  aria-label={p.remove(member.name)}
                  title={p.remove(member.name)}
                  disabled={!!busy}
                  onClick={() => void remove(member.id, member.name)}
                >
                  {p.removeLabel}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        adding ? (
          <div className="gp-add">
            <p className="gp-note">{full ? p.full(groupMembersMax) : p.adding}</p>
            {candidates.length === 0 ? <p className="gp-note">{p.nobodyToAdd}</p> : null}
            {free.length ? (
              <>
                <h4>{p.addFree}</h4>
                <PickList
                  items={free}
                  disabled={full || !!busy}
                  onPick={(item) => void add(item.id, item.name, null)}
                />
              </>
            ) : null}
            {elsewhere.length ? (
              <>
                <h4>{p.addElsewhere}</h4>
                <PickList
                  items={elsewhere}
                  disabled={full || !!busy}
                  onPick={(item) => void add(item.id, item.name, item.projectId)}
                />
              </>
            ) : null}
            <div>
              <Btn className="sm" onClick={() => setAdding(false)}>
                {t.common.close}
              </Btn>
            </div>
          </div>
        ) : (
          <div>
            <Btn className="sm" icon={Plus} disabled={full} onClick={() => setAdding(true)}>
              {p.add}
            </Btn>
            {full ? <p className="gp-note">{p.full(groupMembersMax)}</p> : null}
          </div>
        )
      ) : null}
      <ErrorLine error={error} />
      <p className="meta">要你拍板、要你登录的事，只在那个成员和你的一对一里出现；群里只留一行。</p>
    </div>
  );
}

function PickList({
  items,
  disabled,
  onPick,
}: {
  items: ReturnType<typeof groupChoices>;
  disabled: boolean;
  onPick: (item: ReturnType<typeof groupChoices>[number]) => void;
}) {
  return (
    <ul className="gp-pick">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" disabled={disabled} onClick={() => onPick(item)}>
            <MemberFace {...faceOf(item)} size={24} label={item.name} />
            <span className="who">{item.name}</span>
            {item.group ? <span className="ng-where">{t.newGroup.inGroup(item.group)}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
