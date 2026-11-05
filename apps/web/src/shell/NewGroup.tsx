/**
 * v1.2: the dialog behind 新建群 in the contact list. A group is a name and 2 to 6 members. A
 * member is in one group at a time, so choosing one who is in another group moves her here, and
 * the list says so. On save the group is made, the members are put in it, and the group opens.
 * If some members do not get in, the dialog stays and says who, and 接着移 sends the rest.
 */

import { useProjects } from "@m/projects-state";
import { accountErrorText, environmentPath, useAccountOps } from "@m/shell/accounts/hooks";
import { useShellData } from "@m/shell/data";
import {
  canPick,
  failureLines,
  type GroupChoice,
  groupChoices,
  groupError,
  groupMembersMax,
  type MemberMove,
  moveMembersInto,
  newGroupMembersMin,
  newGroupProblem,
  togglePick,
} from "@m/shell/members/groups";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useRef, useState } from "react";
import { MemberFace } from "../ui/MemberFace";
import { faceOf } from "../ui/member-face";
import { Btn, ErrorLine, Field, Sheet } from "../ui/primitives";
import "./new-group.css";
import { setFrame } from "./state";
import { useAllMembers, useGroupName } from "./useMembers";

const n = t.newGroup;

function close() {
  setFrame({ newGroup: false });
}

export function NewGroup() {
  const nav = useShellNav();
  const data = useShellData();
  const ops = useAccountOps();
  const { create, select } = useProjects();
  const { notify } = useWorkspace();
  const groupName = useGroupName();
  const choices = groupChoices(useAllMembers(), groupName);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  // A retry after some members did not get in does not make a second group, and a member who
  // already moved is not moved again. A member left in no group by a half move starts from there.
  const created = useRef<string | null>(null);
  const moved = useRef(new Set<string>());
  const from = useRef(new Map<string, string | null>());
  const locked = busy || created.current !== null;

  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const leaving = picked.filter((id) => (byId.get(id)?.group ?? null) !== null).length;
  const atMax = picked.length >= groupMembersMax;

  async function save() {
    if (busy) return;
    const problem = created.current ? null : newGroupProblem(name, picked);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    setLines([]);
    try {
      if (!created.current) created.current = (await create(name.trim())).id;
      const groupId = created.current;
      const todo: MemberMove[] = picked
        .filter((id) => !moved.current.has(id))
        .flatMap((id) => {
          const choice = byId.get(id);
          if (!choice) return [];
          const start = from.current.has(id) ? (from.current.get(id) ?? null) : choice.projectId;
          return [{ id, name: choice.name, from: start }];
        });
      const result = await moveMembersInto(
        groupId,
        todo,
        (id, step) =>
          data
            .apiFor(step.header)
            .request<unknown>(environmentPath(id), { projectId: step.projectId }, "PATCH"),
        accountErrorText,
      );
      for (const id of result.moved) {
        moved.current.add(id);
        ops.recordMove(id, groupId);
      }
      for (const item of result.failed) if (item.stuck) ops.recordMove(item.id, null);
      for (const item of result.failed) from.current.set(item.id, item.from);
      await Promise.allSettled([ops.afterChange(), data.topology.refresh()]);
      if (result.failed.length) {
        setError(n.madeButMembers(name.trim()));
        setLines(failureLines(result));
        return;
      }
      notify(n.createdToast(name.trim()));
      close();
      setFrame({ drawer: false, platform: null, peek: null });
      nav.setView("work");
      select(groupId);
    } catch (e) {
      // Nothing is left half made without saying so: before the group exists this is a plain
      // refusal; after it, the group is there and the members are what is still to do.
      const why = groupError(e instanceof Error ? e.message : String(e));
      setError(created.current ? `${n.madeButMembers(name.trim())}${why}` : why);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={n.title}
      onClose={close}
      footer={
        <>
          <Btn disabled={busy} onClick={close}>
            {t.common.cancel}
          </Btn>
          <Btn variant="pri" busy={busy} onClick={() => void save()}>
            {created.current ? n.retry : n.create}
          </Btn>
        </>
      }
    >
      <form
        className="ng-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={n.name}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError("");
          }}
          placeholder={n.namePlaceholder}
          disabled={locked}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
        />
        <div className="nm-section">
          <div className="ng-head">
            <span className="nm-label">{n.members}</span>
            <span className="nm-note">{n.picked(picked.length, groupMembersMax)}</span>
          </div>
          <p className="nm-note">{n.pickHint(newGroupMembersMin, groupMembersMax)}</p>
          {choices.length === 0 ? (
            <p className="nm-note">{n.none}</p>
          ) : (
            <ul className="ng-list">
              {choices.map((choice) => (
                <MemberOption
                  key={choice.id}
                  choice={choice}
                  checked={picked.includes(choice.id)}
                  disabled={locked || !canPick(picked, choice.id)}
                  onToggle={() => {
                    setPicked((list) => togglePick(list, choice.id));
                    setError("");
                  }}
                />
              ))}
            </ul>
          )}
          {atMax ? <p className="nm-note">{n.full(groupMembersMax)}</p> : null}
          {leaving > 0 ? <p className="nm-note">{n.moveSummary(leaving)}</p> : null}
        </div>
        <ErrorLine error={error} />
        {lines.length ? (
          <ul className="ng-problems">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {created.current && !lines.length && error ? (
          <p className="nm-note">{n.emptyHint}</p>
        ) : null}
      </form>
    </Sheet>
  );
}

function MemberOption({
  choice,
  checked,
  disabled,
  onToggle,
}: {
  choice: GroupChoice;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="ng-row" aria-disabled={disabled}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
        <MemberFace {...faceOf(choice)} size={28} label={choice.name} />
        <span className="ng-name">{choice.name}</span>
        <span className="ng-where">{choice.group ? n.inGroup(choice.group) : n.free}</span>
      </label>
      {checked && choice.group ? <p className="ng-move">{n.moveNote(choice.group)}</p> : null}
    </li>
  );
}
