/**
 * Phase C (docs/web.md): the empty conversation, from shell/chat/EmptyState.tsx. The person
 * only gives a goal (「用哪个号做什么」); how to do it and the pacing are the system's own plan.
 * Yuki's own conversation explains what it is for and offers the new-member dialog.
 */

import { useProjects } from "@m/projects-state";
import { emptyStateKind } from "@m/shell/chat/core";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { useProjectTitle } from "@m/shell/store-space";
import { t } from "@m/shell/strings";
import { setFrame } from "../shell/state";

function Suggestion({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button type="button" className="sugg" onClick={onClick}>
      {text}
    </button>
  );
}

export function ChatEmptyState({
  member,
}: {
  /** Set while a member is open: this is her conversation, not the hall's. */
  member?: string | null;
}) {
  const nav = useShellNav();
  const { current } = useProjects();
  const name = useProjectTitle();
  const { accounts } = useShellData();
  const kind = emptyStateKind(current, accounts.value.length);
  return (
    <div className="chat-empty">
      {member ? (
        <p>{t.empty.memberBody(member)}</p>
      ) : kind === "default" ? (
        <>
          <h2>{t.empty.defaultTitle}</h2>
          <p>{t.empty.defaultBody}</p>
          <Suggestion text={t.empty.newMember} onClick={() => setFrame({ newMember: true })} />
        </>
      ) : (
        <>
          <h2>{t.empty.title(name)}</h2>
          <p>
            {kind === "noAccounts" && !accounts.loading ? t.empty.noAccounts : t.empty.groupBody}
          </p>
          {kind === "noAccounts" && !accounts.loading ? (
            <Suggestion
              text={t.empty.joinAccount}
              onClick={() => nav.openPanel({ kind: "join" })}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
