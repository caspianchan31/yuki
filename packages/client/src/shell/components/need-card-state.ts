/**
 * The need card's state without React Native, shared by the phone's
 * NeedCard.tsx and the web's 需要你 rows (apps/web/src/rail): what an account or a project item
 * offers (which logins to add or replace, whether the desktop or the credentials page is the
 * place to act, the steps to do on the desktop), and the flows its buttons open (the review
 * sheet, looked up again when the list is stale; the account's or the project's default desktop,
 * after which the AI looks again at each site that needed a code; the login editor).
 */
import { useState } from "react";
import type { ActionProposal, Workspace } from "../../../../../packages/domain/src";
import { useWorkspace } from "../../workspace";
import { type DesktopNeed, desktopNeed, needInChat } from "../chat/guide-core";
import { useShellData } from "../data";
import {
  type AccountFlag,
  type AccountModel,
  type NeedItem,
  needAction,
  needShots,
  siteFlag,
} from "../model";
import { useShellNav } from "../nav";
import { t } from "../strings";

/** chat: the card in the transcript; rail: a row inside 需要你 (the live panel, the web page). */
export type NeedVariant = "chat" | "rail";

/** The sites among `flags` that needed a code. */
export const codeSites = (flags: readonly AccountFlag[]) =>
  flags.flatMap((flag) => {
    const site = siteFlag(flag);
    return site?.status === "needs_code" ? [site.site] : [];
  });

/** The desktop's step for the flags in `other` (its picture stays above the desktop until it
 * closes), and one line per reason of what to do there. */
function desktopOf(
  item: Extract<NeedItem, { kind: "account" | "project" }>,
  other: readonly AccountFlag[],
) {
  const shots = new Map(needShots(item).map((shot) => [shot.site, shot.id]));
  const need = desktopNeed(other, (site) => shots.get(site) ?? null) ?? undefined;
  return { need, steps: [] as string[] };
}

export interface AccountNeedModel {
  /** Asked for by a chat card (the rail reads one line and is done there). */
  asked: AccountFlag[];
  other: AccountFlag[];
  login: { kind: "login"; site: string } | null;
  wrongPassword: boolean;
  desktop: boolean;
  proxy: boolean;
  /** A platform-set-up space's account without an exit: pick one. */
  exit: boolean;
  /** Not operating: 定长期目标 (its detail) and 在聊天里派活… (the chat). */
  goal: boolean;
  need: DesktopNeed | undefined;
  steps: string[];
}

/** Every fact only the owner can act on, each with where to act on it. */
export function accountNeedModel(
  item: Extract<NeedItem, { kind: "account" }>,
  variant: NeedVariant,
): AccountNeedModel {
  // 需要你 (rail): what the chat already asks for with a card reads one line and is done there.
  const { asked, other } =
    variant === "rail" ? needInChat(item) : { asked: [] as AccountFlag[], other: item.flags };
  const actions = other.map((flag) => needAction(flag));
  const login = actions.find((action) => action.kind === "login");
  return {
    asked,
    other,
    login: login && login.kind === "login" ? { kind: "login", site: login.site } : null,
    wrongPassword: other.some((flag) => siteFlag(flag)?.status === "wrong_password"),
    desktop: actions.some((action) => action.kind === "desktop"),
    proxy: actions.some((action) => action.kind === "proxy"),
    exit: actions.some((action) => action.kind === "exit"),
    goal: actions.some((action) => action.kind === "goal"),
    ...desktopOf(item, other),
  };
}

export interface ProjectNeedModel {
  asked: AccountFlag[];
  other: AccountFlag[];
  logins: { site: string; replace: boolean }[];
  desktop: boolean;
  proxy: boolean;
  need: DesktopNeed | undefined;
  steps: string[];
}

/** The project's own logins (its default desktop): what each fact asks of the owner. */
export function projectNeedModel(
  item: Extract<NeedItem, { kind: "project" }>,
  variant: NeedVariant,
): ProjectNeedModel {
  const { asked, other } =
    variant === "rail" ? needInChat(item) : { asked: [] as AccountFlag[], other: item.flags };
  const actions = other.map((flag) => ({ flag, action: needAction(flag) }));
  return {
    asked,
    other,
    logins: actions.flatMap(({ flag, action }) =>
      action.kind === "login"
        ? [{ site: action.site, replace: siteFlag(flag)?.status === "wrong_password" }]
        : [],
    ),
    desktop: actions.some((entry) => entry.action.kind === "desktop"),
    proxy: actions.some((entry) => entry.action.kind === "proxy"),
    ...desktopOf(item, other),
  };
}

/** The flows a need's buttons open, the same on the phone and the web. */
export function useNeedFlows() {
  const nav = useShellNav();
  const data = useShellData();
  return {
    /** The account's desktop; once the owner is done there, the AI looks again at each site that
     * needed a code and records what it sees. */
    accountDesktop(account: AccountModel, flags: readonly AccountFlag[], need?: DesktopNeed) {
      nav.openPanel({
        kind: "legacy",
        detail: {
          type: "computer",
          environment: {
            id: account.id,
            name: account.name,
            accountLabel: account.view.accountLabel,
          },
          focus: "desktop",
          need,
        },
        afterClose: () => {
          for (const site of codeSites(flags)) void data.recheckSignIn(site, account.id);
        },
      });
    },
    /** The project's default desktop (its own logins). */
    projectDesktop(flags: readonly AccountFlag[], need?: DesktopNeed) {
      nav.openPanel({
        kind: "legacy",
        detail: { type: "computer", focus: "desktop", need },
        afterClose: () => {
          for (const site of codeSites(flags)) void data.recheckSignIn(site, null);
        },
      });
    },
    /** Add (or replace) an account's login for `site`; `account` null: the project's own. */
    loginEditor(site: string, account: AccountModel | null) {
      const saved = account?.view.siteLogins?.find((entry) => entry.site === site);
      nav.openPanel({
        kind: "credentialEditor",
        ...(saved ? { entryId: saved.id } : {}),
        preset: { kind: "site_login", site, environmentId: account?.id ?? null },
      });
    },
  };
}

/** Opens the upstream review sheet for `actionId`; looks it up again when the list is stale. */
export function useOpenReview() {
  const nav = useShellNav();
  const { reviews } = useShellData();
  const { api, workspace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const find = (actions: readonly ActionProposal[], id: string | null | undefined) =>
    id ? actions.find((action) => action.id === id) : undefined;
  const known = (id: string | null | undefined) => find(reviews, id) ?? find(workspace.actions, id);
  const open = async (id: string | null | undefined) => {
    const action = known(id);
    if (action) {
      nav.openPanel({ kind: "legacy", detail: { type: "review", action } });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const snapshot = await api.request<Workspace>("/api/workspace");
      const fresh = find(snapshot.actions ?? [], id);
      if (fresh) nav.openPanel({ kind: "legacy", detail: { type: "review", action: fresh } });
      else setError(t.taskDetail.reviewMissing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { known, open, busy, error };
}
